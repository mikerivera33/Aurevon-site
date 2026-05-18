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

GENESIS_IMG_CID="PLACEHOLDER_GENESIS_PNG_CID"
GENESIS_VID_CID="PLACEHOLDER_GENESIS_MP4_CID"
CHROME_IMG_CID="PLACEHOLDER_CHROME_PNG_CID"
CHROME_VID_CID="PLACEHOLDER_CHROME_MP4_CID"
INSIDER_IMG_CID="PLACEHOLDER_INSIDER_PNG_CID"
INSIDER_VID_CID="PLACEHOLDER_INSIDER_MP4_CID"
EMBER_IMG_CID="PLACEHOLDER_EMBER_PNG_CID"
EMBER_VID_CID="PLACEHOLDER_EMBER_MP4_CID"
OBSIDIAN_IMG_CID="PLACEHOLDER_OBSIDIAN_PNG_CID"
OBSIDIAN_VID_CID="PLACEHOLDER_OBSIDIAN_MP4_CID"
# ---------------------------------------------------------------------------

mint_nft() {
  local NAME="$1"
  local DESC="$2"
  local IMG_CID="$3"
  local VID_CID="$4"
  local TIER="$5"
  local ACCESS="$6"
  local CATEGORY="$7"
  local PRICING="$8"
  local SERIAL="$9"

  local IMG_URL="${GATEWAY}/${IMG_CID}"
  local VID_URL="${GATEWAY}/${VID_CID}"

  echo ""
  echo "Creating NFT: ${NAME}..."

  RESPONSE=$(curl -s -w "\n%{http_code}" --request POST \
    --url "${BASE_URL}/collections/${COLLECTION_ID}/nfts" \
    --header "Content-Type: application/json" \
    --header "X-API-KEY: ${API_KEY}" \
    --data "{
      \"metadata\": {
        \"name\": \"${NAME}\",
        \"description\": \"${DESC}\",
        \"image\": \"${IMG_URL}\",
        \"animation_url\": \"${VID_URL}\",
        \"external_url\": \"https://aurevon.com\",
        \"attributes\": [
          {\"trait_type\": \"Tier\",         \"value\": \"${TIER}\"},
          {\"trait_type\": \"Access Level\", \"value\": \"${ACCESS}\"},
          {\"trait_type\": \"Category\",     \"value\": \"${CATEGORY}\"},
          {\"trait_type\": \"Pricing\",      \"value\": \"${PRICING}\"},
          {\"trait_type\": \"Serial\",       \"value\": \"${SERIAL}\"},
          {\"trait_type\": \"Chain\",        \"value\": \"Base Ethereum L2\"},
          {\"trait_type\": \"Status\",       \"value\": \"Active Operator\"},
          {\"trait_type\": \"Verification\", \"value\": \"Crossmint + Stripe\"},
          {\"trait_type\": \"Minted\",       \"value\": \"2026 Genesis Drop\"},
          {\"trait_type\": \"Issuer\",       \"value\": \"Aurevon Group LLC\"}
        ]
      }
    }")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -1)

  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    echo "SUCCESS (HTTP $HTTP_CODE)"
    echo "Response: $BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
  else
    echo "ERROR (HTTP $HTTP_CODE): $BODY"
  fi
}

echo "=== Aurevon NFT Template Creation ==="
echo "Collection ID: ${COLLECTION_ID}"
echo "Environment:   ${ENV}"
echo "API Base:      ${BASE_URL}"
echo ""

# GENESIS
mint_nft \
  "Aurevon GENESIS Pass" \
  "Live Aurevon shield NFT Monthly community membership. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial GEN-001-2026." \
  "$GENESIS_IMG_CID" "$GENESIS_VID_CID" \
  "001 Genesis" "Community Access" "Community" "29.99/mo" "GEN-001-2026"

# CHROME
mint_nft \
  "Aurevon CHROME Pass" \
  "Community lifetime access pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial CHR-004-2026." \
  "$CHROME_IMG_CID" "$CHROME_VID_CID" \
  "004 Chrome" "Lifetime Access" "Community Lifetime" "349.99" "CHR-004-2026"

# INSIDER
mint_nft \
  "Aurevon INSIDER Pass" \
  "Full Package RE underwriting Included with service tier. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial INS-250-2026." \
  "$INSIDER_IMG_CID" "$INSIDER_VID_CID" \
  "Aurevon Insider" "Full Package Access" "Underwriting" "250.00" "INS-250-2026"

# EMBER
mint_nft \
  "Aurevon EMBER Pass" \
  "Pro Retainer 6 underwriting deals per month. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial EMB-PRO-2026." \
  "$EMBER_IMG_CID" "$EMBER_VID_CID" \
  "Aurevon Ember" "Pro Retainer Access" "Pro Retainer" "1,499/mo" "EMB-PRO-2026"

# OBSIDIAN
mint_nft \
  "Aurevon OBSIDIAN Pass" \
  "Enterprise tier Unlimited underwriting Apex pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial OBS-APEX-2026." \
  "$OBSIDIAN_IMG_CID" "$OBSIDIAN_VID_CID" \
  "Obsidian Executive" "Apex Enterprise Access" "Enterprise" "2,499/mo" "OBS-APEX-2026"

echo ""
echo "=== Done! ==="
echo "Next steps:"
echo "1. Upload PNGs and MP4s to Pinata (Phase 1)"
echo "2. Update CID variables in this script with real Pinata CIDs"
echo "3. Re-run this script to update NFT metadata with real IPFS URLs"
echo "4. Verify NFTs appear in Crossmint Console under NFTs tab"
