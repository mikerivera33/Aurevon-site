#!/usr/bin/env bash
# =============================================================================
# Aurevon Ventures — Automated QA Test Harness
# =============================================================================
# Usage:
#   bash qa-test.sh                  # Standard QA run
#   bash qa-test.sh --full-pipeline  # Full pipeline including Airtable/Discord checks
#   bash qa-test.sh --env prod       # Use SITE_URL from env (default: localhost)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
FULL_PIPELINE=false
BASE_URL="${SITE_URL:-http://localhost:3000}"
PASS=0
FAIL=0
SKIP=0
BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

for arg in "$@"; do
  case $arg in
    --full-pipeline) FULL_PIPELINE=true ;;
    --env) shift ;;
    prod) BASE_URL="${SITE_URL:-https://www.aurevonvc.com}" ;;
    *) ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
pass() { echo -e "${GREEN}[PASS]${RESET} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}[FAIL]${RESET} $1"; FAIL=$((FAIL + 1)); }
skip() { echo -e "${YELLOW}[SKIP]${RESET} $1 (env var missing)"; SKIP=$((SKIP + 1)); }
section() { echo -e "\n${BOLD}=== $1 ===${RESET}"; }
require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    echo -e "${YELLOW}[WARN]${RESET} $var is not set"
    return 1
  fi
  return 0
}

# Load .env.local if it exists
if [[ -f ".env.local" ]]; then
  echo "Loading .env.local..."
  set -a
  # shellcheck disable=SC1091
  source .env.local 2>/dev/null || true
  set +a
fi

echo ""
echo -e "${BOLD}Aurevon QA Test Harness${RESET}"
echo "Target: ${BASE_URL}"
echo "Full pipeline: ${FULL_PIPELINE}"
echo "Started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=============================================="

# ---------------------------------------------------------------------------
# SECTION 1: Health check
# ---------------------------------------------------------------------------
section "1. Health Check"

HEALTH_RESPONSE=$(curl -sf --max-time 10 "${BASE_URL}/api/health" 2>/dev/null || echo "CURL_FAILED")

if [[ "$HEALTH_RESPONSE" == "CURL_FAILED" ]]; then
  fail "GET /api/health — could not reach server at ${BASE_URL}"
else
  STATUS=$(echo "$HEALTH_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "parse_error")
  if [[ "$STATUS" == "ok" ]]; then
    pass "GET /api/health returned status=ok"
  else
    fail "GET /api/health returned unexpected status: $STATUS (body: $HEALTH_RESPONSE)"
  fi

  # Check env completeness from health response
  ENV_STATUS=$(echo "$HEALTH_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('env','unknown'))" 2>/dev/null || echo "unknown")
  if [[ "$ENV_STATUS" == "complete" ]]; then
    pass "Health check reports env=complete (all required vars set)"
  elif [[ "$ENV_STATUS" == "partial" ]]; then
    MISSING=$(echo "$HEALTH_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(d.get('missing',[])))" 2>/dev/null || echo "unknown")
    skip "Health check env=partial — deployment env vars not configured: $MISSING"
  else
    skip "Health check env status unknown — endpoint live but env check skipped"
  fi
fi

# ---------------------------------------------------------------------------
# SECTION 2: Static pages
# ---------------------------------------------------------------------------
section "2. Static Pages"

PAGES=(
  "/"
  "/aurevon-web3.html"
  "/aurevon-re.html"
  "/001_Genesis.html"
  "/004_Chrome.html"
  "/aurevon-re-intake.html"
  "/membership_confirmation.html"
  "/operator.html"
  "/portal.html"
  "/merch.html"
)

for page in "${PAGES[@]}"; do
  HTTP_CODE=$(curl -so /dev/null -w "%{http_code}" --max-time 10 "${BASE_URL}${page}" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    pass "Page ${page} returned HTTP 200"
  else
    fail "Page ${page} returned HTTP ${HTTP_CODE} (expected 200)"
  fi
done

# ---------------------------------------------------------------------------
# SECTION 3: Mock Stripe webhook
# ---------------------------------------------------------------------------
section "3. Stripe Webhook (Mock)"

if require_env "STRIPE_WEBHOOK_SECRET"; then
  # Build a mock Stripe checkout.session.completed event
  MOCK_TIMESTAMP=$(date +%s)
  MOCK_SESSION_ID="cs_test_qa_$(date +%s%N | sha256sum | head -c 12)"
  MOCK_EMAIL="qa-test-$(date +%s)@aurevon-qa.test"

  MOCK_PAYLOAD=$(cat <<PAYLOAD
{
  "id": "evt_test_qa_$(date +%s)",
  "object": "event",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "${MOCK_SESSION_ID}",
      "object": "checkout.session",
      "customer_email": "${MOCK_EMAIL}",
      "payment_status": "paid",
      "amount_total": 29700,
      "currency": "usd",
      "metadata": {
        "tier": "insider"
      },
      "payment_intent": "pi_test_qa_$(date +%s)"
    }
  }
}
PAYLOAD
  )

  # Compute Stripe signature (t=timestamp,v1=HMAC-SHA256)
  PAYLOAD_STRING="${MOCK_TIMESTAMP}.${MOCK_PAYLOAD}"
  SIG_V1=$(echo -n "${PAYLOAD_STRING}" | openssl dgst -sha256 -hmac "${STRIPE_WEBHOOK_SECRET}" | awk '{print $NF}')
  STRIPE_SIG="t=${MOCK_TIMESTAMP},v1=${SIG_V1}"

  WEBHOOK_RESPONSE=$(curl -sf --max-time 30 \
    -X POST \
    -H "Content-Type: application/json" \
    -H "stripe-signature: ${STRIPE_SIG}" \
    -d "${MOCK_PAYLOAD}" \
    "${BASE_URL}/api/webhooks/stripe" 2>/dev/null || echo "CURL_FAILED")

  if [[ "$WEBHOOK_RESPONSE" == "CURL_FAILED" ]]; then
    fail "POST /api/webhooks/stripe — request failed"
  else
    WH_STATUS=$(echo "$WEBHOOK_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('received',False))" 2>/dev/null || echo "false")
    if [[ "$WH_STATUS" == "True" ]] || echo "$WEBHOOK_RESPONSE" | grep -q '"received".*true'; then
      pass "POST /api/webhooks/stripe accepted mock event"
      LAST_QA_EMAIL="$MOCK_EMAIL"
    else
      fail "POST /api/webhooks/stripe returned unexpected response: $WEBHOOK_RESPONSE"
    fi
  fi
else
  skip "POST /api/webhooks/stripe (STRIPE_WEBHOOK_SECRET not set)"
fi

# ---------------------------------------------------------------------------
# SECTION 4: Airtable record verification
# ---------------------------------------------------------------------------
section "4. Airtable Record Verification"

if $FULL_PIPELINE && require_env "AIRTABLE_PAT" && require_env "AIRTABLE_BASE_ID"; then
  TABLE="${AIRTABLE_TABLE_PAYMENTS:-Payments}"
  SEARCH_EMAIL="${LAST_QA_EMAIL:-qa-test@aurevon-qa.test}"

  # Wait up to 30 seconds for the webhook to write to Airtable
  echo "  Waiting 10s for webhook to process and write to Airtable..."
  sleep 10

  AT_RESPONSE=$(curl -sf --max-time 15 \
    -H "Authorization: Bearer ${AIRTABLE_PAT}" \
    "https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE}?filterByFormula=SEARCH(\"${SEARCH_EMAIL}\",{email})&maxRecords=1" \
    2>/dev/null || echo "CURL_FAILED")

  if [[ "$AT_RESPONSE" == "CURL_FAILED" ]]; then
    fail "Airtable Payments query failed (network error)"
  else
    RECORD_COUNT=$(echo "$AT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('records',[])))" 2>/dev/null || echo "0")
    if [[ "$RECORD_COUNT" -gt "0" ]]; then
      pass "Airtable Payments table has record for ${SEARCH_EMAIL}"
    else
      fail "Airtable Payments table has NO record for ${SEARCH_EMAIL} after 10s"
    fi
  fi

  # Check NFT_Mints table
  TABLE_MINTS="${AIRTABLE_TABLE_NFT_MINTS:-NFT_Mints}"
  AT_MINTS=$(curl -sf --max-time 15 \
    -H "Authorization: Bearer ${AIRTABLE_PAT}" \
    "https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE_MINTS}?filterByFormula=SEARCH(\"${SEARCH_EMAIL}\",{email})&maxRecords=1" \
    2>/dev/null || echo "CURL_FAILED")

  if [[ "$AT_MINTS" == "CURL_FAILED" ]]; then
    fail "Airtable NFT_Mints query failed"
  else
    MINT_COUNT=$(echo "$AT_MINTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('records',[])))" 2>/dev/null || echo "0")
    if [[ "$MINT_COUNT" -gt "0" ]]; then
      pass "Airtable NFT_Mints table has record for ${SEARCH_EMAIL}"
    else
      fail "Airtable NFT_Mints table has NO record for ${SEARCH_EMAIL} after 10s"
    fi
  fi
else
  if ! $FULL_PIPELINE; then
    skip "Airtable record check (run with --full-pipeline to enable)"
  else
    skip "Airtable record check (AIRTABLE_PAT or AIRTABLE_BASE_ID not set)"
  fi
fi

# ---------------------------------------------------------------------------
# SECTION 5: Resend email verification
# ---------------------------------------------------------------------------
section "5. Resend Email Verification"

if $FULL_PIPELINE && require_env "RESEND_API_KEY"; then
  # Fetch recent emails from Resend API
  RESEND_EMAILS=$(curl -sf --max-time 10 \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    "https://api.resend.com/emails?limit=5" \
    2>/dev/null || echo "CURL_FAILED")

  if [[ "$RESEND_EMAILS" == "CURL_FAILED" ]]; then
    fail "Resend API request failed (network error or invalid API key)"
  else
    EMAIL_COUNT=$(echo "$RESEND_EMAILS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null || echo "-1")
    if [[ "$EMAIL_COUNT" -ge "0" ]]; then
      pass "Resend API accessible — found ${EMAIL_COUNT} recent emails"
      # Check if our QA test email was sent
      SEARCH_EMAIL="${LAST_QA_EMAIL:-}"
      if [[ -n "$SEARCH_EMAIL" ]]; then
        FOUND=$(echo "$RESEND_EMAILS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
emails = d.get('data', [])
target = '${SEARCH_EMAIL}'
found = any(e.get('to', '') == target for e in emails)
print('true' if found else 'false')
" 2>/dev/null || echo "false")
        if [[ "$FOUND" == "true" ]]; then
          pass "Resend shows email sent to ${SEARCH_EMAIL}"
        else
          fail "No Resend email found for ${SEARCH_EMAIL} in recent emails"
        fi
      fi
    else
      fail "Resend API returned unexpected response: $RESEND_EMAILS"
    fi
  fi
else
  if ! $FULL_PIPELINE; then
    skip "Resend email check (run with --full-pipeline to enable)"
  else
    skip "Resend email check (RESEND_API_KEY not set)"
  fi
fi

# ---------------------------------------------------------------------------
# SECTION 6: Crossmint connectivity check
# ---------------------------------------------------------------------------
section "6. Crossmint Connectivity"

if require_env "CROSSMINT_API_KEY" && require_env "CROSSMINT_COLLECTION_ID"; then
  CROSSMINT_ENV="${CROSSMINT_ENVIRONMENT:-staging}"
  if [[ "$CROSSMINT_ENV" == "production" ]]; then
    CROSSMINT_BASE="https://www.crossmint.com/api/2022-06-09"
  else
    CROSSMINT_BASE="https://staging.crossmint.com/api/2022-06-09"
  fi

  XMINT_RESPONSE=$(curl -sf --max-time 10 \
    -H "x-api-key: ${CROSSMINT_API_KEY}" \
    "${CROSSMINT_BASE}/collections/${CROSSMINT_COLLECTION_ID}" \
    2>/dev/null || echo "CURL_FAILED")

  if [[ "$XMINT_RESPONSE" == "CURL_FAILED" ]]; then
    fail "Crossmint API unreachable (network error)"
  elif echo "$XMINT_RESPONSE" | grep -q '"id"'; then
    pass "Crossmint collection is accessible (ID: ${CROSSMINT_COLLECTION_ID})"
  elif echo "$XMINT_RESPONSE" | grep -q '"error"'; then
    ERR=$(echo "$XMINT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error','unknown'))" 2>/dev/null || echo "unknown")
    fail "Crossmint API returned error: $ERR"
  else
    fail "Crossmint API returned unexpected response (check API key and collection ID)"
  fi
else
  skip "Crossmint check (CROSSMINT_API_KEY or CROSSMINT_COLLECTION_ID not set)"
fi

# ---------------------------------------------------------------------------
# SECTION 7: Discord bot connectivity
# ---------------------------------------------------------------------------
section "7. Discord Bot Connectivity"

if require_env "DISCORD_BOT_TOKEN" && require_env "DISCORD_GUILD_ID"; then
  DISCORD_RESPONSE=$(curl -sf --max-time 10 \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    "https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}" \
    2>/dev/null || echo "CURL_FAILED")

  if [[ "$DISCORD_RESPONSE" == "CURL_FAILED" ]]; then
    fail "Discord API unreachable"
  elif echo "$DISCORD_RESPONSE" | grep -q '"id"'; then
    GUILD_NAME=$(echo "$DISCORD_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name','unknown'))" 2>/dev/null || echo "unknown")
    pass "Discord bot connected to guild: ${GUILD_NAME}"
  else
    fail "Discord API returned unexpected response (check bot token and guild ID)"
  fi
else
  skip "Discord check (DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set)"
fi

# ---------------------------------------------------------------------------
# SECTION 8: Cron endpoint accessibility
# ---------------------------------------------------------------------------
section "8. Cron Endpoint Checks"

for cron_path in "/api/cron/retry-mints" "/api/discord/check-membership"; do
  HTTP_CODE=$(curl -so /dev/null -w "%{http_code}" --max-time 10 "${BASE_URL}${cron_path}" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "401" ]]; then
    # 401 is acceptable — means the endpoint exists but requires Vercel's cron auth header
    pass "Cron endpoint ${cron_path} is reachable (HTTP ${HTTP_CODE})"
  elif [[ "$HTTP_CODE" == "404" ]]; then
    fail "Cron endpoint ${cron_path} returned 404 (function not deployed)"
  else
    fail "Cron endpoint ${cron_path} returned HTTP ${HTTP_CODE}"
  fi
done

# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------
echo ""
echo "=============================================="
echo -e "${BOLD}QA Summary${RESET}"
echo "=============================================="
echo -e "  ${GREEN}Passed:${RESET}  $PASS"
echo -e "  ${RED}Failed:${RESET}  $FAIL"
echo -e "  ${YELLOW}Skipped:${RESET} $SKIP"
echo ""
TOTAL=$((PASS + FAIL))
if [[ $TOTAL -gt 0 ]]; then
  PCT=$(( PASS * 100 / TOTAL ))
  echo "  Pass rate: ${PCT}% (${PASS}/${TOTAL} tests)"
fi
echo ""

if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}All tests passed. Aurevon is ready to deploy.${RESET}"
  exit 0
else
  echo -e "${RED}${BOLD}${FAIL} test(s) failed. Review the output above and fix before going live.${RESET}"
  exit 1
fi
