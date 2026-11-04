/**
 * PayPal IPN fulfilment is as strict as Stripe (Task 10).
 *
 *  - txn_type allow-list: only web_accept / express_checkout / cart /
 *    subscr_payment fulfil (missing txn_type = web_accept); subscr_cancel /
 *    subscr_eot / subscr_failed touch billing only; anything else writes nothing.
 *  - A multi-item cart is add-ons: never an NFT, whatever the total.
 *  - PAYPAL_ITEM_TIERS[item_number] is trusted only when the USD paid matches.
 *  - A recurring subscr_payment (same subscr_id, new txn_id) never mints again.
 *
 * Runs the REAL handler, tiers, entitlements, fulfil, crossmint and email
 * modules; only the database, alerts and the network are faked (nft-harness).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const store = vi.hoisted(() => ({}));

vi.mock('../db.js', async () => (await import('./helpers/nft-harness.js')).makeFakeDb(store));
vi.mock('../airtable-import.js', () => ({
  airtableImportEnabled: vi.fn(() => false), countAirtableMintsByPrefix: vi.fn(),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), addMemberToGuild: vi.fn(), removeRoleFromMember: vi.fn() }));

import {
  resetStore, applyEnv, installFetch, crossmintCalls, resendCalls, ENV,
} from './helpers/nft-harness.js';

const SAVED = { ...process.env };
let db;
let sendAlert;
let processIPN;
let handleVerifiedIPN;

beforeAll(async () => {
  applyEnv(); // before crossmint.js first loads (reads CROSSMINT_ENV at import)
  db = await import('../db.js');
  ({ sendAlert } = await import('../alert.js'));
  ({ processIPN, handleVerifiedIPN } = await import('../../webhooks/paypal.js'));
});
afterAll(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

beforeEach(() => {
  resetStore(store);
  applyEnv();
  delete process.env.PAYPAL_ITEM_TIERS;
  vi.clearAllMocks();
  installFetch(store);
});

const BUYER = 'sub.buyer@example.com';
const SUB = 'I-GENESIS0001';

function ipn(fields) {
  return {
    payer_email: BUYER,
    first_name: 'Sub', last_name: 'Buyer',
    mc_currency: 'USD',
    payment_status: 'Completed',
    receiver_email: ENV.PAYPAL_BUSINESS_EMAIL,
    ...fields,
  };
}
const deliver = (fields) => processIPN(new URLSearchParams(ipn(fields)).toString());
const alerted = (event) => sendAlert.mock.calls.filter(([e]) => e === event);
const payment = (txnId) => store.payments.get(txnId)?.fields ?? null;

function expectNoWrites() {
  expect(db.createPayment).not.toHaveBeenCalled();
  expect(db.updateEntitlementState).not.toHaveBeenCalled();
  expect(db.upsertMemberByEmail).not.toHaveBeenCalled();
  expect(db.createNftMint).not.toHaveBeenCalled();
  expect(crossmintCalls(store)).toHaveLength(0);
  expect(resendCalls(store)).toHaveLength(0);
}

describe('multi-item cart', () => {
  it('cart of 2 × $125 Sensitivity add-ons ($250) → no Crossmint, Pass Type "addons", one purchase confirmation', async () => {
    await deliver({
      txn_type: 'cart', txn_id: 'PPCART250', mc_gross: '250.00', num_cart_items: '2',
      item_name1: 'Sensitivity Modeling', mc_gross_1: '125.00',
      item_name2: 'Sensitivity Modeling', mc_gross_2: '125.00',
      // A forged custom claiming Full Package must not turn a cart into an Insider.
      custom: '{"tier":"full"}',
    });

    expect(crossmintCalls(store)).toHaveLength(0);
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(payment('PPCART250')).toMatchObject({ 'Pass Type': 'addons', 'Status': 'Succeeded' });
    const emails = resendCalls(store);
    expect(emails).toHaveLength(1);
    expect(emails[0].body.subject).toMatch(/purchase is confirmed/);
    expect(emails[0].body.html).toContain('Add-Ons');
    expect(emails[0].body.html).not.toContain('action=auth');
  });

  it('an express_checkout with more than one item is add-ons too', async () => {
    await deliver({ txn_type: 'express_checkout', txn_id: 'PPEC2ITEMS', mc_gross: '250.00', num_cart_items: '2' });
    expect(crossmintCalls(store)).toHaveLength(0);
    expect(payment('PPEC2ITEMS')['Pass Type']).toBe('addons');
  });
});

describe('PAYPAL_ITEM_TIERS', () => {
  it('item_number mapped to full at $250 → Insider minted', async () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-FULL': 're_full' });
    await deliver({ txn_type: 'web_accept', txn_id: 'PPITEMFULL', mc_gross: '250.00', item_number: 'AUR-FULL' });

    expect(crossmintCalls(store)).toHaveLength(1);
    expect(store.mints).toHaveLength(1);
    expect(store.mints[0].fields).toMatchObject({ 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full' });
    expect(payment('PPITEMFULL')['Pass Type']).toBe('full');
  });

  it('a single-item cart (no amount inference) mints only through the item map', async () => {
    await deliver({ txn_type: 'cart', txn_id: 'PPCART1NOMAP', mc_gross: '250.00', num_cart_items: '1', item_number1: 'AUR-FULL' });
    expect(crossmintCalls(store)).toHaveLength(0);
    expect(payment('PPCART1NOMAP')['Pass Type']).toBe('unknown');

    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-FULL': 'full' });
    await deliver({ txn_type: 'cart', txn_id: 'PPCART1MAP', mc_gross: '250.00', num_cart_items: '1', item_number1: 'AUR-FULL' });
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(store.mints[0].fields['NFT Type']).toBe('Aurevon Insider');
  });

  it('item_number mapped to enterprise at $1 → no NFT', async () => {
    process.env.PAYPAL_ITEM_TIERS = JSON.stringify({ 'AUR-ENT': 'enterprise' });
    await deliver({ txn_type: 'web_accept', txn_id: 'PPITEMENT1', mc_gross: '1.00', item_number: 'AUR-ENT' });

    expect(crossmintCalls(store)).toHaveLength(0);
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(payment('PPITEMENT1')['Pass Type']).toBe('unknown');
  });

  it('invalid JSON is ignored with exactly one paypal.item_tiers_invalid alert', async () => {
    process.env.PAYPAL_ITEM_TIERS = '{not json';
    await deliver({ txn_type: 'web_accept', txn_id: 'PPBADMAP01', mc_gross: '250.00', item_number: 'AUR-FULL' });
    await deliver({ txn_type: 'web_accept', txn_id: 'PPBADMAP02', mc_gross: '250.00', item_number: 'AUR-FULL' });

    expect(alerted('paypal.item_tiers_invalid')).toHaveLength(1);
    // Amount inference still works for a single-item payment.
    expect(payment('PPBADMAP01')['Pass Type']).toBe('full');
  });
});

describe('subscr_payment', () => {
  const first = { txn_type: 'subscr_payment', subscr_id: SUB, txn_id: 'PPSUBPAY01', mc_gross: '29.99', custom: '{"tier":"comm_monthly"}' };

  it('the first payment for a subscr_id mints Genesis once and activates billing for 31 days', async () => {
    const before = Date.now();
    await deliver(first);

    expect(crossmintCalls(store)).toHaveLength(1);
    expect(store.mints[0].fields['NFT Type']).toBe('001 Genesis');
    expect(payment('PPSUBPAY01')).toMatchObject({ 'Pass Type': 'comm_monthly', 'Token': `subscr:${SUB}` });
    expect(db.updateEntitlementState).toHaveBeenCalledWith(BUYER, expect.objectContaining({
      entitlementType: 'monthly_membership', billingState: 'active',
    }));
    const { expiresAt } = db.updateEntitlementState.mock.calls[0][1];
    const days = (Date.parse(expiresAt) - before) / 86_400_000;
    expect(days).toBeGreaterThan(30.9);
    expect(days).toBeLessThan(31.1);
  });

  it('a second subscr_payment for an active Genesis subscription → recorded, billing active, NO mint, NO email', async () => {
    await deliver(first);
    const mintsAfterFirst = crossmintCalls(store).length;
    const emailsAfterFirst = resendCalls(store).length;
    vi.clearAllMocks();

    await deliver({ ...first, txn_id: 'PPSUBPAY02' });

    expect(crossmintCalls(store)).toHaveLength(mintsAfterFirst);
    expect(store.mints).toHaveLength(1);
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(resendCalls(store)).toHaveLength(emailsAfterFirst);
    expect(payment('PPSUBPAY02')).toMatchObject({ 'Pass Type': 'comm_monthly', 'Token': `subscr:${SUB}` });
    expect(db.updateEntitlementState).toHaveBeenCalledTimes(1);
    expect(db.updateEntitlementState).toHaveBeenCalledWith(BUYER, expect.objectContaining({
      entitlementType: 'monthly_membership', billingState: 'active', expiresAt: expect.any(String),
    }));
  });

  it('a redelivered renewal (same txn_id) changes nothing', async () => {
    await deliver(first);
    await deliver({ ...first, txn_id: 'PPSUBPAY02' });
    vi.clearAllMocks();
    await deliver({ ...first, txn_id: 'PPSUBPAY02' });
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('a Pro Retainer renewal never mints and never touches the member row (Ember is permanent)', async () => {
    const retainer = { txn_type: 'subscr_payment', subscr_id: 'I-EMBER0001', txn_id: 'PPRETAIN01', mc_gross: '1499.00' };
    await deliver(retainer);
    expect(store.mints.map((m) => m.fields['NFT Type'])).toEqual(['Aurevon Ember']);
    vi.clearAllMocks();

    await deliver({ ...retainer, txn_id: 'PPRETAIN02' });
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(store.mints).toHaveLength(1);
    expect(payment('PPRETAIN02')['Pass Type']).toBe('retainer');
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('a renewal whose amount matches no tier is recorded, billing NOT extended, alerted', async () => {
    await deliver(first);
    vi.clearAllMocks();
    await deliver({ ...first, txn_id: 'PPSUBPAY03', mc_gross: '1.00', custom: '' });
    expect(payment('PPSUBPAY03')['Pass Type']).toBe('unknown');
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(alerted('paypal.subscription_renewal_unmatched')).toHaveLength(1);
  });

  it('a subscr_payment without subscr_id is refused (no marker, no mint) and alerted', async () => {
    await deliver({ ...first, subscr_id: '' });
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmintCalls(store)).toHaveLength(0);
    expect(alerted('paypal.subscr_id_missing')).toHaveLength(1);
  });

  it('a failed subscription lookup aborts before the marker (fail-closed)', async () => {
    db.findPaymentBySubscriptionId.mockRejectedValueOnce(new Error('Supabase timeout'));
    await deliver(first);
    expect(db.createPayment).not.toHaveBeenCalled();
    expect(crossmintCalls(store)).toHaveLength(0);
    expect(alerted('paypal.subscription_lookup_failed')).toHaveLength(1);
  });
});

describe('subscription lifecycle (billing only)', () => {
  const genesis = { txn_type: 'subscr_payment', subscr_id: SUB, txn_id: 'PPSUBPAY01', mc_gross: '29.99' };

  it.each(['subscr_cancel', 'subscr_eot', 'subscr_failed'])(
    '%s for a Genesis member → monthly billing cancelled; no Payments row, no txn_id needed',
    async (txnType) => {
      await deliver(genesis);
      const mintCalls = crossmintCalls(store).length;
      vi.clearAllMocks();

      await deliver({ txn_type: txnType, subscr_id: SUB, payment_status: '', mc_gross: '' });

      expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
      expect(db.createPayment).not.toHaveBeenCalled();
      expect(crossmintCalls(store)).toHaveLength(mintCalls);
      expect(db.updateEntitlementState).toHaveBeenCalledTimes(1);
      expect(db.updateEntitlementState).toHaveBeenCalledWith(BUYER, {
        entitlementType: 'monthly_membership', billingState: 'cancelled',
      });
    },
  );

  it('subscr_cancel is idempotent (a repeat writes the same cancelled state)', async () => {
    await deliver(genesis);
    vi.clearAllMocks();
    await deliver({ txn_type: 'subscr_cancel', subscr_id: SUB });
    await deliver({ txn_type: 'subscr_cancel', subscr_id: SUB });
    expect(db.updateEntitlementState.mock.calls.map((c) => c[1])).toEqual([
      { entitlementType: 'monthly_membership', billingState: 'cancelled' },
      { entitlementType: 'monthly_membership', billingState: 'cancelled' },
    ]);
  });

  it('subscr_cancel for an Ember (Pro Retainer) subscription only logs', async () => {
    await deliver({ txn_type: 'subscr_payment', subscr_id: 'I-EMBER0001', txn_id: 'PPRETAIN01', mc_gross: '1499.00' });
    vi.clearAllMocks();
    await deliver({ txn_type: 'subscr_cancel', subscr_id: 'I-EMBER0001' });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('a legacy subscription with no Payments row is judged by its regular amount (mc_amount3)', async () => {
    await deliver({ txn_type: 'subscr_cancel', subscr_id: 'I-LEGACY01', mc_amount3: '29.99' });
    expect(db.updateEntitlementState).toHaveBeenCalledWith(BUYER, { entitlementType: 'monthly_membership', billingState: 'cancelled' });
    vi.clearAllMocks();
    await deliver({ txn_type: 'subscr_cancel', subscr_id: 'I-LEGACY02', mc_amount3: '2499.00' });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('with neither a row nor an amount, only a monthly_membership member is cancelled', async () => {
    store.members.set(BUYER, { id: 'mem_1', fields: { 'Entitlement Type': 'product_c_reward' } });
    await deliver({ txn_type: 'subscr_cancel', subscr_id: 'I-LEGACY03' });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();

    store.members.set(BUYER, { id: 'mem_1', fields: { 'Entitlement Type': 'monthly_membership' } });
    await deliver({ txn_type: 'subscr_cancel', subscr_id: 'I-LEGACY03' });
    expect(db.updateEntitlementState).toHaveBeenCalledWith(BUYER, { entitlementType: 'monthly_membership', billingState: 'cancelled' });
  });

  it('cancelling an old Genesis subscription while a newer one is paid up is held', async () => {
    await deliver(genesis);
    await deliver({ ...genesis, subscr_id: 'I-GENESIS0002', txn_id: 'PPSUBNEW01' });
    vi.clearAllMocks();

    await deliver({ txn_type: 'subscr_cancel', subscr_id: SUB });

    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(alerted('paypal.monthly_change_held')).toHaveLength(1);
  });

  it('a lifecycle IPN for another receiver changes nothing', async () => {
    await deliver(genesis);
    vi.clearAllMocks();
    await deliver({ txn_type: 'subscr_cancel', subscr_id: SUB, receiver_email: 'someone-else@example.com' });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('a lifecycle IPN that carries only `business` is matched against PAYPAL_BUSINESS_EMAIL', async () => {
    await deliver(genesis);
    vi.clearAllMocks();
    await deliver({ txn_type: 'subscr_cancel', subscr_id: SUB, receiver_email: '', business: ENV.PAYPAL_BUSINESS_EMAIL.toUpperCase() });
    expect(db.updateEntitlementState).toHaveBeenCalledTimes(1);
  });
});

describe('txn_type allow-list', () => {
  it('subscr_signup → 200 path, no writes at all', async () => {
    await deliver({ txn_type: 'subscr_signup', subscr_id: SUB, mc_amount3: '29.99', custom: '{"tier":"comm_monthly"}' });
    expectNoWrites();
    expect(db.findPaymentByTransactionId).not.toHaveBeenCalled();
  });

  it.each(['send_money', 'adjustment', 'new_case', 'masspay', 'recurring_payment', 'virtual_terminal'])(
    'txn_type=%s never fulfils, even with a txn_id and a catalog amount',
    async (txnType) => {
      await deliver({ txn_type: txnType, txn_id: `PP${txnType.replace(/_/g, '')}`.slice(0, 20), mc_gross: '2499.00' });
      expectNoWrites();
    },
  );

  it('handleVerifiedIPN applies the same allow-list when called directly', async () => {
    await handleVerifiedIPN(ipn({ txn_type: 'subscr_signup', txn_id: 'PPDIRECT01', mc_gross: '250.00' }));
    expectNoWrites();
  });

  it('a missing txn_type is treated as web_accept (hosted NCP IPNs omit it)', async () => {
    await deliver({ txn_id: 'PPNOTYPE01', mc_gross: '250.00' });
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(store.mints[0].fields['NFT Type']).toBe('Aurevon Insider');
  });
});
