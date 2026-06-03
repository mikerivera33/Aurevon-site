/**
 * Tier → NFT mapping (legacy compatibility layer).
 *
 * Canonical entitlement logic lives in entitlements.js.
 * This file is preserved for the stripe/paypal webhook handlers
 * that use TIER_NFT_MAP + inferTierFromAmount + getNextSerial.
 *
 * The `re_*` aliases added below fix a silent bug where
 * stripe/checkout.js sets metadata.tier="re_full" but TIER_NFT_MAP
 * only had "full", causing the webhook to fail entitlement resolution.
 *
 * NOTE: web3_* tiers were archived 2026-06-02 (no UI sold them).
 * See api/_lib/_archived/web3-subscription-tiers.js to re-activate.
 */

const _BASE = {
  single:         { nft: null,                           amount: 189.99, template: null,                          serialPrefix: null,       collectionName: null },
  full:           { nft: 'Aurevon Insider',               amount: 250,    template: 'CROSSMINT_TEMPLATE_INSIDER',  serialPrefix: 'INSIDER',  collectionName: 'Aurevon Insider Collection' },
  bogo:           { nft: null,                            amount: 299.99, template: null,                          serialPrefix: null,       collectionName: null },
  retainer:       { nft: 'Aurevon Ember',                 amount: 1499,   template: 'CROSSMINT_TEMPLATE_EMBER',    serialPrefix: 'EMBER',    collectionName: 'Aurevon Ember Collection' },
  enterprise:     { nft: 'Aurevon Obsidian Executive',    amount: 2499,   template: 'CROSSMINT_TEMPLATE_OBSIDIAN', serialPrefix: 'OBSIDIAN', collectionName: 'Aurevon Obsidian Collection' },
  comm_monthly:   { nft: '001 Genesis',                   amount: 29.99,  template: 'CROSSMINT_TEMPLATE_GENESIS',  serialPrefix: 'GENESIS',  collectionName: 'Aurevon Genesis Collection' },
  comm_lifetime:  { nft: '004 Chrome',                    amount: 349.99, template: 'CROSSMINT_TEMPLATE_CHROME',   serialPrefix: 'CHROME',   collectionName: 'Aurevon Chrome Collection' },
  deal:           { nft: null,                           amount: 189.99, template: null,                          serialPrefix: null,       collectionName: null },
  // RE À La Carte Add-Ons — no NFT
  addon_rush:         { nft: null, amount: 99,  template: null, serialPrefix: null, collectionName: null },
  addon_memo:         { nft: null, amount: 149, template: null, serialPrefix: null, collectionName: null },
  addon_lender:       { nft: null, amount: 199, template: null, serialPrefix: null, collectionName: null },
  addon_sensitivity:  { nft: null, amount: 125, template: null, serialPrefix: null, collectionName: null },
  addon_portfolio:    { nft: null, amount: 499, template: null, serialPrefix: null, collectionName: null },
  addon_whitelabel:   { nft: null, amount: 175, template: null, serialPrefix: null, collectionName: null },
};

// Alias map: checkout tier keys → canonical tier keys
const _ALIASES = {
  re_full:      'full',
  re_bogo:      'bogo',
  re_single:    'single',
  re_retainer:  'retainer',
  re_enterprise: 'enterprise',
};

// Resolve aliases so callers can use any tier key
export const TIER_NFT_MAP = new Proxy({}, {
  get(_, key) {
    return _BASE[key] ?? _BASE[_ALIASES[key]] ?? undefined;
  },
  has(_, key) {
    return key in _BASE || key in _ALIASES;
  },
  ownKeys() {
    return [...Object.keys(_BASE), ...Object.keys(_ALIASES)];
  },
  getOwnPropertyDescriptor(_, key) {
    const val = _BASE[key] ?? _BASE[_ALIASES[key]];
    if (!val) return undefined;
    return { value: val, writable: false, enumerable: true, configurable: true };
  },
});

/**
 * Format a serial number as PREFIX_NNN.
 */
export function formatSerial(prefix, number) {
  const padded = number < 1000 ? String(number).padStart(3, '0') : String(number);
  return `${prefix}_${padded}`;
}

/**
 * Return the next serial string for a given prefix by querying Airtable.
 */
export async function getNextSerial(prefix) {
  const { countNftMintsByPrefix } = await import('./airtable.js');
  const count = await countNftMintsByPrefix(prefix);
  return formatSerial(prefix, count + 1);
}

/**
 * Infer canonical tier key from Stripe amount_total (cents).
 */
export function inferTierFromAmount(amountCents) {
  const dollars = amountCents / 100;
  // Exact match first to avoid tolerance collisions when two tier prices land within $1 of each other
  for (const [tier, cfg] of Object.entries(_BASE)) {
    if (dollars === cfg.amount) return tier;
  }
  // Tolerance fallback for payment processors that round cents
  const tolerance = 1;
  for (const [tier, cfg] of Object.entries(_BASE)) {
    if (Math.abs(dollars - cfg.amount) <= tolerance) return tier;
  }
  return null;
}

/**
 * Resolve Crossmint template ID from an env var name.
 */
export function resolveTemplateId(templateKey) {
  if (!templateKey) return null;
  return process.env[templateKey] ?? null;
}
