#!/usr/bin/env bash
# MOTERVA first-owner identity binding — auditable, one-shot, server-side (P0-4).
#
# The production identity layer deliberately has NO public self-provisioning:
# an authenticated OIDC identity that is not linked to a tenant actor is
# refused (IDENTITY_NOT_LINKED). The FIRST owner therefore cannot appear by
# merely logging in — a trusted operator binds issuer+subject to a fresh
# organization/owner actor exactly once, ON THE INSTANCE over SSM (never an
# anonymous HTTP endpoint).
#
# Safety properties (all enforced by ledger.identity.provisionIdentityActor
# itself — this script adds no policy of its own):
#   - one-shot/immutability: the same subject binds once; a DIFFERENT
#     subject bound to the same actor, or a subject bound to another actor,
#     is refused (IDENTITY_CONFLICT / AUTH_USERNAME_TAKEN);
#   - auditability: the ledger journals `actor.created` and
#     `identity.provisioned` evidence events (subject stored hashed);
#   - role: owner only (the service refuses non-owner/admin provisioning);
#   - the Cognito `sub` is resolved from the user pool server-side — never
#     accepted from browser input; no secrets transit this script.
#
# Run ON the judge instance (bootstrap calls it via SSM after first deploy):
#   ISSUER=https://cognito-idp... OWNER_EMAIL=... bash link-owner.sh
set -euo pipefail

ISSUER="${ISSUER:?set ISSUER (OIDC issuer URL)}"
OWNER_EMAIL="${OWNER_EMAIL:?set OWNER_EMAIL}"

log() { printf '\033[1;36m[link-owner]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[link-owner FAILED]\033[0m %s\n' "$*" >&2; exit 1; }

# Resolve the pool id from the issuer (https://cognito-idp.<region>.amazonaws.com/<poolId>)
POOL_ID="${ISSUER##*/}"
[[ "$POOL_ID" =~ ^us(-gov)?-[^-]+-[0-9]+_[A-Za-z0-9]+$ ]] || die "issuer does not look like a Cognito issuer: $ISSUER"

SUB=$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" \
  --username "$OWNER_EMAIL" \
  --query 'UserAttributes[?Name==`sub`].Value' --output text)
[ -n "$SUB" ] && [ "$SUB" != "None" ] || die "cannot resolve Cognito sub for $OWNER_EMAIL"
log "resolved Cognito sub (${SUB:0:8}…) server-side — binding via the ledger provisioning seam"

cd /opt/moterva
# Runs INSIDE the api container (same image + ledger path; single writer).
# ONE-SHOT GUARD (this script's own policy, applied before the ledger seam):
# the ledger seam alone would link a SECOND subject to the same username —
# unacceptable for the initial owner. The guard enforces:
#   already-bound (same provider+subject) → exit 0, no changes;
#   any OTHER live subject bound to this username → REFUSE;
#   username exists without a link (ambiguous pre-state) → REFUSE;
#   fresh state → provision (creates the fresh organization once).
RESULT=$(docker compose -f compose.production.yml exec -T \
  -e LINK_EMAIL="$OWNER_EMAIL" -e LINK_ISSUER="$ISSUER" -e LINK_SUB="$SUB" \
  api node --input-type=module -e "
import { openLedger } from '@moterva/ledger';
const ledger = openLedger(process.env.MOTERVA_LEDGER_PATH);
const username = process.env.LINK_EMAIL;
const provider = process.env.LINK_ISSUER;
const subject = process.env.LINK_SUB;
const rows = ledger.db.prepare(
  'SELECT a.id AS actor_id, a.org_id, l.subject AS linked_subject FROM actors a ' +
  'LEFT JOIN identity_links l ON l.actor_id = a.id AND l.revoked_at IS NULL ' +
  'WHERE a.username = ?'
).all(username);
const boundToSubject = rows.find((r) => r.linked_subject === subject);
if (boundToSubject !== undefined) {
  console.log(JSON.stringify({ outcome: 'already-bound', orgId: boundToSubject.org_id, actorId: boundToSubject.actor_id }));
  process.exit(0);
}
const otherSubject = rows.find((r) => r.linked_subject !== null && r.linked_subject !== undefined);
if (otherSubject !== undefined || rows.some((r) => r.linked_subject === null)) {
  console.error('REFUSED_ONE_SHOT: username \"' + username + '\" already exists with a different or absent identity binding — the initial owner binding is one-shot; rotate owners via in-app invitations instead');
  process.exit(3);
}
const provisioned = ledger.identity.provisionIdentityActor({
  orgTitle: 'MOTERVA',
  username,
  displayName: 'Owner',
  role: 'owner',
  provider,
  subject,
  emailAtLink: username,
  provisioningNote: 'AWS judge bootstrap: one-shot owner binding via SSM (deploy/aws/link-owner.sh)',
});
console.log(JSON.stringify({
  outcome: 'linked',
  orgId: provisioned.orgId,
  actorId: provisioned.actor.id,
  role: provisioned.actor.role,
}));
")
echo "$RESULT" | grep -q '"outcome"' || die "binding refused:
$RESULT"
log "$RESULT"
log "first login: sign in via the Cognito hosted UI as $OWNER_EMAIL — the session lands as org OWNER (no development authentication exists in this deployment)."
log "onboard reviewers INSIDE the app: owner → POST /api/invitations {role: operator|approver} → send the invitation secret out-of-band → reviewer accepts at /api/auth/invitations/accept and signs in via the hosted UI."
