/**
 * POST /api/member/claim — TIMING-oracle regression (M2 hardening).
 *
 * claim-uniform.test.js closes the *content* oracle (byte-identical body). It does
 * NOT close the *timing* oracle: findActiveMintByEmail runs in both branches, but
 * the member branch used to `await sendDiscordAccessLink(...)` — a ~100-800ms
 * external Resend round-trip — while the non-member branch returned immediately.
 * That latency delta lets an anonymous caller enumerate who is/isn't a member.
 *
 * The fix registers the send with waitUntil (from @vercel/functions) and does NOT
 * await it, so the handler returns immediately in BOTH branches while the email
 * still completes (a bare un-awaited promise would be frozen/killed on Vercel the
 * moment the function returns — waitUntil is what keeps it alive).
 *
 * These tests fail against the old awaiting code: with a never-resolving send
 * promise, an awaiting handler would hang and the test would time out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture every promise handed to waitUntil so we can assert the send is
// registered for background completion (durability) rather than awaited or dropped.
const waitUntilCalls = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: (p) => { waitUntilCalls.push(p); },
}));

vi.mock('../airtable.js', () => ({
  findActiveMintByEmail: vi.fn(),
  // referenced at module load by claim.js:
  findMemberByEmail: vi.fn(), findActiveMintByEmailAndType: vi.fn(), findAnyMintByEmailAndType: vi.fn(),
  listNftMints: vi.fn(), listPaymentsSince: vi.fn(), listPendingDiscordSync: vi.fn(),
  listOutOfSyncEntitlements: vi.fn(), listFailedMints: vi.fn(), updateDiscordSyncStatus: vi.fn(),
  updateNftMint: vi.fn(), createNftMint: vi.fn(),
}));
vi.mock('../email.js', () => ({ sendDiscordAccessLink: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn(), onSubscriptionCancelled: vi.fn() }));

import handler from '../../member/claim.js';
import * as airtable from '../airtable.js';
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

async function postClaim(bodyEmail) {
  const res = mockRes();
  await handler({ method: 'POST', query: {}, headers: {}, body: { email: bodyEmail } }, res);
  return res;
}

describe('POST /api/member/claim — timing oracle closed (M2)', () => {
  beforeEach(() => { vi.clearAllMocks(); waitUntilCalls.length = 0; });

  it('member branch does NOT await the send — returns promptly even if the send never resolves', async () => {
    airtable.findActiveMintByEmail.mockResolvedValueOnce({ id: 'm1', fields: { 'NFT Type': 'Aurevon Ember', 'Mint Status': 'Sent' } });
    // Never-resolving send: the OLD `await sendDiscordAccessLink(...)` would hang here,
    // making this test time out. waitUntil-based code returns without awaiting it.
    email.sendDiscordAccessLink.mockReturnValueOnce(new Promise(() => {}));

    const res = await postClaim('member@example.com');

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/if this email has an aurevon membership/i);
    // The send fired and was handed to waitUntil (registered, not dropped, not awaited).
    expect(email.sendDiscordAccessLink).toHaveBeenCalledWith({ email: 'member@example.com' });
    expect(waitUntilCalls).toHaveLength(1);
    expect(typeof waitUntilCalls[0]?.then).toBe('function'); // a real promise was registered
  });

  it('non-member branch registers nothing with waitUntil and sends no email (symmetric fast path)', async () => {
    airtable.findActiveMintByEmail.mockResolvedValueOnce(null);

    const res = await postClaim('stranger@example.com');

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/if this email has an aurevon membership/i);
    expect(email.sendDiscordAccessLink).not.toHaveBeenCalled();
    expect(waitUntilCalls).toHaveLength(0);
  });

  it('a send that rejects is swallowed via waitUntil and never affects the response', async () => {
    airtable.findActiveMintByEmail.mockResolvedValueOnce({ id: 'm1', fields: {} });
    email.sendDiscordAccessLink.mockRejectedValueOnce(new Error('resend down'));

    // The rejection is handled by the .catch() inside the waitUntil chain; the
    // handler must still resolve with the uniform 200 body (no unhandled rejection,
    // no leak). We await the registered promise to confirm it settles cleanly.
    const res = await postClaim('member@example.com');
    expect(res.statusCode).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    await expect(waitUntilCalls[0]).resolves.toBeUndefined();
  });
});
