/**
 * POST /api/member/claim — uniform, non-disclosing "request my access link" (M2).
 *
 * The old handler was an unauthenticated membership/tier ENUMERATION ORACLE
 * (returned nftFound/nftType/mintStatus by email) and also wrote Active:true member
 * rows for arbitrary emails (table pollution). The fix:
 *   - responds UNIFORMLY regardless of membership state (no disclosure),
 *   - does NOT create/patch member rows,
 *   - when (and only when) a real mint exists, emails the tokenized Discord access
 *     link to the inbox owner (so only they learn status / can link).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  findActiveMintByEmail: vi.fn(),
  // referenced at module load by claim.js:
  findMemberByEmail: vi.fn(), findActiveMintByEmailAndType: vi.fn(), findAnyMintByEmailAndType: vi.fn(),
  findMintByTokenId: vi.fn(), listUnlinkedMintsBefore: vi.fn(), listPaymentsSince: vi.fn(), listPendingDiscordSync: vi.fn(), listFailedDiscordSync: vi.fn().mockResolvedValue([]), listStuckSentMints: vi.fn().mockResolvedValue([]), updateEntitlementState: vi.fn().mockResolvedValue({}),
  listOutOfSyncEntitlements: vi.fn(), listFailedMints: vi.fn(), updateDiscordSyncStatus: vi.fn(),
  updateNftMint: vi.fn(), createNftMint: vi.fn(),
  findActiveMintsByEmail: vi.fn(), findLatestPaymentByEmailAndTier: vi.fn(), dbConfigured: vi.fn(() => true),
  // fulfil.js (shared NFT fulfilment):
  findMintByPaymentId: vi.fn().mockResolvedValue(null),
  // claim.js (retry-mints / reconcile):
  listUndeliveredMints: vi.fn(), findPaymentByTransactionId: vi.fn(), listPaymentTransactionIds: vi.fn(),
  recordOpsEvent: vi.fn(), listLapsedMonthlyWithoutExpiry: vi.fn(),
}));
vi.mock('../airtable-import.js', () => ({ importHasProblems: vi.fn(() => false), airtableImportEnabled: vi.fn(() => false), importFromAirtable: vi.fn() }));
vi.mock('../email.js', () => ({ sendDiscordAccessLink: vi.fn().mockResolvedValue({ ok: true, id: 'em_1' }), sendNftDelivery: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn(), onSubscriptionCancelled: vi.fn() }));

import handler from '../../member/claim.js';
import * as db from '../db.js';
import * as email from '../email.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

const DISCLOSURE_KEYS = ['nftFound', 'nftType', 'mintStatus', 'entitlementKey', 'discordAuthUrl', 'discordLinked'];

async function postClaim(bodyEmail) {
  const res = mockRes();
  await handler({ method: 'POST', query: {}, headers: {}, body: { email: bodyEmail } }, res);
  return res;
}

describe('POST /api/member/claim — uniform response (M2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emails the access link and returns the uniform body when a membership exists', async () => {
    db.findActiveMintByEmail.mockResolvedValueOnce({ id: 'm1', fields: { 'NFT Type': 'Aurevon Ember', 'Mint Status': 'Sent' } });
    const res = await postClaim('member@example.com');

    expect(res.statusCode).toBe(200);
    expect(email.sendDiscordAccessLink).toHaveBeenCalledWith({ email: 'member@example.com' });
    for (const k of DISCLOSURE_KEYS) expect(res.body).not.toHaveProperty(k);
    expect(res.body.message).toMatch(/if this email has an aurevon membership/i);
  });

  it('returns the SAME body and sends NO email when no membership exists', async () => {
    db.findActiveMintByEmail.mockResolvedValueOnce(null);
    const res = await postClaim('stranger@example.com');

    expect(res.statusCode).toBe(200);
    expect(email.sendDiscordAccessLink).not.toHaveBeenCalled();
    for (const k of DISCLOSURE_KEYS) expect(res.body).not.toHaveProperty(k);
  });

  it('is a non-oracle: member and non-member responses are byte-identical', async () => {
    db.findActiveMintByEmail.mockResolvedValueOnce({ id: 'm1', fields: { 'NFT Type': 'Aurevon Ember', 'Mint Status': 'Sent' } });
    const hit = await postClaim('member@example.com');
    db.findActiveMintByEmail.mockResolvedValueOnce(null);
    const miss = await postClaim('stranger@example.com');

    expect(hit.statusCode).toBe(miss.statusCode);
    expect(JSON.stringify(hit.body)).toBe(JSON.stringify(miss.body));
  });

  it('never writes member rows (no upsert helper is even imported/called)', async () => {
    db.findActiveMintByEmail.mockResolvedValueOnce(null);
    await postClaim('stranger@example.com');
    // upsertMemberByEmail is intentionally not part of the mocked surface — if
    // claim.js tried to call it, the module would have failed to import.
    expect(db.updateNftMint).not.toHaveBeenCalled();
    expect(db.createNftMint).not.toHaveBeenCalled();
  });

  it('rejects an invalid email with 400 and no lookup', async () => {
    const res = await postClaim('not-an-email');
    expect(res.statusCode).toBe(400);
    expect(db.findActiveMintByEmail).not.toHaveBeenCalled();
    expect(email.sendDiscordAccessLink).not.toHaveBeenCalled();
  });
});
