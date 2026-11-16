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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(join(ROOT, ...p.split('/')), 'utf8');

const cfn = read('deploy/aws/cloudformation.yaml');
const compose = read('deploy/aws/compose.production.yml');
const bootstrap = read('deploy/aws/bootstrap.sh');
const workflow = read('.github/workflows/deploy-aws.yml');
const linkOwner = read('deploy/aws/link-owner.sh');
const ensureKek = read('deploy/aws/ensure-kek.sh');
const teardown = read('deploy/aws/teardown.sh');

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

// Fn::Sub treats EVERY ${...} in UserData as a CloudFormation logical ID,
// parameter, or pseudo-parameter. A shell variable such as ${ROOT_DISK}
// therefore makes ValidateTemplate fail before the first EC2 resource.
const cfnLogicalIds = new Set(
  [...cfn.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/gm)].map((match) => match[1]),
);
const cfnPseudoParameters = new Set([
  'AWS::AccountId',
  'AWS::Region',
  'AWS::StackName',
  'AWS::StackId',
  'AWS::Partition',
  'AWS::URLSuffix',
  'AWS::NoValue',
  'AWS::NotificationARNs',
]);
const unresolvedSubReferences = [...cfn.matchAll(/\$\{([^}]+)\}/g)]
  .map((match) => match[1])
  .filter(
    (name) =>
      !name.startsWith('!') &&
      !cfnPseudoParameters.has(name) &&
      !cfnLogicalIds.has(name.split('.')[0]),
  );
check(
  'CFN-SUB-1',
  'every Fn::Sub interpolation resolves to a declared logical ID or AWS pseudo-parameter',
  unresolvedSubReferences.length === 0,
  `unresolved: ${unresolvedSubReferences.join(', ')}`,
);

// AWS EC2 security-group descriptions accept a specific ASCII-only
// character set. CloudFormation's ValidateTemplate does NOT enforce this:
// the live stack failed at CREATE_FAILED because an em dash was accepted
// by ValidateTemplate but rejected by the EC2 CreateSecurityGroup API.
const sgDescription = /^ {6}GroupDescription:\s*(.+)$/m.exec(cfn)?.[1] ?? '';
const awsEc2GroupChars = new Set(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-:/()#,@[]+=&;{}!$*',
);
check(
  'CFN-EC2-1',
  'security-group description uses AWS EC2 permitted characters only (ASCII, <=255)',
  sgDescription.length > 0 &&
    sgDescription.length <= 255 &&
    [...sgDescription].every((character) => awsEc2GroupChars.has(character)),
  `invalid GroupDescription: ${sgDescription}`,
);

// YAML parsers can silently accept the last duplicate key, hiding a
// malformed resource map even when AWS ValidateTemplate happens to pass.
const resourcesBody = cfn.split(/^Resources:\s*$/m)[1]?.split(/^Outputs:\s*$/m)[0] ?? '';
const resourcesNames = [...resourcesBody.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/gm)].map(
  (match) => match[1],
);
const duplicates = resourcesNames.filter((name, idx) => resourcesNames.indexOf(name) !== idx);
check(
  'CFN-YAML-1',
  'CloudFormation Resources block has no duplicate logical IDs',
  resourcesBody.length > 0 && duplicates.length === 0,
  `duplicate resource logical IDs: ${duplicates.join(', ')}`,
);
check(
  'CFN-ECR-1',
  'ECR repositories are independently conditional for retained-repo reuse, with no conditional GetAtt',
  /ShouldCreateApiRepository: !Equals/.test(cfn) &&
    /ShouldCreateWebRepository: !Equals/.test(cfn) &&
    /ApiRepository:\s*\n\s+Type: AWS::ECR::Repository\s*\n\s+Condition: ShouldCreateApiRepository/.test(
      cfn,
    ) &&
    /WebRepository:\s*\n\s+Type: AWS::ECR::Repository\s*\n\s+Condition: ShouldCreateWebRepository/.test(
      cfn,
    ) &&
    !/!GetAtt (?:ApiRepository|WebRepository)\./.test(cfn) &&
    (cfn.match(/DeletionPolicy: RetainExceptOnCreate/g) ?? []).length === 2,
  'retained repository cannot safely be reused after rollback',
);
const userDataBody = /^ {8}Fn::Base64: !Sub \|\n([\s\S]*?)(?=^ {2}[A-Za-z][A-Za-z0-9]*:\s*$)/m.exec(
  cfn,
)?.[1];
const userDataSyntax = spawnSync('bash', ['-n'], {
  input: userDataBody?.replace(/^ {10}/gm, '') ?? '',
  encoding: 'utf8',
});
check(
  'CFN-USERDATA-1',
  'actual CloudFormation Fn::Sub user-data and both embedded helpers parse under bash -n',
  Boolean(userDataBody) && userDataSyntax.status === 0,
  userDataSyntax.stderr?.trim() || `exit=${userDataSyntax.status}`,
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
const pinnedCompanions = [
  'provision-cognito.sh',
  'reviewer-smoke.sh',
  'compose.production.yml',
  'cloudformation.yaml',
  'link-owner.sh',
  'ensure-kek.sh',
];
const companionHashMismatches = pinnedCompanions.filter((name) => {
  const expectedVar = `EXPECTED_SHA256_${name.replaceAll('.', '_').replaceAll('-', '_').replaceAll('/', '_')}`;
  const pinned = new RegExp(`^${expectedVar}="([a-f0-9]{64})"$`, 'm').exec(bootstrap)?.[1];
  const actual = createHash('sha256')
    .update(read(`deploy/aws/${name}`))
    .digest('hex');
  return pinned !== actual;
});
check(
  'P0-6j',
  'all embedded companion SHA-256 digests exactly match the current release files',
  companionHashMismatches.length === 0,
  `outdated or missing entries: ${companionHashMismatches.join(', ')}`,
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
  'deploy workflow pins the checkout to the input SHA and tags the bare <SHA>',
  /ref: \$\{\{ env\.SHA_FULL \}\}/.test(workflow) && /TAG="\$\{SHA_FULL\}"/.test(workflow),
  'provenance chain incomplete',
);

// Execute the REAL bootstrap helper under nounset. Parsing the script alone
// missed Bash's same-statement `local name="$1" var="...${name}..."` bug,
// which aborted the founder's first CloudShell run before provisioning.
const companionHelper = /fetch_companion\(\) \{[^]*?\n\}/.exec(bootstrap)?.[0];
const companionFixture = [
  'set -euo pipefail',
  'base=$(mktemp -d)',
  'trap \'rm -rf "$base"\' EXIT',
  'SCRIPT_DIR="$base/src"',
  'TMP="$base/out"',
  'mkdir -p "$SCRIPT_DIR" "$TMP"',
  'printf "safe fixture\\n" > "$SCRIPT_DIR/mock.sh"',
  'EXPECTED_SHA256_mock_sh=$(sha256sum "$SCRIPT_DIR/mock.sh" | cut -d\' \' -f1)',
  'GH_REPO_FULL=unused',
  'REF=pinned',
  'die() { printf "%s\\n" "$*" >&2; exit 1; }',
  companionHelper ?? 'false',
];
const companionValid = spawnSync(
  'bash',
  [
    '-c',
    [
      ...companionFixture,
      'fetch_companion mock.sh',
      'cmp "$SCRIPT_DIR/mock.sh" "$TMP/mock.sh"',
    ].join('\n'),
  ],
  { encoding: 'utf8' },
);
check(
  'P0-6f',
  'real fetch_companion works under bash set -u and validates the matching hash',
  Boolean(companionHelper) && companionValid.status === 0,
  companionValid.stderr?.trim() || `exit=${companionValid.status}`,
);
const companionMismatch = spawnSync(
  'bash',
  [
    '-c',
    [
      ...companionFixture,
      'EXPECTED_SHA256_mock_sh=0000000000000000000000000000000000000000000000000000000000000000',
      'fetch_companion mock.sh',
    ].join('\n'),
  ],
  { encoding: 'utf8' },
);
check(
  'P0-6g',
  'real fetch_companion refuses a mismatched revision',
  Boolean(companionHelper) &&
    companionMismatch.status !== 0 &&
    /refusing mixed revisions/.test(companionMismatch.stderr ?? ''),
  companionMismatch.stderr?.trim() || `exit=${companionMismatch.status}`,
);

// The first live rerun got past Cognito, then failed because EXTRA_ARGS=()
// was subsequently read as a scalar under nounset. Execute the actual CLI
// parser AND CloudFormation guard with both flag combinations, without AWS.
const bootstrapCliParser = /^MODE="provision"\n[^]*?^done$/m.exec(bootstrap)?.[0];
const bootstrapStackGuard = /^if .*?(?:EXTRA_ARGS|SKIP_STACK).*; then$/m.exec(bootstrap)?.[0];
function verifyStackFlag(args, expected) {
  return spawnSync(
    'bash',
    [
      '-c',
      [
        'set -euo pipefail',
        bootstrapCliParser ?? 'false',
        'selected=skip',
        bootstrapStackGuard ?? 'false',
        '  selected=provision',
        'fi',
        `[ "$selected" = "${expected}" ]`,
      ].join('\n'),
      'bootstrap-flag-check',
      '--domain',
      'moterva.duckdns.org',
      '--email',
      'fixture@example.invalid',
      ...args,
    ],
    { encoding: 'utf8' },
  );
}
const stackEnabled = verifyStackFlag([], 'provision');
check(
  'P0-6h',
  'real bootstrap CLI and default stack guard work under bash nounset',
  Boolean(bootstrapCliParser && bootstrapStackGuard) && stackEnabled.status === 0,
  stackEnabled.stderr?.trim() || `exit=${stackEnabled.status}`,
);
const stackSkipped = verifyStackFlag(['--skip-stack'], 'skip');
check(
  'P0-6i',
  'real bootstrap CLI honors --skip-stack under bash nounset',
  Boolean(bootstrapCliParser && bootstrapStackGuard) && stackSkipped.status === 0,
  stackSkipped.stderr?.trim() || `exit=${stackSkipped.status}`,
);
// Live CloudShell regression: SSM's shorthand parser rejects quotes and
// commas inside commands=[...]. Execute the REAL ssm_run helper with a fake
// AWS transport that accepts ONLY JSON and round-trips the original bytes.
const ssmHelper = /^ssm_run\(\) \{[^\n]*\n[\s\S]*?^\}/m.exec(bootstrap)?.[0];
const trickySsmCommand =
  "printf '%s' 'encoded,with|special=characters' | base64 -d > /opt/moterva/file\nprintf 'hello\\nworld'";
const ssmRoundTrip = spawnSync(
  'bash',
  [
    '-c',
    [
      'set -euo pipefail',
      'REGION=us-east-1',
      'aws() {',
      '  case "$1 $2" in',
      '    "ssm send-command")',
      '      local parameters=""',
      '      while [ "$#" -gt 0 ]; do',
      '        if [ "$1" = "--parameters" ]; then parameters="$2"; shift 2; continue; fi',
      '        shift',
      '      done',
      '      jq -e --arg expected "$TEST_COMMAND" \'.commands == [$expected]\' <<< "$parameters" >/dev/null || return 1',
      '      printf "test-command-id\\n"',
      '      ;;',
      '    "ssm get-command-invocation") printf "Success\\n" ;;',
      '    *) printf "unexpected fake AWS request\\n" >&2; return 1 ;;',
      '  esac',
      '}',
      ssmHelper ?? 'false',
      'ssm_run i-test "$TEST_COMMAND" 30',
    ].join('\n'),
    'test-ssm-json',
  ],
  { encoding: 'utf8', env: { ...process.env, TEST_COMMAND: trickySsmCommand } },
);
check(
  'SSM-JSON-1',
  'actual bootstrap ssm_run round-trips quotes, commas, pipes and newlines through JSON parameters',
  Boolean(ssmHelper) && ssmRoundTrip.status === 0,
  ssmRoundTrip.stderr?.trim() || `exit=${ssmRoundTrip.status}`,
);
check(
  'SSM-JSON-2',
  'GitHub deploy workflow sends update and domain-read commands as JSON parameter maps',
  (workflow.match(/--parameters "\$[A-Z_]+"/g) ?? []).length === 2 &&
    (workflow.match(/jq -nc --arg cmd /g) ?? []).length === 2 &&
    !/--parameters "commands=\[/.test(workflow),
  'one or more workflow SSM calls still use unescaped shorthand parameters',
);
const cognitoRerun = spawnSync('bash', [join(ROOT, 'deploy/aws/test/cognito-provision.test.sh')], {
  encoding: 'utf8',
});
check(
  'COGNITO-R',
  'real Cognito helper reuses an existing client, reconciles stale URLs, and never prints its secret',
  cognitoRerun.status === 0 &&
    /PASS COGNITO-R1/.test(cognitoRerun.stdout ?? '') &&
    /PASS COGNITO-R2/.test(cognitoRerun.stdout ?? ''),
  cognitoRerun.stderr?.trim() || cognitoRerun.stdout?.trim() || `exit=${cognitoRerun.status}`,
);
check(
  'TAG-1',
  'ECR tag alignment: workflow pushes the bare SHA that update.sh validates, compose pulls and GIT_SHA reports (no prefix drift)',
  (() => {
    const pushesBareSha = /TAG="\$\{SHA_FULL\}"/.test(workflow) && !/TAG="sha-/.test(workflow);
    const updateValidatesBareSha = /\[\[ "\$SHA" =~ \^\[0-9a-f\]\{7,64\}\$ \]\]/.test(cfn);
    const composePullsEnvSha = /\$\{MOTERVA_RELEASE_SHA:\?/.test(compose);
    const gitShaIsEnvSha = /GIT_SHA: \$\{MOTERVA_RELEASE_SHA\}/.test(compose);
    const ssmPassesBareSha = /update\.sh \$\{SHA_FULL\}/.test(workflow);
    return (
      pushesBareSha &&
      updateValidatesBareSha &&
      composePullsEnvSha &&
      gitShaIsEnvSha &&
      ssmPassesBareSha
    );
  })(),
  'push/pull/validation tag forms disagree',
);
check(
  'TAG-2',
  'bootstrap ECR image-wait matches the bare-SHA tag scheme (no sha- prefix remains anywhere in bootstrap)',
  /contains\(imageTags, '\$\{SHA_TO_WAIT\}'\)/.test(bootstrap) &&
    !/sha-/.test(bootstrap.replace(/update\.sh/g, '')),
  'bootstrap still expects prefixed tags',
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
  'ssm:GetCommandInvocation is a SEPARATE statement with Resource=* (the action is not ARN-scopeable)',
  policyJson.Statement.some(
    (s) =>
      (s.Action === 'ssm:GetCommandInvocation' ||
        (Array.isArray(s.Action) && s.Action.includes('ssm:GetCommandInvocation'))) &&
      s.Resource === '*',
  ),
  'GetCommandInvocation not separately authorized with Resource=*',
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
    /--context-entries "ContextKeyName=ssm:resourceTag\/Name,ContextKeyValues=moterva-judge,ContextKeyType=string"/.test(
      bootstrap,
    ) &&
    !/--context-entry\s/.test(bootstrap),
  'simulation coverage incomplete',
);
check(
  'IAM-16',
  'IAM simulation uses the documented --context-entries option and wildcard for unscopable readback',
  /--context-entries "ContextKeyName=/.test(bootstrap) &&
    /"\*" "ssm:GetCommandInvocation"/.test(bootstrap),
  'IAM simulation has an unsupported AWS CLI flag or readback ARN',
);
check(
  'IAM-OIDC-1',
  'GitHub OIDC provider creation uses IAM automatic CA thumbprint resolution (no malformed list)',
  /aws iam create-open-id-connect-provider/.test(bootstrap) &&
    !/--thumbprint-list/.test(bootstrap) &&
    !/openssl s_client/.test(bootstrap),
  'OIDC command still constructs unsupported certificate thumbprint arguments',
);
check(
  'IAM-OIDC-2',
  'full teardown recognizes the scheme-less GitHub OIDC provider URL returned by IAM',
  teardown.includes('[ "$URL" = "token.actions.githubusercontent.com" ]'),
  'teardown would leave behind a bootstrap-created OIDC provider',
);
check(
  'CFN-ROLLBACK-1',
  'ROLLBACK_COMPLETE recovery requires explicit opt-in and never invokes full project teardown',
  /--recover-rolled-back-stack\) RECOVER_ROLLBACK=true/.test(bootstrap) &&
    /ROLLBACK_COMPLETE\)/.test(bootstrap) &&
    /\[ "\$RECOVER_ROLLBACK" = true \]/.test(bootstrap) &&
    /aws cloudformation delete-stack --region "\$REGION" --stack-name "\$STACK"/.test(bootstrap) &&
    !/bash .*teardown\.sh/.test(bootstrap),
  'unsafe or non-opt-in rolled-back stack recovery',
);

// Execute the REAL repo decision helper with mocked AWS responses: a failed
// first stack can leave retained repositories with existing images. They must
// be reused without destructive deletion, while healthy stacks keep managing
// their original resources. Also fail closed on non-immutable or denied repos.
const ecrDecisionHelper = /^ {2}ecr_should_create\(\) \{[\s\S]*?^ {2}\}/m.exec(bootstrap)?.[0];
function ecrDecision(state, managed, stackPresent, expected, expectSuccess) {
  const script = [
    'set -euo pipefail',
    'REGION=us-east-1; STACK=moterva-judge',
    `STACK_PRESENT=${stackPresent ? 'true' : 'false'}`,
    `MOCK_ECR=${state}; MOCK_MANAGED=${managed ? 'true' : 'false'}`,
    'die() { echo "$*" >&2; exit 1; }',
    'aws() {',
    '  case "$*" in',
    '    *describe-stack-resource*) [ "$MOCK_MANAGED" = true ] ;;',
    '    *describe-repositories*)',
    '      case "$MOCK_ECR" in',
    '        existing) echo IMMUTABLE ;;',
    '        mutable) echo MUTABLE ;;',
    '        missing) echo "RepositoryNotFoundException" >&2; return 254 ;;',
    '        denied) echo "AccessDeniedException" >&2; return 254 ;;',
    '      esac ;;',
    '    *) echo "unexpected AWS call: $*" >&2; return 2 ;;',
    '  esac',
    '}',
    ecrDecisionHelper ?? 'false',
    `result=$(ecr_should_create moterva-api ApiRepository)`,
    `[ "$result" = "${expected}" ]`,
  ].join('\n');
  const out = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return expectSuccess ? out.status === 0 : out.status !== 0;
}
check(
  'CFN-ECR-2',
  'real ECR helper handles retained, absent, stack-managed, mutable and access-denied cases under nounset',
  Boolean(ecrDecisionHelper) &&
    ecrDecision('existing', false, false, 'false', true) &&
    ecrDecision('missing', false, false, 'true', true) &&
    ecrDecision('existing', true, true, 'true', true) &&
    ecrDecision('mutable', false, false, '', false) &&
    ecrDecision('denied', false, false, '', false),
  'mocked ECR decision matrix was not respected',
);
const rollbackRecoveryBody =
  /^ {2}if STACK_STATUS=\$\(aws cloudformation describe-stacks[\s\S]*?^ {2}esac$/m.exec(
    bootstrap,
  )?.[0];
function recoveryDecision(stackStatus, optedIn, shouldSucceed, shouldDelete) {
  const script = [
    'set -euo pipefail',
    `MOCK_STATUS=${stackStatus}; RECOVER_ROLLBACK=${optedIn ? 'true' : 'false'}`,
    'REGION=us-east-1; STACK=moterva-judge',
    'die() { echo "$*" >&2; exit 1; }',
    'log() { :; }',
    'aws() {',
    '  case "$*" in',
    '    *describe-stacks*)',
    '      if [ "$MOCK_STATUS" = absent ]; then echo "Stack does not exist" >&2; return 254; fi',
    '      echo "$MOCK_STATUS" ;;',
    '    *delete-stack*) echo DELETE_TRIGGERED ;;',
    '    *stack-delete-complete*) echo WAIT_TRIGGERED ;;',
    '    *) echo "unexpected AWS call: $*" >&2; return 2 ;;',
    '  esac',
    '}',
    rollbackRecoveryBody ?? 'false',
  ].join('\n');
  const out = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return (
    (out.status === 0) === shouldSucceed &&
    (out.stdout?.includes('DELETE_TRIGGERED') ?? false) === shouldDelete
  );
}
check(
  'CFN-ROLLBACK-2',
  'real recovery guard deletes ONLY an opted-in ROLLBACK_COMPLETE stack; other states are preserved',
  Boolean(rollbackRecoveryBody) &&
    recoveryDecision('ROLLBACK_COMPLETE', false, false, false) &&
    recoveryDecision('ROLLBACK_COMPLETE', true, true, true) &&
    recoveryDecision('CREATE_COMPLETE', true, true, false) &&
    recoveryDecision('UPDATE_IN_PROGRESS', true, false, false) &&
    recoveryDecision('absent', true, true, false),
  'mocked rollback decision matrix was not respected',
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
    /workflow_dispatch MUST be launched from this/.test(bootstrap) === false &&
    /workflow_dispatch for this workflow runs from the/.test(bootstrap),
  'trust/dispatch-branch mismatch or undocumented',
);
check(
  'REL-1',
  'the release line is MAIN: trust targets refs/heads/main and no stale integration-branch pin remains',
  /RELEASE_BRANCH="main"/.test(bootstrap) && !/feat\/mtv-19-connected-golden-path/.test(bootstrap),
  'trust still pinned to the pre-release integration branch (a dispatch from main would be denied)',
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
