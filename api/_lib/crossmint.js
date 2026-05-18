/**
 * Crossmint API wrapper for custodial NFT minting.
 * Delivers NFTs directly to a customer email — no wallet setup required.
 * Supports both staging (Base Sepolia) and production (Base mainnet).
 */

import { resolveTemplateId } from './tiers.js';

const IS_STAGING = process.env.CROSSMINT_ENV === 'staging';
const CROSSMINT_BASE_URL = IS_STAGING
  ? 'https://staging.crossmint.com/api/2022-06-09'
  : 'https://www.crossmint.com/api/2022-06-09';

const CROSSMINT_CHAIN = process.env.CROSSMINT_CHAIN || (IS_STAGING ? 'base-sepolia' : 'base');

/** Map tier serial prefix to on-chain rarity trait value. */
const RARITY_MAP = {
  INSIDER:  'Standard',
  EMBER:    'Exclusive',
  OBSIDIAN: 'Apex',
  GENESIS:  'Community',
  CHROME:   'Lifetime',
};

/**
 * Derive the human-readable tier label used in NFT attributes.
 */
function tierLabel(tierKey) {
  const labels = {
    full:         'Full Package',
    bogo:         'BOGO Package',
    retainer:     'Pro Retainer',
    enterprise:   'Enterprise',
    comm_monthly: 'Community Monthly',
    comm_lifetime:'Community Lifetime',
  };
  return labels[tierKey] || tierKey;
}

/**
 * Map tier key to pass type used in NFT name and template lookup.
 */
function passType(tierKey) {
  const map = {
    full:         'INSIDER',
    bogo:         'INSIDER',
    retainer:     'EMBER',
    enterprise:   'OBSIDIAN',
    comm_monthly: 'GENESIS',
    comm_lifetime:'CHROME',
  };
  return map[tierKey] || 'GENESIS';
}

/**
 * Mint an NFT to a customer email address via Crossmint API.
 * Called automatically after a successful Stripe or PayPal payment.
 *
 * @param {string} email - Customer email (NFT delivered here)
 * @param {string} nftType - Human-readable NFT name (e.g. 'Aurevon Insider')
 * @param {string} customerName - Customer display name
 * @param {string} templateKey - Env var key for Crossmint template ID
 * @param {string} serial - Unique serial number for this pass
 * @param {string} collectionName - Collection name for metadata
 * @param {string} tierKey - Internal tier key
 * @returns {Promise<{ok: boolean, actionId?: string, error?: string}>}
 */
export async function mintToEmail({
  email,
  nftType,
  customerName,
  templateKey,
  serial,
  collectionName,
  tierKey,
}) {
  const apiKey = process.env.CROSSMINT_API_KEY;
  const collectionId = process.env.CROSSMINT_COLLECTION_ID;

  if (!apiKey) throw new Error('CROSSMINT_API_KEY not configured');
  if (!collectionId) throw new Error('CROSSMINT_COLLECTION_ID not configured');

  const templateId = resolveTemplateId(templateKey);
  const pType = passType(tierKey);
  const rarity = RARITY_MAP[pType] || 'Standard';

  const url = `${CROSSMINT_BASE_URL}/collections/${collectionId}/nfts`;

  const body = {
    recipient: { email },
    metadata: {
      name: `Aurevon ${pType} Pass`,
      description: `${tierLabel(tierKey)} membership pass. Aurevon Group LLC Systems Capital Infrastructure. On-chain on ${CROSSMINT_CHAIN === 'base-sepolia' ? 'Base Sepolia (testnet)' : 'Base Ethereum L2'}. Serial: ${serial}.`,
      image: `https://aurevon-site.vercel.app/nfts/${pType.toLowerCase()}.html`,
      attributes: [
        { trait_type: 'Tier',         value: nftType },
        { trait_type: 'Access Level', value: tierLabel(tierKey) },
        { trait_type: 'Category',     value: pType },
        { trait_type: 'Serial',       value: serial },
        { trait_type: 'Chain',        value: CROSSMINT_CHAIN === 'base-sepolia' ? 'Base Sepolia' : 'Base Ethereum L2' },
        { trait_type: 'Status',       value: 'Active Operator' },
        { trait_type: 'Rarity',       value: rarity },
        { trait_type: 'Verification', value: 'Crossmint + Stripe' },
        { trait_type: 'Minted',       value: '2026 Genesis Drop' },
        { trait_type: 'Issuer',       value: 'Aurevon Group LLC' },
        { trait_type: 'Customer',     value: customerName || '' },
        { trait_type: 'Collection',   value: collectionName || 'Aurevon Genesis Drop 2026' },
      ],
    },
  };

  if (templateId) body.templateId = templateId;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[crossmint] Mint failed:', data);
      return { ok: false, error: data?.message || 'Crossmint API error', detail: data };
    }

    console.log(`[crossmint] Minted NFT to ${email}: actionId=${data.actionId}`);
    return { ok: true, actionId: data.actionId, id: data.id, data };
  } catch (err) {
    console.error('[crossmint] Mint exception:', err.message);
    return { ok: false, error: err.message };
  }
}
