# AWS judge environment — automated provisioning & operations (issues #17/#19)

One instance, Docker Compose, Caddy TLS, SQLite on encrypted EBS, Cognito
reviewer authentication — provisioned end-to-end by scripts, deployed from
immutable release SHAs by GitHub Actions over OIDC. Written/updated
2026-11-11 by Agent E. Architecture rationale is unchanged from the Nov 10
version (still: no Kubernetes/RDS/microservices; single SQLite writer).

## The ONE command (founder, in CloudShell, us-east-1)

```bash
curl -fsSL \
  https://raw.githubusercontent.com/CosmasMandikonza/Morteva/<ACCEPTED_SHA>/deploy/aws/bootstrap.sh \
  | bash -s -- --domain judge.your-domain.com --email you@your-domain.com
```

This single command, idempotently:

1. Verifies CloudShell auth + region, resolves the default VPC/subnet
   (`vpc-000ecd971da3b24ba`).
2. Creates the Secrets Manager secret `moterva/production`.
3. Provisions **Cognito** (`provision-cognito.sh`): user pool, hosted-UI
   domain, confidential app client (code + PKCE), owner user — client
   secret stored straight into the secret (never printed in full, never
   committed).
4. Deploys the CloudFormation stack (`cloudformation.yaml`): t3.micro,
   SSM-managed (no SSH), encrypted dedicated ledger EBS, EIP, immutable-tag
   ECR repos, **$12/month budget alarm** + status-check alarm, health-signaled
   creation. **This step is the founder's approval to spend** (~$10/month
   steady state).
5. Writes the production compose (`compose.production.yml`) + env to the
   instance over SSM (no SSH keys anywhere).
6. Creates the **GitHub OIDC deploy role** (short-lived credentials only;
   chain thumbprints computed live; ECR-push-on-two-repos + SSM-on-one-
   instance permissions, explicit Deny on iam/secrets/s3/terminate).
7. Waits for the Deploy-AWS workflow images (or you rerun with
   `--wait-images 15` after triggering it), runs `update.sh`, then executes
   the **reviewer smoke checks** (`reviewer-smoke.sh`) against the live URL.

Flags: `--release-sha <sha>` (wait for a specific SHA), `--ref <branch>`
(script provenance, default integration branch), `--refresh-env`
(re-push secret values into the running stack), `--skip-stack`.

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
| Instance failure | status-check alarm → SNS email; relaunch = re-run `terraform`-free: stack update recreates instance; ledger volume reattaches |
| SQLite durability | dedicated encrypted gp3 volume (nofail mount), WAL; nightly backup: `docker compose exec api node deploy/scripts/backup-ledger.mjs` (verified copy) — schedule via `crontab` on the instance or run before demo |
| Restore | documented procedure in `deploy/README.md` §restore; rehearse pre-launch |
| Deploy-time health | `update.sh` polls loopback healthz before declaring success; workflow fails visibly otherwise |
| Spend | Budget $12 (80% actual + 100% forecast alerts); steady state ≈ $10 (t3.micro 7.60 + 20 GB gp3 1.60 + ECR/alarms/transfer ≈ 0.5) |
| Secrets | Secrets Manager only; instance role reads exactly one ARN; nothing in git, AMI, or user-data |

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
3. Point the repo's E2E harness at the live origin (the identity spec's
   server seam is a local fixture; for live runs drive the same steps via
   the browser: hosted-UI sign-in lands the reviewer with the invited role,
   then the Reviewer Demo flow is exercised through the UI).

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
