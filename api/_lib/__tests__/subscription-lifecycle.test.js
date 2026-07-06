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
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../airtable.js', () => ({
  updateEntitlementState: vi.fn().mockResolvedValue({}),
  // referenced at stripe.js module load:
  createPayment: vi.fn(), createNftMint: vi.fn(), updateDiscordSyncStatus: vi.fn(),
  findMemberByEmail: vi.fn(), findPaymentByTransactionId: vi.fn(),
}));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../email.js', () => ({ sendNftDelivery: vi.fn(), sendPurchaseConfirmation: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ removeRoleFromMember: vi.fn() }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

import { handleInvoicePaymentSucceeded, handleSubscriptionUpdated } from '../../webhooks/stripe.js';
import * as airtable from '../airtable.js';

const PERIOD_END = 1893456000; // unix seconds (future)
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();

describe('handleInvoicePaymentSucceeded', () => {
  beforeEach(() => vi.clearAllMocks());

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
  beforeEach(() => vi.clearAllMocks());

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

  it('skips when subscription metadata has no email', async () => {
    await handleSubscriptionUpdated({ status: 'canceled', metadata: { tier: 'comm_monthly' } });
    expect(airtable.updateEntitlementState).not.toHaveBeenCalled();
  });
});
