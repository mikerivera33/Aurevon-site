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

import { sendAlert } from './alert.js';

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
    accessLabel: 'Community Monthly',
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
    accessLabel: 'Community Lifetime',
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
      're_full',
      'aurevon-product-a',
      'product-a',
      'insider',
    ],
    nftType: 'Aurevon Insider',
    serialPrefix: 'INSIDER',
    accessLabel: 'Full Package',
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
    accessLabel: 'Pro Retainer',
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
    accessLabel: 'Enterprise',
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
 * Resolve entitlement from the NFT type string stored on the mint row.
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
 * Whether Discord role grant / access-link redemption is allowed for this
 * entitlement given the member's billing fields.
 *
 * Permanent and lifetime NFTs always grant (revokeOnCancel is false). Recurring
 * monthly membership grants unless billing is explicitly non-active AND past
 * the grace window. Missing billing fields do not block — the first invoice
 * webhook may still be in flight when a new buyer clicks their Discord link.
 *
 * @param {{
 *   entitlementKey: EntitlementKey|null|undefined,
 *   billingState?: string|null,
 *   endsAt?: Date|string|null,
 *   gracePeriodDays?: number,
 * }} opts
 * @returns {boolean}
 */
export function mayGrantPaidAccess({ entitlementKey, billingState = null, endsAt = null, gracePeriodDays = 7 }) {
  const cfg = entitlementKey ? ENTITLEMENT_MAP[entitlementKey] : null;
  if (!cfg?.revokeOnCancel) return true;
  if (!billingState || billingState === 'active' || billingState === 'trialing') return true;
  return !shouldRevokeAccess({
    membershipMode: cfg.membershipMode,
    revokeOnCancel: cfg.revokeOnCancel,
    billingState,
    endsAt,
    gracePeriodDays,
  });
}

/**
 * Convenience wrapper over mayGrantPaidAccess that reads member record fields.
 * @param {EntitlementKey|null|undefined} entitlementKey
 * @param {Record<string, unknown>|null|undefined} memberFields
 * @returns {boolean}
 */
export function mayGrantPaidAccessFromMember(entitlementKey, memberFields) {
  const gracePeriodDays = parseInt(process.env.ENTITLEMENT_GRACE_PERIOD_DAYS ?? '7', 10);
  return mayGrantPaidAccess({
    entitlementKey,
    billingState: memberFields?.['Billing State'] ?? null,
    endsAt: memberFields?.['Entitlement Expires At'] ?? null,
    gracePeriodDays: Number.isFinite(gracePeriodDays) ? gracePeriodDays : 7,
  });
}

/**
 * Build the Crossmint recipient string for a mint call:
 * `email:<email>:<chain>` (custodial wallet) or `<chain>:<walletAddress>`.
 * Chain defaults to CROSSMINT_CHAIN, else base-sepolia on staging, else base.
 *
 * @param {{ email?: string|null, walletAddress?: string|null, chain?: string|null }} opts
 * @returns {string}
 */
export function buildMintRecipient({ email = null, walletAddress = null, chain = null } = {}) {
  const c = chain || process.env.CROSSMINT_CHAIN
    || (process.env.CROSSMINT_ENV === 'staging' ? 'base-sepolia' : 'base');
  if (walletAddress) return `${c}:${walletAddress}`;
  return `email:${String(email ?? '').trim().toLowerCase()}:${c}`;
}

/**
 * Billing fields to use when the member lookup itself failed: treated as
 * non-active, so revocable (monthly) passes are refused — fail closed — while
 * permanent / lifetime passes still grant.
 */
export const UNKNOWN_BILLING_FIELDS = Object.freeze({ 'Billing State': 'unknown' });

const mintEntitlement = (mint) => resolveEntitlementFromNftType(mint?.fields?.['NFT Type'] ?? '');

/**
 * Every entitlement a member's active mints still grant, given their billing
 * fields — unique, in mint order. A lapsed monthly Genesis row is skipped, never
 * hiding a permanent pass; a member with Chrome + Insider gets both.
 * @param {Array<{fields?: Record<string, unknown>}>} mints
 * @param {Record<string, unknown>|null|undefined} memberFields
 * @returns {EntitlementKey[]}
 */
export function grantableEntitlements(mints, memberFields) {
  const keys = [];
  for (const mint of mints ?? []) {
    const key = mintEntitlement(mint);
    if (!key || keys.includes(key)) continue;
    if (mayGrantPaidAccessFromMember(key, memberFields)) keys.push(key);
  }
  return keys;
}

/**
 * Discord role ids for grantableEntitlements (unique, same order). An
 * entitlement whose DISCORD_ROLE_* env is unset is dropped and raises a
 * `discord.role_not_configured` alert; the rest are still returned.
 * @param {Array<{fields?: Record<string, unknown>}>} mints
 * @param {Record<string, unknown>|null|undefined} memberFields
 * @returns {string[]}
 */
export function grantableRoleIds(mints, memberFields) {
  const ids = [];
  for (const key of grantableEntitlements(mints, memberFields)) {
    const roleId = getRoleId(key);
    if (!roleId) {
      console.error(`[entitlements] no Discord role configured for ${key} (${ENTITLEMENT_MAP[key].discordRoleEnv})`);
      // Best-effort and not awaited: keeps this a plain function for every caller.
      try {
        Promise.resolve(sendAlert('discord.role_not_configured',
          { entitlement: key, env: ENTITLEMENT_MAP[key].discordRoleEnv },
          { severity: 'high', dedupeKey: key })).catch(() => {});
      } catch { /* alerting never blocks a grant */ }
      continue;
    }
    if (!ids.includes(roleId)) ids.push(roleId);
  }
  return ids;
}

/**
 * Roles to take away while granting: only revocable (monthly) entitlements the
 * member holds a mint for but that billing no longer grants. A permanent or
 * lifetime pass's role is never returned, nor any role that is also granted.
 * @param {Array<{fields?: Record<string, unknown>}>} mints
 * @param {Record<string, unknown>|null|undefined} memberFields
 * @returns {string[]}
 */
export function obsoleteRoleIds(mints, memberFields) {
  const granted = grantableEntitlements(mints, memberFields);
  const grantedRoles = new Set(granted.map(getRoleId).filter(Boolean));
  const ids = [];
  for (const mint of mints ?? []) {
    const key = mintEntitlement(mint);
    if (!key || !ENTITLEMENT_MAP[key].revokeOnCancel || granted.includes(key)) continue;
    const roleId = getRoleId(key);
    if (roleId && !grantedRoles.has(roleId) && !ids.includes(roleId)) ids.push(roleId);
  }
  return ids;
}

/**
 * The first active mint whose entitlement may still be granted (the mint behind
 * grantableEntitlements()[0]). Kept for callers that need one row. Null when none.
 * @param {Array<{fields?: Record<string, unknown>}>} mints
 * @param {Record<string, unknown>|null|undefined} memberFields
 */
export function pickGrantableMint(mints, memberFields) {
  for (const mint of mints ?? []) {
    const key = mintEntitlement(mint);
    if (!key) continue;
    if (mayGrantPaidAccessFromMember(key, memberFields)) return mint;
  }
  return null;
}
