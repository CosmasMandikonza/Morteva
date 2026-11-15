#!/usr/bin/env bash
# Executes the REAL Cognito provisioning helper against a mocked AWS CLI.
# No network, credentials, AWS writes, or billable resources are involved.
set -euo pipefail

AWS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_FIXTURE_DIR="$(mktemp -d)"
trap 'rm -r -- "$AWS_FIXTURE_DIR"' EXIT

export AWS_FIXTURE_DIR AWS_REGION=us-east-1 DOMAIN=moterva.duckdns.org
export EMAIL=fixture@example.invalid SECRET_NAME=moterva/test
export AWS_FAKE_SECRET='fixture-only-value'

aws() {
  local operation="$1:$2"
  shift 2
  case "$operation" in
    cognito-idp:list-user-pools) printf '%s\n' 'us-east-1_fixture' ;;
    cognito-idp:describe-user-pool) printf '%s\n' 'existing-pool-domain' ;;
    cognito-idp:list-user-pool-clients) printf '%s\n' 'existingclientid' ;;
    cognito-idp:describe-user-pool-client)
      if [ "$AWS_FIXTURE_CASE" = current ] || [ -f "$AWS_FIXTURE_DIR/updated" ]; then
        jq -n --arg callback "https://${DOMAIN}/api/auth/oidc/callback" \
          --arg logout "https://${DOMAIN}/" --arg secret "$AWS_FAKE_SECRET" \
          '{UserPoolClient:{ClientId:"existingclientid",ClientSecret:$secret,CallbackURLs:[$callback],LogoutURLs:[$logout]}}'
      else
        jq -n --arg secret "$AWS_FAKE_SECRET" \
          '{UserPoolClient:{ClientId:"existingclientid",ClientSecret:$secret,CallbackURLs:["https://previous.example.invalid/api/auth/oidc/callback"],LogoutURLs:["https://previous.example.invalid/"]}}'
      fi
      ;;
    cognito-idp:update-user-pool-client)
      for arg in "$@"; do
        [ "$arg" != --generate-secret ] || { echo 'INVALID: update-user-pool-client cannot --generate-secret' >&2; return 2; }
      done
      touch "$AWS_FIXTURE_DIR/updated"
      ;;
    cognito-idp:admin-get-user) return 0 ;;
    *) echo "unexpected Cognito API invocation: $operation" >&2; return 2 ;;
  esac
}
export -f aws

export AWS_FIXTURE_CASE=current
CURRENT_OUTPUT="$(bash "$AWS_SCRIPT_DIR/provision-cognito.sh")"
[[ "$CURRENT_OUTPUT" == *'callback and logout URLs already current'* ]] || { echo 'FAIL: existing matching client should be left untouched'; exit 1; }
[ ! -f "$AWS_FIXTURE_DIR/updated" ] || { echo 'FAIL: existing matching client was mutated'; exit 1; }
[[ "$CURRENT_OUTPUT" != *"$AWS_FAKE_SECRET"* ]] || { echo 'FAIL: client secret exposed to stdout'; exit 1; }
echo 'PASS COGNITO-R1 existing client reused without update or secret disclosure'

export AWS_FIXTURE_CASE=stale
STALE_OUTPUT="$(bash "$AWS_SCRIPT_DIR/provision-cognito.sh")"
[ -f "$AWS_FIXTURE_DIR/updated" ] || { echo 'FAIL: stale client URLs not reconciled'; exit 1; }
[[ "$STALE_OUTPUT" != *"$AWS_FAKE_SECRET"* ]] || { echo 'FAIL: client secret exposed to stdout'; exit 1; }
[[ "$STALE_OUTPUT" == *'owner fixture@example.invalid already exists'* ]] || { echo 'FAIL: existing owner was not preserved'; exit 1; }
echo 'PASS COGNITO-R2 stale client URL updated with a supported API and owner preserved'
