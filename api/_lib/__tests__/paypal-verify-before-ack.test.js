/**
 * PayPal only redelivers an IPN it did not get a 200 for (final fix 5), so the
 * handler verifies with PayPal and writes the Payments marker BEFORE it
 * answers; mint / email run in waitUntil after the 200.
 *
 *   verify network error / unexpected response → 500, no marker, paypal.verify_failed
 *   INVALID                                     → 200, no writes, paypal.ipn_invalid
 *   marker / lookup DB failure                  → 500 (+ existing alert)
 *   VERIFIED                                    → 200 with the marker written, then one mint
 *   post-ack crash                              → paypal.pipeline_crashed (critical)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  createPayment: vi.fn().mockResolvedValue({}),
  findPaymentByTransactionId: vi.fn().mockResolvedValue(null),
  findPaymentBySubscriptionId: vi.fn().mockResolvedValue(null),
  listPaymentsByEmail: vi.fn().mockResolvedValue([]),
  updateEntitlementState: vi.fn().mockResolvedValue({}),
}));
vi.mock('../fulfil.js', () => ({ fulfilNft: vi.fn().mockResolvedValue({ minted: true }) }));
vi.mock('../email.js', () => ({ sendPurchaseConfirmation: vi.fn().mockResolvedValue({}) }));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
const bg = vi.hoisted(() => ({ pending: [] }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => { bg.pending.push(p); } }));

import handler, { acceptIPN } from '../../webhooks/paypal.js';
import * as db from '../db.js';
import { fulfilNft } from '../fulfil.js';
import { sendAlert } from '../alert.js';

const SAVED = { ...process.env };
const RECEIVER = 'mike@aurevonvc.com';

function body(extra = {}) {
  return new URLSearchParams({
    txn_id: 'PPVERIFY0001',
    payer_email: 'buyer@example.com',
    first_name: 'Buy', last_name: 'Er',
    mc_gross: '250.00',
    mc_currency: 'USD',
    payment_status: 'Completed',
    receiver_email: RECEIVER,
    custom: JSON.stringify({ tier: 'full' }),
    ...extra,
  }).toString();
}

function mkRes() {
  const res = { code: null, payload: null };
  res.status = vi.fn((c) => { res.code = c; return res; });
  res.send = vi.fn((b) => { res.payload = b; return res; });
  res.json = vi.fn((b) => { res.payload = b; return res; });
  return res;
}

async function post(raw) {
  const handlers = {};
  const req = { method: 'POST', on(evt, fn) { handlers[evt] = fn; return this; } };
  const res = mkRes();
  const p = handler(req, res);
  handlers.data(Buffer.from(raw));
  handlers.end();
  await p;
  return res;
}

const verifyWith = (impl) => vi.stubGlobal('fetch', vi.fn(impl));
const alerted = (event) => sendAlert.mock.calls.filter(([e]) => e === event);
const drain = async () => { await Promise.all(bg.pending.splice(0)); };

beforeEach(() => {
  vi.clearAllMocks();
  bg.pending.length = 0;
  process.env = { ...SAVED, PAYPAL_BUSINESS_EMAIL: RECEIVER };
  db.findPaymentByTransactionId.mockResolvedValue(null);
  db.createPayment.mockResolvedValue({});
  fulfilNft.mockResolvedValue({ minted: true });
  verifyWith(async () => ({ status: 200, text: async () => 'VERIFIED' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...SAVED }; });

describe('PayPal verify + marker before ack', () => {
  it('verify network error → 500, no marker, paypal.verify_failed (high, dedupe on txn_id)', async () => {
    verifyWith(async () => { throw new Error('ECONNRESET'); });
    const res = await post(body());
    expect(res.code).toBe(500);
    expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(bg.pending).toHaveLength(0);
    expect(alerted('paypal.verify_failed')).toEqual([[
      'paypal.verify_failed', expect.objectContaining({ txnId: 'PPVERIFY0001', error: 'ECONNRESET' }),
      { severity: 'high', dedupeKey: 'PPVERIFY0001' },
    ]]);
  });

  it('an unexpected verify response (neither VERIFIED nor INVALID) → 500, no marker', async () => {
    verifyWith(async () => ({ status: 503, text: async () => '<html>maintenance</html>' }));
    const res = await post(body());
    expect(res.code).toBe(500);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(alerted('paypal.verify_failed')).toHaveLength(1);
    expect(alerted('paypal.verify_failed')[0][1].error).toMatch(/HTTP 503/);
  });

  it('INVALID → 200, no writes, paypal.ipn_invalid (warn)', async () => {
    verifyWith(async () => ({ status: 200, text: async () => 'INVALID' }));
    const res = await post(body());
    expect(res.code).toBe(200);
    expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(bg.pending).toHaveLength(0);
    expect(alerted('paypal.ipn_invalid')).toEqual([[
      'paypal.ipn_invalid', expect.objectContaining({ txnId: 'PPVERIFY0001' }), { severity: 'warn', dedupeKey: 'PPVERIFY0001' },
    ]]);
  });

  it('a marker DB failure → 500 + paypal.payment_marker_failed, nothing after', async () => {
    db.createPayment.mockRejectedValueOnce(new Error('Supabase insert payments: connection reset'));
    const res = await post(body());
    expect(res.code).toBe(500);
    expect(alerted('paypal.payment_marker_failed')).toHaveLength(1);
    expect(bg.pending).toHaveLength(0);
    expect(fulfilNft).not.toHaveBeenCalled();
  });

  it('an idempotency lookup failure → 500 + paypal.idempotency_lookup_failed, no marker', async () => {
    db.findPaymentByTransactionId.mockRejectedValueOnce(new Error('Supabase timeout'));
    const res = await post(body());
    expect(res.code).toBe(500);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(alerted('paypal.idempotency_lookup_failed')).toHaveLength(1);
  });

  it('a subscription lookup failure → 500 (PayPal retries), no marker', async () => {
    db.findPaymentBySubscriptionId.mockRejectedValueOnce(new Error('Supabase timeout'));
    const res = await post(body({ txn_type: 'subscr_payment', subscr_id: 'I-SUB1', mc_gross: '29.99', custom: '' }));
    expect(res.code).toBe(500);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(alerted('paypal.subscription_lookup_failed')).toHaveLength(1);
  });

  it('a concurrent duplicate (DUPLICATE_PAYMENT) → 200, nothing after', async () => {
    db.createPayment.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'DUPLICATE_PAYMENT' }));
    const res = await post(body());
    expect(res.code).toBe(200);
    expect(bg.pending).toHaveLength(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('VERIFIED → 200 with the marker already written, then exactly one mint after the ack; a redelivery is a no-op', async () => {
    const res = await post(body());
    expect(res.code).toBe(200);
    expect(res.payload).toBe('OK');
    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(db.createPayment.mock.invocationCallOrder[0]).toBeLessThan(res.status.mock.invocationCallOrder[0]);
    await drain();
    expect(fulfilNft).toHaveBeenCalledTimes(1);
    // The mint starts only after the answer went out.
    expect(fulfilNft.mock.invocationCallOrder[0]).toBeGreaterThan(res.send.mock.invocationCallOrder[0]);
    expect(fulfilNft).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'PPVERIFY0001', tier: 'full', provider: 'paypal' }));

    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'pay_1' });
    const again = await post(body());
    expect(again.code).toBe(200);
    await drain();
    expect(fulfilNft).toHaveBeenCalledTimes(1);
  });

  it('a crash after the ack alerts paypal.pipeline_crashed (critical)', async () => {
    fulfilNft.mockRejectedValueOnce(new Error('boom'));
    const res = await post(body());
    expect(res.code).toBe(200);
    await drain();
    expect(alerted('paypal.pipeline_crashed')).toEqual([[
      'paypal.pipeline_crashed', { txnId: 'PPVERIFY0001', error: 'boom' }, { severity: 'critical' },
    ]]);
  });

  it('a crash before the ack → 500 + paypal.pipeline_crashed (critical)', async () => {
    // business_email_unset is the one pre-marker alert that is not .catch()ed.
    delete process.env.PAYPAL_BUSINESS_EMAIL;
    sendAlert.mockRejectedValueOnce(new Error('alert sink down'));
    const res = await post(body());
    expect(res.code).toBe(500);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(alerted('paypal.pipeline_crashed')).toEqual([[
      'paypal.pipeline_crashed', { stage: 'accept', error: 'alert sink down' }, { severity: 'critical' },
    ]]);
  });

  it('lifecycle notices are verified first, then processed after the ack', async () => {
    db.findPaymentBySubscriptionId.mockResolvedValueOnce({ id: 'pay_1', fields: { 'Pass Type': 'comm_monthly', 'Customer Email': 'buyer@example.com' } });
    const res = await post(new URLSearchParams({ txn_type: 'subscr_cancel', subscr_id: 'I-GEN1', receiver_email: RECEIVER }).toString());
    expect(res.code).toBe(200);
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    await drain();
    expect(db.updateEntitlementState).toHaveBeenCalledWith('buyer@example.com', expect.objectContaining({ billingState: 'cancelled' }));
  });

  it('acceptIPN on a lifecycle notice whose verify fails → 500 and an alert (no billing change)', async () => {
    verifyWith(async () => { throw new Error('timeout'); });
    const out = await acceptIPN(new URLSearchParams({ txn_type: 'subscr_cancel', subscr_id: 'I-GEN1' }).toString());
    expect(out.status).toBe(500);
    expect(alerted('paypal.verify_failed')).toHaveLength(1);
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });
});
