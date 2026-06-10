/**
 * Recovery for the marker-written-but-mint-missing window (review Critical).
 *
 * If the webhook dies after writing the Payments idempotency marker but before
 * writing the NFT_Mints row, the mint is silently dropped. recoverOrphanPayments
 * finds recent NFT-tier payments with no mint row and dead-letters them ('Failed')
 * so the idempotent retry-mints cron recovers them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../airtable.js', () => ({
  listPaymentsSince: vi.fn(),
  findAnyMintByEmailAndType: vi.fn(),
  createNftMint: vi.fn().mockResolvedValue({}),
  // referenced at module load:
  upsertMemberByEmail: vi.fn(), findMemberByEmail: vi.fn(), findActiveMintByEmail: vi.fn(),
  findActiveMintByEmailAndType: vi.fn(), listNftMints: vi.fn(), listPendingDiscordSync: vi.fn(),
  listOutOfSyncEntitlements: vi.fn(), listFailedMints: vi.fn(), updateDiscordSyncStatus: vi.fn(),
  updateNftMint: vi.fn(),
}));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn(), onSubscriptionCancelled: vi.fn() }));

import { recoverOrphanPayments } from '../../member/claim.js';
import * as airtable from '../airtable.js';

describe('recoverOrphanPayments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dead-letters a paid NFT-tier payment that has no mint row', async () => {
    airtable.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay1', fields: { 'Customer Email': 'buyer@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_orphan_1' } },
    ]);
    airtable.findAnyMintByEmailAndType.mockResolvedValueOnce(null); // no mint row → orphan

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(1);
    expect(airtable.createNftMint).toHaveBeenCalledWith(expect.objectContaining({
      reference: 'RECOVER_cs_orphan_1',
      email: 'buyer@example.com',
      status: 'Failed',
    }));
  });

  it('does NOT dead-letter when a mint row already exists', async () => {
    airtable.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay2', fields: { 'Customer Email': 'ok@example.com', 'Pass Type': 'full', 'Transaction ID': 'cs_ok' } },
    ]);
    airtable.findAnyMintByEmailAndType.mockResolvedValueOnce({ id: 'mintExists' });

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(0);
    expect(airtable.createNftMint).not.toHaveBeenCalled();
  });

  it('re-infers an NFT tier from the amount when Pass Type is unknown (F1 durability)', async () => {
    // Webhook stored 'unknown' because tier inference failed at the time, but the
    // amount matches an NFT tier — this is a dropped mint and MUST be recovered.
    airtable.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay4', fields: { 'Customer Email': 'lost@example.com', 'Pass Type': 'unknown', 'Amount': 2499, 'Transaction ID': 'pp_lost' } },
    ]);
    airtable.findAnyMintByEmailAndType.mockResolvedValueOnce(null);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(1);
    expect(airtable.createNftMint).toHaveBeenCalledWith(expect.objectContaining({
      reference: 'RECOVER_pp_lost',
      email: 'lost@example.com',
      status: 'Failed',
    }));
  });

  it('does NOT recover an unknown-tier payment whose amount is a no-NFT add-on', async () => {
    airtable.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay5', fields: { 'Customer Email': 'addon2@example.com', 'Pass Type': 'unknown', 'Amount': 99, 'Transaction ID': 'pp_addon' } },
    ]);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(0);
    expect(airtable.createNftMint).not.toHaveBeenCalled();
  });

  it('ignores no-NFT tiers (add-ons / second opinion)', async () => {
    airtable.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay3', fields: { 'Customer Email': 'addon@example.com', 'Pass Type': 'addon_rush', 'Transaction ID': 'cs_addon' } },
    ]);

    const result = await recoverOrphanPayments({ sinceDays: 3 });

    expect(result.recovered).toBe(0);
    expect(airtable.findAnyMintByEmailAndType).not.toHaveBeenCalled();
    expect(airtable.createNftMint).not.toHaveBeenCalled();
  });
});
