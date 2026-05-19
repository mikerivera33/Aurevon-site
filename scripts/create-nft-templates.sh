#!/usr/bin/env bash
# =============================================================================
# create-nft-templates.sh
# Creates all 5 Aurevon NFT tier templates in the Crossmint collection.
# Run ONCE after setting up the collection.
#
# Usage:
#   export CROSSMINT_API_KEY="sk_staging_..."
#   export CROSSMINT_COLLECTION_ID="444de9e1-9da4-4088-bf30-ee2030fe3aeb"
#   export CROSSMINT_ENV="staging"   # or "production"
#   bash scripts/create-nft-templates.sh
#
# After running Pinata uploads, update IMAGE_BASE and ANIM_BASE below
# with real IPFS gateway URLs, then re-run to update metadata.
# =============================================================================

set -euo pipefail

API_KEY="${CROSSMINT_API_KEY:?CROSSMINT_API_KEY required}"
COLLECTION_ID="${CROSSMINT_COLLECTION_ID:?CROSSMINT_COLLECTION_ID required}"
ENV="${CROSSMINT_ENV:-staging}"

if [ "$ENV" = "staging" ]; then
  BASE_URL="https://staging.crossmint.com/api/2022-06-09"
else
  BASE_URL="https://www.crossmint.com/api/2022-06-09"
fi

# ---------------------------------------------------------------------------
# UPDATE THESE after Pinata uploads (Phase 1):
# Replace PLACEHOLDER_CID_* with real IPFS CIDs from Pinata
# ---------------------------------------------------------------------------
GATEWAY="https://gateway.pinata.cloud/ipfs"

GENESIS_IMG_CID="bafkreihwovvborajwrljjuiaxhk2lev2l2nxlf5fy27yfh3p74cugt5tfi"
GENESIS_VID_CID="bafybeictzl6vb5pyqe2vplydessfl3nod2rflzajxhqjlrvxly457bcljy"
CHROME_IMG_CID="bafkreic3bi6gpnbhgsncizriwbpcniceipxlzn254zdgvzzilfojajlin4"
CHROME_VID_CID="bafybeiecvoqsrxp27pq43ogp3brqzus53caz3zfbtihibs3w4jfzyqboz4"
INSIDER_IMG_CID="bafkreidla5efyue3p23ta6djte7kps4e4aohaxuij7yc2eiundhv3pasty"
INSIDER_VID_CID="bafybeih4nvmx4pqjvhkbaicb6ngl3jl7mr2ypghwnf26vg4mghzqjpd42m"
EMBER_IMG_CID="bafkreifon655t7ru5vrcpnnhsodjal3jb323cjubfx7na4fnp22n6tdb54"
EMBER_VID_CID="bafybeidcxh52iyvoymwzpm4z575rtgvlqqnznzzjpt3fqkgyc34tom2ao4"
OBSIDIAN_IMG_CID="bafkreie7rhy5sibiocfu5cq7hhwf52tdzgesk3brmj753v2xgulannwsy4"
OBSIDIAN_VID_CID="bafybeiguz4kqtq3uywhvnhbvlkazaacq3cdnqna6ly2yvyfhwnefhspusq"
# ---------------------------------------------------------------------------

create_template() {
  local NAME="$1"
  local DESC="$2"
  local IMG_CID="$3"
  local VID_CID="$4"
  local TIER="$5"
  local ACCESS="$6"
  local CATEGORY="$7"
  local PRICING="$8"
  local ENV_VAR_NAME="$9"

  local IMG_URL="${GATEWAY}/${IMG_CID}"
  local VID_URL="${GATEWAY}/${VID_CID}"

  echo ""
  echo "Creating template: ${NAME}..."

  RESPONSE=$(curl -s -w "\n%{http_code}" --request POST \
    --url "${BASE_URL}/collections/${COLLECTION_ID}/templates" \
    --header "Content-Type: application/json" \
    --header "X-API-KEY: ${API_KEY}" \
    --data "{
      \"metadata\": {
        \"name\": \"${NAME}\",
        \"description\": \"${DESC}\",
        \"image\": \"${IMG_URL}\",
        \"animation_url\": \"${VID_URL}\",
        \"external_url\": \"https://aurevonvc.com\",
        \"attributes\": [
          {\"trait_type\": \"Tier\",         \"value\": \"${TIER}\"},
          {\"trait_type\": \"Access Level\", \"value\": \"${ACCESS}\"},
          {\"trait_type\": \"Category\",     \"value\": \"${CATEGORY}\"},
          {\"trait_type\": \"Pricing\",      \"value\": \"${PRICING}\"},
          {\"trait_type\": \"Chain\",        \"value\": \"Base Ethereum L2\"},
          {\"trait_type\": \"Status\",       \"value\": \"Active Operator\"},
          {\"trait_type\": \"Verification\", \"value\": \"Crossmint + Stripe\"},
          {\"trait_type\": \"Minted\",       \"value\": \"2026 Genesis Drop\"},
          {\"trait_type\": \"Issuer\",       \"value\": \"Aurevon Group LLC\"}
        ]
      },
      \"supply\": { \"limit\": \"unlimited\" }
    }")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -1)

  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    TEMPLATE_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    echo "SUCCESS (HTTP $HTTP_CODE)"
    echo "Template ID: ${TEMPLATE_ID}"
    echo "  → Set Vercel env var: ${ENV_VAR_NAME}=${TEMPLATE_ID}"
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
  else
    echo "ERROR (HTTP $HTTP_CODE): $BODY"
  fi
}

echo "=== Aurevon NFT Template Creation ==="
echo "Collection ID: ${COLLECTION_ID}"
echo "Environment:   ${ENV}"
echo "API Base:      ${BASE_URL}"
echo ""
echo "Templates will be created with unlimited supply."
echo "After creation, copy the template IDs into Vercel env vars."
echo ""

# GENESIS — comm_monthly → CROSSMINT_TEMPLATE_GENESIS
create_template \
  "Aurevon GENESIS Pass" \
  "Live Aurevon shield NFT. Monthly community membership pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop." \
  "$GENESIS_IMG_CID" "$GENESIS_VID_CID" \
  "001 Genesis" "Community Access" "Community" "29.99/mo" "CROSSMINT_TEMPLATE_GENESIS"

# CHROME — comm_lifetime → CROSSMINT_TEMPLATE_CHROME
create_template \
  "Aurevon CHROME Pass" \
  "Community lifetime access pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop." \
  "$CHROME_IMG_CID" "$CHROME_VID_CID" \
  "004 Chrome" "Lifetime Access" "Community Lifetime" "349.99" "CROSSMINT_TEMPLATE_CHROME"

# INSIDER — full/bogo → CROSSMINT_TEMPLATE_INSIDER
create_template \
  "Aurevon INSIDER Pass" \
  "Full Package RE underwriting. Included with service tier. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop." \
  "$INSIDER_IMG_CID" "$INSIDER_VID_CID" \
  "Aurevon Insider" "Full Package Access" "Underwriting" "250.00" "CROSSMINT_TEMPLATE_INSIDER"

# EMBER — retainer → CROSSMINT_TEMPLATE_EMBER
create_template \
  "Aurevon EMBER Pass" \
  "Pro Retainer — 6 underwriting deals per month. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop." \
  "$EMBER_IMG_CID" "$EMBER_VID_CID" \
  "Aurevon Ember" "Pro Retainer Access" "Pro Retainer" "1,499/mo" "CROSSMINT_TEMPLATE_EMBER"

# OBSIDIAN — enterprise → CROSSMINT_TEMPLATE_OBSIDIAN
create_template \
  "Aurevon OBSIDIAN Pass" \
  "Enterprise tier — unlimited underwriting. Apex pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop." \
  "$OBSIDIAN_IMG_CID" "$OBSIDIAN_VID_CID" \
  "Obsidian Executive" "Apex Enterprise Access" "Enterprise" "2,499/mo" "CROSSMINT_TEMPLATE_OBSIDIAN"

echo ""
echo "=== Done! ==="
echo "Next steps:"
echo "1. Copy each 'Set Vercel env var' line above into Vercel Dashboard → Settings → Environment Variables"
echo "2. Verify templates appear in Crossmint Console under the Templates tab"
echo "3. Redeploy on Vercel to pick up the new env vars"
