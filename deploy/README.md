# MOTERVA deployment — staging/production packaging (issue #19)

Single-host, two-container topology. Deliberately **no** Kubernetes, no
microservices, no managed-database dependency: the product is one Fastify API
process + one static web shell + SQLite. The simplest architecture that runs
the real product safely is the right one for a hackathon staging deploy.

## Architecture

```
            Internet
               │  :80/:443 (the ONLY published ports)
        ┌──────┴───────┐
        │  moterva-web │  Caddy 2 (automatic TLS)
        │              │  ├─ serves apps/web/dist (static shell, SPA fallback)
        │              │  ├─ /api/*      → reverse_proxy api:8787 (no-store)
        │              │  └─ /healthz    → reverse_proxy api:8787
        └──────┬───────┘
   compose-internal network only
        ┌──────┴───────┐
        │  moterva-api │  Node 24, Fastify, NODE_ENV=production
        │  (non-root)  │  public surface: GET /healthz, GET /api/system/status
        │              │  authenticated/financial routes DO NOT EXIST here
        └──────┬───────┘
         named volume: moterva-ledger → /var/lib/moterva/ledger.sqlite (WAL)
```

### Why the hosted surface is read-only by construction

The full mission-to-money journey (login, missions, mandates, decisions,
reservations, financial reads) is registered **only** under the development
`DEMO_AUTH` gate, and `apps/api/src/config.ts` structurally refuses
`MOTERVA_DEV_AUTH=1` unless `NODE_ENV≠production` **and** HOST **and**
WEB_ORIGIN are all loopback. This deployment runs `NODE_ENV=production`, so:

- There is no login endpoint, no session, no mutation route to attack.
- The hosted app shows the web shell plus honest system status (providers
  OFFLINE pending #5 credentials; ledger integrity).
- Reviewer access to the FULL journey runs locally via the loopback demo
  (`docs/release/REVIEWER_ACCESS.md`) — the same gates protect it there.

When a real reviewer authentication surface lands (Agent A), the same
containers serve it: only `WEB_ORIGIN`/domain change.

## Prerequisites

- A Linux host with Docker Engine + compose plugin (any small VPS works;
  1 vCPU / 1 GB RAM is sufficient — measured idle footprint is one Node
  process + one Caddy process + a SQLite file).
- DNS A/AAAA record for `MOTERVA_DOMAIN` pointing at the host (production
  TLS). For staging, `MOTERVA_DOMAIN=localhost` uses Caddy's internal CA.

## Deploy procedure (reproducible, immutable SHA)

```bash
git clone https://github.com/CosmasMandikonza/Morteva moterva
cd moterva
git checkout <release-sha>                    # the EXACT reviewed commit
cp deploy/env/production.env.example deploy/env/production.env
#   fill MOTERVA_RELEASE_SHA=<release-sha>, MOTERVA_PUBLIC_ORIGIN,
#   MOTERVA_DOMAIN, ACME_EMAIL
docker compose --env-file deploy/env/production.env up -d --build
```

Verify (these assertions also run automatically in CI —
`.github/workflows/release-verify.yml`):

```bash
curl -fsS https://<domain>/healthz          # status ok, gitSha == release-sha
curl -fsS https://<domain>/api/system/status # rails honest (OFFLINE), ledger ok
curl -s  -o /dev/null -w '%{http_code}\n' https://<domain>/api/missions
#   → 404  (fail closed: no authenticated routes exist in production)
curl -sI https://<domain>/api/system/status | grep -i cache-control
#   → no-store (authenticated-shape responses are never publicly cacheable)
```

## Persistence, backup, restore

- The ledger lives on the `moterva-ledger` named volume — never ephemeral,
  never inside the image. Single-writer by construction (exactly one api
  container; do not scale it — SQLite is not a multi-writer database).
- Online backup (consistent even while the API serves; verifies the copy):

  ```bash
  docker compose exec api node deploy/scripts/backup-ledger.mjs \
    --ledger /var/lib/moterva/ledger.sqlite --out /var/lib/moterva/backups
  ```

  Cron it (e.g. hourly) and copy files off-host (object storage or scp).

- Restore / rollback of DATA:

  ```bash
  docker compose stop api
  docker compose run --rm -v moterva-ledger:/var/lib/moterva api \
    node -e "const fs=require('fs');fs.copyFileSync('/var/lib/moterva/backups/ledger-<stamp>.sqlite','/var/lib/moterva/ledger.sqlite')"
  docker compose start api   # boot runs migrations + integrity verification;
                             # a bad ledger refuses to start (fail closed)
  ```

- Migration policy: startup runs transactional forward-only migrations and
  verifies integrity BEFORE listening; a newer-schema/downgraded binary
  refuses to boot rather than guessing.

## Release rollback

```bash
git checkout <previous-good-sha>
# export MOTERVA_RELEASE_SHA=<previous-good-sha> in production.env
docker compose --env-file deploy/env/production.env up -d --build
```

Containers are stateless; the ledger volume is untouched by redeploys. The
API refuses to start against a ledger written by a NEWER schema, which makes
rollback safe (it fails loudly instead of corrupting).

## Hardening already in the kit

- api: non-root `node` user, `read_only` rootfs, `cap_drop: ALL`,
  `no-new-privileges`, only the ledger volume writable, tmpfs /tmp.
- web (Caddy): `cap_drop: ALL` + only `NET_BIND_SERVICE`, security headers
  (HSTS, nosniff, DENY framing, no-referrer, permissions-policy), no `Server`
  header, `Cache-Control: no-store` on /api/*.
- No secrets in the compose file or image (none exist to include today —
  provider credentials are absent until #5 is credentialed, and then belong
  in the platform's secret store, injected as runtime env).

## Bare-metal alternative

`deploy/moterva-api.service` is an equivalent hardened systemd unit
(ProtectSystem=strict, CapabilityBoundingSet empty, StateDirectory for the
ledger) for hosts where Docker is unavailable; Caddy can run as a host
service with the same `deploy/web/Caddyfile` (replace `api:8787` with
`127.0.0.1:8787`).

## Cost posture (indicative, not a claim)

One small VPS (≈US$5–6/month class) + Docker covers staging and demo load.
AWS is NOT required: nothing here uses cloud-proprietary services; the kit
runs on any provider. If an AWS sponsor credit materializes, the same compose
file runs unchanged on an EC2 instance (see docs/release notes).
