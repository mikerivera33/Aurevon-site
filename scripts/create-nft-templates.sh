#!/usr/bin/env bash
# =============================================================================
# create-nft-templates.sh
# Creates all 5 Aurevon NFT tier templates in the Crossmint collection.
# Run ONCE after setting up the collection.
#
# Usage:
#   export CROSSMINT_API_KEY="sk_staging_..."
#   export CROSSMINT_COLLECTION_ID="444de9e1-9da4-4088-bf30-ee2030fe3aeb"
#   export CROSSMINT_ENV="staging"  # or "production"
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
  local SERIAL="$9"

  local IMG_URL="${GATEWAY}/${IMG_CID}.png"
  local VID_URL="${GATEWAY}/${VID_CID}.mp4"

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
        \"external_url\": \"https://aurevon.com\",
        \"attributes\": [
          {\"trait_type\": \"Tier\", \"value\": \"${TIER}\"},
          {\"trait_type\": \"Access Level\", \"value\": \"${ACCESS}\"},
          {\"trait_type\": \"Category\", \"value\": \"${CATEGORY}\"},
          {\"trait_type\": \"Pricing\", \"value\": \"${PRICING}\"},
          {\"trait_type\": \"Serial\", \"value\": \"${SERIAL}\"},
          {\"trait_type\": \"Chain\", \"value\": \"Base Ethereum L2\"},
          {\"trait_type\": \"Status\", \"value\": \"Active Operator\"},
          {\"trait_type\": \"Verification\", \"value\": \"Crossmint + Stripe\"},
          {\"trait_type\": \"Minted\", \"value\": \"2026 Genesis Drop\"},
          {\"trait_type\": \"Issuer\", \"value\": \"Aurevon Group LLC\"}
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
create_template \
  "Aurevon GENESIS Pass" \
  "Live Aurevon shield NFT Monthly community membership. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial GEN-001-2026." \
  "$GENESIS_IMG_CID" "$GENESIS_VID_CID" \
  "001 Genesis" "Community Access" "Community" "29.99/mo" "GEN-001-2026"

# CHROME
create_template \
  "Aurevon CHROME Pass" \
  "Community lifetime access pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial CHR-004-2026." \
  "$CHROME_IMG_CID" "$CHROME_VID_CID" \
  "004 Chrome" "Lifetime Access" "Community Lifetime" "349.99" "CHR-004-2026"

# INSIDER
create_template \
  "Aurevon INSIDER Pass" \
  "Full Package RE underwriting Included with service tier. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial INS-250-2026." \
  "$INSIDER_IMG_CID" "$INSIDER_VID_CID" \
  "Aurevon Insider" "Full Package Access" "Underwriting" "250.00" "INS-250-2026"

# EMBER
create_template \
  "Aurevon EMBER Pass" \
  "Pro Retainer 6 underwriting deals per month. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial EMB-PRO-2026." \
  "$EMBER_IMG_CID" "$EMBER_VID_CID" \
  "Aurevon Ember" "Pro Retainer Access" "Pro Retainer" "1,499/mo" "EMB-PRO-2026"

# OBSIDIAN
create_template \
  "Aurevon OBSIDIAN Pass" \
  "Enterprise tier Unlimited underwriting Apex pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain membership pass minted on Base Ethereum L2. Verification Crossmint Stripe. 2026 Genesis Drop. Serial OBS-APEX-2026." \
  "$OBSIDIAN_IMG_CID" "$OBSIDIAN_VID_CID" \
  "Obsidian Executive" "Apex Enterprise Access" "Enterprise" "2,499/mo" "OBS-APEX-2026"

echo ""
echo "=== Done! ==="
echo "Next steps:"
echo "1. Verify templates appear in Crossmint Console under NFTs > Templates tab"
echo "2. Upload PNGs and MP4s to Pinata (Phase 1) if not done"
echo "3. Update CID variables in this script with real Pinata CIDs"
echo "4. Re-run this script to update template metadata with real IPFS URLs"
