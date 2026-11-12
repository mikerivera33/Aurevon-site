/**
 * Subscription lifecycle → entitlement state (Reliability: dead revocation backstop).
 *
 * Nothing wrote the Members entitlement fields the daily revocation cron reads
 * (Entitlement Type/Status/Expires At, Billing State), so cancelled monthly members
 * kept their Discord role forever. The Stripe webhook now handles:
 *   - invoice.payment_succeeded  → stamp/renew monthly entitlement (active + expiry)
 *   - customer.subscription.updated → record billing state (past_due / cancelled)
 * Only comm_monthly (recurring, revocable) is tracked; product-tier subs are permanent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  updateEntitlementState: vi.fn().mockResolvedValue({}),
  // referenced at stripe.js module load:
  createPayment: vi.fn(), createNftMint: vi.fn(), updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
  findMemberByEmail: vi.fn().mockResolvedValue(null), findPaymentByTransactionId: vi.fn(),
  // fulfil.js (shared NFT fulfilment):
  findMintByPaymentId: vi.fn().mockResolvedValue(null), updateNftMint: vi.fn().mockResolvedValue({}),
  // refunds / disputes:
  updatePaymentStatus: vi.fn().mockResolvedValue(null), findActiveMintsByEmail: vi.fn().mockResolvedValue([]),
}));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../email.js', () => ({ sendNftDelivery: vi.fn(), sendPurchaseConfirmation: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ removeRoleFromMember: vi.fn().mockResolvedValue({}) }));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({}) }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

const customersRetrieve = vi.fn();
const customersList = vi.fn().mockResolvedValue({ data: [] });
const subscriptionsList = vi.fn().mockResolvedValue({ data: [] });
const subscriptionsRetrieve = vi.fn();
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.customers = { retrieve: customersRetrieve, list: customersList };
      this.subscriptions = { update: vi.fn().mockResolvedValue({}), list: subscriptionsList, retrieve: subscriptionsRetrieve };
    }
  },
}));

import { handleInvoicePaymentSucceeded, handleSubscriptionUpdated, handleSubscriptionDeleted } from '../../webhooks/stripe.js';
import * as db from '../db.js';
import * as discordBot from '../discord-bot.js';
import * as alert from '../alert.js';

const PERIOD_END = 1893456000; // unix seconds (future)
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();

describe('handleInvoicePaymentSucceeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customersList.mockReset().mockResolvedValue({ data: [] });
    subscriptionsList.mockReset().mockResolvedValue({ data: [] });
    subscriptionsRetrieve.mockReset().mockResolvedValue({ status: 'active' });
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  });
  afterEach(() => { delete process.env.STRIPE_SECRET_KEY; });

  // A late or redelivered invoice.payment_succeeded can arrive after
  // customer.subscription.deleted. It must not stamp the member active again.
  const monthlyInvoice = (extra) => ({
    amount_paid: 2999,
    customer_email: 'monthly@example.com',
    lines: { data: [{ period: { end: PERIOD_END } }] },
    ...extra,
  });

  it('still renews when the live subscription is active', async () => {
    await handleInvoicePaymentSucceeded(monthlyInvoice({ subscription: 'sub_live' }));
    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_live');
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', expect.objectContaining({ billingState: 'active' }));
  });

  it.each(['canceled', 'incomplete_expired', 'paused'])('does NOT re-activate billing when the subscription is %s', async (status) => {
    subscriptionsRetrieve.mockResolvedValueOnce({ status });
    await handleInvoicePaymentSucceeded(monthlyInvoice({ subscription: 'sub_dead' }));
    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_dead');
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('reads the subscription id from invoice.parent (newer Stripe API versions)', async () => {
    subscriptionsRetrieve.mockResolvedValueOnce({ status: 'canceled' });
    await handleInvoicePaymentSucceeded(monthlyInvoice({ parent: { subscription_details: { subscription: 'sub_parent' } } }));
    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_parent');
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('still stamps active when the subscription is past_due (this payment is the recovery)', async () => {
    subscriptionsRetrieve.mockResolvedValueOnce({ status: 'past_due' });
    await handleInvoicePaymentSucceeded(monthlyInvoice({ subscription: 'sub_past_due' }));
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', expect.objectContaining({ status: 'active', billingState: 'active' }));
  });

  it('still stamps active when Stripe cannot be read (a paid invoice is not dropped)', async () => {
    subscriptionsRetrieve.mockRejectedValueOnce(new Error('stripe down'));
    await handleInvoicePaymentSucceeded(monthlyInvoice({ subscription: 'sub_x' }));
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', expect.objectContaining({ billingState: 'active' }));
  });

  it('renews monthly entitlement (active + expiry) on a $29.99 invoice', async () => {
    await handleInvoicePaymentSucceeded({
      amount_paid: 2999,
      customer_email: 'monthly@example.com',
      lines: { data: [{ period: { end: PERIOD_END } }] },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', {
      entitlementType: 'monthly_membership',
      status: 'active',
      expiresAt: PERIOD_END_ISO,
      billingState: 'active',
    });
  });

  it('does NOT write entitlement state for a product-tier subscription ($1,499 retainer)', async () => {
    await handleInvoicePaymentSucceeded({
      amount_paid: 149900,
      customer_email: 'retainer@example.com',
      lines: { data: [{ period: { end: PERIOD_END } }] },
    });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('reads the tier from subscription_details metadata before amount inference ($0 promo renewal)', async () => {
    await handleInvoicePaymentSucceeded({
      amount_paid: 0,
      customer_email: 'promo@example.com',
      subscription_details: { metadata: { tier: 'comm_monthly' } },
      lines: { data: [{ period: { end: PERIOD_END } }] },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('promo@example.com', {
      entitlementType: 'monthly_membership', status: 'active', expiresAt: PERIOD_END_ISO, billingState: 'active',
    });
  });

  it('falls back to the invoice line metadata tier', async () => {
    await handleInvoicePaymentSucceeded({
      amount_paid: 2399, // discounted — amount alone infers nothing
      customer_email: 'line@example.com',
      lines: { data: [{ metadata: { tier: 'comm_monthly' }, period: { end: PERIOD_END } }] },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('line@example.com', expect.objectContaining({ billingState: 'active' }));
  });

  it('metadata tier for a non-monthly plan wins over a $29.99 amount', async () => {
    await handleInvoicePaymentSucceeded({
      amount_paid: 2999,
      customer_email: 'ret@example.com',
      subscription_details: { metadata: { tier: 're_retainer' } },
      lines: { data: [{ period: { end: PERIOD_END } }] },
    });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('skips when a monthly invoice has no customer email', async () => {
    await handleInvoicePaymentSucceeded({ amount_paid: 2999, lines: { data: [{ period: { end: PERIOD_END } }] } });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });
});

describe('handleSubscriptionUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customersList.mockReset().mockResolvedValue({ data: [] });
    subscriptionsList.mockReset().mockResolvedValue({ data: [] });
  });

  it('maps past_due status → Billing State past_due for a monthly member', async () => {
    await handleSubscriptionUpdated({
      status: 'past_due',
      current_period_end: PERIOD_END,
      metadata: { email: 'm@example.com', tier: 'comm_monthly' },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('m@example.com', {
      billingState: 'past_due',
      expiresAt: PERIOD_END_ISO,
    });
  });

  it('maps canceled status → Billing State cancelled', async () => {
    await handleSubscriptionUpdated({
      status: 'canceled',
      current_period_end: PERIOD_END,
      metadata: { email: 'm@example.com', tier: 'comm_monthly' },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('m@example.com', expect.objectContaining({ billingState: 'cancelled' }));
  });

  it('ignores non-monthly subscriptions (retainer)', async () => {
    await handleSubscriptionUpdated({ status: 'past_due', metadata: { email: 'm@example.com', tier: 're_retainer' } });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('skips when subscription metadata has no email and no Stripe customer', async () => {
    await handleSubscriptionUpdated({ status: 'canceled', metadata: { tier: 'comm_monthly' } });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(customersRetrieve).not.toHaveBeenCalled();
  });

  it('does not downgrade billing when another monthly subscription for the email is active', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    customersList.mockResolvedValueOnce({ data: [{ id: 'cus_real' }] });
    subscriptionsList.mockResolvedValueOnce({ data: [{ id: 'sub_real', status: 'active', items: { data: [{ price: { unit_amount: 2999 } }] } }] });
    await handleSubscriptionUpdated({ id: 'sub_other', status: 'past_due', customer: 'cus_other', metadata: { tier: 'comm_monthly' } });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('resolves email from Stripe Customer when metadata.email is missing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    customersRetrieve.mockResolvedValue({ email: 'from-customer@example.com' });
    await handleSubscriptionUpdated({
      status: 'canceled',
      current_period_end: PERIOD_END,
      customer: 'cus_missing_meta',
      metadata: { tier: 'comm_monthly' },
    });
    expect(customersRetrieve).toHaveBeenCalledWith('cus_missing_meta');
    expect(db.updateEntitlementState).toHaveBeenCalledWith('from-customer@example.com', expect.objectContaining({ billingState: 'cancelled' }));
  });

  it('uses Members.Entitlement Type when metadata.tier is also missing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    customersRetrieve.mockResolvedValue({ email: 'monthly@example.com' });
    db.findMemberByEmail.mockResolvedValue({
      fields: { 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionUpdated({
      status: 'canceled',
      current_period_end: PERIOD_END,
      customer: 'cus_no_meta',
      metadata: {},
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', expect.objectContaining({ billingState: 'cancelled' }));
  });
});

describe('handleSubscriptionDeleted', () => {
  const SAVED_ROLE = process.env.DISCORD_ROLE_MONTHLY;

  beforeEach(() => {
    vi.clearAllMocks();
    // Drop leftover mock*Once queues: a scan that returns early leaves them unused.
    customersList.mockReset().mockResolvedValue({ data: [] });
    subscriptionsList.mockReset().mockResolvedValue({ data: [] });
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.DISCORD_ROLE_MONTHLY = 'role_monthly';
  });

  afterEach(() => {
    if (SAVED_ROLE === undefined) delete process.env.DISCORD_ROLE_MONTHLY;
    else process.env.DISCORD_ROLE_MONTHLY = SAVED_ROLE;
  });

  it('removes the monthly Discord role using Stripe Customer email when metadata is empty', async () => {
    customersRetrieve.mockResolvedValue({ email: 'monthly@example.com' });
    db.findMemberByEmail.mockResolvedValue({
      fields: { 'Discord ID': 'disc_1', 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionDeleted({
      id: 'sub_empty_meta',
      customer: 'cus_1',
      metadata: {},
    });
    expect(customersRetrieve).toHaveBeenCalledWith('cus_1');
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', { billingState: 'cancelled' });
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_1', 'role_monthly');
    // Final fix 11: off the nightly out-of-sync list once revoked.
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', { status: 'revoked' });
  });

  it('a failed role removal leaves the entitlement active (nightly reconcile retries it)', async () => {
    customersRetrieve.mockResolvedValue({ email: 'monthly@example.com' });
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_f', 'Entitlement Type': 'monthly_membership' } });
    discordBot.removeRoleFromMember.mockRejectedValueOnce(new Error('Discord bot (500): x'));
    await handleSubscriptionDeleted({ id: 'sub_fail', customer: 'cus_f', metadata: { tier: 'comm_monthly' } });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', { billingState: 'cancelled' });
    expect(db.updateEntitlementState).not.toHaveBeenCalledWith('monthly@example.com', { status: 'revoked' });
  });

  it('does not touch a monthly membership when an untagged $1,499 retainer is cancelled', async () => {
    customersRetrieve.mockResolvedValue({ email: 'both@example.com' });
    db.findMemberByEmail.mockResolvedValue({
      fields: { 'Discord ID': 'disc_2', 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionDeleted({
      id: 'sub_old_retainer',
      customer: 'cus_2',
      metadata: {},
      items: { data: [{ price: { unit_amount: 149900 } }] },
    });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('still revokes an untagged subscription whose price is the $29.99 monthly plan', async () => {
    customersRetrieve.mockResolvedValue({ email: 'monthly@example.com' });
    db.findMemberByEmail.mockResolvedValue({
      fields: { 'Discord ID': 'disc_3', 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionDeleted({
      id: 'sub_old_monthly',
      customer: 'cus_3',
      metadata: {},
      items: { data: [{ price: { unit_amount: 2999 } }] },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', { billingState: 'cancelled' });
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_3', 'role_monthly');
  });

  it('prefers the Stripe Customer email over subscription metadata.email', async () => {
    customersRetrieve.mockResolvedValue({ email: 'payer@example.com' });
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_p', 'Entitlement Type': 'monthly_membership' } });
    await handleSubscriptionDeleted({
      id: 'sub_meta_victim',
      customer: 'cus_payer',
      metadata: { tier: 'comm_monthly', email: 'victim@example.com' },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('payer@example.com', { billingState: 'cancelled' });
    expect(db.updateEntitlementState).not.toHaveBeenCalledWith('victim@example.com', expect.anything());
  });

  it('does not mark Discord sync revoked when a permanent retainer sub is cancelled', async () => {
    customersRetrieve.mockResolvedValue({ email: 'retainer@example.com' });
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_r' } });
    await handleSubscriptionDeleted({ id: 'sub_ret', customer: 'cus_r', metadata: { tier: 're_retainer' } });
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('does not revoke when the cancelled sub is not the one entitling the member (another monthly sub is active)', async () => {
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_m', 'Entitlement Type': 'monthly_membership' } });
    customersList.mockResolvedValueOnce({ data: [{ id: 'cus_real' }, { id: 'cus_attacker' }] });
    subscriptionsList
      .mockResolvedValueOnce({ data: [{ id: 'sub_real', status: 'active', metadata: { tier: 'comm_monthly' } }] })
      .mockResolvedValueOnce({ data: [{ id: 'sub_throwaway', status: 'canceled', metadata: { tier: 'comm_monthly' } }] });
    await handleSubscriptionDeleted({ id: 'sub_throwaway', customer: 'cus_attacker', metadata: { tier: 'comm_monthly' } });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('holds the revoke (and alerts) when the other-subscription scan cannot complete', async () => {
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_m', 'Entitlement Type': 'monthly_membership' } });
    customersList.mockRejectedValueOnce(new Error('stripe down'));
    await handleSubscriptionDeleted({ id: 'sub_x', customer: 'cus_x', metadata: { tier: 'comm_monthly' } });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
    expect(alert.sendAlert).toHaveBeenCalledWith('stripe.monthly_change_held', expect.objectContaining({ subscriptionId: 'sub_x' }));
  });

  it('pages through every customer for the email (real member beyond the first page)', async () => {
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_m', 'Entitlement Type': 'monthly_membership' } });
    customersList
      .mockResolvedValueOnce({ data: [{ id: 'cus_junk1' }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: 'cus_real' }], has_more: false });
    subscriptionsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: 'sub_real', status: 'active', metadata: { tier: 'comm_monthly' } }] });
    await handleSubscriptionDeleted({ id: 'sub_junk', customer: 'cus_junk1', metadata: { tier: 'comm_monthly' } });
    expect(customersList).toHaveBeenLastCalledWith(expect.objectContaining({ starting_after: 'cus_junk1' }));
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('ignores deletion of a subscription that never activated (incomplete_expired)', async () => {
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    await handleSubscriptionDeleted({ id: 'sub_abandoned', customer: 'cus_x', status: 'incomplete_expired', metadata: { tier: 'comm_monthly' } });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('alerts and does not revoke when email cannot be resolved', async () => {
    await handleSubscriptionDeleted({ id: 'sub_unknown', metadata: {} });
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
    expect(alert.sendAlert).toHaveBeenCalledWith('stripe.subscription_deleted_no_email', expect.objectContaining({ subscriptionId: 'sub_unknown' }));
  });
});

describe('handleSubscriptionDeleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customersList.mockReset().mockResolvedValue({ data: [] });
    subscriptionsList.mockReset().mockResolvedValue({ data: [] });
  });

  it('stamps Billing State cancelled for a monthly member so grant paths cannot re-OAuth', async () => {
    await handleSubscriptionDeleted({
      metadata: { email: 'monthly@example.com', tier: 'comm_monthly' },
    });
    expect(db.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', {
      billingState: 'cancelled',
    });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith('monthly@example.com', 'revoked');
  });

  it('does not stamp billing cancelled for a permanent retainer sub', async () => {
    await handleSubscriptionDeleted({
      metadata: { email: 'retainer@example.com', tier: 're_retainer' },
    });
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });
});
