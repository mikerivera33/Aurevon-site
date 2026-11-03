/**
 * Stripe refunds and disputes → Payments status + pass revocation.
 *
 *   charge.refunded (full only)  → Payments 'Refunded', mint row Revoked, that pass's Discord role removed
 *   charge.dispute.created       → Payments 'Disputed', same revocation
 *
 * The Checkout Session (our Payments transaction id) is found from the
 * PaymentIntent. Only the refunded entitlement's role is removed, and only
 * when no other active mint of the same NFT type remains for the email.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  updatePaymentStatus: vi.fn(),
  findMintByPaymentId: vi.fn(),
  updateNftMint: vi.fn().mockResolvedValue({}),
  findActiveMintsByEmail: vi.fn().mockResolvedValue([]),
  findMemberByEmail: vi.fn().mockResolvedValue(null),
  updateEntitlementState: vi.fn().mockResolvedValue({}),
  // referenced at stripe.js / fulfil.js module load:
  createPayment: vi.fn(), createNftMint: vi.fn(), updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
  findPaymentByTransactionId: vi.fn(), nextSerial: vi.fn(),
}));
vi.mock('../airtable-import.js', () => ({ airtableImportEnabled: vi.fn(() => false), countAirtableMintsByPrefix: vi.fn() }));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../email.js', () => ({ sendNftDelivery: vi.fn(), sendPurchaseConfirmation: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ removeRoleFromMember: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({}) }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

const sessionsList = vi.fn();
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.checkout = { sessions: { list: sessionsList } };
      this.customers = { retrieve: vi.fn(), list: vi.fn().mockResolvedValue({ data: [] }) };
      this.subscriptions = { update: vi.fn(), retrieve: vi.fn(), list: vi.fn().mockResolvedValue({ data: [] }) };
    }
  },
}));

import { handleChargeRefunded, handleDisputeCreated, isFullRefund } from '../../webhooks/stripe.js';
import * as db from '../db.js';
import * as discordBot from '../discord-bot.js';
import { sendAlert } from '../alert.js';

const SAVED = { ...process.env };

function chromeMint(extra = {}) {
  return {
    id: 'mint_chrome',
    fields: {
      'Reference': 'CHROME_007', 'Email': 'buyer@example.com', 'NFT Type': '004 Chrome',
      'Mint Status': 'Sent', 'Payment Transaction ID': 'cs_chrome', ...extra,
    },
  };
}

const fullCharge = (extra = {}) => ({
  id: 'ch_1', payment_intent: 'pi_chrome', amount: 34999, amount_refunded: 34999, refunded: true, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.DISCORD_ROLE_LIFETIME = 'role_lifetime';
  process.env.DISCORD_ROLE_MONTHLY = 'role_monthly';
  sessionsList.mockReset().mockResolvedValue({ data: [{ id: 'cs_chrome' }] });
  db.updatePaymentStatus.mockResolvedValue({ id: 'pay_1', fields: { 'Transaction ID': 'cs_chrome' } });
  db.findMintByPaymentId.mockResolvedValue(chromeMint());
  db.findActiveMintsByEmail.mockResolvedValue([chromeMint()]);
  db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'disc_1' } });
});

afterEach(() => { process.env = { ...SAVED }; });

describe('isFullRefund', () => {
  it('is true for refunded:true or amount_refunded >= amount, false for a partial refund', () => {
    expect(isFullRefund({ refunded: true })).toBe(true);
    expect(isFullRefund({ refunded: false, amount: 1000, amount_refunded: 1000 })).toBe(true);
    expect(isFullRefund({ refunded: false, amount: 1000, amount_refunded: 400 })).toBe(false);
    expect(isFullRefund({})).toBe(false);
    expect(isFullRefund(null)).toBe(false);
  });
});

describe('handleChargeRefunded', () => {
  it('full refund of a Chrome session → Payments Refunded, mint row Revoked, lifetime role removed', async () => {
    await handleChargeRefunded(fullCharge());

    expect(sessionsList).toHaveBeenCalledWith({ payment_intent: 'pi_chrome', limit: 1 });
    expect(db.updatePaymentStatus).toHaveBeenCalledWith('cs_chrome', 'Refunded');
    expect(db.findMintByPaymentId).toHaveBeenCalledWith('cs_chrome');
    expect(db.updateNftMint).toHaveBeenCalledWith('mint_chrome', {
      'Mint Status': 'Revoked', 'Revoked At': expect.any(String),
    });
    const revokedAt = db.updateNftMint.mock.calls[0][1]['Revoked At'];
    expect(Number.isNaN(Date.parse(revokedAt))).toBe(false);
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledTimes(1);
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_1', 'role_lifetime');
    expect(sendAlert).toHaveBeenCalledWith('stripe.entitlement_revoked',
      expect.objectContaining({ transactionId: 'cs_chrome', nftType: '004 Chrome', reason: 'refund', roleRemoved: true }),
      expect.objectContaining({ severity: 'info' }));
    // Lifetime is not monthly: billing state untouched.
    expect(db.updateEntitlementState).not.toHaveBeenCalled();
  });

  it('alert detail carries ids only (no recipient email)', async () => {
    await handleChargeRefunded(fullCharge());
    for (const [, detail] of sendAlert.mock.calls) {
      expect(JSON.stringify(detail)).not.toContain('buyer@example.com');
    }
  });

  it('accepts amount_refunded >= amount without the refunded flag', async () => {
    await handleChargeRefunded(fullCharge({ refunded: false }));
    expect(db.updatePaymentStatus).toHaveBeenCalledWith('cs_chrome', 'Refunded');
  });

  it('a partial refund changes nothing', async () => {
    await handleChargeRefunded(fullCharge({ refunded: false, amount_refunded: 5000 }));
    expect(sessionsList).not.toHaveBeenCalled();
    expect(db.updatePaymentStatus).not.toHaveBeenCalled();
    expect(db.updateNftMint).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('keeps the role when another active mint of the same NFT type remains for the email', async () => {
    db.findActiveMintsByEmail.mockResolvedValue([
      chromeMint(),
      { id: 'mint_chrome_2', fields: { 'NFT Type': '004 Chrome', 'Mint Status': 'Sent' } },
    ]);
    await handleChargeRefunded(fullCharge());
    expect(db.updateNftMint).toHaveBeenCalledWith('mint_chrome', expect.objectContaining({ 'Mint Status': 'Revoked' }));
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('an active pass of a DIFFERENT type does not block revoking this one', async () => {
    db.findActiveMintsByEmail.mockResolvedValue([
      chromeMint(),
      { id: 'mint_insider', fields: { 'NFT Type': 'Aurevon Insider', 'Mint Status': 'Sent' } },
    ]);
    await handleChargeRefunded(fullCharge());
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_1', 'role_lifetime');
  });

  it('a refunded monthly (Genesis) pass also stamps Billing State cancelled', async () => {
    const genesis = { id: 'mint_gen', fields: { 'Email': 'm@example.com', 'NFT Type': '001 Genesis', 'Mint Status': 'Sent' } };
    db.findMintByPaymentId.mockResolvedValue(genesis);
    db.findActiveMintsByEmail.mockResolvedValue([genesis]);
    await handleChargeRefunded(fullCharge({ payment_intent: 'pi_gen' }));
    expect(db.updateEntitlementState).toHaveBeenCalledWith('m@example.com', {
      entitlementType: 'monthly_membership', billingState: 'cancelled',
    });
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_1', 'role_monthly');
  });

  it('revokes a Failed mint row too, so retry-mints cannot mint a refunded purchase', async () => {
    db.findMintByPaymentId.mockResolvedValue(chromeMint({ 'Mint Status': 'Failed' }));
    await handleChargeRefunded(fullCharge());
    expect(db.updateNftMint).toHaveBeenCalledWith('mint_chrome', expect.objectContaining({ 'Mint Status': 'Revoked' }));
  });

  it('skips role removal (but still revokes the row) when the member has no Discord ID', async () => {
    db.findMemberByEmail.mockResolvedValue({ fields: {} });
    await handleChargeRefunded(fullCharge());
    expect(db.updateNftMint).toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('stripe.entitlement_revoked', expect.objectContaining({ roleRemoved: false }), expect.anything());
  });

  it('no mint row (no-NFT tier) → Payments still marked Refunded, nothing revoked', async () => {
    db.findMintByPaymentId.mockResolvedValue(null);
    await handleChargeRefunded(fullCharge());
    expect(db.updatePaymentStatus).toHaveBeenCalledWith('cs_chrome', 'Refunded');
    expect(db.updateNftMint).not.toHaveBeenCalled();
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });

  it('alerts stripe.refund_unmatched (info) when no Checkout Session has that PaymentIntent', async () => {
    sessionsList.mockResolvedValue({ data: [] });
    await handleChargeRefunded(fullCharge());
    expect(sendAlert).toHaveBeenCalledWith('stripe.refund_unmatched',
      expect.objectContaining({ reason: 'refund', sourceId: 'ch_1', paymentIntentId: 'pi_chrome' }),
      expect.objectContaining({ severity: 'info' }));
    expect(db.updatePaymentStatus).not.toHaveBeenCalled();
    expect(db.updateNftMint).not.toHaveBeenCalled();
  });

  it('a DB failure propagates (the webhook turns it into stripe.pipeline_crashed)', async () => {
    db.updatePaymentStatus.mockRejectedValueOnce(new Error('Supabase down'));
    await expect(handleChargeRefunded(fullCharge())).rejects.toThrow('Supabase down');
    expect(discordBot.removeRoleFromMember).not.toHaveBeenCalled();
  });
});

describe('handleDisputeCreated', () => {
  it('marks Payments Disputed and revokes the pass', async () => {
    await handleDisputeCreated({ id: 'dp_1', payment_intent: 'pi_chrome', charge: 'ch_1' });
    expect(sessionsList).toHaveBeenCalledWith({ payment_intent: 'pi_chrome', limit: 1 });
    expect(db.updatePaymentStatus).toHaveBeenCalledWith('cs_chrome', 'Disputed');
    expect(db.updateNftMint).toHaveBeenCalledWith('mint_chrome', expect.objectContaining({ 'Mint Status': 'Revoked' }));
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('disc_1', 'role_lifetime');
  });

  it('accepts an expanded payment_intent object', async () => {
    await handleDisputeCreated({ id: 'dp_2', payment_intent: { id: 'pi_chrome' } });
    expect(sessionsList).toHaveBeenCalledWith({ payment_intent: 'pi_chrome', limit: 1 });
  });
});
