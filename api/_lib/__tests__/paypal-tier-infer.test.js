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
import { describe, it, expect, vi } from 'vitest';

// Stub the heavy side-effect deps so importing the webhook module is clean;
// tiers.js is intentionally NOT mocked — inferTierFromIPN must use the real map.
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../airtable.js', () => ({ createPayment: vi.fn(), createNftMint: vi.fn() }));
vi.mock('../email.js', () => ({ sendNftDelivery: vi.fn(), sendPurchaseConfirmation: vi.fn() }));

import { inferTierFromIPN } from '../../webhooks/paypal.js';

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
