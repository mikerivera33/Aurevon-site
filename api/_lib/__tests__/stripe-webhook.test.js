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
vi.mock('../db.js', () => ({
  findPaymentByTransactionId: vi.fn(),
  createPayment: vi.fn().mockResolvedValue({}),
  createNftMint: vi.fn().mockResolvedValue({}),
  countNftMintsByPrefix: vi.fn().mockResolvedValue(0),
  updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
  findMemberByEmail: vi.fn().mockResolvedValue(null),
  updateEntitlementState: vi.fn().mockResolvedValue({}),
}));
vi.mock('../crossmint.js', () => ({
  mintToEmail: vi.fn().mockResolvedValue({ ok: true, actionId: 'act_test', imageUrl: null }),
}));
vi.mock('../email.js', () => ({
  sendNftDelivery: vi.fn().mockResolvedValue({}),
  sendPurchaseConfirmation: vi.fn().mockResolvedValue({}),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({}) }));
vi.mock('../discord-bot.js', () => ({ removeRoleFromMember: vi.fn() }));

const subscriptionsUpdate = vi.fn().mockResolvedValue({});
const subscriptionsRetrieve = vi.fn();
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.subscriptions = { update: subscriptionsUpdate, retrieve: subscriptionsRetrieve };
      this.customers = { retrieve: vi.fn() };
    }
  },
}));

import { handleCheckoutSessionCompleted, isSettledCheckout } from '../../webhooks/stripe.js';
import * as db from '../db.js';
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
    db.createPayment.mockResolvedValue({});
  });

  it('mints exactly once when the same session is delivered twice', async () => {
    const s = session();

    // First delivery: no prior Payments row.
    db.findPaymentByTransactionId.mockResolvedValueOnce(null);
    await handleCheckoutSessionCompleted(s);

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(db.createPayment).toHaveBeenCalledTimes(1);

    // Redelivery: the marker now exists → must be a no-op.
    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });
    await handleCheckoutSessionCompleted(s);

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1); // still once
    expect(db.createPayment).toHaveBeenCalledTimes(1); // no second marker
  });

  it('does NOT mint when the dedup marker (createPayment) fails to persist', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce(null);
    db.createPayment.mockRejectedValueOnce(new Error('Supabase 500'));

    await handleCheckoutSessionCompleted(session('cs_test_marker_fail'));

    // No marker written ⇒ pipeline aborted before the irreversible mint.
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('does NOT mint when the idempotency lookup itself fails', async () => {
    db.findPaymentByTransactionId.mockRejectedValueOnce(new Error('Supabase timeout'));

    await handleCheckoutSessionCompleted(session('cs_test_lookup_fail'));

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createPayment).not.toHaveBeenCalled();
  });

  it('still writes subscription metadata when the Payments marker already exists', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });

    await handleCheckoutSessionCompleted({
      id: 'cs_retry_sub',
      payment_status: 'paid',
      mode: 'subscription',
      subscription: 'sub_retry',
      customer_details: { email: 'monthly@example.com', name: 'Monthly' },
      metadata: { tier: 'comm_monthly' },
      amount_total: 2999,
    });

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).toHaveBeenCalledWith('sub_retry', {
      metadata: { email: 'monthly@example.com', tier: 'comm_monthly' },
    });
  });
});

describe('Stripe webhook settlement gate (async payment methods)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.createPayment.mockResolvedValue({});
    db.findPaymentByTransactionId.mockResolvedValue(null);
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
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
  });

  it('does NOT mint when payment_status is missing (fail closed)', async () => {
    const s = session('cs_test_missing_status');
    delete s.payment_status;
    await handleCheckoutSessionCompleted(s);

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createPayment).not.toHaveBeenCalled();
  });

  it('mints once when the same session later arrives as paid (async_payment_succeeded)', async () => {
    const unpaid = session('cs_test_afterpay_settle', { payment_status: 'unpaid' });
    await handleCheckoutSessionCompleted(unpaid);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();

    await handleCheckoutSessionCompleted({ ...unpaid, payment_status: 'paid' });
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(db.createPayment).toHaveBeenCalledTimes(1);
  });

  it('a paid monthly checkout (incl. re-subscribe after cancel) resets Billing State to active', async () => {
    await handleCheckoutSessionCompleted(session('cs_test_resub', {
      payment_status: 'paid', mode: 'subscription', amount_total: 2999, metadata: { tier: 'comm_monthly' },
    }));
    expect(db.updateEntitlementState).toHaveBeenCalledWith('buyer@example.com', {
      entitlementType: 'monthly_membership', status: 'active', billingState: 'active',
    });
  });

  it('a redelivered monthly checkout re-activates only if the subscription is still active', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const paid = session('cs_test_redeliver', {
      payment_status: 'paid', mode: 'subscription', subscription: 'sub_r', amount_total: 2999, metadata: { tier: 'comm_monthly' },
    });
    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });
    subscriptionsRetrieve.mockResolvedValueOnce({ status: 'canceled' });
    await handleCheckoutSessionCompleted(paid);
    expect(db.updateEntitlementState).not.toHaveBeenCalled();

    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });
    subscriptionsRetrieve.mockResolvedValueOnce({ status: 'active' });
    await handleCheckoutSessionCompleted(paid);
    expect(db.updateEntitlementState).toHaveBeenCalledWith('buyer@example.com', expect.objectContaining({ billingState: 'active' }));
  });

  it('a one-time purchase does not touch monthly billing state', async () => {
    await handleCheckoutSessionCompleted(session('cs_test_full_once', { payment_status: 'paid' }));
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('fulfills a $0 / 100% promo checkout (no_payment_required)', async () => {
    await handleCheckoutSessionCompleted(
      session('cs_test_promo_zero', { payment_status: 'no_payment_required', amount_total: 0 })
    );

    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
  });
});
