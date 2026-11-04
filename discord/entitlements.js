/**
 * Entitlement table for the Railway gateway bot — a hand-copied subset of
 * api/_lib/entitlements.js ENTITLEMENT_MAP (the bot deploys on its own and
 * cannot import from api/). Dependency-free, pure functions only.
 *
 * Kept in lockstep by api/_lib/__tests__/bot-entitlement-parity.test.js: any
 * difference in nftType / discordRoleEnv / revokeOnCancel / membershipMode, or
 * in the grant rule, fails the site's test suite.
 *
 * Mint and member records use the bot's `{ id, fields }` shape:
 *   mint.fields['NFT Type'], member fields 'Billing State' / 'Entitlement Expires At'.
 */

export const ENTITLEMENTS = Object.freeze([
  { key: 'monthly_membership',  nftType: '001 Genesis',                discordRoleEnv: 'DISCORD_ROLE_MONTHLY',   revokeOnCancel: true,  membershipMode: 'recurring', label: 'Genesis' },
  { key: 'lifetime_membership', nftType: '004 Chrome',                 discordRoleEnv: 'DISCORD_ROLE_LIFETIME',  revokeOnCancel: false, membershipMode: 'lifetime',  label: 'Chrome' },
  { key: 'product_a_reward',    nftType: 'Aurevon Insider',            discordRoleEnv: 'DISCORD_ROLE_PRODUCT_A', revokeOnCancel: false, membershipMode: 'permanent', label: 'Insider' },
  { key: 'product_b_reward',    nftType: 'Aurevon Ember',              discordRoleEnv: 'DISCORD_ROLE_PRODUCT_B', revokeOnCancel: false, membershipMode: 'permanent', label: 'Ember' },
  { key: 'product_c_reward',    nftType: 'Aurevon Obsidian Executive', discordRoleEnv: 'DISCORD_ROLE_PRODUCT_C', revokeOnCancel: false, membershipMode: 'permanent', label: 'Obsidian Executive' },
].map(Object.freeze));

const BY_KEY = new Map(ENTITLEMENTS.map((e) => [e.key, e]));
const BY_NFT = new Map(ENTITLEMENTS.map((e) => [e.nftType.toLowerCase(), e]));

/** Entitlement row for a key, or null. */
export function entitlementByKey(key) {
  return BY_KEY.get(key) ?? null;
}

/**
 * Entitlement key for an NFT type — case-insensitive EXACT match (surrounding
 * whitespace ignored), never a substring. Null for anything else.
 * @param {string|null|undefined} nftType
 * @returns {string|null}
 */
export function resolveEntitlementForNft(nftType) {
  if (typeof nftType !== 'string') return null;
  return BY_NFT.get(nftType.trim().toLowerCase())?.key ?? null;
}

/** Role env var name (e.g. 'DISCORD_ROLE_MONTHLY') for an NFT type, or null. */
export function resolveRoleEnvForNft(nftType) {
  const key = resolveEntitlementForNft(nftType);
  return key ? BY_KEY.get(key).discordRoleEnv : null;
}

/**
 * Same rule as mayGrantPaidAccess in api/_lib/entitlements.js:
 * a non-revocable pass always grants; billing null / 'active' / 'trialing'
 * grants; any other state grants only within `graceDays` after `endsAt`;
 * no `endsAt` → refused.
 * @param {{ key: string|null|undefined, billingState?: string|null, endsAt?: Date|string|null, graceDays?: number, now?: number }} opts
 * @returns {boolean}
 */
export function mayGrant({ key, billingState = null, endsAt = null, graceDays = 7, now = Date.now() }) {
  const cfg = key ? BY_KEY.get(key) : null;
  if (!cfg?.revokeOnCancel) return true;
  if (!billingState || billingState === 'active' || billingState === 'trialing') return true;
  if (cfg.membershipMode !== 'recurring') return true;
  if (!endsAt) return false;
  const cutoff = new Date(endsAt).getTime() + graceDays * 86_400_000;
  return !(now > cutoff);
}

function grantCheck(key, memberFields, graceDays) {
  return mayGrant({
    key,
    billingState: memberFields?.['Billing State'] ?? null,
    endsAt: memberFields?.['Entitlement Expires At'] ?? null,
    graceDays,
  });
}

const mintKey = (mint) => resolveEntitlementForNft(mint?.fields?.['NFT Type']);

/**
 * Every entitlement key the member's active mints still grant (unique, mint
 * order). A lapsed monthly never hides a permanent pass.
 */
export function grantableKeys(mints, memberFields, graceDays = 7) {
  const keys = [];
  for (const mint of mints ?? []) {
    const key = mintKey(mint);
    if (!key || keys.includes(key)) continue;
    if (grantCheck(key, memberFields, graceDays)) keys.push(key);
  }
  return keys;
}

/** Unique role env names for grantableKeys. */
export function grantableRoleEnvs(mints, memberFields, graceDays = 7) {
  const envs = [];
  for (const key of grantableKeys(mints, memberFields, graceDays)) {
    const env = BY_KEY.get(key).discordRoleEnv;
    if (!envs.includes(env)) envs.push(env);
  }
  return envs;
}

/**
 * Role env names to take away: only revocable (monthly) entitlements the member
 * holds a mint for that billing no longer grants. Never a permanent/lifetime pass.
 */
export function obsoleteRoleEnvs(mints, memberFields, graceDays = 7) {
  const granted = grantableKeys(mints, memberFields, graceDays);
  const envs = [];
  for (const mint of mints ?? []) {
    const key = mintKey(mint);
    if (!key || granted.includes(key)) continue;
    const cfg = BY_KEY.get(key);
    if (cfg.revokeOnCancel && !envs.includes(cfg.discordRoleEnv)) envs.push(cfg.discordRoleEnv);
  }
  return envs;
}
