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
  findActiveMintByEmailAndType: vi.fn(), findMintByTokenId: vi.fn(), listUnlinkedMintsBefore: vi.fn(), listPendingDiscordSync: vi.fn(),
  listOutOfSyncEntitlements: vi.fn(), listFailedMints: vi.fn(), updateDiscordSyncStatus: vi.fn(),
  updateNftMint: vi.fn(),
  findActiveMintsByEmail: vi.fn(), findLatestPaymentByEmailAndTier: vi.fn(), dbConfigured: vi.fn(() => true),
  // fulfil.js (shared NFT fulfilment):
  findMintByPaymentId: vi.fn().mockResolvedValue(null),
  // claim.js (retry-mints / reconcile):
  listUndeliveredMints: vi.fn(), findPaymentByTransactionId: vi.fn(), listPaymentTransactionIds: vi.fn(),
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

  it('re-infers an NFT tier from the amount when Pass Type is unknown (F1 durability)', async () => {
    // Webhook stored 'unknown' because tier inference failed at the time, but the
    // amount matches an NFT tier — this is a dropped mint and MUST be recovered.
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay4', fields: { 'Customer Email': 'lost@example.com', 'Pass Type': 'unknown', 'Amount': 2499, 'Transaction ID': 'pp_lost' } },
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
      { id: 'pay5', fields: { 'Customer Email': 'addon2@example.com', 'Pass Type': 'unknown', 'Amount': 99, 'Transaction ID': 'pp_addon' } },
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
});
