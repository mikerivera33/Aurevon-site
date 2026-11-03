/**
 * Crossmint API wrapper for custodial NFT minting.
 * Delivers NFTs directly to a customer email — no wallet setup required.
 * Supports both staging (Base Sepolia) and production (Base mainnet).
 */

import { ENTITLEMENT_MAP, resolveEntitlementFromNftType, buildMintRecipient } from './entitlements.js';

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

/** Map pass art key (ENTITLEMENT_MAP serialPrefix) to on-chain rarity trait value. */
const RARITY_MAP = {
  INSIDER:  'Standard',
  EMBER:    'Exclusive',
  OBSIDIAN: 'Executive',
  GENESIS:  'Community',
  CHROME:   'Lifetime',
};

const MINT_TIMEOUT_MS = 12000;

/**
 * Pass art key (INSIDER | EMBER | OBSIDIAN | GENESIS | CHROME) for one of the five
 * canonical NFT types, or null when the type is not one of them. Never defaults.
 * @param {string} nftType e.g. 'Aurevon Ember'
 * @returns {string|null}
 */
export function passArtKeyForNft(nftType) {
  const key = resolveEntitlementFromNftType(nftType);
  return key ? ENTITLEMENT_MAP[key].serialPrefix : null;
}

/**
 * Human-readable access label for an entitlement key (e.g. 'Pro Retainer'), or null.
 * @param {string} key
 * @returns {string|null}
 */
export function accessLabelForEntitlement(key) {
  return ENTITLEMENT_MAP[key]?.accessLabel ?? null;
}

/**
 * Mint one of the five Aurevon NFTs via Crossmint
 * (POST|PUT {base}/2022-06-09/collections/{collectionId}/nfts[/{idempotencyKey}]).
 *
 * The request body carries only fields the documented API accepts:
 * recipient (string), metadata, sendNotification, reuploadLinkedFiles.
 * No customer name/email is written into on-chain metadata.
 *
 * Legacy caller fields (templateKey, customerName, collectionName, tierKey) are
 * accepted and ignored; the entitlement is resolved from `nftType`.
 *
 * @param {object} opts
 * @param {string} [opts.email] - Recipient email (custodial wallet), unless walletAddress given
 * @param {string} opts.nftType - Canonical NFT type (e.g. 'Aurevon Insider')
 * @param {string} [opts.serial] - Serial number for this pass
 * @param {string} [opts.idempotencyKey] - Stable per-purchase key (payment transaction id).
 *   When supplied we mint via the idempotent PUT /collections/{id}/nfts/{key}: a repeat
 *   call with the SAME key returns the already-minted NFT instead of minting again, which
 *   makes orphan-recovery / retry-mints safe. Without a key we use the non-idempotent POST.
 * @param {string|null} [opts.walletAddress] - Deliver to this wallet instead of the email
 * @param {string|null} [opts.entitlementKey] - Overrides resolution from nftType
 * @returns {Promise<{ok: boolean, actionId?: string, id?: string, tokenId?: string|null, imageUrl?: string, error?: string}>}
 */
export async function mintToEmail({
  email,
  nftType,
  serial,
  idempotencyKey,
  walletAddress = null,
  entitlementKey = null,
} = {}) {
  const key = entitlementKey ?? resolveEntitlementFromNftType(nftType);
  const cfg = key ? ENTITLEMENT_MAP[key] : null;
  if (!cfg) throw new Error(`Unknown NFT type: ${nftType}`);

  const apiKey = process.env.CROSSMINT_API_KEY;
  if (!apiKey) throw new Error('CROSSMINT_API_KEY not configured');
  const collectionId = process.env[cfg.collectionEnv] || process.env.CROSSMINT_COLLECTION_ID;
  if (!collectionId) throw new Error(`${cfg.collectionEnv} / CROSSMINT_COLLECTION_ID not configured`);
  if (!email && !walletAddress) throw new Error('Mint recipient requires an email or walletAddress');

  const artKey = cfg.serialPrefix;
  const imageUrl = NFT_IMAGES[artKey];
  const chainLabel = CROSSMINT_CHAIN === 'base-sepolia' ? 'Base Sepolia' : 'Base Ethereum L2';

  // Crossmint restricts the path id, so sanitize to a safe charset and bound the
  // length; the payment transaction id (cs_live_… / PayPal txn) stays unique.
  const safeKey = idempotencyKey
    ? String(idempotencyKey).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100)
    : null;
  const method = safeKey ? 'PUT' : 'POST';
  const url = safeKey
    ? `${CROSSMINT_BASE_URL}/collections/${collectionId}/nfts/${safeKey}`
    : `${CROSSMINT_BASE_URL}/collections/${collectionId}/nfts`;

  const body = {
    recipient: buildMintRecipient({ email, walletAddress, chain: CROSSMINT_CHAIN }),
    metadata: {
      name: `Aurevon ${artKey} Pass`,
      image: imageUrl,
      description: `${cfg.accessLabel} membership pass. Aurevon Ventures LLC Systems Capital Infrastructure. On-chain on ${CROSSMINT_CHAIN === 'base-sepolia' ? 'Base Sepolia (testnet)' : 'Base Ethereum L2'}. Serial: ${serial}.`,
      animation_url: NFT_ANIMATIONS[artKey],
      attributes: [
        { trait_type: 'Tier',          value: cfg.nftType },
        { trait_type: 'Access Level',  value: cfg.accessLabel },
        { trait_type: 'Category',      value: artKey },
        { trait_type: 'Serial',        value: String(serial ?? '') },
        { trait_type: 'Chain',         value: chainLabel },
        { trait_type: 'Rarity',        value: RARITY_MAP[artKey] },
        { trait_type: 'Issuer',        value: 'Aurevon Ventures LLC' },
        { trait_type: 'Collection',    value: cfg.collectionName },
        { trait_type: 'Status',        value: 'Active Operator' },
        { trait_type: 'Verification',  value: 'Crossmint + Stripe' },
        { trait_type: 'Minted',        value: '2026 Genesis Drop' },
      ],
    },
    sendNotification: false,
    reuploadLinkedFiles: false,
  };

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(MINT_TIMEOUT_MS),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`[crossmint] Mint failed (${response.status}):`, data?.message || data);
      return { ok: false, error: data?.message || `Crossmint API error ${response.status}`, detail: data };
    }

    console.log(`[crossmint] Minted ${artKey} pass: actionId=${data.actionId}`);
    return {
      ok: true,
      actionId: data.actionId,
      id: data.id,
      tokenId: data?.onChain?.tokenId ?? null,
      imageUrl,
    };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      console.error('[crossmint] Mint timed out');
      return { ok: false, error: 'Crossmint timeout' };
    }
    console.error('[crossmint] Mint exception:', err?.message);
    return { ok: false, error: err?.message || 'Crossmint request failed' };
  }
}
