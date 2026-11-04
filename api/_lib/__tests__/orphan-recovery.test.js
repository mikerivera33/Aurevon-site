/**
 * Recovery for the marker-written-but-mint-missing window (review Critical).
 *
 * If the webhook dies after writing the Payments idempotency marker but before
 * writing the NFT_Mints row, the mint is silently dropped. recoverOrphanPayments
 * finds recent NFT-tier payments with no mint row and dead-letters them ('Failed')
 * so the idempotent retry-mints cron recovers them.
 *
 * Behaviour change (Task 7): "has a mint row" is now decided by PAYMENT ID
 * (findMintByPaymentId), not email + NFT type — the old "row exists" case is
 * kept with the payment-id lookup. The dead-letter row now carries
 * paymentTransactionId and the canonical (re-inferred) tier; Refunded /
 * Disputed payments are never dead-lettered; recipient emails are not logged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  listPaymentsSince: vi.fn(),
  findAnyMintByEmailAndType: vi.fn(),
  createNftMint: vi.fn().mockResolvedValue({}),
  // referenced at module load:
  upsertMemberByEmail: vi.fn(), findMemberByEmail: vi.fn(), findActiveMintByEmail: vi.fn(),
  findActiveMintByEmailAndType: vi.fn(), findMintByTokenId: vi.fn(), listUnlinkedMintsBefore: vi.fn(), listPendingDiscordSync: vi.fn(), listFailedDiscordSync: vi.fn().mockResolvedValue([]),
  listOutOfSyncEntitlements: vi.fn(), listFailedMints: vi.fn(), updateDiscordSyncStatus: vi.fn(),
  updateNftMint: vi.fn(),
  findActiveMintsByEmail: vi.fn(), findLatestPaymentByEmailAndTier: vi.fn(), dbConfigured: vi.fn(() => true),
  // fulfil.js (shared NFT fulfilment):
  findMintByPaymentId: vi.fn().mockResolvedValue(null),
  // claim.js (retry-mints / reconcile):
  listUndeliveredMints: vi.fn(), findPaymentByTransactionId: vi.fn(), listPaymentTransactionIds: vi.fn(),
  findPaymentBySubscriptionId: vi.fn().mockResolvedValue(null),
  recordOpsEvent: vi.fn(), listLapsedMonthlyWithoutExpiry: vi.fn(),
}));
vi.mock('../airtable-import.js', () => ({ importHasProblems: vi.fn(() => false), airtableImportEnabled: vi.fn(() => false), importFromAirtable: vi.fn() }));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn(), onSubscriptionCancelled: vi.fn() }));

import { recoverOrphanPayments } from '../../member/claim.js';
import * as db from '../db.js';

describe('recoverOrphanPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findMintByPaymentId.mockResolvedValue(null);
    db.createNftMint.mockResolvedValue({});
  });

  it('dead-letters a paid NFT-tier payment that has no mint row', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay1', fields: { 'Customer Email': 'buyer@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_orphan_1' } },
    ]);
    db.findMintByPaymentId.mockResolvedValueOnce(null); // no mint row → orphan

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(1);
    expect(db.findMintByPaymentId).toHaveBeenCalledWith('cs_orphan_1');
    expect(db.createNftMint).toHaveBeenCalledWith(expect.objectContaining({
      reference: 'RECOVER_cs_orphan_1',
      email: 'buyer@example.com',
      status: 'Failed',
      nftType: 'Aurevon Insider',
      tierSource: 'full',
      paymentTransactionId: 'cs_orphan_1',
      entitlementType: 'product_a_reward',
    }));
  });

  it('stores the canonical tier for a checkout-key Pass Type (re_retainer → retainer)', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'payK', fields: { 'Customer Email': 'k@example.com', 'Pass Type': 're_retainer', 'Transaction ID': 'cs_orphan_k' } },
    ]);

    await recoverOrphanPayments({ sinceDays: 3 });

    expect(db.createNftMint).toHaveBeenCalledWith(expect.objectContaining({ tierSource: 'retainer', nftType: 'Aurevon Ember' }));
  });

  it('does NOT dead-letter when the payment already has a mint row', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay2', fields: { 'Customer Email': 'ok@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_ok' } },
    ]);
    db.findMintByPaymentId.mockResolvedValueOnce({ id: 'mintExists' });

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(0);
    expect(db.findMintByPaymentId).toHaveBeenCalledWith('cs_ok');
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it('dedupes by payment id, never email + type: a second purchase of the same pass is still recovered', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay2b', fields: { 'Customer Email': 'twice@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_second' } },
    ]);
    db.findAnyMintByEmailAndType.mockResolvedValue({ id: 'mintFromFirstPurchase' }); // must not matter
    db.findMintByPaymentId.mockResolvedValueOnce(null);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(1);
    expect(db.findAnyMintByEmailAndType).not.toHaveBeenCalled();
    expect(db.createNftMint).toHaveBeenCalledWith(expect.objectContaining({ paymentTransactionId: 'cs_second' }));
  });

  it.each(['Refunded', 'Disputed'])('never dead-letters a %s payment', async (status) => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'payR', fields: { 'Customer Email': 'r@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_reversed', Status: status } },
    ]);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(0);
    expect(db.findMintByPaymentId).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it('skips (does not dead-letter) when the mint lookup fails, and counts the error', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'payL', fields: { 'Customer Email': 'l@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_lookup' } },
    ]);
    db.findMintByPaymentId.mockRejectedValueOnce(new Error('Supabase 503'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result).toEqual({ recovered: 0, errors: 1 });
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it('a failed dead-letter write is an error, not a recovery; a concurrent row (DUPLICATE_PAYMENT_MINT) is neither', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'payW', fields: { 'Customer Email': 'w@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_write' } },
      { id: 'payC', fields: { 'Customer Email': 'c@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_conc' } },
    ]);
    db.createNftMint
      .mockRejectedValueOnce(new Error('Supabase 503'))
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'DUPLICATE_PAYMENT_MINT' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result).toEqual({ recovered: 0, errors: 1 });
  });

  it('never logs the recipient email', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'payP', fields: { 'Customer Email': 'private.orphan@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_priv' } },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await recoverOrphanPayments({ sinceDays: 3 });

    expect(log).toHaveBeenCalled();
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls])).not.toContain('private.orphan@example.com');
  });

  it('re-infers an NFT tier from the amount when a STRIPE Pass Type is unknown (F1 durability)', async () => {
    // Webhook stored 'unknown' because tier inference failed at the time, but the
    // amount matches an NFT tier — this is a dropped mint and MUST be recovered.
    // (Task 10: Stripe rows only — a PayPal row's tier is never re-inferred.)
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay4', fields: { 'Customer Email': 'lost@example.com', 'Pass Type': 'unknown', 'Amount': 2499, 'Transaction ID': 'pp_lost', 'Payment Provider': 'Stripe Card' } },
    ]);
    db.findMintByPaymentId.mockResolvedValueOnce(null);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(1);
    expect(db.createNftMint).toHaveBeenCalledWith(expect.objectContaining({
      reference: 'RECOVER_pp_lost',
      email: 'lost@example.com',
      status: 'Failed',
      // The re-inferred tier (not the stored 'unknown') so retry-mints can mint it.
      tierSource: 'enterprise',
      nftType: 'Aurevon Obsidian Executive',
      paymentTransactionId: 'pp_lost',
    }));
  });

  it('does NOT recover an unknown-tier payment whose amount is a no-NFT add-on', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay5', fields: { 'Customer Email': 'addon2@example.com', 'Pass Type': 'unknown', 'Amount': 99, 'Transaction ID': 'pp_addon', 'Payment Provider': 'Stripe Card' } },
    ]);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(0);
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it('ignores no-NFT tiers (add-ons / second opinion)', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay3', fields: { 'Customer Email': 'addon@example.com', 'Pass Type': 'addon_rush', 'Transaction ID': 'cs_addon' } },
    ]);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(0);
    expect(db.findMintByPaymentId).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  // ── Task 10 Fix round 1 ──
  it('never re-infers a tier for a PayPal row (the IPN handler decided it against the money)', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pp1', fields: { 'Customer Email': 'pp@example.com', 'Pass Type': 'unknown', 'Amount': 250, 'Transaction ID': 'PPUNKNOWN1', 'Payment Provider': 'PayPal' } },
    ]);
    const result = await recoverOrphanPayments({ sinceDays: 3 });
    expect(result.recovered).toBe(0);
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it('never re-infers for a row with no provider or a non-"unknown" unmapped label', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'np1', fields: { 'Customer Email': 'a@example.com', 'Pass Type': 'unknown', 'Amount': 2499, 'Transaction ID': 'NOPROV1' } },
      { id: 'np2', fields: { 'Customer Email': 'b@example.com', 'Pass Type': 'mystery', 'Amount': 2499, 'Transaction ID': 'cs_test_mystery', 'Payment Provider': 'Stripe Card' } },
    ]);
    const result = await recoverOrphanPayments({ sinceDays: 3 });
    expect(result.recovered).toBe(0);
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it("skips Pass Type 'addons' (multi-item cart) whatever the amount or provider", async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'ad1', fields: { 'Customer Email': 'c@example.com', 'Pass Type': 'addons', 'Amount': 250, 'Transaction ID': 'PPCART1', 'Payment Provider': 'PayPal' } },
      { id: 'ad2', fields: { 'Customer Email': 'c@example.com', 'Pass Type': 'addons', 'Amount': 250, 'Transaction ID': 'cs_test_cart', 'Payment Provider': 'Stripe Card' } },
    ]);
    const result = await recoverOrphanPayments({ sinceDays: 3 });
    expect(result.recovered).toBe(0);
    expect(db.findMintByPaymentId).not.toHaveBeenCalled();
  });

  it.each([['subscr', 'I-SUB1'], ['rpp', 'I-RPP1']])(
    'a %s renewal row is never dead-lettered; the earliest row for the subscription is',
    async (kind, id) => {
      const firstRow = { id: 'r1', fields: { 'Customer Email': 'g@example.com', 'Pass Type': 'comm_monthly', 'Transaction ID': 'PPFIRST1', 'Payment Provider': 'PayPal', 'Token': `${kind}:${id}` } };
      const renewalRow = { id: 'r2', fields: { ...firstRow.fields, 'Transaction ID': 'PPRENEW1' } };
      db.listPaymentsSince.mockResolvedValueOnce([firstRow, renewalRow]);
      db.findPaymentBySubscriptionId.mockResolvedValue(firstRow);

      const result = await recoverOrphanPayments({ sinceDays: 3 });

      expect(db.findPaymentBySubscriptionId).toHaveBeenCalledWith(id, kind);
      expect(result.recovered).toBe(1);
      expect(db.createNftMint).toHaveBeenCalledTimes(1);
      expect(db.createNftMint).toHaveBeenCalledWith(expect.objectContaining({ paymentTransactionId: 'PPFIRST1', nftType: '001 Genesis' }));
      db.findPaymentBySubscriptionId.mockResolvedValue(null);
    },
  );

  it('a failed subscription lookup skips the row and counts an error', async () => {
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'r3', fields: { 'Customer Email': 'g@example.com', 'Pass Type': 'comm_monthly', 'Transaction ID': 'PPLOOKUP1', 'Payment Provider': 'PayPal', 'Token': 'subscr:I-SUB2' } },
    ]);
    db.findPaymentBySubscriptionId.mockRejectedValueOnce(new Error('Supabase timeout'));
    const result = await recoverOrphanPayments({ sinceDays: 3 });
    expect(result).toEqual({ recovered: 0, errors: 1 });
    expect(db.createNftMint).not.toHaveBeenCalled();
  });
});

