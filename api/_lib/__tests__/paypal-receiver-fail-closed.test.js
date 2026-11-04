/**
 * PayPal IPN receiver validation must FAIL CLOSED.
 *
 * Before this change, an unset PAYPAL_BUSINESS_EMAIL skipped receiver validation
 * (fail-open): a verified IPN paid to ANY PayPal account would mint/grant. And the
 * receiver compare was case-sensitive, so casing drift on receiver_email could
 * falsely reject a legitimate payment. Now: unset business email ⇒ refuse + alert;
 * compare is case-insensitive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  createPayment: vi.fn().mockResolvedValue({}),
  createNftMint: vi.fn().mockResolvedValue({}),
  findPaymentByTransactionId: vi.fn().mockResolvedValue(null),
  findPaymentBySubscriptionId: vi.fn().mockResolvedValue(null),
  listPaymentsByEmail: vi.fn().mockResolvedValue([]),
  updateEntitlementState: vi.fn().mockResolvedValue({}),
  nextSerial: vi.fn().mockResolvedValue(1),
  // fulfil.js (shared NFT fulfilment):
  findMintByPaymentId: vi.fn().mockResolvedValue(null), updateNftMint: vi.fn().mockResolvedValue({}), findMemberByEmail: vi.fn().mockResolvedValue(null), updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
}));
vi.mock('../airtable-import.js', () => ({ airtableImportEnabled: vi.fn(() => false), countAirtableMintsByPrefix: vi.fn() }));
vi.mock('../crossmint.js', () => ({
  mintToEmail: vi.fn().mockResolvedValue({ ok: true, actionId: 'act_test', imageUrl: null }),
}));
vi.mock('../email.js', () => ({
  sendNftDelivery: vi.fn().mockResolvedValue({}),
  sendPurchaseConfirmation: vi.fn().mockResolvedValue({}),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }));

import { handleVerifiedIPN, processIPN } from '../../webhooks/paypal.js';
import * as db from '../db.js';
import * as crossmint from '../crossmint.js';
import * as email from '../email.js';
import { sendAlert } from '../alert.js';

// A completed IPN for a $250 Full Package (tier "full" → Aurevon Insider).
function completedIpn(receiver, extra = {}) {
  return {
    txn_id: 'PP_TEST_1',
    payer_email: 'buyer@example.com',
    first_name: 'Buy', last_name: 'Er',
    mc_gross: '250.00',
    mc_currency: 'USD',
    payment_status: 'Completed',
    receiver_email: receiver,
    ...extra,
  };
}

const SAVED = { ...process.env };
const crossmintPayload = () => crossmint.mintToEmail.mock.calls[0]?.[0] ?? null;

describe('paypal receiver validation (fail-closed + case-insensitive)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED };
    delete process.env.PAYPAL_BUSINESS_EMAIL;
  });

  it('refuses to process (no mint, no marker) and alerts when PAYPAL_BUSINESS_EMAIL is unset', async () => {
    await handleVerifiedIPN(completedIpn('anyone@paypal.com'));
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('paypal.business_email_unset', expect.objectContaining({ txnId: 'PP_TEST_1' }));
  });

  it('proceeds when receiver matches business email case-insensitively', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'MIKE@Aurevonvc.com';
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com'));
    // Passed the receiver gate → wrote the idempotency marker.
    expect(db.createPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects a genuine receiver mismatch (no marker written)', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    await handleVerifiedIPN(completedIpn('attacker@paypal.com'));
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('refuses a completed non-USD payment (no marker, no mint)', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', {
      mc_gross: '2499.00',
      mc_currency: 'JPY',
      custom: '{"tier":"enterprise"}',
    }));
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('paypal.non_usd_rejected', expect.objectContaining({ currency: 'JPY', gross: '2499.00' }));
  });

  it('does not alert on a non-USD IPN that is Pending or for another receiver', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', { mc_currency: 'JPY', payment_status: 'Pending' }));
    await handleVerifiedIPN(completedIpn('someone-else@example.com', { mc_currency: 'JPY' }));
    expect(sendAlert).not.toHaveBeenCalledWith('paypal.non_usd_rejected', expect.anything());
  });

  it('refuses a spoofed custom.tier that does not match USD paid', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', {
      mc_gross: '1.00',
      custom: '{"tier":"enterprise"}',
    }));
    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('refuses a verified IPN with no txn_id', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    const ipn = completedIpn('mike@aurevonvc.com');
    delete ipn.txn_id;
    await handleVerifiedIPN(ipn);
    expect(db.createPayment).not.toHaveBeenCalled();
  });
});

describe('paypal IPN idempotency (fail-closed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED };
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: async () => 'VERIFIED' }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...SAVED };
  });

  it('does NOT process when the idempotency lookup itself fails', async () => {
    db.findPaymentByTransactionId.mockRejectedValueOnce(new Error('Supabase timeout'));
    const raw = new URLSearchParams(completedIpn('mike@aurevonvc.com')).toString();
    await processIPN(raw);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(
      'paypal.idempotency_lookup_failed',
      expect.objectContaining({ txnId: 'PP_TEST_1' }),
    );
  });

  it('mints once on the happy path (control for the marker tests below)', async () => {
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com'));
    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
  });

  it('a concurrent duplicate IPN (DUPLICATE_PAYMENT on the marker) returns quietly: no mint, no alert', async () => {
    const dup = Object.assign(new Error('Supabase insert payments: duplicate key value violates unique constraint'), { code: 'DUPLICATE_PAYMENT' });
    db.createPayment.mockRejectedValueOnce(dup);

    await expect(handleVerifiedIPN(completedIpn('mike@aurevonvc.com'))).resolves.toBeUndefined();

    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(email.sendNftDelivery).not.toHaveBeenCalled();
    expect(email.sendPurchaseConfirmation).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('any other marker failure alerts and aborts before mint', async () => {
    db.createPayment.mockRejectedValueOnce(new Error('Supabase insert payments: connection reset'));

    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com'));

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('paypal.payment_marker_failed', expect.objectContaining({ txnId: 'PP_TEST_1' }));
  });

  it('does NOT process a verified IPN missing txn_id', async () => {
    const ipn = completedIpn('mike@aurevonvc.com');
    delete ipn.txn_id;
    await processIPN(new URLSearchParams(ipn).toString());
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });
});

describe('paypal txn_type gate + lifecycle receiver (fail-closed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED };
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
  });
  afterEach(() => { process.env = { ...SAVED }; });

  it('cart $250 (2 × $125) → no Crossmint, purchase confirmation, Pass Type "addons"', async () => {
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', { txn_type: 'cart', num_cart_items: '2', custom: '{"tier":"full"}' }));
    expect(crossmintPayload()).toBeNull();
    expect(db.createPayment).toHaveBeenCalledWith(expect.objectContaining({ tier: 'addons' }));
    expect(email.sendPurchaseConfirmation).toHaveBeenCalledWith(expect.objectContaining({ tier: 'addons', transactionId: 'PP_TEST_1' }));
    expect(email.sendNftDelivery).not.toHaveBeenCalled();
  });

  it('subscr_signup → no writes', async () => {
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', { txn_type: 'subscr_signup', subscr_id: 'I-SIGNUP1' }));
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(email.sendPurchaseConfirmation).not.toHaveBeenCalled();
  });

  it('subscr_cancel with PAYPAL_BUSINESS_EMAIL unset → alert, no billing write', async () => {
    delete process.env.PAYPAL_BUSINESS_EMAIL;
    db.findPaymentBySubscriptionId.mockResolvedValueOnce({ id: 'pay_1', fields: { 'Pass Type': 'comm_monthly' } });
    await handleVerifiedIPN({ txn_type: 'subscr_cancel', subscr_id: 'I-GEN1', payer_email: 'buyer@example.com', receiver_email: 'anyone@paypal.com' });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('paypal.business_email_unset', expect.objectContaining({ txnType: 'subscr_cancel', subscrId: 'I-GEN1' }));
  });

  it('subscr_cancel for a Genesis subscription to us → billing cancelled', async () => {
    db.findPaymentBySubscriptionId.mockResolvedValueOnce({ id: 'pay_1', fields: { 'Pass Type': 'comm_monthly' } });
    await handleVerifiedIPN({ txn_type: 'subscr_cancel', subscr_id: 'I-GEN1', payer_email: 'buyer@example.com', receiver_email: 'MIKE@aurevonvc.com' });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('buyer@example.com', { entitlementType: 'monthly_membership', billingState: 'cancelled' });
  });

  it('subscr_cancel for another receiver → no billing write', async () => {
    db.findPaymentBySubscriptionId.mockResolvedValueOnce({ id: 'pay_1', fields: { 'Pass Type': 'comm_monthly' } });
    await handleVerifiedIPN({ txn_type: 'subscr_cancel', subscr_id: 'I-GEN1', payer_email: 'buyer@example.com', receiver_email: 'attacker@paypal.com' });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });
});
