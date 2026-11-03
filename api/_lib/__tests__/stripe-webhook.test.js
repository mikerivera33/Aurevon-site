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
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock the side-effecting libs. tiers.js stays REAL so TIER_NFT_MAP / getNextSerial
// exercise the real mapping (getNextSerial reserves from the mocked nextSerial counter;
// airtable-import is mocked off so the Airtable bridge guard never runs).
vi.mock('../db.js', () => ({
  findPaymentByTransactionId: vi.fn(),
  createPayment: vi.fn().mockResolvedValue({}),
  createNftMint: vi.fn().mockResolvedValue({}),
  nextSerial: vi.fn().mockResolvedValue(1),
  updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
  findMemberByEmail: vi.fn().mockResolvedValue(null),
  updateEntitlementState: vi.fn().mockResolvedValue({}),
  // fulfil.js (shared NFT fulfilment):
  findMintByPaymentId: vi.fn().mockResolvedValue(null), updateNftMint: vi.fn().mockResolvedValue({}),
  // refunds / disputes:
  updatePaymentStatus: vi.fn().mockResolvedValue(null), findActiveMintsByEmail: vi.fn().mockResolvedValue([]),
}));
// Capture waitUntil work so handler tests can await the background pipeline.
const bg = vi.hoisted(() => ({ pending: [] }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => { bg.pending.push(p); } }));
vi.mock('../airtable-import.js', () => ({ airtableImportEnabled: vi.fn(() => false), countAirtableMintsByPrefix: vi.fn() }));
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
      this.checkout = { sessions: { list: vi.fn().mockResolvedValue({ data: [] }) } };
    }
  },
}));

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import handler, {
  handleCheckoutSessionCompleted, isSettledCheckout, recordCheckoutPayment, verifyStripeSignature, REQUIRED_STRIPE_EVENTS,
} from '../../webhooks/stripe.js';
import * as db from '../db.js';
import * as crossmint from '../crossmint.js';
import { sendAlert } from '../alert.js';
import * as email from '../email.js';

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
    // Normal path: the serial comes from the atomic counter and is the mint reference.
    expect(db.nextSerial).toHaveBeenCalledWith('INSIDER');
    expect(db.createNftMint).toHaveBeenCalledWith(expect.objectContaining({ reference: 'INSIDER_001' }));

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
    expect(db.createNftMint).not.toHaveBeenCalled();
    // A genuine write failure is an incident: the owner is alerted.
    expect(sendAlert).toHaveBeenCalledWith('stripe.payment_marker_failed', expect.objectContaining({ sessionId: 'cs_test_marker_fail' }));
  });

  it('a concurrent duplicate delivery (DUPLICATE_PAYMENT on the marker) returns quietly: no mint, no alert', async () => {
    // Two deliveries race past findPaymentByTransactionId; the UNIQUE
    // transaction_id makes the loser's insert fail with DUPLICATE_PAYMENT.
    const dup = Object.assign(new Error('Supabase insert payments: duplicate key value violates unique constraint'), { code: 'DUPLICATE_PAYMENT' });
    db.findPaymentByTransactionId.mockResolvedValueOnce(null);
    db.createPayment.mockRejectedValueOnce(dup);

    await expect(handleCheckoutSessionCompleted(session('cs_test_race'))).resolves.toBeUndefined();

    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(email.sendNftDelivery).not.toHaveBeenCalled();
    expect(email.sendPurchaseConfirmation).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a non-duplicate Postgres error code on the marker still alerts and aborts before mint', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce(null);
    db.createPayment.mockRejectedValueOnce(Object.assign(new Error('Supabase insert payments: null value in column'), { code: '23502' }));

    await handleCheckoutSessionCompleted(session('cs_test_not_null'));

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('stripe.payment_marker_failed', expect.objectContaining({ sessionId: 'cs_test_not_null' }));
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

describe('activateMonthlyBilling paid-through date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.createPayment.mockResolvedValue({});
    db.findPaymentByTransactionId.mockResolvedValue(null);
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  });

  it('passes expiresAt from the live subscription current_period_end', async () => {
    const periodEnd = 1893456000;
    subscriptionsRetrieve.mockResolvedValueOnce({ status: 'active', current_period_end: periodEnd });
    await handleCheckoutSessionCompleted(session('cs_test_expiry', {
      mode: 'subscription', subscription: 'sub_exp', amount_total: 2999, metadata: { tier: 'comm_monthly' },
    }));
    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_exp');
    expect(db.updateEntitlementState).toHaveBeenCalledWith('buyer@example.com', {
      entitlementType: 'monthly_membership', status: 'active', billingState: 'active',
      expiresAt: new Date(periodEnd * 1000).toISOString(),
    });
  });
});

// ── Vercel handler: signature, sync-ack marker, background crash alerts ──────

const SECRET = 'whsec_test_handler';

function sign(body, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  return { ts, v1: crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex') };
}

function makeReq(body, sigHeader) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.headers = { 'stripe-signature': sigHeader };
  return req;
}

function makeRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function deliverEvent(event, { header } = {}) {
  const body = JSON.stringify(event);
  const { ts, v1 } = sign(body);
  const res = makeRes();
  await handler(makeReq(body, header ?? `t=${ts},v1=${v1}`), res);
  await Promise.all(bg.pending.splice(0));
  return res;
}

const checkoutEvent = (s, type = 'checkout.session.completed') => ({ id: `evt_${s.id}`, type, data: { object: s } });

describe('Stripe webhook handler', () => {
  const SAVED_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  beforeEach(() => {
    vi.clearAllMocks();
    bg.pending.length = 0;
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    db.createPayment.mockResolvedValue({});
    db.findPaymentByTransactionId.mockResolvedValue(null);
    db.findMintByPaymentId.mockResolvedValue(null);
  });
  afterAll(() => {
    if (SAVED_SECRET === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = SAVED_SECRET;
  });

  it('answers 500 and alerts when STRIPE_WEBHOOK_SECRET is unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = makeRes();
    await handler(makeReq('{}', 't=1,v1=00'), res);
    expect(res.statusCode).toBe(500);
    expect(sendAlert).toHaveBeenCalledWith('stripe.webhook_unconfigured', {}, { severity: 'critical', dedupeKey: 'config' });
  });

  it('rejects a bad signature with 400', async () => {
    const res = await deliverEvent(checkoutEvent(session('cs_bad_sig')), { header: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
    expect(res.statusCode).toBe(400);
    expect(db.createPayment).not.toHaveBeenCalled();
  });

  it('accepts a header with two v1 entries when only the second matches (secret rotation)', async () => {
    const body = JSON.stringify(checkoutEvent(session('cs_two_sigs')));
    const { ts, v1 } = sign(body);
    const stale = sign(body, 'whsec_old_secret', ts).v1;
    expect(() => verifyStripeSignature(body, `t=${ts},v1=${stale},v1=${v1}`, SECRET)).not.toThrow();
    expect(() => verifyStripeSignature(body, `t=${ts},v1=${v1},v1=${stale}`, SECRET)).not.toThrow();
    expect(() => verifyStripeSignature(body, `t=${ts},v1=${stale}`, SECRET)).toThrow(/mismatch/);

    const res = makeRes();
    await handler(makeReq(body, `t=${ts},v1=${stale},v1=${v1}`), res);
    await Promise.all(bg.pending.splice(0));
    expect(res.statusCode).toBe(200);
    expect(db.createPayment).toHaveBeenCalledTimes(1);
  });

  it('still rejects an expired timestamp even when a v1 entry matches', () => {
    const body = '{}';
    const old = Math.floor(Date.now() / 1000) - 600;
    const { v1 } = sign(body, SECRET, old);
    expect(() => verifyStripeSignature(body, `t=${old},v1=${v1}`, SECRET)).toThrow(/too old/);
  });

  it('records the Payments marker BEFORE acking, then fulfils in the background', async () => {
    const res = await deliverEvent(checkoutEvent(session('cs_sync_ok')));
    expect(res.statusCode).toBe(200);
    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
  });

  it('a DB failure on the marker answers 500 (Stripe redelivers) and never mints', async () => {
    db.createPayment.mockRejectedValueOnce(new Error('Supabase 503'));
    const res = await deliverEvent(checkoutEvent(session('cs_sync_fail')));
    expect(res.statusCode).toBe(500);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('stripe.payment_marker_failed',
      expect.objectContaining({ sessionId: 'cs_sync_fail', error: 'Supabase 503' }),
      { severity: 'critical', dedupeKey: 'cs_sync_fail' });
  });

  it('a failed idempotency lookup also answers 500 and never mints', async () => {
    db.findPaymentByTransactionId.mockRejectedValueOnce(new Error('Supabase timeout'));
    const res = await deliverEvent(checkoutEvent(session('cs_lookup_500')));
    expect(res.statusCode).toBe(500);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('recordCheckoutPayment throws on a real DB failure but not on DUPLICATE_PAYMENT', async () => {
    db.createPayment.mockRejectedValueOnce(new Error('Supabase 500'));
    await expect(recordCheckoutPayment(session('cs_rec_throw'))).rejects.toThrow('Supabase 500');
    db.createPayment.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'DUPLICATE_PAYMENT' }));
    await expect(recordCheckoutPayment(session('cs_rec_dup'))).resolves.toMatchObject({ status: 'duplicate', concurrent: true, tier: 'full' });
    await expect(recordCheckoutPayment(session('cs_rec_ok'))).resolves.toMatchObject({ status: 'recorded', tier: 'full' });
    await expect(recordCheckoutPayment(session('cs_rec_unpaid', { payment_status: 'unpaid' }))).resolves.toMatchObject({ status: 'skipped' });
  });

  it('a SETTLED session with no customer email alerts stripe.paid_session_no_email (critical) and writes nothing', async () => {
    const s = session('cs_paid_no_email', { customer_details: { name: 'Nobody' } });
    const res = await deliverEvent(checkoutEvent(s));
    expect(res.statusCode).toBe(200);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('stripe.paid_session_no_email', { sessionId: 'cs_paid_no_email', tier: 'full' },
      { severity: 'critical', dedupeKey: 'cs_paid_no_email' });
  });

  it('a concurrent DUPLICATE_PAYMENT answers 200 and does not mint', async () => {
    db.createPayment.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'DUPLICATE_PAYMENT' }));
    const res = await deliverEvent(checkoutEvent(session('cs_sync_dup')));
    expect(res.statusCode).toBe(200);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(email.sendNftDelivery).not.toHaveBeenCalled();
  });

  it('a redelivery (Payments row exists, mint row exists) answers 200 and does not mint again', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });
    db.findMintByPaymentId.mockResolvedValueOnce({ id: 'mint_prior', fields: { 'Mint Status': 'Sent', 'Reference': 'INSIDER_001' } });
    const res = await deliverEvent(checkoutEvent(session('cs_redeliver_done')));
    expect(res.statusCode).toBe(200);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(email.sendNftDelivery).not.toHaveBeenCalled();
  });

  it('a redelivery whose first run died before minting self-heals (fulfilNft re-driven)', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });
    const res = await deliverEvent(checkoutEvent(session('cs_redeliver_heal')));
    expect(res.statusCode).toBe(200);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
  });

  it('a redelivery of a refunded payment is never fulfilled again', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior', fields: { 'Status': 'Refunded' } });
    const res = await deliverEvent(checkoutEvent(session('cs_redeliver_refunded')));
    expect(res.statusCode).toBe(200);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it('a redelivered no-NFT purchase does not resend the purchase confirmation', async () => {
    db.findPaymentByTransactionId.mockResolvedValueOnce({ id: 'recPrior' });
    await deliverEvent(checkoutEvent(session('cs_redeliver_bogo', { amount_total: 29999, metadata: { tier: 'bogo' } })));
    expect(email.sendPurchaseConfirmation).not.toHaveBeenCalled();
  });

  it('an unsettled checkout answers 200 with the awaiting-payment alert and no marker', async () => {
    const res = await deliverEvent(checkoutEvent(session('cs_sync_unpaid', { payment_status: 'unpaid' })));
    expect(res.statusCode).toBe(200);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('stripe.checkout_awaiting_payment', expect.objectContaining({ sessionId: 'cs_sync_unpaid' }));
  });

  it('a crash in background work alerts stripe.pipeline_crashed', async () => {
    // The renewal write fails, then its own alert throws: the handler rejects
    // after the 200, which only the waitUntil catch can surface.
    db.updateEntitlementState.mockRejectedValueOnce(new Error('db down'));
    sendAlert.mockImplementationOnce(() => { throw new Error('alert sink down'); });
    const res = await deliverEvent({
      id: 'evt_crash', type: 'invoice.payment_succeeded',
      data: { object: { amount_paid: 2999, customer_email: 'm@example.com' } },
    });
    expect(res.statusCode).toBe(200);
    expect(sendAlert).toHaveBeenCalledWith('stripe.pipeline_crashed',
      { eventId: 'evt_crash', type: 'invoice.payment_succeeded', error: 'alert sink down' },
      { severity: 'critical', dedupeKey: 'evt_crash' });
  });

  it('handles every REQUIRED_STRIPE_EVENTS type (none falls through to "Ignoring")', async () => {
    expect(REQUIRED_STRIPE_EVENTS).toEqual([
      'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
      'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_succeeded',
      'invoice.payment_failed', 'charge.refunded', 'charge.dispute.created',
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const type of REQUIRED_STRIPE_EVENTS) {
        const res = await deliverEvent({ id: `evt_${type}`, type, data: { object: { id: `obj_${type}`, payment_status: 'unpaid', metadata: {} } } });
        expect(res.statusCode).toBe(200);
      }
      expect(log.mock.calls.some(([m]) => String(m).includes('Ignoring event'))).toBe(false);
      await deliverEvent({ id: 'evt_other', type: 'payout.paid', data: { object: {} } });
      expect(log.mock.calls.some(([m]) => String(m).includes('Ignoring event type="payout.paid"'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
