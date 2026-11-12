/**
 * Fail-closed Svix verification for POST /api/webhooks/crossmint.
 *
 * Crossmint signs with Svix: headers svix-id / svix-timestamp / svix-signature
 * ("v1,<base64>" entries), HMAC-SHA256 over `${id}.${timestamp}.${body}` keyed
 * with the base64-decoded secret after `whsec_`.
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  updateNftMint: vi.fn(), findMemberByEmail: vi.fn(), findMintByActionId: vi.fn(), findMintByTokenId: vi.fn(),
  listActiveMintsByEmailAndTypeWithoutToken: vi.fn(), findActiveMintsByEmail: vi.fn(), updateDiscordSyncStatus: vi.fn(),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ syncMemberRoles: vi.fn(), addRoleToMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onEntitlementActivated: vi.fn() }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

import handler, { verifyCrossmintSignature } from '../../webhooks/crossmint.js';
import { sendAlert } from '../alert.js';
import { updateNftMint } from '../db.js';

const SECRET = `whsec_${Buffer.from('test-signing-key-0123456789abcdef').toString('base64')}`;

function signSvix({ secret, id, timestamp, body }) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` };
}
const now = () => Math.floor(Date.now() / 1000);

function fakeReq({ headers = {}, body = '{}' }) {
  const h = {};
  const req = { method: 'POST', headers, on(ev, cb) { h[ev] = cb; return req; } };
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
beforeEach(() => { vi.clearAllMocks(); });

const BODY = JSON.stringify({ type: 'some.other.event', actionId: 'act_x' });

describe('verifyCrossmintSignature (Svix)', () => {
  it('accepts a correctly signed body', () => {
    const headers = signSvix({ secret: SECRET, id: 'msg_1', timestamp: now(), body: BODY });
    expect(verifyCrossmintSignature(BODY, headers, SECRET)).toBe(true);
  });

  it('accepts when any of several space-separated entries matches', () => {
    const headers = signSvix({ secret: SECRET, id: 'msg_1', timestamp: now(), body: BODY });
    headers['svix-signature'] = `v1,AAAA ${headers['svix-signature']}`;
    expect(verifyCrossmintSignature(BODY, headers, SECRET)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, and missing headers', () => {
    const headers = signSvix({ secret: SECRET, id: 'msg_1', timestamp: now(), body: BODY });
    expect(verifyCrossmintSignature(`${BODY} `, headers, SECRET)).toBe(false);
    expect(verifyCrossmintSignature(BODY, headers, `whsec_${Buffer.from('other').toString('base64')}`)).toBe(false);
    for (const k of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const h = { ...headers }; delete h[k];
      expect(verifyCrossmintSignature(BODY, h, SECRET)).toBe(false);
    }
  });

  it('rejects a valid MAC under a non-v1 version tag', () => {
    const headers = signSvix({ secret: SECRET, id: 'msg_1', timestamp: now(), body: BODY });
    headers['svix-signature'] = headers['svix-signature'].replace(/^v1,/, 'v2,');
    expect(verifyCrossmintSignature(BODY, headers, SECRET)).toBe(false);
  });

  it('rejects a timestamp outside the 5-minute tolerance', () => {
    const ts = now() - 301;
    const headers = signSvix({ secret: SECRET, id: 'msg_1', timestamp: ts, body: BODY });
    expect(verifyCrossmintSignature(BODY, headers, SECRET)).toBe(false);
  });
});

describe('crossmint webhook handler — fail-closed', () => {
  it('valid signature → 200', async () => {
    process.env.CROSSMINT_WEBHOOK_SECRET = SECRET;
    const res = mockRes();
    await handler(fakeReq({ headers: signSvix({ secret: SECRET, id: 'msg_1', timestamp: now(), body: BODY }), body: BODY }), res);
    expect(res.statusCode).toBe(200);
  });

  it('tampered body → 401 + webhook_rejected alert', async () => {
    process.env.CROSSMINT_WEBHOOK_SECRET = SECRET;
    const headers = signSvix({ secret: SECRET, id: 'msg_1', timestamp: now(), body: BODY });
    const res = mockRes();
    await handler(fakeReq({ headers, body: BODY.replace('act_x', 'act_y') }), res);
    expect(res.statusCode).toBe(401);
    expect(sendAlert).toHaveBeenCalledWith('crossmint.webhook_rejected', { reason: 'bad_signature' }, { dedupeKey: 'sig' });
    expect(updateNftMint).not.toHaveBeenCalled();
  });

  it('stale timestamp → 401', async () => {
    process.env.CROSSMINT_WEBHOOK_SECRET = SECRET;
    const res = mockRes();
    await handler(fakeReq({ headers: signSvix({ secret: SECRET, id: 'msg_1', timestamp: now() - 600, body: BODY }), body: BODY }), res);
    expect(res.statusCode).toBe(401);
  });

  it('old `crossmint-signature: t=,v1=` header → 401', async () => {
    process.env.CROSSMINT_WEBHOOK_SECRET = SECRET;
    const ts = now();
    const hex = crypto.createHmac('sha256', SECRET).update(`${ts}.${BODY}`).digest('hex');
    const res = mockRes();
    await handler(fakeReq({ headers: { 'crossmint-signature': `t=${ts},v1=${hex}` }, body: BODY }), res);
    expect(res.statusCode).toBe(401);
  });

  it('unset secret → 500 + critical unconfigured alert', async () => {
    delete process.env.CROSSMINT_WEBHOOK_SECRET;
    const res = mockRes();
    await handler(fakeReq({ body: BODY }), res);
    expect(res.statusCode).toBe(500);
    expect(sendAlert).toHaveBeenCalledWith('crossmint.webhook_unconfigured', {}, { severity: 'critical', dedupeKey: 'config' });
  });
});
