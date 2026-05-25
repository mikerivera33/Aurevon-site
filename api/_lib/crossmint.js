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

const NFT_IMAGES = {
  INSIDER:  'https://gateway.pinata.cloud/ipfs/bafkreidla5efyue3p23ta6djte7kps4e4aohaxuij7yc2eiundhv3pasty',
  EMBER:    'https://gateway.pinata.cloud/ipfs/bafkreifon655t7ru5vrcpnnhsodjal3jb323cjubfx7na4fnp22n6tdb54',
  OBSIDIAN: 'https://gateway.pinata.cloud/ipfs/bafkreie7rhy5sibiocfu5cq7hhwf52tdzgesk3brmj753v2xgulannwsy4',
  GENESIS:  'https://gateway.pinata.cloud/ipfs/bafkreihwovvborajwrljjuiaxhk2lev2l2nxlf5fy27yfh3p74cugt5tfi',
  CHROME:   'https://gateway.pinata.cloud/ipfs/bafkreic3bi6gpnbhgsncizriwbpcniceipxlzn254zdgvzzilfojajlin4',
};

const NFT_ANIMATIONS = {
  INSIDER:  'https://gateway.pinata.cloud/ipfs/bafybeih4nvmx4pqjvhkbaicb6ngl3jl7mr2ypghwnf26vg4mghzqjpd42m',
  EMBER:    'https://gateway.pinata.cloud/ipfs/bafybeidcxh52iyvoymwzpm4z575rtgvlqqnznzzjpt3fqkgyc34tom2ao4',
  OBSIDIAN: 'https://gateway.pinata.cloud/ipfs/bafybeiguz4kqtq3uywhvnhbvlkazaacq3cdnqna6ly2yvyfhwnefhspusq',
  GENESIS:  'https://gateway.pinata.cloud/ipfs/bafybeictzl6vb5pyqe2vplydessfl3nod2rflzajxhqjlrvxly457bcljy',
  CHROME:   'https://gateway.pinata.cloud/ipfs/bafybeiecvoqsrxp27pq43ogp3brqzus53caz3zfbtihibs3w4jfzyqboz4',
};

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
 * Covers all tier keys used in checkout.js PRODUCT_CATALOG.
 */
function tierLabel(tierKey) {
  const labels = {
    // RE tiers
    re_full:         'Full Package',
    re_bogo:         'BOGO Package',
    re_single:       'Second Opinion',
    re_retainer:     'Pro Retainer',
    re_enterprise:   'Enterprise',
    // Base aliases (legacy / direct keys)
    full:            'Full Package',
    bogo:            'BOGO Package',
    single:          'Second Opinion',
    retainer:        'Pro Retainer',
    enterprise:      'Enterprise',
    // Community tiers
    comm_monthly:    'Community Monthly',
    comm_lifetime:   'Community Lifetime',
    // Web3 tiers
    web3_starter:    'Web3 Starter',
    web3_growth:     'Web3 Growth',
    web3_scale:      'Web3 Scale',
    web3_enterprise: 'Web3 Enterprise',
    // Standalone NFT tiers
    nft_insider:     'Insider NFT Pass',
    nft_obsidian:    'Obsidian NFT Pass',
    // Add-ons (no NFT — label for confirmation email)
    addon_rush:        '12-Hour Rush Delivery',
    addon_memo:        'Investor Memo Formatting',
    addon_lender:      'Lender Presentation Package',
    addon_sensitivity: 'Sensitivity Modeling',
    addon_portfolio:   'Portfolio Review Bundle',
    addon_whitelabel:  'White-Label Reports',
  };
  return labels[tierKey] || tierKey;
}

/**
 * Map tier key to pass type (NFT_IMAGES / NFT_ANIMATIONS key).
 * Covers all tier keys used across checkout.js, stripe webhook, and PayPal webhook.
 */
function passType(tierKey) {
  const map = {
    // RE tiers → product NFTs
    re_full:         'INSIDER',
    re_bogo:         'INSIDER',
    re_single:       'GENESIS',  // no NFT minted for single; GENESIS used as safe default
    re_retainer:     'EMBER',
    re_enterprise:   'OBSIDIAN',
    // Base aliases
    full:            'INSIDER',
    bogo:            'INSIDER',
    single:          'GENESIS',
    retainer:        'EMBER',
    enterprise:      'OBSIDIAN',
    // Community
    comm_monthly:    'GENESIS',
    comm_lifetime:   'CHROME',
    // Web3
    web3_starter:    'GENESIS',
    web3_growth:     'GENESIS',
    web3_scale:      'INSIDER',
    web3_enterprise: 'OBSIDIAN',
    // Standalone NFT
    nft_insider:     'INSIDER',
    nft_obsidian:    'OBSIDIAN',
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
      image: NFT_IMAGES[pType] ?? NFT_IMAGES.GENESIS,
      animation_url: NFT_ANIMATIONS[pType] ?? NFT_ANIMATIONS.GENESIS,
      attributes: [
        { trait_type: 'Tier',          value: nftType },
        { trait_type: 'Access Level',  value: tierLabel(tierKey) },
        { trait_type: 'Category',      value: pType },
        { trait_type: 'Serial',        value: serial },
        { trait_type: 'Chain',         value: CROSSMINT_CHAIN === 'base-sepolia' ? 'Base Sepolia' : 'Base Ethereum L2' },
        { trait_type: 'Status',        value: 'Active Operator' },
        { trait_type: 'Rarity',        value: rarity },
        { trait_type: 'Verification',  value: 'Crossmint + Stripe' },
        { trait_type: 'Minted',        value: '2026 Genesis Drop' },
        { trait_type: 'Issuer',        value: 'Aurevon Group LLC' },
        { trait_type: 'Customer',      value: customerName || '' },
        { trait_type: 'Collection',    value: collectionName || 'Aurevon Genesis Drop 2026' },
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
    return { ok: true, actionId: data.actionId, id: data.id, imageUrl: NFT_IMAGES[pType] ?? null, data };
  } catch (err) {
    console.error('[crossmint] Mint exception:', err.message);
    return { ok: false, error: err.message };
  }
}
