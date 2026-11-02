/**
 * Durability-under-retry + settlement-gate regression tests for the Stripe
 * webhook pipeline.
 *
 * These guard:
 *   1. Redelivery of the same checkout.session.completed must mint exactly once.
 *   2. If the dedup marker (Payments row) can't be written, the pipeline must
 *      abort BEFORE the irreversible Crossmint mint (no marker ⇒ no mint).
 *   3. Unpaid async checkouts (Afterpay / Cash App / ACH) must not fulfill
 *      on the checkout.session.completed precursor — only after settlement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the side-effecting libs. tiers.js stays REAL so TIER_NFT_MAP / getNextSerial
// exercise the real mapping (getNextSerial calls the mocked countNftMintsByPrefix).
vi.mock('../airtable.js', () => ({
  findPaymentByTransactionId: vi.fn(),
  createPayment: vi.fn().mockResolvedValue({}),
  createNftMint: vi.fn().mockResolvedValue({}),
  countNftMintsByPrefix: vi.fn().mockResolvedValue(0),
  updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
  findMemberByEmail: vi.fn().mockResolvedValue(null),
}));
vi.mock('../crossmint.js', () => ({
  mintToEmail: vi.fn().mockResolvedValue({ ok: true, actionId: 'act_test', imageUrl: null }),
}));
vi.mock('../email.js', () => ({
  sendNftDelivery: vi.fn().mockResolvedValue({}),
  sendPurchaseConfirmation: vi.fn().mockResolvedValue({}),
}));

import { handleCheckoutSessionCompleted, isSettledCheckout } from '../../webhooks/stripe.js';
import * as airtable from '../airtable.js';
import * as crossmint from '../crossmint.js';

function session(id = 'cs_test_dedupe_1', extras = {}) {
  return {
    id,
    payment_status: 'paid',
    customer_details: { email: 'buyer@example.com', name: 'Buyer' },
    amount_total: 25000, // $250 → tier "full" (Aurevon Insider, has an NFT)
    metadata: { tier: 'full' },
    ...extras,
  };
}

describe('Stripe webhook idempotency (durability under retry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    airtable.createPayment.mockResolvedValue({});
  });

  it('mints exactly once when the same session is delivered twice', async () => {
    const s = session();

    // First delivery: no prior Payments row.
    airtable.findPaymentByTransactionId.mockResolvedValueOnce(null);
    await handleCheckoutSessionCompleted(s);

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(airtable.createPayment).toHaveBeenCalledTimes(1);

    // Redelivery: the marker now exists → must be a no-op.
    airtable.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });
    await handleCheckoutSessionCompleted(s);

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1); // still once
    expect(airtable.createPayment).toHaveBeenCalledTimes(1); // no second marker
  });

  it('does NOT mint when the dedup marker (createPayment) fails to persist', async () => {
    airtable.findPaymentByTransactionId.mockResolvedValueOnce(null);
    airtable.createPayment.mockRejectedValueOnce(new Error('Airtable 500'));

    await handleCheckoutSessionCompleted(session('cs_test_marker_fail'));

    // No marker written ⇒ pipeline aborted before the irreversible mint.
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('does NOT mint when the idempotency lookup itself fails', async () => {
    airtable.findPaymentByTransactionId.mockRejectedValueOnce(new Error('Airtable timeout'));

    await handleCheckoutSessionCompleted(session('cs_test_lookup_fail'));

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(airtable.createPayment).not.toHaveBeenCalled();
  });
});

describe('Stripe webhook settlement gate (async payment methods)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    airtable.createPayment.mockResolvedValue({});
    airtable.findPaymentByTransactionId.mockResolvedValue(null);
  });

  it('treats only paid and no_payment_required as settled', () => {
    expect(isSettledCheckout({ payment_status: 'paid' })).toBe(true);
    expect(isSettledCheckout({ payment_status: 'no_payment_required' })).toBe(true);
    expect(isSettledCheckout({ payment_status: 'unpaid' })).toBe(false);
    expect(isSettledCheckout({})).toBe(false);
    expect(isSettledCheckout(null)).toBe(false);
  });

  it('does NOT mint or write a Payments row on unpaid checkout.session.completed', async () => {
    await handleCheckoutSessionCompleted(session('cs_test_afterpay_unpaid', { payment_status: 'unpaid' }));

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(airtable.createPayment).not.toHaveBeenCalled();
    expect(airtable.findPaymentByTransactionId).not.toHaveBeenCalled();
  });

  it('does NOT mint when payment_status is missing (fail closed)', async () => {
    const s = session('cs_test_missing_status');
    delete s.payment_status;
    await handleCheckoutSessionCompleted(s);

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(airtable.createPayment).not.toHaveBeenCalled();
  });

  it('mints once when the same session later arrives as paid (async_payment_succeeded)', async () => {
    const unpaid = session('cs_test_afterpay_settle', { payment_status: 'unpaid' });
    await handleCheckoutSessionCompleted(unpaid);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();

    await handleCheckoutSessionCompleted({ ...unpaid, payment_status: 'paid' });
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(airtable.createPayment).toHaveBeenCalledTimes(1);
  });

  it('fulfills a $0 / 100% promo checkout (no_payment_required)', async () => {
    await handleCheckoutSessionCompleted(
      session('cs_test_promo_zero', { payment_status: 'no_payment_required', amount_total: 0 })
    );

    expect(airtable.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
  });
});
