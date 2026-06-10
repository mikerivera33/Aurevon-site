/**
 * Authz regression for the direct mint endpoint — POST /api/member/claim?action=mint
 * (rewritten from /api/crossmint/mint).
 *
 * This endpoint triggers an irreversible Crossmint mint to an arbitrary recipient.
 * It MUST require the INTERNAL_API_SECRET (the Zapier/Make automation in
 * AUTOMATION_PLAYBOOKS.md sends `Authorization: Bearer <INTERNAL_API_SECRET>`).
 * Previously the POST branch ran handleMint with no auth check at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// No module mocks needed: the auth gate short-circuits before any side-effecting
// lib is called, and none of claim.js's imports perform I/O at module load.
import handler from '../../member/claim.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });
beforeEach(() => { process.env.INTERNAL_API_SECRET = 'super_secret_value_123456'; });

describe('mint endpoint authz', () => {
  it('rejects an unauthenticated mint with 401', async () => {
    const res = mockRes();
    await handler(
      { method: 'POST', query: { action: 'mint' }, headers: {}, body: { passType: 'INSIDER', recipientEmail: 'attacker@example.com' } },
      res,
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong secret with 401', async () => {
    const res = mockRes();
    await handler(
      { method: 'POST', query: { action: 'mint' }, headers: { authorization: 'Bearer wrong' }, body: { passType: 'INSIDER', recipientEmail: 'attacker@example.com' } },
      res,
    );
    expect(res.statusCode).toBe(401);
  });

  it('passes auth with the correct secret (no longer 401)', async () => {
    const res = mockRes();
    await handler(
      { method: 'POST', query: { action: 'mint' }, headers: { authorization: 'Bearer super_secret_value_123456' }, body: { passType: 'INSIDER', recipientEmail: 'buyer@example.com' } },
      res,
    );
    // Past the auth gate; with no Crossmint config in the test env this surfaces
    // as 503 (or a downstream code), but never the 401 auth rejection.
    expect(res.statusCode).not.toBe(401);
  });

  it('returns 500 when INTERNAL_API_SECRET is not configured', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const res = mockRes();
    await handler(
      { method: 'POST', query: { action: 'mint' }, headers: { authorization: 'Bearer anything' }, body: { passType: 'INSIDER' } },
      res,
    );
    expect(res.statusCode).toBe(500);
  });
});
