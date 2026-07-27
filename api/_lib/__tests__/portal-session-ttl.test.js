/**
 * Portal session tokens expire after 30 days, and the Magic Link Token is no
 * longer accepted as a data-access credential.
 *
 * Session tokens are `<base36 issue-ms>.<random hex>`; handleData enforces the
 * TTL from the embedded timestamp (no extra Airtable field). A token with no
 * timestamp prefix (legacy/malformed) is treated as expired. The former
 * `Session Token ?? Magic Link Token` fallback is removed — a captured one-time
 * magic link must not act as a durable session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../portal/data.js';

const AUTH = process.env.AIRTABLE_TABLE_CUSTOMER_AUTH ?? 'tblbCS7TL65FcOiWn';
const DAY_MS = 24 * 60 * 60 * 1000;
const RAND = 'a'.repeat(64);

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

function res() {
  return {
    statusCode: 0, body: null,
    setHeader() { return this; },
    end() { return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function dataReq(email, sessionToken) {
  return { method: 'POST', query: { action: 'data' }, body: { email, sessionToken } };
}

/** AUTH table query returns the given auth record; every other table is empty. */
function installFetch(authFields) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.includes(AUTH)) return { ok: true, json: async () => ({ records: [{ id: 'recAuth', fields: authFields }] }) };
    return { ok: true, json: async () => ({ records: [] }) };
  }));
}

describe('portal session TTL + magic-link fallback removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AIRTABLE_PAT = 'pat_test';
    process.env.AIRTABLE_BASE_ID = 'app_test';
  });

  it('accepts a fresh session token (issued now)', async () => {
    const token = `${Date.now().toString(36)}.${RAND}`;
    installFetch({ Email: 'u@example.com', 'Session Active': true, 'Session Token': token });
    const r = res();
    await handler(dataReq('u@example.com', token), r);
    expect(r.statusCode).toBe(200);
  });

  it('rejects a token older than the 30-day TTL', async () => {
    const token = `${(Date.now() - 31 * DAY_MS).toString(36)}.${RAND}`;
    installFetch({ Email: 'u@example.com', 'Session Active': true, 'Session Token': token });
    const r = res();
    await handler(dataReq('u@example.com', token), r);
    expect(r.statusCode).toBe(401);
    expect(r.body.error).toMatch(/expired/i);
  });

  it('rejects a legacy token with no timestamp prefix', async () => {
    const token = RAND; // no "<ts>." prefix
    installFetch({ Email: 'u@example.com', 'Session Active': true, 'Session Token': token });
    const r = res();
    await handler(dataReq('u@example.com', token), r);
    expect(r.statusCode).toBe(401);
  });

  it('does NOT accept a Magic Link Token as a session credential', async () => {
    const magic = `${Date.now().toString(36)}.${RAND}`;
    // No 'Session Token' field at all — only a Magic Link Token. Client presents it.
    installFetch({ Email: 'u@example.com', 'Session Active': true, 'Magic Link Token': magic });
    const r = res();
    await handler(dataReq('u@example.com', magic), r);
    expect(r.statusCode).toBe(401);
  });
});
