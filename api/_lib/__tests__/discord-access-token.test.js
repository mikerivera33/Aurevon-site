/**
 * Discord email-ownership access token (H2 fix).
 *
 * The OAuth account-linking flow used to issue a valid HMAC `state` for ANY
 * ?email= with no proof the requester controlled that inbox — anyone who knew a
 * paying member's email could steal their role. The fix requires a SIGNED,
 * email-bound, EXPIRING, single-use token (delivered only to the inbox) and
 * derives the email FROM the token. These tests pin:
 *   - round-trip: verify derives the (normalized) email from a signed token,
 *   - tamper/forgery is rejected (signature mismatch, timing-safe),
 *   - expiry is enforced,
 *   - /api/discord?action=auth FAILS CLOSED for old ?email=-only links (no token),
 *   - a valid token redirects to Discord with the token as `state` (no ?email=).
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import handler, { signDiscordAccessToken, verifyDiscordAccessToken } from '../../discord.js';

const SAVED = { ...process.env };
beforeEach(() => { process.env.STATE_SECRET = 'test_state_secret_abcdefghij1234567890'; });
afterEach(() => { process.env = { ...SAVED }; });

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    redirectedTo: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
    redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
  };
}

describe('Discord access token — sign/verify (H2)', () => {
  it('round-trips and derives the normalized email from the token', () => {
    const token = signDiscordAccessToken('Member@Example.COM');
    const { email, nonce, exp } = verifyDiscordAccessToken(token);
    expect(email).toBe('member@example.com');
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
    expect(exp).toBeGreaterThan(Date.now());
  });

  it('rejects a payload swapped to a different email (keeps old MAC)', () => {
    const token = signDiscordAccessToken('owner@example.com');
    const mac = token.slice(token.lastIndexOf('.') + 1);
    const forgedPayload = b64url(JSON.stringify({ e: 'victim@example.com', x: Date.now() + 100000, n: 'n' }));
    expect(() => verifyDiscordAccessToken(`${forgedPayload}.${mac}`)).toThrow();
  });

  it('rejects a tampered MAC', () => {
    const token = signDiscordAccessToken('owner@example.com');
    const lastDot = token.lastIndexOf('.');
    const payload = token.slice(0, lastDot);
    const mac = token.slice(lastDot + 1);
    const flipped = mac.slice(0, -1) + (mac.slice(-1) === 'A' ? 'B' : 'A');
    expect(() => verifyDiscordAccessToken(`${payload}.${flipped}`)).toThrow();
  });

  it('rejects an expired token (correctly signed, past expiry)', () => {
    const secret = process.env.STATE_SECRET;
    const payload = b64url(JSON.stringify({ e: 'a@b.com', x: Date.now() - 1000, n: 'nonce1' }));
    const mac = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
    expect(() => verifyDiscordAccessToken(`${payload}.${mac}`)).toThrow(/expired/i);
  });

  it('rejects malformed / missing tokens', () => {
    expect(() => verifyDiscordAccessToken('')).toThrow();
    expect(() => verifyDiscordAccessToken('nodothere')).toThrow();
    expect(() => verifyDiscordAccessToken(undefined)).toThrow();
  });

  it('cannot be verified once signed under a different secret', () => {
    const token = signDiscordAccessToken('a@b.com');
    process.env.STATE_SECRET = 'a_totally_different_secret_value_00';
    expect(() => verifyDiscordAccessToken(token)).toThrow();
  });
});

describe('/api/discord?action=auth — token gating (H2)', () => {
  it('FAILS CLOSED for an old ?email=-only link (no token) with 400', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'auth', email: 'victim@example.com' }, headers: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.redirectedTo).toBeNull();
  });

  it('rejects an invalid/forged token with 403 (no redirect)', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'auth', token: 'garbage.token' }, headers: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.redirectedTo).toBeNull();
  });

  it('redirects to Discord OAuth with a valid token as state (never trusts ?email=)', async () => {
    const res = mockRes();
    const token = signDiscordAccessToken('member@example.com');
    await handler({ method: 'GET', query: { action: 'auth', token, email: 'attacker@evil.com' }, headers: {} }, res);
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).toContain('discord.com/api/oauth2/authorize');
    expect(res.redirectedTo).toContain(`state=${encodeURIComponent(token)}`);
    // The attacker-supplied ?email= must NOT appear anywhere in the redirect.
    expect(res.redirectedTo).not.toContain('attacker%40evil.com');
    expect(res.redirectedTo).not.toContain('attacker@evil.com');
  });
});
