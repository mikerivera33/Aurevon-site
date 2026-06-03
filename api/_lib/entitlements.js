/**
 * Entitlement engine — single source of truth for SKU→NFT→Discord→Crossmint mapping.
 *
 * Five entitlement types map directly to the five Aurevon NFTs:
 *
 *   monthly_membership  → 001 Genesis  (recurring, revocable)
 *   lifetime_membership → 004 Chrome   (permanent)
 *   product_a_reward    → Aurevon Insider          (permanent, product purchase)
 *   product_b_reward    → Aurevon Ember            (permanent, product purchase)
 *   product_c_reward    → Aurevon Obsidian Executive (permanent, product purchase)
 *
 * SKU aliases cover every tier key used in stripe/checkout.js, webhooks, and PayPal.
 */

/** @typedef {'monthly_membership'|'lifetime_membership'|'product_a_reward'|'product_b_reward'|'product_c_reward'} EntitlementKey */

/** @type {Record} */
export const ENTITLEMENT_MAP = {
  monthly_membership: {
    skus: [
      'comm_monthly',
      'aurevon-monthly',
      'monthly-membership',
      'monthly-pass',
    ],
    nftType: '001 Genesis',
    serialPrefix: 'GENESIS',
    collectionName: 'Aurevon Genesis Collection',
    discordRoleEnv: 'DISCORD_ROLE_MONTHLY',
    collectionEnv: 'CROSSMINT_COLLECTION_MONTHLY',
    templateEnv: 'CROSSMINT_TEMPLATE_GENESIS',
    membershipMode: 'recurring',
    revokeOnCancel: true,
  },
  lifetime_membership: {
    skus: [
      'comm_lifetime',
      'aurevon-lifetime',
      'lifetime-membership',
      'lifetime-pass',
    ],
    nftType: '004 Chrome',
    serialPrefix: 'CHROME',
    collectionName: 'Aurevon Chrome Collection',
    discordRoleEnv: 'DISCORD_ROLE_LIFETIME',
    collectionEnv: 'CROSSMINT_COLLECTION_LIFETIME',
    templateEnv: 'CROSSMINT_TEMPLATE_CHROME',
    membershipMode: 'lifetime',
    revokeOnCancel: false,
  },
  product_a_reward: {
    skus: [
      'full',
      'bogo',
      're_full',
      're_bogo',
      'aurevon-product-a',
      'product-a',
      'insider',
    ],
    nftType: 'Aurevon Insider',
    serialPrefix: 'INSIDER',
    collectionName: 'Aurevon Insider Collection',
    discordRoleEnv: 'DISCORD_ROLE_PRODUCT_A',
    collectionEnv: 'CROSSMINT_COLLECTION_PRODUCT_A',
    templateEnv: 'CROSSMINT_TEMPLATE_INSIDER',
    membershipMode: 'permanent',
    revokeOnCancel: false,
  },
  product_b_reward: {
    skus: [
      'retainer',
      're_retainer',
      'aurevon-product-b',
      'product-b',
      'ember',
    ],
    nftType: 'Aurevon Ember',
    serialPrefix: 'EMBER',
    collectionName: 'Aurevon Ember Collection',
    discordRoleEnv: 'DISCORD_ROLE_PRODUCT_B',
    collectionEnv: 'CROSSMINT_COLLECTION_PRODUCT_B',
    templateEnv: 'CROSSMINT_TEMPLATE_EMBER',
    membershipMode: 'permanent',
    revokeOnCancel: false,
  },
  product_c_reward: {
    skus: [
      'enterprise',
      're_enterprise',
      'aurevon-product-c',
      'product-c',
      'obsidian',
    ],
    nftType: 'Aurevon Obsidian Executive',
    serialPrefix: 'OBSIDIAN',
    collectionName: 'Aurevon Obsidian Collection',
    discordRoleEnv: 'DISCORD_ROLE_PRODUCT_C',
    collectionEnv: 'CROSSMINT_COLLECTION_PRODUCT_C',
    templateEnv: 'CROSSMINT_TEMPLATE_OBSIDIAN',
    membershipMode: 'permanent',
    revokeOnCancel: false,
  },
};

// Build reverse lookup: nftType → entitlement key
const _nftTypeIndex = new Map();
for (const [key, cfg] of Object.entries(ENTITLEMENT_MAP)) {
  _nftTypeIndex.set(cfg.nftType.toLowerCase(), key);
}

// Build reverse lookup: sku → entitlement key
const _skuIndex = new Map();
for (const [key, cfg] of Object.entries(ENTITLEMENT_MAP)) {
  for (const sku of cfg.skus) {
    _skuIndex.set(sku.toLowerCase(), key);
  }
}

/**
 * Resolve entitlement from a SKU / tier key string.
 * Returns null for SKUs that carry no NFT entitlement (e.g. re_single, single, addon_*).
 *
 * @param {string} sku
 * @returns {EntitlementKey|null}
 */
export function resolveEntitlementFromSku(sku) {
  if (!sku) return null;
  return _skuIndex.get(sku.toLowerCase()) ?? null;
}

/**
 * Resolve entitlement from the NFT type string stored in Airtable.
 *
 * @param {string} nftType e.g. "001 Genesis"
 * @returns {EntitlementKey|null}
 */
export function resolveEntitlementFromNftType(nftType) {
  if (!nftType) return null;
  return _nftTypeIndex.get(nftType.toLowerCase()) ?? null;
}

/**
 * Get the Discord role ID for an entitlement key.
 * Returns null if the env var is not set.
 *
 * @param {EntitlementKey} key
 * @returns {string|null}
 */
export function getRoleId(key) {
  const cfg = ENTITLEMENT_MAP[key];
  if (!cfg) return null;
  return process.env[cfg.discordRoleEnv] ?? null;
}

/**
 * Determine whether access should currently be revoked.
 *
 * @param {{
 *   membershipMode: 'recurring'|'lifetime'|'permanent',
 *   revokeOnCancel: boolean,
 *   billingState: 'active'|'cancelled'|'past_due'|'unpaid'|string,
 *   endsAt: Date|string|null,
 *   gracePeriodDays?: number,
 * }} opts
 * @returns {boolean}
 */
export function shouldRevokeAccess({ membershipMode, revokeOnCancel, billingState, endsAt, gracePeriodDays = 7 }) {
  if (!revokeOnCancel) return false;
  if (membershipMode !== 'recurring') return false;
  if (billingState === 'active') return false;
  // Non-active billing states: cancelled, past_due, unpaid
  if (!endsAt) return true; // no end date means revoke immediately
  const end = new Date(endsAt);
  const graceCutoff = new Date(end.getTime() + gracePeriodDays * 86_400_000);
  return Date.now() > graceCutoff.getTime();
}

/**
 * Build the Crossmint recipient object for a mint call.
 *
 * @param {{ email: string, walletAddress?: string|null, chain?: string }} opts
 * @returns {{ email?: string, walletAddress?: string, chain: string }}
 */
export function buildMintRecipient({ email, walletAddress = null, chain = null }) {
  const c = chain ?? process.env.CROSSMINT_CHAIN ?? 'base';
  if (walletAddress) return { walletAddress, chain: c };
  return { email, chain: c };
}
