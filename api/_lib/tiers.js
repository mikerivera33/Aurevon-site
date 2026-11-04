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
 * Canonical (bare) tier key: strips the checkout `re_` prefix
 * (`re_full` → `full`); any other value is returned unchanged.
 * Used for the stored NFT_Mints `Tier Source`.
 */
export function canonicalTier(tier) {
  return typeof tier === 'string' ? tier.replace(/^re_/, '') : tier;
}

/**
 * PayPal hosted-button item numbers → tier, from env `PAYPAL_ITEM_TIERS`
 * (JSON `{ "<item_number>": "<tier>" }`). Parsed once per distinct env value.
 * Values are canonicalised (`re_full` → `full`); entries naming a tier that is
 * not in the catalog are dropped. Invalid JSON (or a non-object) → empty map
 * with `invalid: true` so the caller can alert once.
 *
 * The map is only a HINT: a forged Buy Now form can set item_number too, so the
 * IPN handler trusts a mapped tier only when the USD paid matches its price.
 *
 * @returns {{ map: Readonly<Record<string,string>>, invalid: boolean, dropped: string[], raw: string }}
 */
let _itemTiers = null;
export function paypalItemTiers() {
  const raw = String(process.env.PAYPAL_ITEM_TIERS ?? '').trim();
  if (_itemTiers && _itemTiers.raw === raw) return _itemTiers;
  const map = {};
  const dropped = [];
  let invalid = false;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [item, tier] of Object.entries(parsed)) {
        const key = canonicalTier(typeof tier === 'string' ? tier.trim() : '');
        if (key && Object.hasOwn(_BASE, key)) map[String(item).trim()] = key;
        else dropped.push(String(item));
      }
    } catch {
      invalid = true;
    }
  }
  _itemTiers = { map: Object.freeze(map), invalid, dropped, raw };
  return _itemTiers;
}

// Only Aurevon Capital underwriting purchases unlock the deal-intake form —
// not community memberships or stand-alone add-ons. Stripe metadata carries
// the prefixed checkout key (re_full); PayPal rows carry the bare key (full).
// Lives here (dependency-free) so email.js can use it without pulling in the
// Stripe SDK; intake-verify.js re-exports it.
export const INTAKE_TIERS = new Set(['single', 'full', 'bogo', 'retainer', 'enterprise', 'deal']);
export function isIntakeTier(tier) {
  return INTAKE_TIERS.has(String(tier ?? '').trim().toLowerCase().replace(/^re_/, ''));
}

/** Proof-of-payment id formats the deal-intake gate accepts. */
export const STRIPE_SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]+$/;
export const PAYPAL_TXN_RE = /^[A-Za-z0-9]{8,32}$/;

/**
 * Format a serial number as PREFIX_NNN.
 */
export function formatSerial(prefix, number) {
  const padded = number < 1000 ? String(number).padStart(3, '0') : String(number);
  return `${prefix}_${padded}`;
}

/**
 * Reserve the next serial string for a prefix (atomic Postgres counter).
 *
 * While the Airtable bridge is on, old Airtable mints may not be copied yet, so
 * keep reserving until the number is past the Airtable count (bounded).
 */
export async function getNextSerial(prefix) {
  const { nextSerial } = await import('./db.js');
  let n = await nextSerial(prefix);
  const { airtableImportEnabled, countAirtableMintsByPrefix } = await import('./airtable-import.js');
  if (airtableImportEnabled()) {
    let airtableCount = 0;
    try { airtableCount = await countAirtableMintsByPrefix(prefix); } catch (err) {
      console.error(`[tiers] Airtable serial count failed for ${prefix}: ${err.message}`);
    }
    for (let i = 0; i < 50 && n <= airtableCount; i++) n = await nextSerial(prefix);
    if (n <= airtableCount) throw new Error(`Serial for ${prefix} still behind Airtable count after 50 reservations`);
  }
  return formatSerial(prefix, n);
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
