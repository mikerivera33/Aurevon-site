/**
 * ARCHIVED — Aurevon Web3 subscription tiers
 * ==========================================
 *
 * Removed from active code on 2026-06-02 because no UI on the live site sells these.
 * The audit found backend product definitions but zero buy buttons on /aurevon-web3
 * or anywhere else. Per Mike's call: rip them out so we don't risk advertising a
 * product that doesn't exist; archive the source here so re-introducing them is
 * a copy-paste, not a re-derivation.
 *
 * This file is REFERENCE ONLY. It is not imported by any runtime code path.
 *
 * ── To re-activate ────────────────────────────────────────────────────────────
 *
 * 1) UI: build the Web3 pricing block on /aurevon-web3 (mirror the RE pricing
 *    pattern). Each tier needs a buy button calling openAUREVONPayment({tier, …}).
 *
 * 2) api/_lib/tiers.js → splice these 4 entries back into `_BASE` (next to the
 *    other community/web3-style tiers, before the `addon_*` block):
 *
 *      web3_starter:    { nft: null, amount: 49,  template: null, serialPrefix: null, collectionName: null },
 *      web3_growth:     { nft: null, amount: 149, template: null, serialPrefix: null, collectionName: null },
 *      web3_scale:      { nft: null, amount: 349, template: null, serialPrefix: null, collectionName: null },
 *      web3_enterprise: { nft: null, amount: 799, template: null, serialPrefix: null, collectionName: null },
 *
 * 3) api/stripe/checkout.js → restore the 4 PRODUCT_CATALOG entries:
 *
 *      web3_starter: {
 *        name: 'Aurevon Web3 — Starter',
 *        priceId: 'price_1TUbWM8e9ZIjX9wL1rvz5qpC',   // confirm this is still valid in Stripe
 *        mode: 'subscription',
 *        tier: 'web3_starter',
 *        amount: '49.00',
 *      },
 *      web3_growth: {
 *        name: 'Aurevon Web3 — Growth',
 *        priceId: 'price_1TUbWw8e9ZIjX9wLkSdG65AA',
 *        mode: 'subscription',
 *        tier: 'web3_growth',
 *        amount: '149.00',
 *      },
 *      web3_scale: {
 *        name: 'Aurevon Web3 — Scale',
 *        priceId: 'price_1TUbXO8e9ZIjX9wLWcv9ckWi',
 *        mode: 'subscription',
 *        tier: 'web3_scale',
 *        amount: '349.00',
 *      },
 *      web3_enterprise: {
 *        name: 'Aurevon Web3 — Enterprise',
 *        priceId: 'price_1TUbXi8e9ZIjX9wL1UllvSGy',
 *        mode: 'subscription',
 *        tier: 'web3_enterprise',
 *        amount: '799.00',
 *      },
 *
 *    Also restore the WEB3_TIERS Set + its branch in the success/cancel URL logic:
 *
 *      const WEB3_TIERS = new Set(['web3_starter', 'web3_growth', 'web3_scale', 'web3_enterprise']);
 *      // …
 *      } else if (WEB3_TIERS.has(product.tier)) {
 *        successUrl = `${BASE_URL}/aurevon-web3?purchased=${product.tier}&session_id={CHECKOUT_SESSION_ID}`;
 *        cancelUrl  = `${BASE_URL}/aurevon-web3`;
 *      }
 *
 * 4) api/_lib/crossmint.js → restore the 4 display-name entries in TIER_DISPLAY_NAMES:
 *
 *      web3_starter:    'Web3 Starter',
 *      web3_growth:     'Web3 Growth',
 *      web3_scale:      'Web3 Scale',
 *      web3_enterprise: 'Web3 Enterprise',
 *
 *    And the 4 passType() entries:
 *
 *      web3_starter:    'GENESIS',
 *      web3_growth:     'GENESIS',
 *      web3_scale:      'INSIDER',
 *      web3_enterprise: 'OBSIDIAN',
 *
 * 5) api/_lib/entitlements.js → restore the SKU aliases in ENTITLEMENT_MAP:
 *
 *    monthly_membership.skus  → add 'web3_starter', 'web3_growth'
 *    product_a_reward.skus    → add 'web3_scale'
 *    product_c_reward.skus    → add 'web3_enterprise'
 *
 * 6) Tests: restore the assertions in api/_lib/__tests__/tiers.test.js and
 *    api/_lib/__tests__/entitlements.test.js (the "resolves web3_* …" suites
 *    and the `web3_scale ($349) vs comm_lifetime ($349.99)` exact-match guard).
 *
 * 7) docs/aurevon-membership-automation.md → restore the web3_* entries in the
 *    SKU → entitlement table.
 *
 * 8) Verify Stripe price IDs above are still active in your Stripe dashboard;
 *    if Stripe deleted them after a long inactive period, create new ones and
 *    update the priceId values.
 *
 * 9) Run `npm test` and `npm run lint` — should be green with no edits to other
 *    files.
 *
 * 10) Update CHANGELOG / commit message: "feat: re-activate Web3 subscription
 *     tiers (restored from api/_lib/_archived/web3-subscription-tiers.js)".
 */

// Raw data — preserved as inert object literals for easy splice-back.
// NOT exported — importing this file is a no-op for runtime.

const _ARCHIVED_WEB3_TIERS_TIERS_JS = {
  web3_starter:    { nft: null, amount: 49,  template: null, serialPrefix: null, collectionName: null },
  web3_growth:     { nft: null, amount: 149, template: null, serialPrefix: null, collectionName: null },
  web3_scale:      { nft: null, amount: 349, template: null, serialPrefix: null, collectionName: null },
  web3_enterprise: { nft: null, amount: 799, template: null, serialPrefix: null, collectionName: null },
};

const _ARCHIVED_WEB3_TIERS_CHECKOUT_CATALOG = {
  web3_starter: {
    name: 'Aurevon Web3 — Starter',
    priceId: 'price_1TUbWM8e9ZIjX9wL1rvz5qpC',
    mode: 'subscription',
    tier: 'web3_starter',
    amount: '49.00',
  },
  web3_growth: {
    name: 'Aurevon Web3 — Growth',
    priceId: 'price_1TUbWw8e9ZIjX9wLkSdG65AA',
    mode: 'subscription',
    tier: 'web3_growth',
    amount: '149.00',
  },
  web3_scale: {
    name: 'Aurevon Web3 — Scale',
    priceId: 'price_1TUbXO8e9ZIjX9wLWcv9ckWi',
    mode: 'subscription',
    tier: 'web3_scale',
    amount: '349.00',
  },
  web3_enterprise: {
    name: 'Aurevon Web3 — Enterprise',
    priceId: 'price_1TUbXi8e9ZIjX9wL1UllvSGy',
    mode: 'subscription',
    tier: 'web3_enterprise',
    amount: '799.00',
  },
};

const _ARCHIVED_WEB3_TIERS_CROSSMINT_DISPLAY = {
  web3_starter:    'Web3 Starter',
  web3_growth:     'Web3 Growth',
  web3_scale:      'Web3 Scale',
  web3_enterprise: 'Web3 Enterprise',
};

const _ARCHIVED_WEB3_TIERS_CROSSMINT_PASSTYPE = {
  web3_starter:    'GENESIS',
  web3_growth:     'GENESIS',
  web3_scale:      'INSIDER',
  web3_enterprise: 'OBSIDIAN',
};

const _ARCHIVED_WEB3_TIERS_ENTITLEMENT_SKUS = {
  monthly_membership: ['web3_starter', 'web3_growth'],
  product_a_reward:   ['web3_scale'],
  product_c_reward:   ['web3_enterprise'],
};

// Suppress unused-variable lint by referencing each object once.
// Removing these references won't break anything — they exist purely to silence
// `eslint no-unused-vars` while the file remains an inert archive.
export const _ARCHIVED_WEB3_TIERS = {
  tiers:        _ARCHIVED_WEB3_TIERS_TIERS_JS,
  catalog:      _ARCHIVED_WEB3_TIERS_CHECKOUT_CATALOG,
  display:      _ARCHIVED_WEB3_TIERS_CROSSMINT_DISPLAY,
  passType:     _ARCHIVED_WEB3_TIERS_CROSSMINT_PASSTYPE,
  entitlements: _ARCHIVED_WEB3_TIERS_ENTITLEMENT_SKUS,
};
