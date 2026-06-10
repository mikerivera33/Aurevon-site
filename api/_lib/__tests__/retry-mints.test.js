/**
 * Durability-under-retry regression for the retry-mints cron.
 *
 * A "Failed" NFT_Mints row whose original mint actually went through on-chain
 * (lost response) must NOT be re-minted — that would create a second asset.
 * The cron reads-before-retry: if an active mint of the same type already exists
 * for the email, it resolves the stale row instead of re-minting.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../airtable.js', () => ({
  listFailedMints: vi.fn(),
  findActiveMintByEmailAndType: vi.fn(),
  updateNftMint: vi.fn().mockResolvedValue({}),
  // unused-by-this-path exports referenced at module load:
  upsertMemberByEmail: vi.fn(), findMemberByEmail: vi.fn(), findActiveMintByEmail: vi.fn(),
  listNftMints: vi.fn(), listPendingDiscordSync: vi.fn(), listOutOfSyncEntitlements: vi.fn(),
  updateDiscordSyncStatus: vi.fn(),
}));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn().mockResolvedValue({ ok: true, actionId: 'act_new' }) }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn(), onSubscriptionCancelled: vi.fn() }));

import { handleRetryMints } from '../../member/claim.js';
import * as airtable from '../airtable.js';
import * as crossmint from '../crossmint.js';

describe('handleRetryMints idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AIRTABLE_PAT = 'pat_test';
    process.env.AIRTABLE_BASE_ID = 'app_test';
  });

  it('does NOT re-mint a Failed row when an active mint of the same type already exists', async () => {
    airtable.listFailedMints.mockResolvedValueOnce([
      { id: 'recFailed', fields: { Email: 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full' } },
    ]);
    airtable.findActiveMintByEmailAndType.mockResolvedValueOnce({
      id: 'recActive', fields: { 'Mint Status': 'Sent', 'Token ID': 'act_original' },
    });

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();          // no second mint
    expect(report.skippedDuplicates).toBe(1);
    expect(airtable.updateNftMint).toHaveBeenCalledWith('recFailed', expect.objectContaining({
      'Token ID': 'act_original',
    }));
  });

  it('does re-mint a genuinely failed row with no prior active mint', async () => {
    airtable.listFailedMints.mockResolvedValueOnce([
      { id: 'recFailed2', fields: { Email: 'other@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer' } },
    ]);
    airtable.findActiveMintByEmailAndType.mockResolvedValueOnce(null);

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(report.retried).toBe(1);
  });

  it('does NOT stamp a row Sent when the retry mint returns ok:false', async () => {
    airtable.listFailedMints.mockResolvedValueOnce([
      { id: 'recFailed3', fields: { Email: 'fail@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer' } },
    ]);
    airtable.findActiveMintByEmailAndType.mockResolvedValueOnce(null);
    crossmint.mintToEmail.mockResolvedValueOnce({ ok: false, error: 'Crossmint 500' });

    const report = await handleRetryMints();

    expect(report.retried).toBe(0);
    expect(report.errors).toBe(1);
    // must NOT have marked it Sent (which would leave listFailedMints forever)
    const sentCall = airtable.updateNftMint.mock.calls.find(
      ([, fields]) => fields['Mint Status'] === 'Sent'
    );
    expect(sentCall).toBeUndefined();
  });
});
