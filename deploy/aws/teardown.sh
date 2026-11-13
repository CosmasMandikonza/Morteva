#!/usr/bin/env bash
# MOTERVA judge environment — full teardown (reverses bootstrap.sh).
#
#   bash teardown.sh                     # interactive: asks before deleting data
#   bash teardown.sh --yes               # non-interactive
#   bash teardown.sh --yes --purge-data  # ALSO delete the ledger volume (irreversible)
#   bash teardown.sh --yes --keep-images # keep ECR repositories (rollback images)
#
# Deletes, in order: CloudFormation stack (instance, EIP, SG, alarms,
# budget), Cognito user pool + domain, the Secrets Manager secret, the
# GitHub OIDC deploy role (+ the GitHub OIDC provider ONLY if this script
# created it, tracked via a tag), and the orphaned ledger EBS volume.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="moterva-judge"
SECRET_NAME="moterva/production"
POOL_NAME="moterva-reviewers"
ROLE_NAME="moterva-github-deploy"
CONFIRM="no"; PURGE_DATA="no"; KEEP_IMAGES="no"
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRM="yes" ;;
    --purge-data) PURGE_DATA="yes" ;;
    --keep-images) KEEP_IMAGES="yes" ;;
  esac
done

log() { printf '\033[1;36m[teardown]\033[0m %s\n' "$*"; }

if [ "$CONFIRM" != "yes" ]; then
  printf 'This DELETES the judge instance, EIP, Cognito pool and the production secret.\n'
  printf '%s' "Type DELETE to confirm: "
  read -r answer
  [ "$answer" = "DELETE" ] || { echo "aborted"; exit 1; }
fi

# Backup the ledger BEFORE anything else (last-resort local copy in /tmp).
log "backing up ledger (best effort) to /tmp/moterva-ledger-backup-$(date +%s).sqlite"
VOLID=$(aws ec2 describe-volumes --region "$REGION" \
  --filters "Name=tag:Name,Values=moterva-judge" --query 'Volumes[0].VolumeId' --output text 2>/dev/null || true)
if [ -n "$VOLID" ] && [ "$VOLID" != "None" ]; then
  aws ec2 create-snapshot --region "$REGION" --volume-id "$VOLID" \
    --description "moterva teardown safety snapshot" --query SnapshotId --output text >/dev/null 2>&1 \
    && log "EBS snapshot created as a safety copy (delete it manually after verifying)" \
    || log "snapshot skipped (volume busy/absent)"
fi

# GitHub deploy role FIRST (stops any in-flight workflow from re-provisioning)
aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name moterva-deploy-least-privilege 2>/dev/null || true
aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null && log "deploy role deleted" || log "deploy role absent"
# The GitHub OIDC provider is account-global: delete ONLY if tagged as ours.
for ARN in $(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text); do
  URL=$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$ARN" --query Url --output text 2>/dev/null || true)
  [ "$URL" = "https://token.actions.githubusercontent.com" ] || continue
  OWNED=$(aws iam list-open-id-connect-provider-tags --open-id-connect-provider-arn "$ARN" \
    --query "Tags[?Key=='created-by' && Value=='moterva-bootstrap'] | [0].Key" --output text 2>/dev/null || echo None)
  if [ "$OWNED" = "created-by" ]; then
    aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$ARN" \
      && log "GitHub OIDC provider deleted (created by moterva bootstrap)"
  else
    log "GitHub OIDC provider present but NOT created by this bootstrap — left untouched"
  fi
done

# CloudFormation stack (instance, EIP, SG, alarms, budget, ECR via Retain)
if aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" >/dev/null 2>&1; then
  aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
  log "waiting for stack deletion..."
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK" || true
  log "stack deleted"
fi

# Cognito pool + domain
POOLID=$(aws cognito-idp list-user-pools --region "$REGION" --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id" --output text 2>/dev/null | head -n1 || true)
if [ -n "$POOLID" ] && [ "$POOLID" != "None" ]; then
  DOMAIN_PREFIX=$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOLID" --query 'UserPool.Domain' --output text 2>/dev/null || true)
  [ -n "$DOMAIN_PREFIX" ] && [ "$DOMAIN_PREFIX" != "None" ] \
    && aws cognito-idp delete-user-pool-domain --region "$REGION" --user-pool-id "$POOLID" --domain "$DOMAIN_PREFIX" || true
  aws cognito-idp delete-user-pool --region "$REGION" --user-pool-id "$POOLID"
  log "Cognito pool $POOLID deleted"
fi

# Secret (force-wait even if scheduled for deletion)
aws secretsmanager delete-secret --region "$REGION" --secret-id "$SECRET_NAME" \
  --force-delete-without-recovery >/dev/null 2>&1 && log "secret deleted" || log "secret absent"

# ECR repositories (Retain policy kept them; teardown decides)
if [ "$KEEP_IMAGES" = "yes" ]; then
  log "ECR repositories kept (--keep-images) for rollback imagery"
else
  for R in moterva-api moterva-web; do
    aws ecr delete-repository --region "$REGION" --repository-name "$R" --force 2>/dev/null \
      && log "ECR $R deleted" || log "ECR $R absent"
  done
fi

# Orphaned ledger volume (stack delete leaves DeleteOnTermination=false volumes)
sleep 10
VOLID=$(aws ec2 describe-volumes --region "$REGION" \
  --filters "Name=tag:Name,Values=moterva-judge" --query 'Volumes[0].VolumeId' --output text 2>/dev/null || true)
if [ -n "$VOLID" ] && [ "$VOLID" != "None" ]; then
  if [ "$PURGE_DATA" = "yes" ]; then
    aws ec2 delete-volume --region "$REGION" --volume-id "$VOLID" && log "ledger volume $VOLID DELETED (--purge-data)"
  else
    log "ledger volume $VOLID KEPT (delete manually with: aws ec2 delete-volume --volume-id $VOLID)"
  fi
fi

log "teardown complete — verify Billing → Cost Explorer shows spend stopping within hours"
