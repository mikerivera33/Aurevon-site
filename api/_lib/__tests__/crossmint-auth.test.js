/**
 * Fail-closed authz regression for POST /api/webhooks/crossmint.
 *
 * Verification is mandatory: a forged `action.succeeded` must never be able to
 * grant Discord roles / entitlements. Specifically:
 *   - CROSSMINT_WEBHOOK_SECRET unset            → 500 (misconfigured), no processing
 *   - secret set + missing/invalid signature    → 401
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub side-effecting libs so a hypothetical processing path can't touch I/O.
vi.mock('../airtable.js', () => ({
  updateNftMint: vi.fn(), findMemberByEmail: vi.fn(), listNftMints: vi.fn(),
  updateDiscordSyncStatus: vi.fn(), findActiveMintByEmail: vi.fn(),
}));
vi.mock('../entitlements.js', () => ({ resolveEntitlementFromNftType: vi.fn(), getRoleId: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onEntitlementActivated: vi.fn() }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

import handler from '../../webhooks/crossmint.js';

function fakeReq({ headers = {}, body = '{}' }) {
  const h = {};
  const req = { method: 'POST', headers, on(ev, cb) { h[ev] = cb; return req; } };
  // Emit the body on a microtask, after the handler has attached its listeners.
  Promise.resolve().then(() => { if (h.data) h.data(Buffer.from(body)); if (h.end) h.end(); });
  return req;
}
function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

describe('crossmint webhook fail-closed verification', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 500 when CROSSMINT_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.CROSSMINT_WEBHOOK_SECRET;
    const res = mockRes();
    await handler(fakeReq({ body: JSON.stringify({ type: 'action.succeeded' }) }), res);
    expect(res.statusCode).toBe(500);
  });

  it('returns 401 when the secret is set but no signature is provided', async () => {
    process.env.CROSSMINT_WEBHOOK_SECRET = 'whsec_test_secret';
    const res = mockRes();
    await handler(fakeReq({ headers: {}, body: JSON.stringify({ type: 'action.succeeded' }) }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 on a present-but-invalid signature', async () => {
    process.env.CROSSMINT_WEBHOOK_SECRET = 'whsec_test_secret';
    const res = mockRes();
    const ts = Math.floor(Date.now() / 1000);
    await handler(fakeReq({
      headers: { 'crossmint-signature': `t=${ts},v1=deadbeef` },
      body: JSON.stringify({ type: 'action.succeeded' }),
    }), res);
    expect(res.statusCode).toBe(401);
  });
});
