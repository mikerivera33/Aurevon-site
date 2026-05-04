/**
 * Crossmint API wrapper for custodial NFT minting.
 * Delivers NFTs directly to a customer email — no wallet setup required.
 */

import { resolveTemplateId } from './tiers.js';

const CROSSMINT_BASE_URL = 'https://www.crossmint.com/api/2022-06-09';

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
    full:          'Full Package',
    bogo:          'BOGO Package',
    retainer:      'Pro Retainer',
    enterprise:    'Enterprise',
    comm_monthly:  'Community Monthly',
    comm_lifetime: 'Community Lifetime',
    single:        'Second Opinion',
  };
  return labels[tierKey] ?? tierKey;
}

/**
 * Mint an NFT to a customer's email address.
 *
 * @param {{
 *   email: string,
 *   nftType: string,
 *   customerName: string,
 *   templateKey: string,
 *   serial: string,
 *   collectionName: string,
 *   tierKey: string,
 * }} opts
 * @returns {Promise<{ mintId: string, imageUrl: string }>}
 */
export async function mintToEmail({ email, nftType, customerName, templateKey, serial, collectionName, tierKey }) {
  const apiKey = process.env.CROSSMINT_API_KEY;
  const projectId = process.env.CROSSMINT_PROJECT_ID;
  const collectionId = process.env.CROSSMINT_COLLECTION_ID;

  if (!apiKey || !projectId || !collectionId) {
    throw new Error('Missing required Crossmint env vars: CROSSMINT_API_KEY, CROSSMINT_PROJECT_ID, CROSSMINT_COLLECTION_ID');
  }

  const templateId = resolveTemplateId(templateKey);
  if (!templateId) {
    throw new Error(`No templateId found for templateKey="${templateKey}". Set the corresponding env var.`);
  }

  // Parse the serial to extract the numeric edition (e.g. "EMBER_014" → prefix="EMBER", edition=14)
  const serialParts = serial ? serial.split('_') : [];
  const prefix = serialParts[0] ?? '';
  const edition = serialParts[1] ? parseInt(serialParts[1], 10) : 0;

  // On-chain display name: e.g. "Aurevon Ember #014"
  const onChainName = serial
    ? `${nftType} #${String(edition).padStart(3, '0')}`
    : nftType;

  const rarity = RARITY_MAP[prefix] ?? 'Standard';
  const tierLabelStr = tierLabel(tierKey);
  const collectionDisplay = collectionName ?? nftType;

  console.log(`[Crossmint] Minting "${onChainName}" (serial=${serial}) to ${email} using template ${templateId}`);

  const url = `${CROSSMINT_BASE_URL}/collections/${collectionId}/nfts`;

  const body = {
    // Chain: defaults to "base" (Coinbase L2 on Ethereum). Set CROSSMINT_CHAIN=ethereum for L1.
    recipient: `email:${email}:${process.env.CROSSMINT_CHAIN || 'base'}`,
    metadata: {
      name: onChainName,
      description: `Aurevon — ${nftType} membership NFT`,
      serial: serial ?? '',
      edition,
      collection: collectionDisplay,
      tier: tierKey ?? '',
      attributes: [
        { trait_type: 'Collection', value: collectionDisplay.replace(' Collection', '') },
        { trait_type: 'Serial',     value: serial ?? '' },
        { trait_type: 'Edition',    value: edition },
        { trait_type: 'Tier',       value: tierLabelStr },
        { trait_type: 'Rarity',     value: rarity },
        { trait_type: 'Chain',      value: (process.env.CROSSMINT_CHAIN || 'base').charAt(0).toUpperCase() + (process.env.CROSSMINT_CHAIN || 'base').slice(1) },
        { trait_type: 'Recipient',  value: customerName },
        { trait_type: 'Issued',     value: new Date().toISOString().split('T')[0] },
      ],
    },
    // templateId is passed as a top-level field when using template-based minting
    ...(templateId ? { templateId } : {}),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Crossmint mint failed (${response.status}): ${errText}`);
  }

  const data = await response.json();

  const mintId = data.id ?? data.mintId ?? data.actionId ?? 'unknown';
  const imageUrl = data.metadata?.image ?? data.nft?.metadata?.image ?? null;

  console.log(`[Crossmint] Mint initiated. mintId=${mintId}, serial=${serial}, imageUrl=${imageUrl}`);

  return { mintId, imageUrl };
}

/**
 * Poll mint status by ID.
 * @param {string} mintId
 * @returns {Promise<{ status: string, data: object }>}
 */
export async function getMintStatus(mintId) {
  const apiKey = process.env.CROSSMINT_API_KEY;
  const collectionId = process.env.CROSSMINT_COLLECTION_ID;

  const url = `${CROSSMINT_BASE_URL}/collections/${collectionId}/nfts/${mintId}`;

  const response = await fetch(url, {
    headers: { 'X-API-KEY': apiKey },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Crossmint status check failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return { status: data.onChain?.status ?? 'unknown', data };
}
