/**
 * Durability-under-retry regression tests for the Stripe webhook pipeline.
 *
 * These guard the idempotency invariant added in fix/payment-durability:
 *   1. Redelivery of the same checkout.session.completed must mint exactly once.
 *   2. If the dedup marker (Payments row) can't be written, the pipeline must
 *      abort BEFORE the irreversible Crossmint mint (no marker ⇒ no mint).
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
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.subscriptions = { update: subscriptionsUpdate };
      this.customers = { retrieve: vi.fn() };
    }
  },
}));

import { handleCheckoutSessionCompleted } from '../../webhooks/stripe.js';
import * as airtable from '../airtable.js';
import * as crossmint from '../crossmint.js';

function session(id = 'cs_test_dedupe_1') {
  return {
    id,
    customer_details: { email: 'buyer@example.com', name: 'Buyer' },
    amount_total: 25000, // $250 → tier "full" (Aurevon Insider, has an NFT)
    metadata: { tier: 'full' },
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

  it('still writes subscription metadata when the Payments marker already exists', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    airtable.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });

    await handleCheckoutSessionCompleted({
      id: 'cs_retry_sub',
      mode: 'subscription',
      subscription: 'sub_retry',
      customer_details: { email: 'monthly@example.com', name: 'Monthly' },
      metadata: { tier: 'comm_monthly' },
      amount_total: 2999,
    });

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(airtable.createPayment).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).toHaveBeenCalledWith('sub_retry', {
      metadata: { email: 'monthly@example.com', tier: 'comm_monthly' },
    });
  });
});
