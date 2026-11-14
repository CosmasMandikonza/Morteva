#!/usr/bin/env bash
# KEK provisioning tests (CTO PR#62 comment 6808567133) — positive AND
# negative, executed against the REAL scripts:
#   - deploy/aws/ensure-kek.sh runs unmodified against a STUBBED aws CLI
#     (file-backed secret store; put-call counter) — no AWS, no spending.
#   - bootstrap.sh's merge_secret is extracted verbatim (sed) and exercised
#     with the same stub, proving the OIDC/env merge can NEVER create,
#     rotate or drop custody keys.
#   - an INDEPENDENT node implementation verifies the fingerprint formula
#     matches the app's Kek.id (sha256(base64url(key))[0:12]).
# Exit 0 = all scenarios pass. Runs in CI (ubuntu) and Git Bash.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL $1 — $2"; }
assert() { # assert <name> <detail> <condition-exit>
  if [ "$3" -eq 0 ]; then ok "$1"; else bad "$1" "$2"; fi
}

# ---------------------------------------------------------------- stub aws
mkdir -p "$TMP/bin"
# jq shim ONLY when the host lacks jq (CI ubuntu / CloudShell have real jq;
# this Git Bash box does not). The scripts under test run unmodified either
# way — they just call `jq` from PATH.
if ! command -v jq >/dev/null 2>&1; then
  cat > "$TMP/bin/jq" <<SHIM
#!/usr/bin/env bash
exec node "$HERE/lib/jq-shim.mjs" "\$@"
SHIM
  chmod +x "$TMP/bin/jq"
fi
cat > "$TMP/bin/aws" <<'STUB'
#!/usr/bin/env bash
# Minimal secretsmanager stub: flag-order independent; file-backed store.
STORE="${FAKE_AWS_STORE:?}"
CALLS="${FAKE_AWS_CALLS:?}"
cmd="$1"; shift
op=""
case "$cmd" in
  secretsmanager) op="$1"; shift ;;
  *) exit 2 ;;
esac
PUT_VALUE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --secret-id|--region|--query|--output) shift 2 ;;
    --secret-string)
      if [ "$2" = "file:///dev/stdin" ]; then PUT_VALUE="$(cat)"; else PUT_VALUE="$2"; fi
      shift 2 ;;
    *) shift ;;
  esac
done
case "$op" in
  get-secret-value) cat "$STORE" ;;
  put-secret-value) printf '%s' "$PUT_VALUE" > "$STORE"; echo put >> "$CALLS" ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$TMP/bin/aws"
export PATH="$TMP/bin:$PATH"
# Windows-friendly store paths when present (node inside the jq shim cannot
# open MSYS /tmp paths; bash itself handles both forms).
STORE_PATH="$TMP/secret.json"
CALLS_PATH="$TMP/calls.log"
if command -v cygpath >/dev/null 2>&1; then
  STORE_PATH="$(cygpath -m "$STORE_PATH")"
  CALLS_PATH="$(cygpath -m "$CALLS_PATH")"
fi
export FAKE_AWS_STORE="$STORE_PATH"
export FAKE_AWS_CALLS="$CALLS_PATH"
export SECRET_NAME="moterva/production"
export AWS_REGION="us-east-1"

puts_count() { [ -f "$FAKE_AWS_CALLS" ] && wc -l < "$FAKE_AWS_CALLS" | tr -d ' ' || echo 0; }
kek_of_store() { jq -jr '.MOTERVA_SOURCE_KEY_KEK // ""' "$FAKE_AWS_STORE"; }

# Extract bootstrap's REAL merge_secret (verbatim) for the merge tests.
sed -n '/^merge_secret() {/,/^}/p' "$ROOT/deploy/aws/bootstrap.sh" > "$TMP/merge_secret.sh"
grep -q '^merge_secret() {' "$TMP/merge_secret.sh" || { echo "FATAL: merge_secret extraction failed"; exit 1; }

# Independent fingerprint implementation (node) for cross-checking — same
# formula as the app's Kek.id: sha256(base64url(key-bytes))[0:12]. Accepts
# any canonical 32-byte encoding; decodes like the app does.
node_fingerprint() { # $1 = KEK (44-base64 / 43-base64url / 64-hex)
  node -e '
    const {createHash} = require("node:crypto");
    const raw = process.argv[1];
    let bytes;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) bytes = Buffer.from(raw, "hex");
    else if (/^[A-Za-z0-9_-]{43}$/.test(raw)) bytes = Buffer.from(raw, "base64url");
    else bytes = Buffer.from(raw, "base64");
    const b64url = bytes.toString("base64url");
    process.stdout.write(createHash("sha256").update(b64url).digest("hex").slice(0, 12));
  ' "$1"
}

# ---------------------------------------------------------------- T1 create
echo '{}' > "$FAKE_AWS_STORE"; : > "$FAKE_AWS_CALLS"
OUT1="$(bash "$ROOT/deploy/aws/ensure-kek.sh" 2>&1)"; RC1=$?
assert "T1a ensure-kek succeeds on an empty secret" "rc=$RC1 out=$OUT1" $([ $RC1 -eq 0 ] && echo 0 || echo 1)
KEK1="$(kek_of_store)"
assert "T1b created KEK is canonical 44-char base64 (32 bytes)" "got len ${#KEK1}" \
  $(printf '%s' "$KEK1" | grep -Eq '^[A-Za-z0-9+/]{43}=$' && echo 0 || echo 1)
assert "T1c exactly one secret write happened" "puts=$(puts_count)" $([ "$(puts_count)" = "1" ] && echo 0 || echo 1)
assert "T1d output carries the non-secret fingerprint" "no 'fingerprint' in: $OUT1" \
  $(printf '%s' "$OUT1" | grep -q 'fingerprint' && echo 0 || echo 1)
assert "T1e output NEVER contains the KEK value" "leaked in: $OUT1" \
  $(printf '%s' "$OUT1" | grep -qF "$KEK1" && echo 1 || echo 0)
FP_LOG="$(printf '%s' "$OUT1" | grep -oE 'fingerprint [0-9a-f]{12}' | awk '{print $2}' | head -1)"
FP_NODE="$(node_fingerprint "$KEK1")"
assert "T1f fingerprint matches the app's Kek.id formula" "log=$FP_LOG node=$FP_NODE" \
  $([ -n "$FP_LOG" ] && [ "$FP_LOG" = "$FP_NODE" ] && echo 0 || echo 1)

# ---------------------------------------------------------------- T2 rerun
: > "$FAKE_AWS_CALLS"
OUT2="$(bash "$ROOT/deploy/aws/ensure-kek.sh" 2>&1)"; RC2=$?
assert "T2a rerun succeeds" "rc=$RC2 out=$OUT2" $([ $RC2 -eq 0 ] && echo 0 || echo 1)
assert "T2b rerun performs ZERO secret writes (never rotates)" "puts=$(puts_count)" \
  $([ "$(puts_count)" = "0" ] && echo 0 || echo 1)
assert "T2c KEK is byte-identical after rerun" "changed" $([ "$(kek_of_store)" = "$KEK1" ] && echo 0 || echo 1)
assert "T2d rerun output never contains the value" "leaked in: $OUT2" \
  $(printf '%s' "$OUT2" | grep -qF "$KEK1" && echo 1 || echo 0)

# ------------------------------------------------- T3 empty-but-present refuse
jq -n --arg k "" '{MOTERVA_SOURCE_KEY_KEK:$k}' > "$FAKE_AWS_STORE"
BEFORE="$(cat "$FAKE_AWS_STORE")"; : > "$FAKE_AWS_CALLS"
OUT3="$(bash "$ROOT/deploy/aws/ensure-kek.sh" 2>&1)"; RC3=$?
assert "T3a empty-but-present KEK REFUSES" "rc=$RC3" $([ $RC3 -ne 0 ] && echo 0 || echo 1)
assert "T3b refusal writes nothing" "puts=$(puts_count)" $([ "$(puts_count)" = "0" ] && echo 0 || echo 1)
assert "T3c secret unchanged by the refusal" "differs" $([ "$(cat "$FAKE_AWS_STORE")" = "$BEFORE" ] && echo 0 || echo 1)

# --------------------------------------------------- T4 foreign-format refuse
jq -n '{MOTERVA_SOURCE_KEY_KEK:"not-hex-at-all"}' > "$FAKE_AWS_STORE"
: > "$FAKE_AWS_CALLS"
bash "$ROOT/deploy/aws/ensure-kek.sh" >/dev/null 2>&1; RC4=$?
assert "T4 non-64hex existing KEK REFUSES (foreign custody untouched)" "rc=$RC4" \
  $([ $RC4 -ne 0 ] && [ "$(puts_count)" = "0" ] && echo 0 || echo 1)

# ------------------------------------- T5 merge_secret can never touch custody
jq -n --arg k "$KEK1" --arg prev "operator-rotation-value" \
  '{MOTERVA_SOURCE_KEY_KEK:$k, MOTERVA_SOURCE_KEY_KEK_PREVIOUS:$prev, WEB_ORIGIN:"https://old.example"}' > "$FAKE_AWS_STORE"
: > "$FAKE_AWS_CALLS"
# shellcheck disable=SC1090
( source "$TMP/merge_secret.sh"
  SECRET_NAME="$SECRET_NAME"; REGION="$AWS_REGION"; DOMAIN="judge.example.com"
  merge_secret "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_X" "client-1" "oidc-secret-value" )
assert "T5a merge_secret keeps the KEK byte-identical" "changed" $([ "$(kek_of_store)" = "$KEK1" ] && echo 0 || echo 1)
assert "T5b merge_secret keeps operator rotation state (PREVIOUS)" "dropped" \
  $(jq -e '.MOTERVA_SOURCE_KEY_KEK_PREVIOUS == "operator-rotation-value"' "$FAKE_AWS_STORE" >/dev/null && echo 0 || echo 1)
assert "T5c merge_secret still updates the env fields it owns" "WEB_ORIGIN not refreshed" \
  $(jq -e '.WEB_ORIGIN == "https://judge.example.com"' "$FAKE_AWS_STORE" >/dev/null && echo 0 || echo 1)
assert "T5d merged secret never leaks into this test output" "" \
  $(jq -e '.MOTERVA_OIDC_CLIENT_SECRET == "oidc-secret-value"' "$FAKE_AWS_STORE" >/dev/null && echo 0 || echo 1)

# ------------------------------------------------------------- T6 malformed store
echo 'not-json' > "$FAKE_AWS_STORE"
bash "$ROOT/deploy/aws/ensure-kek.sh" >/dev/null 2>&1; RC6=$?
assert "T6 non-JSON secret REFUSES (never guesses)" "rc=$RC6" $([ $RC6 -ne 0 ] && echo 0 || echo 1)

echo
echo "kek-provision: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
