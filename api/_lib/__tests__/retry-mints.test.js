/**
 * Durability-under-retry regression for the retry-mints cron.
 *
 * A "Failed" NFT_Mints row whose original mint actually went through on-chain
 * (lost response) must NOT be re-minted — that would create a second asset.
 * The cron reads-before-retry: if an active mint of the same type already exists
 * for the email, it resolves the stale row instead of re-minting.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  listFailedMints: vi.fn(),
  findActiveMintByEmailAndType: vi.fn(),
  findLatestPaymentByEmailAndTier: vi.fn().mockResolvedValue(null),
  updateNftMint: vi.fn().mockResolvedValue({}),
  // unused-by-this-path exports referenced at module load:
  upsertMemberByEmail: vi.fn(), findMemberByEmail: vi.fn(), findActiveMintByEmail: vi.fn(),
  findMintByTokenId: vi.fn(), listUnlinkedMintsBefore: vi.fn(), listPendingDiscordSync: vi.fn(), listOutOfSyncEntitlements: vi.fn(),
  updateDiscordSyncStatus: vi.fn(),
  findActiveMintsByEmail: vi.fn(), findAnyMintByEmailAndType: vi.fn(),
  listPaymentsSince: vi.fn(), createNftMint: vi.fn(), dbConfigured: vi.fn(() => true),
}));
vi.mock('../airtable-import.js', () => ({ airtableImportEnabled: vi.fn(() => false), importFromAirtable: vi.fn() }));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn().mockResolvedValue({ ok: true, actionId: 'act_new' }) }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn(), onSubscriptionCancelled: vi.fn() }));

import { handleRetryMints } from '../../member/claim.js';
import * as db from '../db.js';
import * as crossmint from '../crossmint.js';

describe('handleRetryMints idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.dbConfigured.mockReturnValue(true);
  });

  it('skips cleanly (no lookup, no mint) when the database is not configured', async () => {
    db.dbConfigured.mockReturnValueOnce(false);

    const report = await handleRetryMints();

    expect(report.skipped).toBe(true);
    expect(db.listFailedMints).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('does NOT re-mint a Failed row when an active mint of the same type already exists', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recFailed', fields: { Email: 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce({
      id: 'recActive', fields: { 'Mint Status': 'Sent', 'Token ID': 'act_original' },
    });

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();          // no second mint
    expect(report.skippedDuplicates).toBe(1);
    expect(db.updateNftMint).toHaveBeenCalledWith('recFailed', expect.objectContaining({
      'Token ID': 'act_original',
    }));
  });

  it('does re-mint a genuinely failed row with no prior active mint', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recFailed2', fields: { Email: 'other@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce(null);

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(report.retried).toBe(1);
  });

  it('reuses the original payment id as the mint idempotency key for a recovered orphan', async () => {
    // The double-mint fix: a recovered orphan row is `RECOVER_<txnId>`, and the
    // webhook minted with THAT txnId as its Crossmint key. Reusing it makes this
    // re-mint a server-side no-op (returns the existing NFT) instead of a 2nd asset.
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recOrphan', fields: { Email: 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full', Reference: 'RECOVER_cs_live_ABC123' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce(null); // no row yet (that's why it orphaned)

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'cs_live_ABC123' })
    );
  });

  it('reuses the Payments transaction id when the Failed row Reference is a serial', async () => {
    // Webhook minted with sessionId, then recorded Failed (timeout after Crossmint
    // accepted the PUT) and stored the serial as Reference. Retrying with EMB_0007
    // would mint a second on-chain asset. The Payments marker holds the real key.
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recPlain', fields: { Email: 'x@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'EMB_0007' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce(null);
    db.findLatestPaymentByEmailAndTier.mockResolvedValueOnce({
      id: 'pay1',
      fields: { 'Transaction ID': 'cs_live_ABC123', 'Pass Type': 'retainer' },
    });

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'cs_live_ABC123' })
    );
  });

  it('falls back to the serial only when no matching payment exists', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recPlain2', fields: { Email: 'y@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'EMB_0008' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce(null);
    db.findLatestPaymentByEmailAndTier.mockResolvedValueOnce(null);

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'EMB_0008' })
    );
  });

  it('skips the row (no mint) when the Payments lookup errors, instead of falling back to the serial', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recOutage', fields: { Email: 'z@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'EMB_0009' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce(null);
    db.findLatestPaymentByEmailAndTier.mockRejectedValueOnce(new Error('Supabase 503'));

    const out = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(out.skippedLookupErrors).toBe(1);
  });

  it('skips the row (no mint) when the active-mint lookup errors', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recOutage2', fields: { Email: 'w@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'EMB_0010' } },
    ]);
    db.findActiveMintByEmailAndType.mockRejectedValueOnce(new Error('Supabase 503'));

    const out = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(out.skippedLookupErrors).toBe(1);
  });

  it('strips a PAY_ prefix so Failed webhook rows reuse the payment id', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recPay', fields: { Email: 'z@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full', Reference: 'PAY_cs_live_PAY1' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce(null);

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'cs_live_PAY1' })
    );
    expect(db.findLatestPaymentByEmailAndTier).not.toHaveBeenCalled();
  });

  it('does NOT stamp a row Sent when the retry mint returns ok:false', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recFailed3', fields: { Email: 'fail@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer' } },
    ]);
    db.findActiveMintByEmailAndType.mockResolvedValueOnce(null);
    crossmint.mintToEmail.mockResolvedValueOnce({ ok: false, error: 'Crossmint 500' });

    const report = await handleRetryMints();

    expect(report.retried).toBe(0);
    expect(report.errors).toBe(1);
    // must NOT have marked it Sent (which would leave listFailedMints forever)
    const sentCall = db.updateNftMint.mock.calls.find(
      ([, fields]) => fields['Mint Status'] === 'Sent'
    );
    expect(sentCall).toBeUndefined();
  });
});
