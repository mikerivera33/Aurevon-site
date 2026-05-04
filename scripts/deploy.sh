#!/usr/bin/env bash
# =============================================================================
# BLOCKT Ventures — One-Command Production Deploy Script
# =============================================================================
# Usage:
#   bash scripts/deploy.sh            # Deploy to production
#   bash scripts/deploy.sh --preview  # Deploy to preview URL (no custom domain)
#   bash scripts/deploy.sh --dry-run  # Validate config without deploying
# =============================================================================

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
CYAN="\033[36m"
RESET="\033[0m"

PROD=true
DRY_RUN=false

for arg in "$@"; do
  case $arg in
    --preview) PROD=false ;;
    --dry-run) DRY_RUN=true ;;
    *) ;;
  esac
done

log()   { echo -e "${CYAN}[deploy]${RESET} $1"; }
ok()    { echo -e "${GREEN}[ok]${RESET}    $1"; }
warn()  { echo -e "${YELLOW}[warn]${RESET}  $1"; }
error() { echo -e "${RED}[error]${RESET} $1"; exit 1; }

echo ""
echo -e "${BOLD}BLOCKT Ventures — Production Deploy${RESET}"
echo "Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Mode: $( $PROD && echo 'Production' || echo 'Preview' )"
echo "=================================="

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
log "Running pre-flight checks..."

# Check vercel CLI is available
if ! command -v vercel &>/dev/null; then
  error "Vercel CLI not found. Run: npm install -g vercel"
fi
ok "Vercel CLI found: $(vercel --version 2>/dev/null | head -1)"

# Check we're in the right directory
if [[ ! -f "vercel.json" ]]; then
  error "vercel.json not found. Run this script from the site/ directory."
fi
ok "vercel.json found"

# Check package.json
if [[ ! -f "package.json" ]]; then
  error "package.json not found."
fi
ok "package.json found"

# Check for .env.local (warn if missing, not fatal)
if [[ ! -f ".env.local" ]] && [[ ! -f ".env" ]]; then
  warn ".env.local not found. Make sure env vars are set in Vercel Dashboard."
fi

# Validate vercel.json is valid JSON
if ! python3 -c "import json; json.load(open('vercel.json'))" 2>/dev/null; then
  error "vercel.json is not valid JSON. Fix syntax errors before deploying."
fi
ok "vercel.json is valid JSON"

# Check Vercel project is linked
if [[ ! -d ".vercel" ]]; then
  warn ".vercel/ directory not found — project may not be linked."
  log "Run 'vercel link' to link to a Vercel project, then retry."
  if $PROD; then
    error "Cannot deploy to production without a linked project. Run 'vercel link' first."
  fi
fi

if $DRY_RUN; then
  echo ""
  ok "Dry run complete — all pre-flight checks passed."
  echo "Remove --dry-run to execute the deploy."
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
echo ""
log "Starting Vercel deployment..."
echo ""

if $PROD; then
  log "Deploying to PRODUCTION..."
  vercel --prod --yes
else
  log "Deploying to PREVIEW..."
  vercel --yes
fi

DEPLOY_EXIT=$?

echo ""
if [[ $DEPLOY_EXIT -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}Deployment successful!${RESET}"
  echo ""
  if $PROD; then
    log "Production deployment complete. Custom domain should be live within 30s."
    log "Run 'npm run test:qa' to verify the deployment."
  else
    log "Preview deployment complete. Use the preview URL to test before promoting."
  fi
else
  error "Deployment failed with exit code $DEPLOY_EXIT. Check the output above."
fi
