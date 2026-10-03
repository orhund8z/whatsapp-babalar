#!/usr/bin/env bash
# =============================================================================
# Babalar — AWS Deploy Script
# Usage: ./deploy.sh [--skip-secrets] [--infra-only] [--frontend-only]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/deploy.config"
INFRA_DIR="$SCRIPT_DIR/infrastructure"
FRONTEND_DIR="$SCRIPT_DIR/babalar-frontend"

SKIP_SECRETS=false
INFRA_ONLY=false
FRONTEND_ONLY=false

for arg in "$@"; do
  case $arg in
    --skip-secrets)  SKIP_SECRETS=true ;;
    --infra-only)    INFRA_ONLY=true ;;
    --frontend-only) FRONTEND_ONLY=true ;;
  esac
done

# ── Output helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[•]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }

# ── Load config ────────────────────────────────────────────────────────────────
[[ -f "$CONFIG_FILE" ]] || error "deploy.config not found. Run: cp deploy.config.example deploy.config"
# shellcheck source=/dev/null
source "$CONFIG_FILE"

# ── Validate config ────────────────────────────────────────────────────────────
validate_config() {
  local missing=()
  for var in AWS_PROFILE AWS_REGION AWS_ACCOUNT_ID REPO_URL \
             DOMAIN ACM_CERT_ARN OPENAI_API_KEY JWT_SECRET INGEST_API_KEY DB_PASSWORD; do
    local val="${!var:-}"
    if [[ -z "$val" || "$val" == *"CHANGE_ME"* ]]; then
      missing+=("$var")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Unfilled values in deploy.config:\n  ${missing[*]}"
  fi
}

# ── Check prerequisites ────────────────────────────────────────────────────────
check_prerequisites() {
  info "Checking prerequisites..."
  local missing=()
  command -v aws     &>/dev/null || missing+=("aws-cli")
  command -v cdk     &>/dev/null || missing+=("aws-cdk (npm install -g aws-cdk)")
  command -v node    &>/dev/null || missing+=("node")
  command -v python3 &>/dev/null || missing+=("python3")
  command -v npm     &>/dev/null || missing+=("npm")
  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing tools: ${missing[*]}"
  fi
  success "All prerequisites met."
}

# ── AWS Secrets Manager ────────────────────────────────────────────────────────
upsert_secret() {
  local name="$1" value="$2"
  if aws secretsmanager describe-secret --secret-id "$name" \
       --region "$AWS_REGION" --profile "$AWS_PROFILE" &>/dev/null; then
    aws secretsmanager put-secret-value \
      --secret-id "$name" --secret-string "$value" \
      --region "$AWS_REGION" --profile "$AWS_PROFILE" --output text > /dev/null
    warn "  Updated: $name"
  else
    aws secretsmanager create-secret \
      --name "$name" --secret-string "$value" \
      --region "$AWS_REGION" --profile "$AWS_PROFILE" --output text > /dev/null
    success "  Created: $name"
  fi
}

has_secret_value() {
  local val="${1:-}"
  [[ -n "$val" && "$val" != *"CHANGE_ME"* ]]
}

create_secrets() {
  info "Uploading secrets to Secrets Manager..."
  # db-password must be JSON (RDS Credentials requirement)
  upsert_secret "babalar/db-password"    "{\"password\":\"$DB_PASSWORD\"}"
  upsert_secret "babalar/openai-api-key" "$OPENAI_API_KEY"
  upsert_secret "babalar/jwt-secret"     "$JWT_SECRET"
  upsert_secret "babalar/ingest-api-key" "$INGEST_API_KEY"
  if has_secret_value "${LANGFUSE_PUBLIC_KEY:-}"; then
    upsert_secret "babalar/langfuse-public-key" "$LANGFUSE_PUBLIC_KEY"
  fi
  if has_secret_value "${LANGFUSE_SECRET_KEY:-}"; then
    upsert_secret "babalar/langfuse-secret-key" "$LANGFUSE_SECRET_KEY"
  fi
  if has_secret_value "${LANGFUSE_BASE_URL:-}"; then
    upsert_secret "babalar/langfuse-base-url" "$LANGFUSE_BASE_URL"
  fi
  if has_secret_value "${TYPESAFE_API_KEY:-}"; then
    upsert_secret "babalar/typesafe-api-key" "$TYPESAFE_API_KEY"
  fi
  if has_secret_value "${JEV_MODEL:-}"; then
    upsert_secret "babalar/jev-model" "$JEV_MODEL"
  fi
  success "Secrets ready."
}

# ── CDK ────────────────────────────────────────────────────────────────────────
CDK_CONTEXT="-c region=$AWS_REGION \
  -c account=$AWS_ACCOUNT_ID \
  -c repo_url=$REPO_URL \
  -c domain=$DOMAIN \
  -c cert_arn=$ACM_CERT_ARN"

VENV_DIR="$INFRA_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

setup_venv() {
  if [[ ! -f "$VENV_PYTHON" ]]; then
    info "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
    success "Virtual environment created."
  fi
  info "Installing CDK Python dependencies..."
  "$VENV_PYTHON" -m pip install --quiet --disable-pip-version-check -r "$INFRA_DIR/requirements.txt"
  success "CDK dependencies ready."
}

cdk_run() {
  JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 \
  AWS_PROFILE="$AWS_PROFILE" cdk "$@" $CDK_CONTEXT \
    --app "$VENV_PYTHON app.py" \
    --require-approval never \
    --profile "$AWS_PROFILE"
}

deploy_infra() {
  info "Deploying infrastructure stacks (Network → Database → Compute)..."
  cd "$INFRA_DIR"
  setup_venv
  cdk_run deploy BabalarNetwork BabalarDatabase BabalarCompute
  success "Infrastructure deploy complete."
}

get_alb_dns() {
  cd "$INFRA_DIR"
  AWS_PROFILE="$AWS_PROFILE" aws cloudformation describe-stacks \
    --stack-name BabalarCompute \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" \
    --output text
}

build_frontend() {
  local api_url="$1"
  local build_version
  build_version=$(git -C "$SCRIPT_DIR" log -1 --format="%cd.%h" --date=format:"%Y%m%d" 2>/dev/null || echo "dev")
  info "Building frontend (API: $api_url, version: $build_version)..."
  cd "$FRONTEND_DIR"
  npm ci --silent
  VITE_API_URL="$api_url" VITE_APP_VERSION="$build_version" npm run build
  success "Frontend build complete."
}

deploy_frontend() {
  info "Deploying frontend stack (S3 + CloudFront)..."
  cd "$INFRA_DIR"
  setup_venv
  JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 \
  AWS_PROFILE="$AWS_PROFILE" cdk deploy BabalarFrontend $CDK_CONTEXT \
    -c alb_dns="$ALB_DNS" \
    --app "$VENV_PYTHON app_frontend.py" \
    --require-approval never \
    --profile "$AWS_PROFILE"
  success "Frontend deploy complete."
}

get_cloudfront_url() {
  cd "$INFRA_DIR"
  AWS_PROFILE="$AWS_PROFILE" aws cloudformation describe-stacks \
    --stack-name BabalarFrontend \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='CloudFrontURL'].OutputValue" \
    --output text
}

# ── Main ───────────────────────────────────────────────────────────────────────
echo ""
echo "  ======================================"
echo "   Babalar AWS Deploy"
echo "  ======================================"
echo "  Region  : $AWS_REGION"
echo "  Account : $AWS_ACCOUNT_ID"
echo "  Domain  : $DOMAIN"
echo "  Profile : $AWS_PROFILE"
echo "  ======================================"
echo ""

validate_config
check_prerequisites

if [[ "$FRONTEND_ONLY" == false ]]; then
  [[ "$SKIP_SECRETS" == false ]] && create_secrets
  deploy_infra
fi

ALB_DNS=$(get_alb_dns)
[[ -z "$ALB_DNS" ]] && error "Could not get ALB DNS. Are the infra stacks deployed?"
info "ALB DNS: $ALB_DNS"

API_URL="https://$DOMAIN"
build_frontend "$API_URL"

[[ "$INFRA_ONLY" == false ]] && deploy_frontend

CLOUDFRONT_URL=$(get_cloudfront_url)

echo ""
echo "  ======================================"
echo -e "   ${GREEN}Deploy Complete!${NC}"
echo "  ======================================"
echo "  CloudFront : $CLOUDFRONT_URL"
echo "  Domain     : https://$DOMAIN"
echo "  ======================================"
echo ""
echo "  Next steps:"
echo "  1. Add DNS record (CNAME, not A record):"
echo "     $DOMAIN → ${CLOUDFRONT_URL#https://}"
echo ""
echo "  2. Get EC2 instance ID:"
echo "     aws ec2 describe-instances \\"
echo "       --filters Name=tag:aws:cloudformation:stack-name,Values=BabalarCompute \\"
echo "       --query 'Reservations[].Instances[].InstanceId' --output text \\"
echo "       --region $AWS_REGION --profile $AWS_PROFILE"
echo ""
echo "  3. Connect to EC2 (SSM — no SSH needed):"
echo "     aws ssm start-session --target <INSTANCE_ID> --region $AWS_REGION --profile $AWS_PROFILE"
echo "     → tail -f /var/log/babalar-setup.log"
echo ""
echo "  4. Create admin user (after setup completes):"
echo "     docker compose -f /app/docker-compose.prod.yml exec backend python -m app.cli setup"
echo ""
echo "  5. Connect WhatsApp: Admin panel → Groups tab → scan QR code"
echo ""
