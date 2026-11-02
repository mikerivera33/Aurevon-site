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

vi.mock('../airtable.js', () => ({
  updateEntitlementState: vi.fn().mockResolvedValue({}),
  // referenced at stripe.js module load:
  createPayment: vi.fn(), createNftMint: vi.fn(), updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
  findMemberByEmail: vi.fn().mockResolvedValue(null), findPaymentByTransactionId: vi.fn(),
}));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../email.js', () => ({ sendNftDelivery: vi.fn(), sendPurchaseConfirmation: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ removeRoleFromMember: vi.fn().mockResolvedValue({}) }));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({}) }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

const customersRetrieve = vi.fn();
const customersList = vi.fn().mockResolvedValue({ data: [] });
const subscriptionsList = vi.fn().mockResolvedValue({ data: [] });
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.customers = { retrieve: customersRetrieve, list: customersList };
      this.subscriptions = { update: vi.fn().mockResolvedValue({}), list: subscriptionsList };
    }
  },
}));

import { handleInvoicePaymentSucceeded, handleSubscriptionUpdated, handleSubscriptionDeleted } from '../../webhooks/stripe.js';
import * as airtable from '../airtable.js';
import * as discordBot from '../discord-bot.js';
import * as alert from '../alert.js';

const PERIOD_END = 1893456000; // unix seconds (future)
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();

describe('handleInvoicePaymentSucceeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customersList.mockReset().mockResolvedValue({ data: [] });
    subscriptionsList.mockReset().mockResolvedValue({ data: [] });
  });

  it('renews monthly entitlement (active + expiry) on a $29.99 invoice', async () => {
    await handleInvoicePaymentSucceeded({
      amount_paid: 2999,
      customer_email: 'monthly@example.com',
      lines: { data: [{ period: { end: PERIOD_END } }] },
    });
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', {
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
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('skips when a monthly invoice has no customer email', async () => {
    await handleInvoicePaymentSucceeded({ amount_paid: 2999, lines: { data: [{ period: { end: PERIOD_END } }] } });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
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
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('m@example.com', {
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
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('m@example.com', expect.objectContaining({ billingState: 'cancelled' }));
  });

  it('ignores non-monthly subscriptions (retainer)', async () => {
    await handleSubscriptionUpdated({ status: 'past_due', metadata: { email: 'm@example.com', tier: 're_retainer' } });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('skips when subscription metadata has no email and no Stripe customer', async () => {
    await handleSubscriptionUpdated({ status: 'canceled', metadata: { tier: 'comm_monthly' } });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
    expect(customersRetrieve).not.toHaveBeenCalled();
  });

  it('does not downgrade billing when another monthly subscription for the email is active', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    customersList.mockResolvedValueOnce({ data: [{ id: 'cus_real' }] });
    subscriptionsList.mockResolvedValueOnce({ data: [{ id: 'sub_real', status: 'active', items: { data: [{ price: { unit_amount: 2999 } }] } }] });
    await handleSubscriptionUpdated({ id: 'sub_other', status: 'past_due', customer: 'cus_other', metadata: { tier: 'comm_monthly' } });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
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
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('from-customer@example.com', expect.objectContaining({ billingState: 'cancelled' }));
  });

  it('uses Members.Entitlement Type when metadata.tier is also missing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    customersRetrieve.mockResolvedValue({ email: 'monthly@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({
      fields: { 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionUpdated({
      status: 'canceled',
      current_period_end: PERIOD_END,
      customer: 'cus_no_meta',
      metadata: {},
    });
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', expect.objectContaining({ billingState: 'cancelled' }));
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
    airtable.findMemberByEmail.mockResolvedValue({
      fields: { 'Discord ID': 'disc_1', 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionDeleted({
      id: 'sub_empty_meta',
      customer: 'cus_1',
      metadata: {},
    });
    expect(customersRetrieve).toHaveBeenCalledWith('cus_1');
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', { billingState: 'cancelled' });
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_1', 'role_monthly');
  });

  it('does not touch a monthly membership when an untagged $1,499 retainer is cancelled', async () => {
    customersRetrieve.mockResolvedValue({ email: 'both@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({
      fields: { 'Discord ID': 'disc_2', 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionDeleted({
      id: 'sub_old_retainer',
      customer: 'cus_2',
      metadata: {},
      items: { data: [{ price: { unit_amount: 149900 } }] },
    });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('still revokes an untagged subscription whose price is the $29.99 monthly plan', async () => {
    customersRetrieve.mockResolvedValue({ email: 'monthly@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({
      fields: { 'Discord ID': 'disc_3', 'Entitlement Type': 'monthly_membership' },
    });
    await handleSubscriptionDeleted({
      id: 'sub_old_monthly',
      customer: 'cus_3',
      metadata: {},
      items: { data: [{ price: { unit_amount: 2999 } }] },
    });
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', { billingState: 'cancelled' });
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_3', 'role_monthly');
  });

  it('prefers the Stripe Customer email over subscription metadata.email', async () => {
    customersRetrieve.mockResolvedValue({ email: 'payer@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_p', 'Entitlement Type': 'monthly_membership' } });
    await handleSubscriptionDeleted({
      id: 'sub_meta_victim',
      customer: 'cus_payer',
      metadata: { tier: 'comm_monthly', email: 'victim@example.com' },
    });
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('payer@example.com', { billingState: 'cancelled' });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalledWith('victim@example.com', expect.anything());
  });

  it('does not mark Discord sync revoked when a permanent retainer sub is cancelled', async () => {
    customersRetrieve.mockResolvedValue({ email: 'retainer@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_r' } });
    await handleSubscriptionDeleted({ id: 'sub_ret', customer: 'cus_r', metadata: { tier: 're_retainer' } });
    expect(airtable.updateDiscordSyncStatus).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('does not revoke when the cancelled sub is not the one entitling the member (another monthly sub is active)', async () => {
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_m', 'Entitlement Type': 'monthly_membership' } });
    customersList.mockResolvedValueOnce({ data: [{ id: 'cus_real' }, { id: 'cus_attacker' }] });
    subscriptionsList
      .mockResolvedValueOnce({ data: [{ id: 'sub_real', status: 'active', metadata: { tier: 'comm_monthly' } }] })
      .mockResolvedValueOnce({ data: [{ id: 'sub_throwaway', status: 'canceled', metadata: { tier: 'comm_monthly' } }] });
    await handleSubscriptionDeleted({ id: 'sub_throwaway', customer: 'cus_attacker', metadata: { tier: 'comm_monthly' } });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
    expect(airtable.updateDiscordSyncStatus).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('holds the revoke (and alerts) when the other-subscription scan cannot complete', async () => {
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_m', 'Entitlement Type': 'monthly_membership' } });
    customersList.mockRejectedValueOnce(new Error('stripe down'));
    await handleSubscriptionDeleted({ id: 'sub_x', customer: 'cus_x', metadata: { tier: 'comm_monthly' } });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
    expect(alert.sendAlert).toHaveBeenCalledWith('stripe.monthly_change_held', expect.objectContaining({ subscriptionId: 'sub_x' }));
  });

  it('pages through every customer for the email (real member beyond the first page)', async () => {
    customersRetrieve.mockResolvedValue({ email: 'member@example.com' });
    airtable.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_m', 'Entitlement Type': 'monthly_membership' } });
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
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('alerts and does not revoke when email cannot be resolved', async () => {
    await handleSubscriptionDeleted({ id: 'sub_unknown', metadata: {} });
    expect(airtable.updateDiscordSyncStatus).not.toHaveBeenCalled();
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
    expect(airtable.updateEntitlementState).toHaveBeenCalledWith('monthly@example.com', {
      billingState: 'cancelled',
    });
    expect(airtable.updateDiscordSyncStatus).toHaveBeenCalledWith('monthly@example.com', 'revoked');
  });

  it('does not stamp billing cancelled for a permanent retainer sub', async () => {
    await handleSubscriptionDeleted({
      metadata: { email: 'retainer@example.com', tier: 're_retainer' },
    });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
  });
});
