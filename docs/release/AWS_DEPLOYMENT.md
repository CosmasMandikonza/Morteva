# AWS judge environment — architecture, costs, provisioning (issues #17/#19)

Companion to `deploy/README.md` (which stays the canonical runbook). This
document is the AWS-specific architecture decision, the REAL expected
monthly cost before anything is provisioned, the founder console steps, and
the resilience/acceptance mapping. Written 2026-11-10 by Agent E.

## Architecture decision (deliberately boring)

```
                          Route 53 / founder DNS (A record → Elastic IP)
                                        │
                    ┌───────────────────▼────────────────────┐
   :443/:80 only →  │  EC2 t3.micro (1 vCPU / 1 GB, x86_64)  │
   (SG ingress)     │  Amazon Linux 2023 + Docker/Compose    │
                    │  ┌──────────────┐  ┌────────────────┐  │
                    │  │ moterva-web  │  │  moterva-api   │  │
                    │  │ Caddy (TLS)  │──▶│ Node 24, prod  │  │
                    │  └──────────────┘  │ OIDC+reviewer  │  │
                    │                    │ demo routes    │  │
                    │                    └───────┬────────┘  │
                    │  encrypted EBS gp3 20 GB   ▼           │
                    │  /var/lib/moterva/ledger.sqlite (WAL)  │
                    │  + nightly verified backups            │
                    └────────────────────────────────────────┘
       CI (GitHub Actions): OIDC-federated role → pushes images to private ECR
       Secrets: AWS Secrets Manager (OIDC client secret) — never in git
       IdP: Amazon Cognito user pool (reviewer invitations, E2)
```

- **One EC2 instance, Docker Compose, the exact `deploy/` topology.** The
  SQLite ledger stays single-writer (one api container). No Kubernetes, no
  RDS, no microservices — nothing the product does not need.
- **t3.micro (1 GB) is sufficient** because images are BUILT IN CI and
  pulled from ECR; the host never runs `npm ci`/`npm run build` (that is
  the 1 GB+ step). Runtime footprint: one Node process (~120 MB), one
  Caddy (~30 MB), OS — comfortably inside 1 GB with swap as a safety net.
- **Caddy terminates TLS** for the founder's domain (Let's Encrypt over
  port 443; the API container stays container-private exactly as in
  `deploy/docker-compose.yml`). `MOTERVA_TRUST_PROXY=1` on the API.
- **Encrypted EBS** (gp3, SSE-KMS with the aws/ebs key): ledger home +
  backups directory. Nightly `backup-ledger.mjs` (verified copy) via
  systemd timer; weekly EBS snapshot for point-in-time recovery.
- **Security group**: ingress 443 + 80 (ACME HTTP-01) from 0.0.0.0/0; SSH
  only from the founder's IP or none (SSM Session Manager preferred — no
  open SSH at all). No other ingress. Egress: all (ACME, ECR pulls, Cognito
  discovery).
- **IAM, least privilege:**
  - EC2 instance role: `ECR pull` (2 repos), `SecretsManager GetSecretValue`
    on the ONE moterva secret, CloudWatch `PutMetricData` (namespace
    moterva only). Nothing else.
  - CI deploy role: GitHub OIDC federation (`token.actions.githubusercontent.com`)
    constrained to this repo + branch; policy allows ECR push on the two
    repos only. **Short-lived credentials only; no AWS keys ever in
    GitHub.**
- **Alarms**: CloudWatch alarm on StatusCheckFailed + memory/disk via the
  CloudWatch agent; an AWS Budget with a hard $10/month threshold and
  email alert at 50%/90%; the api's own `/healthz` polled by
  `uptime`-style external check of the founder's choice.

## Real expected monthly cost (us-east-1, on-demand, Nov 2026 prices)

| Item | Spec | Monthly |
|---|---|---|
| EC2 t3.micro | 24×7 | ≈ $7.60 |
| EBS gp3 | 20 GB | $1.60 |
| EBS snapshots | ~5 GB incremental/week | ≈ $0.25 |
| ECR | ~1 GB total images | $0.10 |
| Elastic IP | attached (free) | $0 |
| Cognito (Lite) | <50 MAU reviewers | $0 |
| CloudWatch | 1–2 alarms, capped logs | ≈ $0.20 |
| AWS Budgets | first budget | $0 |
| Data transfer out | <1 GB | ≈ $0.10 |
| **Total** | | **≈ $10/month** |

The $500 credits cover **years** at this footprint; the budget alarm is the
control that matters, not the credits. Billing alarms assume NOTHING about
credits (per assignment: do not assume credits prevent billing).

## Founder console steps (exact, non-secret)

1. **Domain**: point a DNS A record (e.g. `moterva-demo.<your-domain>`) at
   the instance's Elastic IP (created in step 2). A domain you control is
   REQUIRED for Let's Encrypt TLS.
2. **IaC**: deploy `deploy/aws/cloudformation.yaml` (next section) —
   creates VPC/subnet-free minimal stack: EC2 + instance role + SG + EBS +
   EIP. Or run the equivalent console clicks listed inside the template's
   header comment.
3. **Account defaults**: enable *default EBS encryption* (EC2 → Settings)
   and *default EBS snapshot encryption*.
4. **Secrets Manager**: create secret `moterva/production` with JSON keys
   `MOTERVA_OIDC_CLIENT_SECRET` (+ later provider credentials). Note the
   ARN — the instance role policy allows only this ARN.
5. **Cognito (the reviewer IdP, E2)**:
   - Create a user pool `moterva-reviewers` (Lite tier). App client
     `moterva-api` — confidential client, auth code flow with PKCE,
     redirect URI `https://<domain>/api/auth/oidc/callback`, scopes
     `openid profile email`, RS256.
   - Hosted UI domain `<something>.auth.<region>.amazoncognito.com`.
   - Create reviewers: one user per judge/reviewer (email + temp password),
     then `CreateGroup` `operators` / `approvers` per assignment needs. The
     app's role binding happens through MOTERVA invitations (below), not
     Cognito groups — Cognito is only identity; MOTERVA enforces roles.
6. **MOTERVA invitations (role provisioning)**: as the provisioned owner
   (first sign-in with the bootstrap steps in step 7), `POST
   /api/invitations {role: 'operator'|'approver', email: <reviewer-email>}`
   — send each reviewer their invitation secret OUT OF BAND (never in
   git/issues/chat). Reviewer accepts at `/api/auth/invitations/accept`,
   signs in via the Cognito hosted UI, and lands with exactly that role in
   exactly that tenant.
7. **First boot**: SSH-less — SSM Session Manager → run the user-data
   (already in the template) pulls the compose env from Secrets Manager and
   `docker compose up -d`. Set `MOTERVA_REVIEWER_DEMO=1` + the OIDC env +
   `MOTERVA_TRUST_PROXY=1` in `deploy/env/production.env` on the instance
   (from Secrets Manager), never in git.
8. **Budgets**: Billing → Budgets → template "Zero spend budget" is not
   right here; create Monthly cost budget $10, alerts at 50/90/100% to
   your email.

## Deployment flow (CI, no keys)

`.github/workflows/release-verify.yml` builds the two images per PR/SHA.
The new `deploy-aws.yml` workflow (added with this work) pushes the
release-SHA-tagged images to ECR using GitHub OIDC federation — role ARN
supplied as a repo VARIABLE (not secret; it grants nothing without the
trust policy), then SSM `SendCommand` (or a manual founder step) runs
`docker compose pull && up -d` on the instance. Rollback = redeploy the
previous SHA tag (compose file pins image tags by SHA).

## Resilience / acceptance mapping (E5)

| Requirement | Proof |
|---|---|
| Automatic restart | `restart: unless-stopped` + systemd docker; cloudwatch StatusCheckFailed alarm |
| SQLite persistence across replacement | ledger on encrypted EBS volume; compose volume; release-verify already proves container-replace persistence on CI |
| Backup AND restore | nightly verified backup script (CI-proven); restore procedure in deploy/README.md rehearsed pre-launch (founder step 7) |
| Secret isolation | only Secrets Manager; instance role scoped to one secret ARN; no secrets in env files in git |
| 401/403/404 correctness | release security suites (12 scenarios) run per PR |
| Dev routes denied in production | verify-production.mjs P2/P2b/P5–P7 (per PR) |
| No anonymous financial mutation | production mounts authenticated scope only with OIDC; S suites S1/S2 |
| Correct release SHA + rollback | /healthz gitSha assertion (CI-proven); compose pins image per SHA |
| Budget alarms | AWS Budget $10 + CloudWatch alarms (founder step 8) |
| External HTTPS browser tests | post-provision run of the reviewer E2E against the live URL (this repo's harness pointed at the domain) |

## Bedrock (optional, non-blocking)

No model runtime is required for the judge journey (the planner is typed
policy code). If Agent C later needs Bedrock, the contract is a server-side
model-adapter seam behind the planner interface — decision authority NEVER
moves into a cloud agent runtime. If account policy blocks Bedrock access,
deployment proceeds unchanged.
