#!/usr/bin/env bash
# MOTERVA judge environment — ONE-COMMAND CloudShell bootstrap (issues #17/#19).
#
# The founder's single action (in CloudShell, region us-east-1):
#
#   curl -fsSL https://raw.githubusercontent.com/CosmasMandikonza/Morteva/<ACCEPTED_SHA>/deploy/aws/bootstrap.sh \
#     | bash -s -- --domain judge.your-domain.com --email you@your-domain.com
#
# Unavoidable inputs (documented in AWS_DEPLOYMENT.md):
#   --domain  a DNS hostname YOU control (judge URL; point its A record at
#             the Elastic IP this script prints — Let's Encrypt needs it)
#   --email   billing/alarm + ACME contact address
# Everything else (secret, Cognito pool/client/owner, stack, ECR, GitHub
# OIDC deploy role, first deploy) is provisioned here, idempotently.
# Re-running is safe: existing resources are reused, never duplicated.
#
# NO AWS SPENDING HAPPENS BEFORE THIS SCRIPT RUNS — executing it IS the
# founder's approval. Steady-state cost ≈ $10/month, hard budget alarm at
# $12 with email alerts. teardown.sh reverses everything.
#
# Subcommands:
#   (default)            full provision + first deploy if images exist
#   --refresh-env        re-push Secrets Manager values into the running stack
#   --wait-images <min>  poll ECR for the release images then deploy
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
REPO="CosmasMandikonza/Morteva"
STACK="moterva-judge"
SECRET_NAME="moterva/production"
GH_REPO_FULL="CosmasMandikonza/Morteva"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"
# When curl|bash, SCRIPT_DIR is unusable — fetch companions to a temp dir.
TMP=$(mktemp -d /tmp/moterva-bootstrap.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

MODE="provision"
WAIT_MINUTES=15
DOMAIN=""; EMAIL=""; RELEASE_SHA=""; EXTRA_ARGS=()
# PROVENANCE (P0): --ref is REQUIRED and must be an exact reviewed SHA or
# the founder's documented release ref. Companions are fetched ONLY from
# this ref and verified against the embedded sha256 map below — a silent
# main-branch fallback or mixed-revision bootstrap is refused.
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --release-sha) RELEASE_SHA="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --refresh-env) MODE="refresh-env"; shift ;;
    --wait-images) WAIT_MINUTES="$2"; MODE="wait-images"; shift 2 ;;
    --skip-stack) EXTRA_ARGS="$EXTRA_ARGS skip-stack"; shift ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done

# Embedded integrity map for the companion scripts (sha256 of each file as
# committed AT THIS bootstrap revision). fetch_companion verifies every
# download against this map: if the requested --ref contains a DIFFERENT
# revision of any companion than this bootstrap was reviewed with, the run
# REFUSES rather than silently mixing versions.
EXPECTED_SHA256_provision_cognito_sh="aea27e3b20b451287210ff056205c64009d0577bdd3d550395714f0914fd0443"
EXPECTED_SHA256_reviewer_smoke_sh="475319311eb7bef4d0b8c03a2f5defa7e4f6962618cd938fc42be8f5d3cd9f2e"
EXPECTED_SHA256_compose_production_yml="347baf02c64a4a2f0912bf38e434f263367218402cbbd1da02c5d97dd737f4c5"
EXPECTED_SHA256_cloudformation_yaml="c1aed448f9669021c5b40c545acaba5655e9dbe7b6ec07ee95081d0db984a62f"
EXPECTED_SHA256_link_owner_sh="eade3ab815b520b581ab054afbcb26e51474b424f1253d29496c4a7b7b936feb"

log() { printf '\n\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bootstrap FAILED]\033[0m %s\n' "$*" >&2; exit 1; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text) || die "not authenticated — run inside CloudShell"
[ "$REGION" = "us-east-1" ] || REGION=$(aws configure get region 2>/dev/null || echo "$REGION")
log "account $ACCOUNT, region $REGION"

# --------------------------------------------------------------- helpers
fetch_companion() { # fetch + VERIFY a companion against the embedded sha256 map (no fallback ref, no mixed revisions)
  local name="$1" var="EXPECTED_SHA256_${name//[.\/-]/_}" expected actual
  expected="${!var:-}"
  if [ -f "$SCRIPT_DIR/$name" ]; then
    cp "$SCRIPT_DIR/$name" "$TMP/$name"
  else
    [ -n "$REF" ] || die "--ref <exact-release-sha> is required when running via curl|bash (provenance cannot be pinned otherwise)"
    curl -fsSL "https://raw.githubusercontent.com/${GH_REPO_FULL}/${REF}/deploy/aws/$name" \
      -o "$TMP/$name" || die "cannot fetch $name at ref $REF — REFUSING to fall back to another ref (mixed revisions are dangerous)"
  fi
  chmod +x "$TMP/$name"
  if [ -n "$expected" ] && [[ "$expected" != PLACEHOLDER_* ]]; then
    actual=$(sha256sum "$TMP/$name" | cut -d' ' -f1)
    [ "$actual" = "$expected" ] || die "companion $name at ref '$REF' is revision $actual but this bootstrap was reviewed with $expected — refusing mixed revisions (pass --ref matching THIS bootstrap's own URL)"
  fi
}

ssm_run() { # run a shell command on the judge instance, wait, return stdout
  local instance_id="$1" cmd="$2" timeout="${3:-120}"
  local cid status
  cid=$(aws ssm send-command --region "$REGION" --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript --comment "moterva-bootstrap" \
    --parameters "commands=[$cmd]" --timeout-seconds "$timeout" \
    --query 'Command.CommandId' --output text)
  for _ in $(seq 1 "$timeout"); do
    status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
      --instance-id "$instance_id" --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in
      Success) return 0 ;;
      Failed|Cancelled|TimedOut) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

instance_id() {
  aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=moterva-judge" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null
}

# --------------------------------------------------------------- preflight
if [ "$MODE" = "provision" ]; then
  [ -n "$DOMAIN" ] || die "--domain is required (a hostname you control — this becomes the judge URL)"
  [ -n "$EMAIL" ] || die "--email is required (billing alarms + ACME contact)"
  echo "$DOMAIN" | grep -Eq '^[a-z0-9.-]+\.[a-z]{2,}$' || die "DOMAIN must be a hostname like judge.example.com"
fi

fetch_companion provision-cognito.sh
fetch_companion reviewer-smoke.sh
fetch_companion compose.production.yml
fetch_companion cloudformation.yaml
fetch_companion link-owner.sh

# --------------------------------------------------------------- refresh-env
if [ "$MODE" = "refresh-env" ]; then
  ID=$(instance_id) || die "instance not running"
  log "refreshing production env from Secrets Manager (on-instance helper)"
  ssm_run "$ID" '/opt/moterva/refresh-env.sh' 300 || die "env refresh failed"
  log "api container recreated with the updated env. Done."
  exit 0
fi

# --------------------------------------------------------------- secrets
log "ensuring Secrets Manager secret $SECRET_NAME"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" \
  --region "$REGION" --query ARN --output text 2>/dev/null || true)
if [ -z "$SECRET_ARN" ] || [ "$SECRET_ARN" = "None" ]; then
  aws secretsmanager create-secret --region "$REGION" --name "$SECRET_NAME" \
    --description "MOTERVA judge production env (bootstrap-managed)" \
    --secret-string '{}' >/dev/null
  SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" --query ARN --output text)
fi

merge_secret() { # merge KEY=VALUE pairs into the secret JSON (existing values are overwritten by these)
  # WEB_ORIGIN is what apps/api/src/config.ts actually reads (CORS origin +
  # OIDC landing). The earlier draft wrote a differently-named origin var
  # the API never read — the P0-3 contract check forbids any such key here.
  aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" \
    --query SecretString --output text | jq -s '.[0] * .[1]' - <(jq -n \
      --arg domain "$DOMAIN" \
      --arg origin "https://$DOMAIN" \
      --arg redirect "https://$DOMAIN/api/auth/oidc/callback" \
      --arg issuer "$1" --arg clientid "$2" --arg secret "$3" \
      '{WEB_ORIGIN:$origin, MOTERVA_DOMAIN:$domain, MOTERVA_REVIEWER_DEMO:"1", MOTERVA_TRUST_PROXY:"1", MOTERVA_OIDC_ISSUER:$issuer, MOTERVA_OIDC_CLIENT_ID:$clientid, MOTERVA_OIDC_CLIENT_SECRET:$secret, MOTERVA_OIDC_REDIRECT_URI:$redirect}') \
    | aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --region "$REGION" --secret-string file:///dev/stdin >/dev/null
}

# --------------------------------------------------------------- cognito
log "provisioning Cognito reviewer authentication (idempotent)"
export AWS_REGION="$REGION" DOMAIN EMAIL SECRET_NAME
export OUTPUTS_FILE="$TMP/cognito.json"
bash "$TMP/provision-cognito.sh"
COGNITO=$(jq -s 'add' "$TMP/cognito.json")
ISSUER=$(echo "$COGNITO" | jq -r .cognitoIssuer)
CLIENTID=$(echo "$COGNITO" | jq -r .cognitoClientId)
CLIENTSECRET=$(aws cognito-idp describe-user-pool-client --region "$REGION" \
  --user-pool-id "$(echo "$COGNITO" | jq -r .cognitoPoolId)" \
  --client-id "$CLIENTID" --query 'UserPoolClient.ClientSecret' --output text)
log "merging OIDC values into the secret"
merge_secret "$ISSUER" "$CLIENTID" "$CLIENTSECRET"

# --------------------------------------------------------------- stack
if [[ "$EXTRA_ARGS" != *"skip-stack"* ]]; then
  log "ensuring CloudFormation stack $STACK (this creates/bills the EC2 instance)"
  VPCID=$(aws ec2 describe-vpcs --region "$REGION" --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)
  SUBNET=$(aws ec2 describe-subnets --region "$REGION" --filters "Name=vpc-id,Values=$VPCID" "Name=default-for-az,Values=true" \
    --query 'Subnets[0].SubnetId' --output text)
  aws cloudformation deploy --region "$REGION" \
    --stack-name "$STACK" --template-file "$TMP/cloudformation.yaml" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "MotervaSecretArn=$SECRET_ARN" "MotervaSecretName=$SECRET_NAME" \
      "FounderEmail=$EMAIL" "MonthlyBudgetLimit=12" \
      "VpcId=$VPCID" "SubnetId=$SUBNET" "InstanceType=t3.micro" \
    --no-fail-on-empty-changeset || die "cloudformation deploy failed"
fi

ELASTIC_IP=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ElasticIP'].OutputValue" --output text)
ECR_REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
log "Elastic IP: $ELASTIC_IP  →  point DNS A record of $DOMAIN here"

# ------------------------------------------------------- instance files
ID=$(instance_id) || die "instance not running (stack up failed)"
log "writing compose + env files to /opt/moterva (SSM; no SSH keys involved)"
ssm_run "$ID" "mkdir -p /opt/moterva" 60 >/dev/null || die "cannot reach instance over SSM"
COMPOSE_B64=$(base64 -w0 < "$TMP/compose.production.yml")
ssm_run "$ID" "printf '%s' '$COMPOSE_B64' | base64 -d > /opt/moterva/compose.production.yml" 60 \
  || die "compose file delivery failed"
ssm_run "$ID" "test -s /opt/moterva/compose.production.yml" 60 || die "compose file not delivered"
LINK_B64=$(base64 -w0 < "$TMP/link-owner.sh")
ssm_run "$ID" "printf '%s' '$LINK_B64' | base64 -d > /opt/moterva/link-owner.sh && chmod +x /opt/moterva/link-owner.sh" 60 \
  || die "link-owner delivery failed"
ssm_run "$ID" "printf 'ECR_REGISTRY=$ECR_REGISTRY\nMOTERVA_DOMAIN=$DOMAIN\n' > /opt/moterva/.env && chmod 600 /opt/moterva/.env" 60 \
  || die ".env delivery failed"

# ------------------------------------------------- GitHub OIDC deploy role
log "ensuring GitHub Actions OIDC deploy role (short-lived credentials only)"
PROVIDER_ARN=$(aws iam list-open-id-connect-providers --query \
  "OpenIDConnectProviderList[].Arn" --output text | tr '\t' '\n' | while read -r arn; do
    [ -n "$arn" ] || continue
    if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$arn" \
        --query 'Url' --output text 2>/dev/null | grep -q 'token.actions.githubusercontent.com'; then echo "$arn"; break; fi
  done)
if [ -z "$PROVIDER_ARN" ]; then
  log "creating GitHub OIDC provider (thumbprints computed live from the token host)"
  THUMBPRINTS=$(echo | openssl s_client -showcerts -servername token.actions.githubusercontent.com \
    -connect token.actions.githubusercontent.com:443 2>/dev/null \
    | awk '/BEGIN CERT/,/END CERT/{c=/BEGIN CERT/?c+1:c; print > ("/tmp/ghcert." c)}' ; \
    TH=""; for f in /tmp/ghcert.*; do TH="$TH \"$(openssl x509 -in "$f" -fingerprint -sha1 -noout | cut -d= -f2 | tr -d ':')\","; rm -f "$f"; done; echo "$TH" | sed 's/,$//')
  PROVIDER_ARN=$(aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "[$THUMBPRINTS]" --query 'OpenIDConnectProviderArn' --output text)
  # Tag as ours so teardown deletes ONLY this provider (it is account-global;
  # a pre-existing provider from another project is never touched).
  aws iam tag-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" \
    --tags Key=created-by,Value=moterva-bootstrap >/dev/null
fi
ROLE_NAME="moterva-github-deploy"
RELEASE_BRANCH="feat/mtv-19-connected-golden-path"
# Trust is scoped to the RELEASE BRANCH of this one repository — not
# repo:* (P0 least-privilege). The workflow's job must run on that branch
# for its OIDC subject to match.
TRUST=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"$PROVIDER_ARN"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},"StringLike":{"token.actions.githubusercontent.com:sub":"repo:${GH_REPO_FULL}:ref:refs/heads/${RELEASE_BRANCH}"}}}]}
EOF
)
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" >/dev/null
  # Permissions scoped to the two ECR repositories, the judge instance
  # (SSM), and the RunShellScript document. Explicit Deny on destructive
  # and secret-bearing surfaces.
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name moterva-deploy-least-privilege --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"ecr:InitiateLayerUpload\",\"ecr:UploadLayerPart\",\"ecr:CompleteLayerUpload\",\"ecr:PutImage\",\"ecr:BatchCheckLayerAvailability\",\"ecr:DescribeRepositories\"],\"Resource\":[\"arn:aws:ecr:${REGION}:${ACCOUNT}:repository/moterva-api\",\"arn:aws:ecr:${REGION}:${ACCOUNT}:repository/moterva-web\"]},
      {\"Effect\":\"Allow\",\"Action\":\"ssm:SendCommand\",\"Resource\":\"arn:aws:ssm:${REGION}:${ACCOUNT}:document/AWS-RunShellScript\",\"Condition\":{\"StringEquals\":{\"ssm:resourceTag/Name\":\"moterva-judge\"}}},
      {\"Effect\":\"Allow\",\"Action\":\"ssm:GetCommandInvocation\",\"Resource\":\"arn:aws:ec2:${REGION}:${ACCOUNT}:instance/*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"ec2:DescribeInstances\"],\"Resource\":\"*\"},
      {\"Effect\":\"Deny\",\"Action\":[\"iam:*\",\"s3:*\",\"secretsmanager:*\",\"ec2:Delete*\",\"ec2:TerminateInstances\"],\"Resource\":\"*\"}
    ]
  }" >/dev/null
  log "deploy role created (branch-scoped trust; ECR repos + tagged instance only)"
else
  log "deploy role $ROLE_NAME exists — refreshing its trust + policy to current scoping"
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" >/dev/null
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name moterva-deploy-least-privilege --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"ecr:InitiateLayerUpload\",\"ecr:UploadLayerPart\",\"ecr:CompleteLayerUpload\",\"ecr:PutImage\",\"ecr:BatchCheckLayerAvailability\",\"ecr:DescribeRepositories\"],\"Resource\":[\"arn:aws:ecr:${REGION}:${ACCOUNT}:repository/moterva-api\",\"arn:aws:ecr:${REGION}:${ACCOUNT}:repository/moterva-web\"]},
      {\"Effect\":\"Allow\",\"Action\":\"ssm:SendCommand\",\"Resource\":\"arn:aws:ssm:${REGION}:${ACCOUNT}:document/AWS-RunShellScript\",\"Condition\":{\"StringEquals\":{\"ssm:resourceTag/Name\":\"moterva-judge\"}}},
      {\"Effect\":\"Allow\",\"Action\":\"ssm:GetCommandInvocation\",\"Resource\":\"arn:aws:ec2:${REGION}:${ACCOUNT}:instance/*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"ec2:DescribeInstances\"],\"Resource\":\"*\"},
      {\"Effect\":\"Deny\",\"Action\":[\"iam:*\",\"s3:*\",\"secretsmanager:*\",\"ec2:Delete*\",\"ec2:TerminateInstances\"],\"Resource\":\"*\"}
    ]
  }" >/dev/null
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)

# --------------------------------------------------------------- summary
cat <<SUMMARY

==========================================================================
 MOTERVA judge environment — provisioned (account $ACCOUNT / $REGION)
==========================================================================
  Judge URL (after DNS):  https://$DOMAIN
  Elastic IP (A record):  $ELASTIC_IP
  Cognito hosted UI:      $(echo "$COGNITO" | jq -r .cognitoHostedUi)
  OIDC issuer:            $ISSUER
  Release provenance:     image tag = the exact deployed git SHA (immutable)

 NEXT STEPS (only two, both yours):
  1. DNS: create the A record  $DOMAIN  →  $ELASTIC_IP
  2. GitHub repo settings (values for Actions → Deploy AWS):
       Settings → Secrets and variables → Actions → Variables:
         AWS_DEPLOY_ROLE_ARN = $ROLE_ARN
         AWS_REGION          = $REGION
     then run: Actions → "Deploy AWS" → Run workflow
       release_sha = <the accepted SHA>   confirm_live = DEPLOY
       (dispatch from the release branch — the deploy role trust is scoped
        to that branch's OIDC subject)

 AFTER FIRST DEPLOY this script automatically:
   - binds YOUR Cognito owner identity to a fresh organization (one-shot,
     audited ledger evidence; first hosted-UI sign-in lands as OWNER)
   - runs the reviewer smoke checks against https://$DOMAIN

 Spend honesty: the budget is an ALERT ONLY (no hard spending cap).
 Expected steady state ≈ \$13.5/month (t3.micro 7.6 + 20 GB gp3 1.6 +
 public IPv4 3.6 + ECR/alarms/transfer ≈ 0.7) — promotional credits do
 NOT necessarily cover every fee; the \$EMAIL budget alert is the control.
 Teardown: deploy/aws/teardown.sh (reverses everything incl. Cognito).
==========================================================================
SUMMARY

# --------------------------------------------------------------- deploy
if [ "$MODE" = "wait-images" ] || [ "$MODE" = "provision" ]; then
  if [ -n "$RELEASE_SHA" ]; then SHA_TO_WAIT="$RELEASE_SHA"; else
    log "no --release-sha given; will wait for the newest workflow-pushed images"
    SHA_TO_WAIT=""
  fi
  log "waiting up to ${WAIT_MINUTES}m for immutable release images in ECR (run the Deploy AWS workflow now)"
  DEADLINE=$(( $(date +%s) + WAIT_MINUTES * 60 ))
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if [ -n "$SHA_TO_WAIT" ]; then
      # Explicit provenance: wait for THIS exact immutable tag in BOTH repos.
      API_OK=$(aws ecr describe-images --region "$REGION" --repository-name moterva-api \
        --query "imageDetails[?contains(imageTags, 'sha-${SHA_TO_WAIT}')] | [0].imageTags" --output text 2>/dev/null || true)
      WEB_OK=$(aws ecr describe-images --region "$REGION" --repository-name moterva-web \
        --query "imageDetails[?contains(imageTags, 'sha-${SHA_TO_WAIT}')] | [0].imageTags" --output text 2>/dev/null || true)
      if [ "$API_OK" != "None" ] && [ "$WEB_OK" != "None" ] && [ -n "$API_OK" ] && [ -n "$WEB_OK" ]; then
        log "images found for sha-$SHA_TO_WAIT — deploying"
        ssm_run "$ID" "/opt/moterva/update.sh ${SHA_TO_WAIT}" 600 || die "update.sh failed"
        # P0-4: bind the founder's Cognito owner identity once (SSM, on the
        # instance — never an HTTP endpoint), then verify the public surface.
        log "binding first owner identity (auditable, one-shot, server-side)"
        ssm_run "$ID" "ISSUER='$ISSUER' OWNER_EMAIL='$EMAIL' bash /opt/moterva/link-owner.sh" 300 \
          || die "owner identity binding failed"
        log "deployed + owner bound. running reviewer smoke checks against https://$DOMAIN"
        DOMAIN="$DOMAIN" RELEASE_SHA="$SHA_TO_WAIT" bash "$TMP/reviewer-smoke.sh" || die "smoke checks failed"
        log "JUDGE ENVIRONMENT LIVE: https://$DOMAIN — sign in as $EMAIL via the hosted UI"
        exit 0
      fi
    else
      # No explicit SHA: deploy the newest workflow-pushed tag present in both repos.
      for TAG in $(aws ecr describe-images --region "$REGION" --repository-name moterva-api \
        --query 'imageDetails[].imageTags[]' --output text 2>/dev/null | grep '^sha-' | sort -u); do
        WEB_TAG=$(aws ecr describe-images --region "$REGION" --repository-name moterva-web \
          --query "imageDetails[?contains(imageTags, '$TAG')].imageTags | [0]" --output text 2>/dev/null || echo None)
        if [ "$WEB_TAG" != "None" ] && [ -n "$WEB_TAG" ]; then
          log "images found for $TAG — deploying"
          ssm_run "$ID" "/opt/moterva/update.sh ${TAG#sha-}" 600 || die "update.sh failed"
          log "binding first owner identity (auditable, one-shot, server-side)"
          ssm_run "$ID" "ISSUER='$ISSUER' OWNER_EMAIL='$EMAIL' bash /opt/moterva/link-owner.sh" 300 \
            || die "owner identity binding failed"
          log "deployed + owner bound. running reviewer smoke checks against https://$DOMAIN"
          DOMAIN="$DOMAIN" RELEASE_SHA="${TAG#sha-}" bash "$TMP/reviewer-smoke.sh" || die "smoke checks failed"
          log "JUDGE ENVIRONMENT LIVE: https://$DOMAIN — sign in as $EMAIL via the hosted UI"
          exit 0
        fi
      done
    fi
    sleep 30
  done
  log "no images arrived within ${WAIT_MINUTES}m — infrastructure is READY; run the Deploy AWS workflow, then rerun this script with --wait-images 15"
fi
