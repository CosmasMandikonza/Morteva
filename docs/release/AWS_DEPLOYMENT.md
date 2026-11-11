# AWS judge environment — automated provisioning & operations (issues #17/#19)

One instance, Docker Compose, Caddy TLS, SQLite on encrypted EBS, Cognito
reviewer authentication — provisioned end-to-end by scripts, deployed from
immutable release SHAs by GitHub Actions over OIDC. Written/updated
2026-11-11 by Agent E. Architecture rationale is unchanged from the Nov 10
version (still: no Kubernetes/RDS/microservices; single SQLite writer).

## The ONE command (founder, in CloudShell, us-east-1)

**Provenance-pinned** (CTO P0-6): the ref IS the exact reviewed SHA — the
bootstrap fetches every companion from that same SHA and verifies each
against an embedded sha256 map, refusing mixed revisions. No silent
main-branch fallback exists.

```bash
curl -fsSL \
  https://raw.githubusercontent.com/CosmasMandikonza/Morteva/<REVIEWED_SHA>/deploy/aws/bootstrap.sh \
  | bash -s -- --ref <REVIEWED_SHA> --domain judge.your-domain.com --email you@your-domain.com
```

This single command, idempotently:

1. Verifies CloudShell auth + region, resolves the default VPC/subnet
   (`vpc-000ecd971da3b24ba`).
2. Creates the Secrets Manager secret `moterva/production` — with
   **`WEB_ORIGIN=https://<domain>`** (the variable `apps/api/src/config.ts`
   actually reads for CORS + the OIDC landing).
3. Provisions **Cognito** (`provision-cognito.sh`): user pool, hosted-UI
   domain, confidential app client (code + PKCE), owner user — client
   secret stored straight into the secret (never printed in full, never
   committed).
4. Deploys the CloudFormation stack (`cloudformation.yaml`): t3.micro,
   SSM-managed (no SSH), encrypted dedicated ledger EBS **bind-mounted into
   the api container** (never a Docker named volume on the root disk),
   EIP, immutable-tag ECR repos, **$18/month budget ALERT** (alert-only —
   see Spend honesty) + status-check alarm, creation that **fails the stack
   on any boot failure** (CreationPolicy ResourceSignal + ERR-trap signal).
   **This step is the founder's approval to spend.**
5. Writes the production compose (`compose.production.yml`) + env to the
   instance over SSM (no SSH keys anywhere).
6. Creates the **GitHub OIDC deploy role** (short-lived credentials only;
   trust scoped to the release branch of this one repo; ECR push on the two
   repos only; SSM on the RunShellScript document + judge-tagged instance;
   explicit Deny on iam/secrets/s3/terminate).
7. Waits for the Deploy-AWS workflow images (or you rerun with
   `--wait-images 15` after triggering it), runs `update.sh` (which
   **refuses to start the api if the EBS mount is missing**), then:
   - **binds your first owner identity** (`link-owner.sh` over SSM —
     auditable, one-shot; the same server-side seam the tests prove);
   - executes the **reviewer smoke checks** (`reviewer-smoke.sh`) against
     the live URL.

Flags: `--ref <sha>` (**required** for curl|bash runs — provenance),
`--release-sha <sha>` (wait for a specific SHA), `--refresh-env`
(re-push secret values into the running stack), `--skip-stack`.

### Spend honesty (CTO P0-8)

The budget is an **ALERT, not a hard spending cap**. Expected steady state
≈ **$13.5/month**: t3.micro $7.60 + 20 GB gp3 $1.60 + **public IPv4 $3.60**
(charged even while attached since Feb 2024) + ECR/CloudWatch/transfer
≈ $0.70. Promotional credits do **not** necessarily cover every fee (e.g.
some marketplace/support charges are credit-ineligible). The $18 budget
(email at 80% actual / 100% forecast) is the control, not a cap.

### Genuinely unavoidable inputs

| Input | Why it cannot be automated |
|---|---|
| `--domain` | Judge URL + Let's Encrypt TLS need a hostname **you control**; its A record must point at the printed Elastic IP. |
| `--email` | AWS Budget alert subscriber (and human ACME contact). |
| DNS A record | Created in your DNS provider's console (any provider). |
| GitHub variables | `AWS_DEPLOY_ROLE_ARN` + `AWS_REGION` under repo → Settings → Actions → Variables (bootstrap prints exact values; pasting them is a UI click, not a secret transfer — the role itself carries no credential). |

Everything else — secrets, Cognito (pool/client/domain/owner), ECR, EC2,
IAM, budget — is script-provisioned. No AWS access keys exist anywhere; CI
uses GitHub OIDC; the instance uses its role.

## Deployment & rollback (immutable release SHAs)

`Actions → Deploy AWS → Run workflow`: input `release_sha` (the reviewed
SHA) + `confirm_live=DEPLOY`. The workflow checks out THAT SHA, builds both
images, pushes to ECR as `sha-<sha>` (ECR tag immutability is ON — a tag
can never be overwritten), then runs `/opt/moterva/update.sh <sha>` over
SSM, which pulls, recreates, and health-checks (loopback `:18087`, never
public) before reporting success.

**Rollback = the same workflow with an older reviewed SHA.** Old images
remain pullable (immutable tags); the ledger volume is untouched by image
changes, and the API refuses a NEWER-schema ledger at boot — rollback of a
schema-forward release fails loudly instead of corrupting (existing
migration gate).

## Production wiring (what the reviewer gets)

- `NODE_ENV=production`, `MOTERVA_TRUST_PROXY=1` behind Caddy.
- `MOTERVA_REVIEWER_DEMO=1` + full `MOTERVA_OIDC_*` — the authenticated
  scope mounts with real OIDC sessions; reviewer capability live; DEV_AUTH
  structurally absent in production (login endpoint 404, proven per PR).
- Optional provider credentials (e.g. Airwallex sandbox) enter ONLY via the
  secret: add them to `moterva/production`, then `bootstrap.sh --refresh-env`.

## Health checks & resilience (E5)

| Layer | Mechanism |
|---|---|
| Container crash | `restart: unless-stopped`; Docker enabled at boot |
| Instance failure | status-check alarm → SNS email; stack update recreates the instance; the ledger volume REATTACHES (device discovered by UUID-pinned fstab, never reformatted) |
| SQLite durability | dedicated encrypted gp3 volume **bind-mounted into the api container** (CTO P0-2: a named Docker volume would have silently lived on the root disk — fixed and contract-checked); WAL; verified backups |
| Boot-time integrity | CloudFormation CreationPolicy waits for user-data; ANY boot failure signals `-e 1` and fails/rolls back the stack |
| Deploy-time health | `update.sh` fails closed if the EBS mount is missing, then polls loopback healthz before declaring success; the workflow fails visibly otherwise |
| Persistence proof | CI: compose-boot stops the api container, restarts it, and asserts identical ledger fingerprints (events/actors/operations) — real container-rebuild persistence, per PR |
| Spend | Budget $18 **ALERT only** (80% actual + 100% forecast email); steady ≈ $13.5 incl. public IPv4 $3.60; credits do not necessarily cover every fee |
| Secrets | Secrets Manager only; instance role reads exactly one ARN; nothing in git, AMI, or user-data |

## First-owner onboarding & reviewer access (CTO P0-4)

Production identity has NO public self-provisioning: an unlinked OIDC
identity is refused at the callback (`IDENTITY_NOT_LINKED`, no session) —
proven by `apps/api/test/identity/no-devauth-onboarding.test.ts`, which
also proves the full fresh-organization path WITHOUT any development
authentication (owner bound server-side → OIDC sign-in → invitation →
operator role → reviewer capability usable).

At deploy time `bootstrap.sh` runs `deploy/aws/link-owner.sh` ON THE
INSTANCE over SSM: it resolves the Cognito `sub` server-side, enforces the
one-shot/immutability guard (a different subject for the same username is
REFUSED; reruns are no-ops), binds through the ledger's auditable
provisioning seam (journals `actor.created` + `identity.provisioned`), and
then the owner's first hosted-UI sign-in lands as org OWNER. Additional
operators/approvers are onboarded INSIDE the app via `POST /api/invitations`
(secrets delivered out-of-band) — the flow the identity E2E suite exercises
in a real browser.

## Reviewer browser testing (E4 against the live URL)

API-level: `bootstrap.sh`/`reviewer-smoke.sh` runs the full fail-closed +
OIDC-capability + IdP-discovery assertion set against `https://<domain>`.

Full governed journey in a real browser (invitation → OIDC sign-in →
sandbox mission → signed synthetic incident → recorded planning response →
immutable proposal → different approver → refresh):

1. Create reviewer users in the pool (script):
   `aws cognito-idp admin-create-user --user-pool-id <pool> --username judge1@example.com ...`
2. As the owner (first hosted-UI sign-in → set password), `POST
   /api/invitations {role:'operator'|'approver', email:...}` per reviewer;
   send the invitation secret out-of-band.
3. Drive the journey in the browser: hosted-UI sign-in lands the reviewer
   with the invited role; the Reviewer Demo flow is exercised through the
   UI (baseline → 24.6 kt incident → recorded planning response changes →
   immutable proposal → different-approver approval → refresh/replay).
4. Responsive acceptance at 320/390/1024/1440 widths during the live pass.

Claims discipline unchanged: synthetic evidence labeled SYNTHETIC; provider
rails honestly OFFLINE until real sandbox credentials are configured; no
claim of real money movement.

### Acceptance gate (honest)

Infrastructure correctness is contract-checked per PR
(`deploy/aws/test/contract-checks.mjs`, 28 assertions — the exact P0
classes), and persistence is proven across container rebuilds in CI.
**The live gate remains: an actual HTTPS deployment, first-owner login,
persistent ledger under redeploy, and the real browser workflow — executed
at founder-approved deploy time via the single command above.** CI booting
localhost is necessary, not sufficient, and is never claimed otherwise.

Claims discipline unchanged: synthetic evidence labeled SYNTHETIC; provider
rails honestly OFFLINE until real sandbox credentials are configured; no
claim of real money movement.

## Teardown

```bash
bash deploy/aws/teardown.sh --yes          # everything except the ledger volume
bash deploy/aws/teardown.sh --yes --purge-data   # also delete the ledger volume (irreversible)
```

Order: deploy role → stack (snapshot taken as a safety copy first) →
Cognito → secret (force) → ECR (unless `--keep-images`) → orphan volume.
Only the bootstrap-created GitHub OIDC provider is removed (tag-checked);
pre-existing providers are never touched.

## Bedrock (optional, non-blocking)

No model runtime is needed for the judge journey (typed policy planner). If
Agent C later needs Bedrock, the contract is a server-side adapter seam
behind the planner interface — decision authority never moves into a cloud
agent runtime. Blocked account access does not affect this deployment.
