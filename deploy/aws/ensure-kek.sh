#!/usr/bin/env bash
# MOTERVA_SOURCE_KEY_KEK provisioning — ONE-TIME, cryptographically secure
# (CTO review PR #62 comment 6808567133; consumes Agent C's custody contract
# from PR #64: exactly 32 bytes, 64-hex / 43-base64url / 44-base64 canonical
# encodings; production refuses to boot without a configured KEK).
#
# The KEK is generated and stored in the 44-character canonical base64 form
# (`openssl rand -base64 32`) — text-only handling, no binary pipelines.
#
# INVARIANTS (tested by deploy/aws/test/kek-provision.test.sh):
#   1. A KEK is generated ONLY when the secret carries none: 32 bytes from
#      the CSPRNG, stored as canonical 44-char base64.
#   2. An EXISTING KEK is never overwritten, rotated or re-sealed by tooling
#      — rotation is the operator's MOTERVA_SOURCE_KEY_KEK_PREVIOUS/_RETIRED
#      protocol (see C's source-key-custody.ts), deliberately NOT automated.
#      Reruns and --refresh-env leave it byte-identical.
#   3. A present-but-EMPTY KEK field REFUSES to proceed (another operator may
#      be mid-rotation; silent overwrite could destroy recoverability).
#   4. The VALUE is never printed, logged or written anywhere except the
#      Secrets Manager secret; terminal output carries only the non-secret
#      fingerprint (same formula as the app: sha256(base64url(key))[0:12]).
#
# Env: SECRET_NAME (default moterva/production), AWS_REGION, authenticated
# aws CLI + jq + openssl. Exit 0 = KEK present (created or retained).
set -euo pipefail

SECRET_NAME="${SECRET_NAME:-moterva/production}"
REGION="${AWS_REGION:-us-east-1}"

log() { printf '\033[1;36m[ensure-kek]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ensure-kek FAILED]\033[0m %s\n' "$*" >&2; exit 1; }

fetch_secret_json() {
  aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_NAME" \
    --query SecretString --output text 2>/dev/null || echo '{}'
}
put_secret_json() { # $1 = complete JSON to persist
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_NAME" \
    --secret-string "$1" >/dev/null
}

# Non-secret fingerprint, identical to the app's Kek.id: sha256 of the
# base64url-encoded key bytes (first 12 hex chars). Pure text transforms —
# base64 → base64url is a character substitution, no binary handling.
fingerprint_b64_kek() { # $1 = 44-char base64 KEK
  printf '%s' "$1" | tr '+/' '-_' | tr -d '=' \
    | openssl dgst -sha256 -hex | awk '{print substr($NF,1,12)}'
}

CURRENT="$(fetch_secret_json)"
echo "$CURRENT" | jq -e . >/dev/null 2>&1 || die "secret $SECRET_NAME is not valid JSON — refusing to touch it"

if echo "$CURRENT" | jq -e 'has("MOTERVA_SOURCE_KEY_KEK")' >/dev/null; then
  EXISTING="$(echo "$CURRENT" | jq -jr '.MOTERVA_SOURCE_KEY_KEK // ""')"
  if [ -z "$EXISTING" ]; then
    die "MOTERVA_SOURCE_KEY_KEK is present but EMPTY — another operator may be mid-rotation; resolve manually (never auto-overwritten)"
  fi
  if ! printf '%s' "$EXISTING" | grep -Eq '^[A-Za-z0-9+/]{43}=$|^[A-Za-z0-9_-]{43}$|^[0-9a-fA-F]{64}$'; then
    die "existing MOTERVA_SOURCE_KEY_KEK is not in a canonical 32-byte encoding this tool recognizes — refusing to touch it"
  fi
  log "existing MOTERVA_SOURCE_KEY_KEK retained (fingerprint $(fingerprint_b64_kek "$(printf '%s' "$EXISTING" | tr -d '\n')")) — tooling never rotates it"
  exit 0
fi

KEK="$(openssl rand -base64 32)"
printf '%s' "$KEK" | grep -Eq '^[A-Za-z0-9+/]{43}=$' || die "CSPRNG returned a non-canonical value — refusing to store"
# Degenerate-key guard mirrors the app parser (one repeated byte = refused):
# 32 identical bytes encode to a single repeated base64 character run.
if [ "$(printf '%s' "$KEK" | head -c 43 | tr -d "$(printf '%s' "${KEK:0:1}")" | wc -c)" -le 1 ]; then
  die "CSPRNG returned a degenerate (repeated-byte) key — refusing to store"
fi

MERGED="$(echo "$CURRENT" | jq --arg kek "$KEK" '. + {MOTERVA_SOURCE_KEY_KEK: $kek}')"
put_secret_json "$MERGED"
# Read-back verification: the persisted secret must contain EXACTLY the
# generated value (catches races with concurrent writers).
PERSISTED="$(fetch_secret_json | jq -jr '.MOTERVA_SOURCE_KEY_KEK // ""')"
[ "$PERSISTED" = "$KEK" ] || die "read-back mismatch — the stored KEK differs from the generated one; inspect the secret manually before rerunning"
log "MOTERVA_SOURCE_KEY_KEK provisioned (32 CSPRNG bytes, fingerprint $(fingerprint_b64_kek "$KEK")) — stored only in Secrets Manager:$SECRET_NAME; never printed, never rotated by tooling"
