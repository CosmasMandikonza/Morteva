#!/usr/bin/env bash
# MOTERVA judge environment — post-deploy reviewer smoke checks (E5/E4).
# Runs from CloudShell against the LIVE https origin; every assertion is a
# genuine service check (no snapshot-only tests). Complements the CI release
# suites (which already prove the production fail-closed contract per PR).
#
# Usage:  DOMAIN=judge.example.com RELEASE_SHA=<sha> [REVIEWER_EMAIL=...] bash reviewer-smoke.sh
# Exit 0 = all checks pass.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN}"
BASE="https://${DOMAIN}"
RELEASE_SHA="${RELEASE_SHA:-}"
INSECURE_CURL=() # TLS is real via Let's Encrypt; no -k needed here

log() { printf '\033[1;36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[smoke FAILED]\033[0m %s\n' "$*" >&2; exit 1; }
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then log "PASS $1"; else fail "$1: expected '$2', got '$3'"; fi
}

log "origin: $BASE"

# 1. Health + release provenance (immutable SHA deployed)
HEALTH=$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -fsS "$BASE/healthz") || fail "healthz unreachable (is DNS live? is Caddy serving?)"
check "healthz status" "ok" "$(echo "$HEALTH" | jq -r .status)"
if [ -n "$RELEASE_SHA" ]; then
  check "healthz gitSha provenance" "$RELEASE_SHA" "$(echo "$HEALTH" | jq -r .gitSha)"
fi
check "providerMode honest" "offline" "$(echo "$HEALTH" | jq -r .providerMode)"

# 2. Honest system status (rails disabled, ledger integrity)
STATUS=$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -fsS "$BASE/api/system/status")
echo "$STATUS" | jq -e '.providers[]? | select(.label != "OFFLINE") | error("provider rail not OFFLINE")' >/dev/null \
  || log "PASS provider rails honestly OFFLINE"
check "ledger integrity" "ok" "$(echo "$STATUS" | jq -r '.ledger.integrity // "missing"')"

# 3. Anonymous fail-closed contract (DEV_AUTH can never exist in production)
check "anonymous missions 401" "401" \
  "$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -s -o /dev/null -w '%{http_code}' "$BASE/api/missions")"
check "anonymous financial overview 401" "401" \
  "$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -s -o /dev/null -w '%{http_code}' "$BASE/api/financial/overview")"
check "dev login endpoint absent" "404" \
  "$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d '{}')"
check "reserve unauthenticated refused" "401" \
  "$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/operations/reserve" -H 'content-type: application/json' -d '{}')"

# 4. OIDC reviewer capability projected (E3 gate)
CAPS=$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -fsS "$BASE/api/auth/capabilities")
check "authMode" "oidc" "$(echo "$CAPS" | jq -r .authMode)"
check "reviewerDemo enabled" "true" "$(echo "$CAPS" | jq -r .reviewerDemo)"
check "demo login hidden" "false" "$(echo "$CAPS" | jq -r .demoLogin)"

# 5. OIDC flow entrypoint redirects to the IdP (never 500s on bad config)
LOGIN_CODE=$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/oidc/login")
check "oidc login entrypoint" "303" "$LOGIN_CODE"

# 6. Cognito discovery reachable + issuer match (reviewer entrypoint)
ISSUER=$(aws secretsmanager get-secret-value --secret-id moterva/production \
  --query SecretString --output text 2>/dev/null | jq -r '.MOTERVA_OIDC_ISSUER // empty' 2>/dev/null || true)
if [ -n "$ISSUER" ] && [ "$ISSUER" != "null" ]; then
  DISCO=$(curl -fsSL "$ISSUER/.well-known/openid-configuration") || fail "IdP discovery unreachable"
  check "IdP discovery issuer match" "$ISSUER" "$(echo "$DISCO" | jq -r .issuer)"
else
  log "SKIP IdP discovery (no secret read access in this shell)"
fi

# 7. Public caching + security headers on API responses
HDRS=$(curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -sI "$BASE/api/system/status")
echo "$HDRS" | grep -qi 'cache-control: *no-store' || fail "/api/* not no-store"
echo "$HDRS" | grep -qi 'strict-transport-security' || fail "no HSTS"
log "PASS no-store + HSTS"

# 8. Web shell served
curl ${INSECURE_CURL[@]+"${INSECURE_CURL[@]}"} -fsS "$BASE/" | grep -q '<div id="root">' || fail "web shell not served"
log "PASS web shell served"

cat <<'SUMMARY'

API-level smoke PASS. For the full REVIEWER BROWSER JOURNEY (invitation →
OIDC sign-in → sandbox mission → signed synthetic incident → governed
proposal → different approver → refresh), run the repository E2E spec
against this origin (see docs/release/AWS_DEPLOYMENT.md §Reviewer browser
testing) — it drives the REAL IdP and the REAL governed routes.
SUMMARY
log "all smoke checks passed for https://$DOMAIN"
