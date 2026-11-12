/**
 * PayPal IPN tier inference (F1).
 *
 * The hosted PayPal NCP links generally can't attach a per-transaction `custom`
 * field, so tier resolution falls back to the payment amount. The original code
 * used an EXACT amount match (no tolerance), so any processor rounding / minor
 * price drift resolved to null → the no-NFT branch → the mint was silently
 * dropped. inferTierFromIPN must reuse the $1-tolerant inferTierFromAmount that
 * the Stripe webhook already relies on, while staying restricted to the tiers
 * that are actually sold via PayPal (so an add-on price can't masquerade as a
 * mintable tier).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Stub the heavy side-effect deps so importing the webhook module is clean;
// tiers.js is intentionally NOT mocked — inferTierFromIPN must use the real map.
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../db.js', () => ({
  createPayment: vi.fn(), createNftMint: vi.fn(),
  // fulfil.js (shared NFT fulfilment):
  findMintByPaymentId: vi.fn(), updateNftMint: vi.fn(), findMemberByEmail: vi.fn(), updateDiscordSyncStatus: vi.fn(),
}));
vi.mock('../email.js', () => ({ sendNftDelivery: vi.fn(), sendPurchaseConfirmation: vi.fn() }));

import { inferTierFromIPN, ipnTxnType } from '../../webhooks/paypal.js';
import { paypalItemTiers } from '../tiers.js';

describe('inferTierFromIPN', () => {
  it('resolves an exact amount to its tier', () => {
    expect(inferTierFromIPN({ mc_gross: '250.00' })).toBe('full');
    expect(inferTierFromIPN({ mc_gross: '2499.00' })).toBe('enterprise');
    expect(inferTierFromIPN({ mc_gross: '1499.00' })).toBe('retainer');
  });

  it('resolves an amount within $1 tolerance (the F1 fix)', () => {
    // $2498.50 is within $1 of enterprise ($2499) — previously returned null,
    // routing a paying buyer to the no-NFT branch with no recovery.
    expect(inferTierFromIPN({ mc_gross: '2498.50' })).toBe('enterprise');
    expect(inferTierFromIPN({ mc_gross: '249.50' })).toBe('full'); // within $1 of $250
  });

  it('accepts a JSON custom field only when the USD paid matches that tier', () => {
    expect(inferTierFromIPN({ custom: '{"tier":"retainer"}', mc_gross: '1499.00', mc_currency: 'USD' })).toBe('retainer');
    expect(inferTierFromIPN({ custom: '{"tier":"re_full"}', mc_gross: '250.00' })).toBe('full');
  });

  it('accepts a plain-string custom field only when the USD paid matches that tier', () => {
    expect(inferTierFromIPN({ custom: 'full', mc_gross: '250.00' })).toBe('full');
  });

  it('does NOT grant a spoofed custom.tier when the amount does not match', () => {
    // Classic Buy Now tamper: $1 to the merchant with custom claiming Enterprise.
    expect(inferTierFromIPN({ custom: '{"tier":"enterprise"}', mc_gross: '1.00' })).toBeNull();
    expect(inferTierFromIPN({ custom: 'enterprise' })).toBeNull();
    // Paid Full Package but claimed Enterprise → honor what was paid, not the hint.
    expect(inferTierFromIPN({ custom: '{"tier":"enterprise"}', mc_gross: '250.00' })).toBe('full');
  });

  it('does NOT resolve a non-USD mc_gross as a USD catalog tier', () => {
    expect(inferTierFromIPN({ mc_gross: '2499.00', mc_currency: 'JPY' })).toBeNull();
    expect(inferTierFromIPN({ mc_gross: '250.00', mc_currency: 'EUR' })).toBeNull();
    expect(inferTierFromIPN({ custom: '{"tier":"enterprise"}', mc_gross: '2499.00', mc_currency: 'MXN' })).toBeNull();
  });

  it('does NOT resolve an add-on price to an NFT tier', () => {
    // $99 is addon_rush — not sold via PayPal IPN as a mintable tier.
    expect(inferTierFromIPN({ mc_gross: '99.00' })).toBeNull();
  });

  it('returns null for unrecognized amounts', () => {
    expect(inferTierFromIPN({ mc_gross: '5.00' })).toBeNull();
    expect(inferTierFromIPN({})).toBeNull();
  });
});

describe('inferTierFromIPN — carts (Task 10)', () => {
  it('a multi-item cart totalling a catalog price is add-ons, never an NFT tier', () => {
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '2', mc_gross: '250.00' })).toBe('addons');
    // Even when the buyer-controlled custom claims a tier whose price matches.
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '2', mc_gross: '250.00', custom: '{"tier":"full"}' })).toBe('addons');
    expect(inferTierFromIPN({ txn_type: 'express_checkout', num_cart_items: '3', mc_gross: '2499.00' })).toBe('addons');
  });

  it('a cart uses amount inference only when num_cart_items is exactly "1" (same $1 bound)', () => {
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '1', mc_gross: '250.00' })).toBe('full');
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '1', mc_gross: '249.50' })).toBe('full');
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '1', mc_gross: '99.00' })).toBeNull(); // add-on price: not PayPal-eligible
    expect(inferTierFromIPN({ txn_type: 'cart', mc_gross: '250.00' })).toBeNull(); // cart without a count
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '2', mc_gross: '250.00' })).toBe('addons');
  });

  it('a single-item cart still honours an amount-checked custom tier', () => {
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '1', mc_gross: '250.00', custom: '{"tier":"full"}' })).toBe('full');
  });

  it('num_cart_items absent or "1" keeps amount inference; anything else disables it', () => {
    expect(inferTierFromIPN({ txn_type: 'web_accept', mc_gross: '250.00' })).toBe('full');
    expect(inferTierFromIPN({ txn_type: 'express_checkout', num_cart_items: '1', mc_gross: '250.00' })).toBe('full');
    expect(inferTierFromIPN({ txn_type: 'express_checkout', num_cart_items: 'x', mc_gross: '250.00' })).toBeNull();
  });

  it('the forged $1 custom tier is still refused in every shape', () => {
    expect(inferTierFromIPN({ txn_type: 'web_accept', custom: '{"tier":"enterprise"}', mc_gross: '1.00' })).toBeNull();
    expect(inferTierFromIPN({ txn_type: 'subscr_payment', custom: '{"tier":"comm_monthly"}', mc_gross: '1.00' })).toBeNull();
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '1', custom: '{"tier":"enterprise"}', mc_gross: '1.00' })).toBeNull();
  });
});

describe('inferTierFromIPN — PAYPAL_ITEM_TIERS (Task 10)', () => {
  const SAVED_MAP = process.env.PAYPAL_ITEM_TIERS;
  afterEach(() => {
    if (SAVED_MAP === undefined) delete process.env.PAYPAL_ITEM_TIERS;
    else process.env.PAYPAL_ITEM_TIERS = SAVED_MAP;
  });

  it('item_number mapped to full at $250 → full (the map is what resolves a single-item cart)', () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-FULL': 're_full' });
    expect(inferTierFromIPN({ item_number: 'AUR-FULL', mc_gross: '250.00' })).toBe('full');
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '1', item_number1: 'AUR-FULL', mc_gross: '250.00' })).toBe('full');
  });

  it('item_number mapped to enterprise at $1 → no tier (forged Buy Now form)', () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-ENT': 'enterprise' });
    expect(inferTierFromIPN({ item_number: 'AUR-ENT', mc_gross: '1.00' })).toBeNull();
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '1', item_number1: 'AUR-ENT', mc_gross: '1.00' })).toBeNull();
  });

  it('an eligible, amount-matched custom wins over the item map; an ineligible one falls through to it', () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-X': 'single' });
    expect(inferTierFromIPN({ item_number: 'AUR-X', custom: 'deal', mc_gross: '189.99' })).toBe('single');
    expect(inferTierFromIPN({ item_number: 'AUR-X', custom: '{"tier":"comm_lifetime"}', mc_gross: '349.99' })).toBe('comm_lifetime');
  });

  it('the item map can label an add-on, but never on a mismatched amount', () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-RUSH': 'addon_rush' });
    expect(inferTierFromIPN({ item_number: 'AUR-RUSH', mc_gross: '99.00' })).toBe('addon_rush');
    expect(inferTierFromIPN({ item_number: 'AUR-RUSH', mc_gross: '2499.00' })).toBe('enterprise'); // amount inference
  });

  it('a multi-item cart ignores the item map', () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-FULL': 'full' });
    expect(inferTierFromIPN({ txn_type: 'cart', num_cart_items: '2', item_number1: 'AUR-FULL', mc_gross: '250.00' })).toBe('addons');
  });

  it('invalid JSON → empty map, flagged invalid; unknown tiers are dropped', () => {
    process.env.PAYPAL_ITEM_TIERS = '{oops';
    expect(paypalItemTiers()).toMatchObject({ map: {}, invalid: true });
    expect(inferTierFromIPN({ item_number: 'AUR-FULL', mc_gross: '250.00' })).toBe('full'); // amount inference only

    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ A: 'full', B: 'web3_starter', C: 42 });
    expect(paypalItemTiers()).toMatchObject({ map: { A: 'full' }, invalid: false, dropped: ['B', 'C'] });
  });

  it('is parsed once per env value', () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ A: 'full' });
    expect(paypalItemTiers()).toBe(paypalItemTiers());
  });
});

describe('ipnTxnType', () => {
  it('defaults a missing txn_type to web_accept and lower-cases the rest', () => {
    expect(ipnTxnType({})).toBe('web_accept');
    expect(ipnTxnType({ txn_type: '  ' })).toBe('web_accept');
    expect(ipnTxnType({ txn_type: 'Subscr_Payment' })).toBe('subscr_payment');
  });
});
