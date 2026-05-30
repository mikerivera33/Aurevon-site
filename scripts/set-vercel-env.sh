#!/usr/bin/env bash
# =============================================================================
# Aurevon Ventures LLC — Vercel Environment Setup
# =============================================================================
# Sets the email/branding/Crossmint env vars that this PR depends on.
# Run locally where the Vercel CLI is authenticated (`vercel login`) and the
# project is linked (`.vercel/project.json` present — it is in this repo).
#
# Usage:
#   bash scripts/set-vercel-env.sh            # set the safe brand/email vars
#   bash scripts/set-vercel-env.sh --crossmint # ALSO prompt for Crossmint prod IDs
#
# Notes:
# - Re-running is safe: each var is removed (if present) then re-added.
# - Secrets (API keys) are NOT set here — paste those in the dashboard or add
#   your own `vercel env add` lines. This script only sets non-secret config.
# =============================================================================

set -euo pipefail

GREEN="\033[32m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
TARGETS=(production preview development)

need_cli() {
  command -v vercel >/dev/null 2>&1 || { echo "Vercel CLI not found. Install: npm i -g vercel"; exit 1; }
}

set_var() {
  local key="$1" val="$2"
  for env in "${TARGETS[@]}"; do
    vercel env rm "$key" "$env" -y >/dev/null 2>&1 || true
    printf '%s' "$val" | vercel env add "$key" "$env" >/dev/null 2>&1 \
      && echo -e "  ${GREEN}✓${RESET} $key ($env) = $val" \
      || echo -e "  ${YELLOW}!${RESET} $key ($env) — failed (check auth/link)"
  done
}

need_cli
echo -e "${BOLD}Setting Aurevon brand/email env vars on the linked Vercel project…${RESET}"

# ── Email (single sender → mike@aurevonvc.com) ──────────────────────────────
set_var RESEND_FROM_EMAIL "mike@aurevonvc.com"
set_var RESEND_FROM_NAME  "Aurevon"

# ── Canonical domain (single domain → www.aurevonvc.com) ────────────────────
set_var BASE_URL "https://www.aurevonvc.com"
set_var DOMAIN   "https://www.aurevonvc.com"
set_var SITE_URL "https://www.aurevonvc.com"

# ── Crossmint: keep PRODUCTION (Base mainnet) ───────────────────────────────
set_var CROSSMINT_ENV   "production"
set_var CROSSMINT_CHAIN "base"

if [[ "${1:-}" == "--crossmint" ]]; then
  echo -e "\n${BOLD}Crossmint production IDs (leave blank to skip a field):${RESET}"
  read -r -p "  CROSSMINT_COLLECTION_ID: " COLL
  [[ -n "$COLL" ]] && set_var CROSSMINT_COLLECTION_ID "$COLL"
  for tier in INSIDER EMBER OBSIDIAN GENESIS CHROME; do
    read -r -p "  CROSSMINT_TEMPLATE_$tier: " TPL
    [[ -n "$TPL" ]] && set_var "CROSSMINT_TEMPLATE_$tier" "$TPL"
  done
fi

echo -e "\n${BOLD}Done.${RESET} Secrets still to set in the dashboard or via 'vercel env add':"
echo "  RESEND_API_KEY · STRIPE_SECRET_KEY · STRIPE_WEBHOOK_SECRET · CROSSMINT_API_KEY"
echo "  AIRTABLE_PAT · DISCORD_BOT_TOKEN · DISCORD_CLIENT_SECRET · PAYPAL_SECRET"
echo -e "\nRedeploy to apply:  ${BOLD}vercel --prod${RESET}"
