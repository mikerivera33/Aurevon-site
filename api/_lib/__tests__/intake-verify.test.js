/**
 * Deal-intake payment gate: only a live paid Stripe session or a Succeeded
 * Payments row (PayPal txn_id / Stripe session id) unlocks the form.
 * Client-minted `paid_*` tokens must never be accepted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  findPaymentByTransactionId: vi.fn(),
}));

const retrieve = vi.fn();
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.checkout = { sessions: { retrieve } };
    }
  },
}));

import { verifyIntakePayment } from '../intake-verify.js';
import * as db from '../db.js';

const SAVED = { ...process.env };

function paymentRow(overrides = {}) {
  return {
    fields: {
      Status: 'Succeeded',
      'Pass Type': 're_full',
      'Payment Provider': 'Stripe Card',
      ...overrides,
    },
  };
}

describe('verifyIntakePayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED, STRIPE_SECRET_KEY: 'sk_test_x' };
    retrieve.mockReset();
    db.findPaymentByTransactionId.mockReset();
  });

  it('rejects a client-minted paid_ token (no sessionId / txnId)', async () => {
    const result = await verifyIntakePayment({ token: 'paid_full_abc123xyz' });
    expect(result).toEqual({ ok: false, status: 400, error: 'missing_id' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
  });

  it('rejects a session id that is not a Stripe Checkout id', async () => {
    const result = await verifyIntakePayment({ sessionId: 'paid_full_looks_long_enough' });
    expect(result).toEqual({ ok: false, status: 400, error: 'invalid_session' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('refuses a paid session that is not an underwriting package (community / add-on)', async () => {
    retrieve.mockResolvedValueOnce({ payment_status: 'paid', metadata: { tier: 'comm_monthly' } });
    expect(await verifyIntakePayment({ sessionId: 'cs_test_comm1' }))
      .toEqual({ ok: false, status: 403, error: 'not_intake_purchase' });
    retrieve.mockResolvedValueOnce({ payment_status: 'paid', metadata: { tier: 'addon_rush' } });
    expect(await verifyIntakePayment({ sessionId: 'cs_test_addon1' }))
      .toEqual({ ok: false, status: 403, error: 'not_intake_purchase' });
  });

  it('accepts every Capital package key, prefixed or bare', async () => {
    for (const tier of ['re_bogo', 're_single', 're_full', 're_retainer', 're_enterprise', 'full', 'retainer', 'deal']) {
      retrieve.mockResolvedValueOnce({ payment_status: 'paid', metadata: { tier } });
      expect((await verifyIntakePayment({ sessionId: 'cs_test_t' + tier.replace(/_/g, '') })).ok).toBe(true);
    }
  });

  it('unlocks when Stripe says payment_status=paid', async () => {
    retrieve.mockResolvedValueOnce({
      payment_status: 'paid',
      metadata: { tier: 're_full' },
    });
    const result = await verifyIntakePayment({ sessionId: 'cs_test_abc123' });
    expect(result).toEqual({ ok: true, tier: 're_full', method: 'stripe' });
    expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
  });

  it('rejects unpaid async Checkout (Afterpay/Cash App/ACH not yet collected)', async () => {
    retrieve.mockResolvedValueOnce({
      payment_status: 'unpaid',
      metadata: { tier: 're_full' },
    });
    const result = await verifyIntakePayment({ sessionId: 'cs_test_unpaid' });
    expect(result).toEqual({ ok: false, status: 402, error: 'unpaid' });
  });

  it('rejects no_payment_required (same class as unpaid async Checkout)', async () => {
    retrieve.mockResolvedValueOnce({
      payment_status: 'no_payment_required',
      metadata: { tier: 're_full' },
    });
    const result = await verifyIntakePayment({ sessionId: 'cs_test_free' });
    expect(result).toEqual({ ok: false, status: 402, error: 'unpaid' });
  });

  it('falls back to a Succeeded Payments row when Stripe retrieve fails', async () => {
    retrieve.mockRejectedValueOnce(new Error('No such checkout.session'));
    db.findPaymentByTransactionId.mockResolvedValueOnce(paymentRow());
    const result = await verifyIntakePayment({ sessionId: 'cs_live_recorded' });
    expect(result).toEqual({ ok: true, tier: 're_full', method: 'stripe' });
  });

  it('unlocks a PayPal txn_id that has a Succeeded Payments row', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce(
      paymentRow({ 'Pass Type': 'full', 'Payment Provider': 'PayPal' }),
    );
    const result = await verifyIntakePayment({ txnId: '1AB23456CD7890123' });
    expect(result).toEqual({ ok: true, tier: 'full', method: 'paypal' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('rejects a PayPal txn_id with no Succeeded Payments row', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce(null);
    const result = await verifyIntakePayment({ txnId: '9ZZ99999ZZ9999999' });
    expect(result).toEqual({ ok: false, status: 404, error: 'not_found' });
  });

  it('rejects a Payments row that is not Succeeded', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce(
      paymentRow({ Status: 'Pending', 'Payment Provider': 'PayPal' }),
    );
    const result = await verifyIntakePayment({ txnId: '1AB23456CD7890123' });
    expect(result).toEqual({ ok: false, status: 404, error: 'not_found' });
  });

  it('rejects a malformed PayPal txn_id without hitting the database', async () => {
    const result = await verifyIntakePayment({ txnId: 'paid_full_not_a_txn' });
    expect(result).toEqual({ ok: false, status: 400, error: 'invalid_txn' });
    expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
  });

  it('fails closed when the Payments lookup throws', async () => {
    db.findPaymentByTransactionId.mockRejectedValueOnce(new Error('Supabase timeout'));
    const result = await verifyIntakePayment({ txnId: '1AB23456CD7890123' });
    expect(result).toEqual({ ok: false, status: 503, error: 'lookup_failed' });
  });
});
