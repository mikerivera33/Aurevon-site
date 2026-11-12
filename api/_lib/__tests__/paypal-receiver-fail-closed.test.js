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

vi.mock('../airtable.js', () => ({
  createPayment: vi.fn().mockResolvedValue({}),
  createNftMint: vi.fn().mockResolvedValue({}),
  findPaymentByTransactionId: vi.fn().mockResolvedValue(null),
  findAnyMintByEmailAndType: vi.fn().mockResolvedValue(null),
  countNftMintsByPrefix: vi.fn().mockResolvedValue(0),
}));
vi.mock('../crossmint.js', () => ({
  mintToEmail: vi.fn().mockResolvedValue({ ok: true, actionId: 'act_test', imageUrl: null }),
}));
vi.mock('../email.js', () => ({
  sendNftDelivery: vi.fn().mockResolvedValue({}),
  sendPurchaseConfirmation: vi.fn().mockResolvedValue({}),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }));

import { handleVerifiedIPN, processIPN } from '../../webhooks/paypal.js';
import * as airtable from '../airtable.js';
import * as crossmint from '../crossmint.js';
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

describe('paypal receiver validation (fail-closed + case-insensitive)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED };
    delete process.env.PAYPAL_BUSINESS_EMAIL;
  });

  it('refuses to process (no mint, no marker) and alerts when PAYPAL_BUSINESS_EMAIL is unset', async () => {
    await handleVerifiedIPN(completedIpn('anyone@paypal.com'));
    expect(airtable.createPayment).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('paypal.business_email_unset', expect.objectContaining({ txnId: 'PP_TEST_1' }));
  });

  it('proceeds when receiver matches business email case-insensitively', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'MIKE@Aurevonvc.com';
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com'));
    // Passed the receiver gate → wrote the idempotency marker.
    expect(airtable.createPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects a genuine receiver mismatch (no marker written)', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    await handleVerifiedIPN(completedIpn('attacker@paypal.com'));
    expect(airtable.createPayment).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('refuses a completed non-USD payment (no marker, no mint)', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', {
      mc_gross: '2499.00',
      mc_currency: 'JPY',
      custom: '{"tier":"enterprise"}',
    }));
    expect(airtable.createPayment).not.toHaveBeenCalled();
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
    expect(airtable.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('refuses a verified IPN with no txn_id', async () => {
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
    const ipn = completedIpn('mike@aurevonvc.com');
    delete ipn.txn_id;
    await handleVerifiedIPN(ipn);
    expect(airtable.createPayment).not.toHaveBeenCalled();
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
    airtable.findPaymentByTransactionId.mockRejectedValueOnce(new Error('Airtable timeout'));
    const raw = new URLSearchParams(completedIpn('mike@aurevonvc.com')).toString();
    await processIPN(raw);
    expect(airtable.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(
      'paypal.idempotency_lookup_failed',
      expect.objectContaining({ txnId: 'PP_TEST_1' }),
    );
  });

  it('does NOT process a verified IPN missing txn_id', async () => {
    const ipn = completedIpn('mike@aurevonvc.com');
    delete ipn.txn_id;
    await processIPN(new URLSearchParams(ipn).toString());
    expect(airtable.createPayment).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });
});

describe('paypal stacked-cart and renewal fulfilment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED };
    process.env.PAYPAL_BUSINESS_EMAIL = 'mike@aurevonvc.com';
  });

  it('does not mint Insider when two $125 add-ons total $250', async () => {
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', {
      mc_gross: '250.00',
      num_cart_items: '2',
      item_name1: 'Sensitivity Modeling',
      mc_gross_1: '125.00',
      item_name2: 'Sensitivity Modeling',
      mc_gross_2: '125.00',
    }));
    expect(airtable.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('does not re-mint Genesis on a later subscr_payment', async () => {
    airtable.findAnyMintByEmailAndType.mockResolvedValueOnce({ id: 'mint_genesis_1' });
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', {
      mc_gross: '29.99',
      txn_type: 'subscr_payment',
      subscr_id: 'I-EXISTING',
    }));
    expect(airtable.createPayment).toHaveBeenCalledTimes(1);
    expect(airtable.findAnyMintByEmailAndType).toHaveBeenCalledWith('buyer@example.com', '001 Genesis');
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('mints Genesis on the first subscr_payment', async () => {
    airtable.findAnyMintByEmailAndType.mockResolvedValueOnce(null);
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com', {
      mc_gross: '29.99',
      txn_type: 'subscr_payment',
      subscr_id: 'I-NEW',
    }));
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
  });

  it('still mints Insider for a single-item $250 NCP payment', async () => {
    await handleVerifiedIPN(completedIpn('mike@aurevonvc.com'));
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
  });
});
