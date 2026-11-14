#!/usr/bin/env node
// AWS deployment CONTRACT checks (regression harness for the CTO P0 review).
// Parses the actual deploy artifacts as TEXT and asserts the wiring contracts
// that previously drifted silently. Zero dependencies; exit 1 on any drift.
//
// Run: node deploy/aws/test/contract-checks.mjs
// Wired into .github/workflows/release-verify.yml so the P0 classes cannot
// regress: port mismatch, named-volume ledger, wrong origin variable, broken
// CloudFormation signaling, missing mount fail-closed, provenance pinning,
// IAM breadth, owner-binding path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(join(ROOT, ...p.split('/')), 'utf8');

const cfn = read('deploy/aws/cloudformation.yaml');
const compose = read('deploy/aws/compose.production.yml');
const bootstrap = read('deploy/aws/bootstrap.sh');
const workflow = read('.github/workflows/deploy-aws.yml');
const linkOwner = read('deploy/aws/link-owner.sh');
const ensureKek = read('deploy/aws/ensure-kek.sh');

const results = [];
function check(id, name, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${ok ? '' : ' — ' + detail}`);
}

// ---- P0-1: update.sh health gate MUST poll the exact loopback port the
// compose file publishes for the api (never 8080 again).
const publishedPort = /127\.0\.0\.1:(\d+):8787/.exec(compose)?.[1];
check(
  'P0-1a',
  'compose publishes the api on host-loopback 127.0.0.1:<PORT>:8787',
  publishedPort !== undefined,
  'no 127.0.0.1:<PORT>:8787 mapping found',
);
const gatePort = /127\.0\.0\.1:(\d+)\/healthz/.exec(cfn)?.[1];
check(
  'P0-1b',
  'update.sh health gate polls the same loopback port',
  publishedPort !== undefined && gatePort === publishedPort,
  `compose=${publishedPort ?? 'none'} update.sh=${gatePort ?? 'none'}`,
);
check(
  'P0-1c',
  'update.sh never polls the historical wrong port 8080',
  !/127\.0\.0\.1:8080/.test(cfn),
  'found 127.0.0.1:8080 reference in cloudformation.yaml',
);

// ---- P0-2: the ledger MUST be a bind mount to the EBS path, not a Docker
// named volume; user-data must never reformat an existing filesystem and
// must fail closed when the mount is absent.
check(
  'P0-2a',
  'compose bind-mounts /var/lib/moterva from the HOST (EBS), not a named volume',
  /-\s+\/var\/lib\/moterva:\/var\/lib\/moterva/.test(compose) && !/moterva-ledger:/.test(compose),
  'named volume moterva-ledger still present or bind mount missing',
);
check(
  'P0-2b',
  'user-data discovers the data disk (no hardcoded /dev/xvdf mount)',
  /findmnt -n -o SOURCE \//.test(cfn) && /lsblk -dpno NAME,TYPE/.test(cfn),
  'device discovery missing',
);
check(
  'P0-2c',
  'mkfs runs ONLY when blkid reports no existing filesystem (never reformat non-empty volume)',
  /FS_TYPE=\$\(blkid -s TYPE -o value "\$DATADEV"/.test(cfn) && /if \[ -z "\$FS_TYPE" \]/.test(cfn),
  'blind mkfs or missing blkid guard',
);
check(
  'P0-2d',
  'fstab entry is UUID-based (durable across device renaming)',
  /UUID=\$DATA_UUID \/var\/lib\/moterva/.test(cfn),
  'fstab not UUID-pinned',
);
check(
  'P0-2e',
  'update.sh FAILS CLOSED when /var/lib/moterva is not a mountpoint',
  /findmnt -n -o SOURCE \/var\/lib\/moterva/.test(cfn) &&
    /refusing to start the api on root-disk storage/.test(cfn),
  'no mount fail-closed guard in update.sh',
);
check(
  'P0-2f',
  'ledger directory ownership granted to the container uid (chown 1000:1000)',
  /chown 1000:1000 \/var\/lib\/moterva/.test(cfn),
  'ownership not granted post-mount',
);

// ---- P0-3: the secret must carry WEB_ORIGIN (what config.ts reads), not
// the dead MOTERVA_PUBLIC_ORIGIN variable. Scoped to merge_secret's body —
// the dead variable's name may appear in an explanatory comment, never as
// a written key.
const mergeSecretBody = /merge_secret\(\) \{[\s\S]*?\n\}/.exec(bootstrap)?.[0] ?? '';
check(
  'P0-3a',
  'bootstrap merge_secret writes WEB_ORIGIN=https://<domain>',
  /WEB_ORIGIN:\$origin/.test(mergeSecretBody),
  'WEB_ORIGIN missing from merge_secret',
);
check(
  'P0-3b',
  'the dead MOTERVA_PUBLIC_ORIGIN variable is never written into the secret',
  mergeSecretBody !== '' && !/MOTERVA_PUBLIC_ORIGIN/.test(mergeSecretBody),
  'MOTERVA_PUBLIC_ORIGIN still written inside merge_secret',
);

// ---- P0-4: first-owner binding is a server-side SSM path (link-owner.sh),
// never an anonymous endpoint; the ledger provisioning seam journals it.
check(
  'P0-4a',
  'link-owner.sh resolves the Cognito sub server-side (admin-get-user)',
  /admin-get-user/.test(linkOwner),
  'subject not resolved from the pool',
);
check(
  'P0-4b',
  'link-owner.sh uses the ledger provisioning seam (auditable, conflict-safe)',
  /provisionIdentityActor/.test(linkOwner),
  'not using the ledger identity service',
);
check(
  'P0-4c',
  'bootstrap runs link-owner.sh over SSM before smoke checks',
  /link-owner\.sh" 300/.test(bootstrap) || /link-owner\.sh" \d+/.test(bootstrap),
  'bootstrap does not invoke link-owner.sh over SSM',
);
check(
  'P0-4d',
  'no anonymous owner-creation HTTP endpoint was added (link-owner runs in-container)',
  /docker compose -f compose\.production\.yml exec -T[\s\S]*?api node --input-type=module/.test(
    linkOwner,
  ),
  'binding is not the in-container ledger path',
);

// ---- P0-5: CloudFormation completion signaling — CreationPolicy on the
// instance, cfn-signal --resource JudgeInstance, ERR trap fails the stack.
check(
  'P0-5a',
  'instance carries a CreationPolicy ResourceSignal (no WaitConditionHandle)',
  /CreationPolicy:/.test(cfn) && /ResourceSignal:/.test(cfn) && !/WaitConditionHandle/.test(cfn),
  'WaitConditionHandle present or CreationPolicy missing',
);
check(
  'P0-5b',
  'cfn-signal targets the JudgeInstance resource',
  /--resource JudgeInstance/.test(cfn) && !/--resource JudgeWaitHandle/.test(cfn),
  'cfn-signal resource wrong',
);
check(
  'P0-5c',
  'user-data signals FAILURE on error (ERR trap), so a broken boot fails the stack',
  /trap 'echo "user-data FAILED — signaling stack failure"; SIGNAL_FAIL' ERR/.test(cfn),
  'no ERR-trap failure signal',
);

// ---- P0-6: provenance pinning — companions verified against an embedded
// sha256 map; NO silent main fallback; --ref required for curl|bash.
check(
  'P0-6a',
  'bootstrap embeds a sha256 map for every companion',
  /EXPECTED_SHA256_provision_cognito_sh=/.test(bootstrap) &&
    /EXPECTED_SHA256_reviewer_smoke_sh=/.test(bootstrap) &&
    /EXPECTED_SHA256_compose_production_yml=/.test(bootstrap) &&
    /EXPECTED_SHA256_cloudformation_yaml=/.test(bootstrap) &&
    /EXPECTED_SHA256_link_owner_sh=/.test(bootstrap) &&
    /EXPECTED_SHA256_ensure_kek_sh=/.test(bootstrap),
  'companion hash map incomplete',
);
check(
  'P0-6b',
  'downloads are hash-verified (sha256sum) and mixed revisions are refused',
  /sha256sum "\$TMP\/\$name"/.test(bootstrap) && /refusing mixed revisions/.test(bootstrap),
  'hash verification missing',
);
check(
  'P0-6c',
  'NO silent main-branch fallback for companions',
  !/\/main\/deploy\/aws/.test(bootstrap),
  'main fallback still present',
);
check(
  'P0-6d',
  'no unresolved placeholder hashes remain in bootstrap (hash map is real)',
  !/="PLACEHOLDER_/.test(bootstrap),
  'placeholder hashes still present',
);
check(
  'P0-6e',
  'deploy workflow pins the checkout to the input SHA and tags sha-<SHA>',
  /ref: \$\{\{ env\.SHA_FULL \}\}/.test(workflow) && /TAG="sha-\$\{SHA_FULL\}"/.test(workflow),
  'provenance chain incomplete',
);

// ---- P0-7: least privilege — branch-scoped OIDC trust, repo-ARN ECR push,
// document+tag-scoped SSM.
check(
  'P0-7a',
  'deploy role trust is scoped to the release branch (not repo:*)',
  /ref:refs\/heads\/\$\{RELEASE_BRANCH\}/.test(bootstrap) &&
    !/repo:\$\{GH_REPO_FULL\}:\*/.test(bootstrap),
  'trust policy still repo:*',
);
check(
  'P0-7b',
  'ECR push scoped to the two moterva repository ARNs',
  /arn:aws:ecr:\$\{REGION\}:\$\{ACCOUNT\}:repository\/moterva-api/.test(bootstrap),
  'ECR push resource not repo-scoped',
);
check(
  'P0-7c',
  'ssm:SendCommand scoped to the RunShellScript document with the judge tag condition',
  /document\/AWS-RunShellScript/.test(bootstrap) && /ssm:resourceTag\/Name/.test(bootstrap),
  'SendCommand not document/tag-scoped',
);

// ---- P0-8: honest spend language — the budget is an ALERT, not a cap;
// IPv4 charge acknowledged; no "credits cover everything" claim.
check(
  'P0-8a',
  'bootstrap summary states the budget is alert-only',
  /budget is an ALERT ONLY/.test(bootstrap),
  'budget wording overclaims',
);
check(
  'P0-8b',
  'cost summary includes the public IPv4 charge',
  /public IPv4 3\.6/.test(bootstrap),
  'IPv4 cost omitted',
);

// ---- CTO integration review (IAM P0): the SSM authorization must use the
// ACCOUNT-EMPTY AWS-managed document ARN, authorize the TAGGED INSTANCE
// separately (tag condition belongs on the instance, not the document),
// and keep GetCommandInvocation separate. The policy must be defined ONCE
// and applied on both the create and rerun paths (a rerun can never
// preserve a broken policy).
const policyBlock = /DEPLOY_POLICY=\$\(cat <<EOF\n([\s\S]*?)\nEOF\n\)/.exec(bootstrap)?.[1] ?? '';
check(
  'IAM-1',
  'a single shared DEPLOY_POLICY definition exists (both create and rerun apply it)',
  policyBlock !== '',
  'DEPLOY_POLICY heredoc not found',
);
const putRolePolicyCount = (bootstrap.match(/put-role-policy/g) ?? []).length;
check(
  'IAM-2',
  'exactly ONE put-role-policy call (rerun path reuses the same policy — no drift possible)',
  putRolePolicyCount === 1,
  `found ${putRolePolicyCount} put-role-policy calls`,
);
check(
  'IAM-3',
  'policy JSON is syntactically valid (placeholders substituted with dummies then parsed)',
  (() => {
    try {
      const dummy = policyBlock
        .replace(/\$\{REGION\}/g, 'us-east-1')
        .replace(/\$\{ACCOUNT\}/g, '123456789012')
        .replace(/\$\{GH_REPO_FULL\}/g, 'CosmasMandikonza/Morteva');
      JSON.parse(dummy);
      return true;
    } catch {
      return false;
    }
  })(),
  'policy JSON does not parse',
);
const policyJson = JSON.parse(
  policyBlock
    .replace(/\$\{REGION\}/g, 'us-east-1')
    .replace(/\$\{ACCOUNT\}/g, '123456789012')
    .replace(/\$\{GH_REPO_FULL\}/g, 'CosmasMandikonza/Morteva'),
);
const sendStatements = policyJson.Statement.filter(
  (s) =>
    s.Action === 'ssm:SendCommand' ||
    (Array.isArray(s.Action) && s.Action.includes('ssm:SendCommand')),
);
check(
  'IAM-4',
  'ssm:SendCommand is granted by exactly TWO statements (document + instance)',
  sendStatements.length === 2,
  `found ${sendStatements.length} SendCommand statements`,
);
const docStatement = sendStatements.find((s) =>
  (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).some((r) => r.includes('::document/')),
);
check(
  'IAM-5',
  'the document statement targets the AWS-managed RunShellScript ARN with NO account id (arn:aws:ssm:<region>::document/...)',
  docStatement !== undefined &&
    (Array.isArray(docStatement.Resource) ? docStatement.Resource : [docStatement.Resource]).every(
      (r) => !r.includes('document/') || /^arn:aws:ssm:[^:]*::document\//.test(r),
    ) &&
    docStatement.Condition === undefined,
  'document ARN carries an account id or the statement is conditioned',
);
const instanceStatement = sendStatements.find((s) =>
  (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).some((r) => /:instance\//.test(r)),
);
check(
  'IAM-6',
  'the instance statement targets instance ARNs with the moterva-judge tag CONDITION (tag belongs on the target)',
  instanceStatement !== undefined &&
    (Array.isArray(instanceStatement.Resource)
      ? instanceStatement.Resource
      : [instanceStatement.Resource]
    ).every((r) => /:instance\//.test(r)) &&
    JSON.stringify(instanceStatement.Condition ?? {}).includes('ssm:resourceTag/Name') &&
    JSON.stringify(instanceStatement.Condition ?? {}).includes('moterva-judge'),
  'instance statement missing, mis-scoped, or tag condition absent',
);
check(
  'IAM-7',
  'ssm:GetCommandInvocation is a SEPARATE statement on instance ARNs',
  policyJson.Statement.some(
    (s) =>
      (s.Action === 'ssm:GetCommandInvocation' ||
        (Array.isArray(s.Action) && s.Action.includes('ssm:GetCommandInvocation'))) &&
      (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).every((r) => /:instance\//.test(r)),
  ),
  'GetCommandInvocation not separately instance-scoped',
);
check(
  'IAM-8',
  'no account-bearing SSM document ARN remains anywhere in bootstrap',
  !/arn:aws:ssm:\$\{REGION\}:\$\{ACCOUNT\}:document/.test(bootstrap),
  'stale account-scoped document ARN present',
);
check(
  'IAM-9',
  'an IAM simulation preflight runs at bootstrap time (free, before any billable resource)',
  /simulate-principal-policy/.test(bootstrap) && /sim_assert/.test(bootstrap),
  'no simulation preflight',
);
check(
  'IAM-10',
  'the simulation asserts BOTH the document and a tagged instance, with the tag context entry',
  /arn:aws:ssm:\$\{REGION\}::document\/AWS-RunShellScript" "ssm:SendCommand/.test(bootstrap) &&
    /instance\/i-00000000000000000" "ssm:SendCommand"/.test(bootstrap) &&
    /ssm:resourceTag\/Name,Values=moterva-judge/.test(bootstrap),
  'simulation coverage incomplete',
);
check(
  'IAM-11',
  'bootstrap refuses to continue if simulation denies any deploy action',
  /refusing to hand over a deploy role that cannot deploy/.test(bootstrap),
  'no refuse-on-deny gate',
);
check(
  'IAM-12',
  'trust policy subject matches the manual dispatch branch and bootstrap states the dispatch requirement',
  /ref:refs\/heads\/\$\{RELEASE_BRANCH\}/.test(bootstrap) &&
    /workflow_dispatch MUST be launched from this/.test(bootstrap),
  'trust/dispatch-branch mismatch or undocumented',
);
check(
  'IAM-13',
  'bootstrap verifies the workflow file exists on the DEFAULT branch before advising dispatch (workflow_dispatch restriction)',
  /deploy-aws\.yml\?ref=\$\{DEFAULT_BRANCH\}/.test(bootstrap),
  'no default-branch workflow availability check',
);
check(
  'IAM-14',
  'bootstrap validates the CloudFormation template (free API) BEFORE any billable deploy',
  /validate-template --region "\$REGION" \\\s*--template-body "file:\/\/\$TMP\/cloudformation\.yaml"/.test(
    bootstrap,
  ),
  'no template validation preflight',
);
check(
  'IAM-15',
  'stale $12/hard-cap budget language is gone from bootstrap and CFN (alert-only $18/~$13.5)',
  !/hard budget alarm|BudgetLimit=12|Default: 12/.test(bootstrap + cfn) && /alert only/i.test(cfn),
  'stale budget wording remains',
);

// ---- SOURCE-KEY KEK custody (CTO PR#62 comment 6808567133, consuming C's
// PR #64 contract): one-time 32-byte KEK in Secrets Manager, never rotated
// by tooling, delivered ONLY to the api process, retained across reruns /
// env refresh / redeploys / rollback.
check(
  'KEK-1',
  'bootstrap fetches ensure-kek.sh (hash-pinned companion) and invokes it BEFORE any other secret write',
  /fetch_companion ensure-kek\.sh/.test(bootstrap) &&
    /SECRET_NAME="\$SECRET_NAME" bash "\$TMP\/ensure-kek\.sh"/.test(bootstrap) &&
    bootstrap.indexOf('ensure-kek.sh') < bootstrap.indexOf('merge_secret "$ISSUER"'),
  'ensure-kek missing or ordered after the OIDC merge',
);
check(
  'KEK-2',
  'merge_secret STRIPS the three custody variables from the incoming object (cannot create/rotate/drop them)',
  /\.\[0\] \* \(\$next \| del\(\.MOTERVA_SOURCE_KEY_KEK, \.MOTERVA_SOURCE_KEY_KEK_PREVIOUS, \.MOTERVA_SOURCE_KEY_KEK_RETIRED\)\)/.test(
    bootstrap,
  ),
  'custody del-guard missing from merge_secret',
);
check(
  'KEK-3',
  'ensure-kek generates ONLY when the key is absent, via the CSPRNG, in a canonical 32-byte encoding',
  /openssl rand -base64 32/.test(ensureKek) &&
    /has\("MOTERVA_SOURCE_KEY_KEK"\)/.test(ensureKek) &&
    /grep -Eq '\^\[A-Za-z0-9\+\/\]\{43\}=\$'/.test(ensureKek),
  'generation is not CSPRNG/canonical/conditional',
);
check(
  'KEK-4',
  'ensure-kek REFUSES a present-but-empty key and a foreign (non-canonical) existing key — never auto-overwrites',
  /present but EMPTY/.test(ensureKek) && /refusing to touch it/.test(ensureKek),
  'empty/foreign refusal guards missing',
);
check(
  'KEK-5',
  'ensure-kek verifies the persisted value by read-back before declaring success',
  /read-back mismatch/.test(ensureKek),
  'no read-back verification',
);
check(
  'KEK-6',
  'ensure-kek NEVER prints the value: log lines carry only fingerprints; every echo/printf is piped or discarded',
  (() => {
    const lines = ensureKek.split('\n');
    const logLines = lines.filter((l) => /^\s*log\b/.test(l));
    const pipeLines = lines.filter((l) => /^\s*(echo|printf)\b/.test(l));
    const stripSubs = (l) => {
      let prev;
      do {
        prev = l;
        l = l.replace(/\$\([^()]*\)/g, 'SUB');
      } while (l !== prev);
      return l;
    };
    const logOk =
      logLines.length > 0 &&
      logLines.every((l) => !/\$(KEK|MERGED|PERSISTED|EXISTING)\b/.test(stripSubs(l)));
    const pipesOk = pipeLines.every((l) => /\|/.test(l) || /\/dev\/null/.test(l));
    return logOk && pipesOk;
  })(),
  'a terminal-output line carries key material',
);
check(
  'KEK-7',
  'the api service alone loads production.env (env_file); the web edge does NOT receive it',
  /env_file: production\.env/.test(compose) &&
    !/env_file:/.test((compose.match(/^ {2}web:[\s\S]*?(?=^ {2}[a-z]|^volumes:)/m) ?? [''])[0]),
  'env_file not api-exclusive',
);
check(
  'KEK-8',
  'refresh-env (on-instance) writes the ENTIRE secret — KEK included — to a 600 env file and never echoes values',
  cfn.includes(`to_entries[] | "\\(.key)=\\(.value)"`) &&
    /chmod 600 \/opt\/moterva\/production\.env/.test(cfn) &&
    !/cat \/opt\/moterva\/production\.env/.test(cfn),
  'refresh-env leaks or drops custody values',
);
check(
  'KEK-9',
  'the deploy/rollback helper (update.sh) NEVER writes the secret — the KEK and sealed credentials stay consistent across rollback',
  (() => {
    const m = cfn.match(/cat > \/opt\/moterva\/update\.sh <<'EOS'[\s\S]*?EOS/);
    return m !== null && !/put-secret-value|secretsmanager/.test(m[0]);
  })(),
  'update.sh touches the secret',
);

// ---- summary
const failed = results.filter((r) => !r.ok);
console.log(`\ncontract-checks: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map((f) => f.id).join(', '));
  process.exitCode = 1;
}
