#!/usr/bin/env bash
# MOTERVA reviewer authentication — idempotent Cognito provisioning (E2).
# Called BY deploy/aws/bootstrap.sh; can also be rerun standalone (every
# step checks before creating; existing resources are REUSED, never rebuilt).
#
# What it creates (one user pool, nothing else):
#   - user pool moterva-reviewers (RS256, email-verified-required flow)
#   - hosted-UI domain moterva-judge-<random>
#   - confidential app client moterva-api (authorization code + PKCE,
#     secret generated here and stored INTO Secrets Manager — never printed
#     in full, never committed)
#   - the pool owner user (temporary password printed ONCE; forced change at
#     first hosted-UI sign-in)
#
# Env/args:  AWS_REGION (default us-east-1)
#            DOMAIN (judge public hostname, e.g. moterva.example.com)
#            SECRET_NAME (default moterva/production)
#            OWNER_EMAIL (default $EMAIL)
# Outputs (also written to $OUTPUTS_FILE when set): pool id, issuer,
#   client id, hosted-UI base URL, owner temp password (once).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DOMAIN="${DOMAIN:?set DOMAIN}"
SECRET_NAME="${SECRET_NAME:-moterva/production}"
OWNER_EMAIL="${OWNER_EMAIL:-${EMAIL:?set EMAIL}}"
POOL_NAME="moterva-reviewers"
CLIENT_NAME="moterva-api"
OUTPUTS_FILE="${OUTPUTS_FILE:-}"

POOLID=$(aws cognito-idp list-user-pools --region "$REGION" --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id" --output text 2>/dev/null | head -n1 || true)

if [ -z "$POOLID" ] || [ "$POOLID" = "None" ]; then
  echo "[cognito] creating user pool $POOL_NAME"
  POOLID=$(aws cognito-idp create-user-pool --region "$REGION" \
    --pool-name "$POOL_NAME" \
    --policies "PasswordPolicy={MinimumLength=14,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=true,TemporaryPasswordValidityDays=7}" \
    --auto-verified-attributes email \
    --mfa-configuration OFF \
    --account-recovery-setting "RecoveryMechanisms=[{Priority=1,Name=verified_email}]" \
    --admin-create-user-config "AllowAdminCreateUserOnly=true" \
    --query 'UserPool.Id' --output text)
else
  echo "[cognito] reusing pool $POOLID"
fi

ISSUER="https://cognito-idp.${REGION}.amazonaws.com/${POOLID}"
POOL_DOMAIN_PREFIX=$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOLID" \
  --query 'UserPool.Domain' --output text 2>/dev/null || true)
if [ -z "$POOL_DOMAIN_PREFIX" ] || [ "$POOL_DOMAIN_PREFIX" = "None" ]; then
  POOL_DOMAIN_PREFIX="moterva-judge-$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 8)"
  aws cognito-idp create-user-pool-domain --region "$REGION" \
    --user-pool-id "$POOLID" --domain "$POOL_DOMAIN_PREFIX" >/dev/null
  echo "[cognito] hosted-UI domain created: $POOL_DOMAIN_PREFIX"
fi
HOSTED_UI="https://${POOL_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"

CLIENTID=$(aws cognito-idp list-user-pool-clients --region "$REGION" --user-pool-id "$POOLID" --max-results 60 \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId" --output text 2>/dev/null | head -n1 || true)
CALLBACK="https://${DOMAIN}/api/auth/oidc/callback"

if [ -z "$CLIENTID" ] || [ "$CLIENTID" = "None" ]; then
  echo "[cognito] creating confidential app client $CLIENT_NAME (callback $CALLBACK)"
  CLIENTJSON=$(aws cognito-idp create-user-pool-client --region "$REGION" \
    --user-pool-id "$POOLID" \
    --client-name "$CLIENT_NAME" \
    --generate-secret \
    --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-flows "code" \
    --allowed-o-auth-scopes "openid" "profile" "email" \
    --callback-urls "$CALLBACK" \
    --logout-urls "https://${DOMAIN}/" \
    --supported-identity-providers "COGNITO" \
    --explicit-auth-flows "ALLOW_USER_SRP_AUTH" \
    --prevent-user-existence-errors ENABLED \
    --refresh-token-validity 1 --access-token-validity 60 --id-token-validity 60 \
    --token-validity-units "AccessToken=minutes,IdToken=minutes,RefreshToken=days" \
    --output json)
else
  echo "[cognito] reusing client $CLIENTID"
  # Callback URL may have changed (new DOMAIN): update it on rerun.
  aws cognito-idp update-user-pool-client --region "$REGION" \
    --user-pool-id "$POOLID" --client-id "$CLIENTID" \
    --generate-secret \
    --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-flows "code" \
    --allowed-o-auth-scopes "openid" "profile" "email" \
    --callback-urls "$CALLBACK" \
    --logout-urls "https://${DOMAIN}/" \
    --supported-identity-providers "COGNITO" \
    --explicit-auth-flows "ALLOW_USER_SRP_AUTH" \
    --prevent-user-existence-errors ENABLED \
    --refresh-token-validity 1 --access-token-validity 60 --id-token-validity 60 \
    --token-validity-units "AccessToken=minutes,IdToken=minutes,RefreshToken=days" >/dev/null
  CLIENTJSON=$(aws cognito-idp describe-user-pool-client --region "$REGION" \
    --user-pool-id "$POOLID" --client-id "$CLIENTID" --output json)
fi

CLIENTID=$(echo "$CLIENTJSON" | jq -r '.UserPoolClient.ClientId')
CLIENTSECRET=$(echo "$CLIENTJSON" | jq -r '.UserPoolClient.ClientSecret')
[ -n "$CLIENTSECRET" ] && [ "$CLIENTSECRET" != "null" ] || { echo "no client secret returned"; exit 1; }

# The client secret goes straight into Secrets Manager (bootstrap merges the
# JSON); the terminal shows only a fingerprint, never the value.
SECRET_FP=$(printf '%s' "$CLIENTSECRET" | sha256sum | cut -c1-12)
echo "[cognito] client secret captured (sha256 prefix $SECRET_FP) — stored in $SECRET_NAME"

# Pool owner: temporary password generated here, printed ONCE (Cognito
# forces a change at first hosted-UI sign-in).
OWNER_TEMP=$(head -c 64 /dev/urandom | base64 | tr -d '/+=' | head -c 20)'!Aa1'
if ! aws cognito-idp admin-get-user --region "$REGION" --user-pool-id "$POOLID" \
     --username "$OWNER_EMAIL" >/dev/null 2>&1; then
  aws cognito-idp admin-create-user --region "$REGION" \
    --user-pool-id "$POOLID" --username "$OWNER_EMAIL" \
    --user-attributes Name=email,Value="$OWNER_EMAIL" Name=email_verified,Value=true \
    --temporary-password "$OWNER_TEMP" \
    --message-action SUPPRESS >/dev/null
  echo "[cognito] OWNER created: $OWNER_EMAIL  temp password (printed ONCE, change at first sign-in): $OWNER_TEMP"
else
  echo "[cognito] owner $OWNER_EMAIL already exists (temp password NOT regenerated)"
fi

if [ -n "$OUTPUTS_FILE" ]; then
  jq -n --arg poolid "$POOLID" --arg issuer "$ISSUER" --arg clientid "$CLIENTID" \
        --arg hosted "$HOSTED_UI" \
        '{cognitoPoolId:$poolid, cognitoIssuer:$issuer, cognitoClientId:$clientid, cognitoHostedUi:$hosted}' \
        >> "$OUTPUTS_FILE"
fi
echo "[cognito] OK  pool=$POOLID issuer=$ISSUER client=$CLIENTID hosted=$HOSTED_UI"
