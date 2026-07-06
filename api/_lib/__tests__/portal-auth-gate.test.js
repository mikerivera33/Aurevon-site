/**
 * Portal magic-link abuse control (Security · Backend, medium).
 *
 * POST /api/portal/auth is unauthenticated. Before this gate it wrote a
 * CustomerAuth row and emailed a login link for ANY valid-looking address —
 * an email-bombing + table-flooding primitive. It now only sends/writes when the
 * email already belongs to a member, and returns the SAME success body for
 * non-members (no oracle).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../portal/data.js';

const MEMBERS = process.env.AIRTABLE_TABLE_MEMBERS ?? 'tblYPn7hxnrgH723B';
const RESEND = 'api.resend.com/emails';

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
function authReq(email) {
  return { method: 'POST', query: { action: 'auth' }, body: { email } };
}

/** Route fetch by URL: membership tables return `members` for the MEMBERS table
 *  (others empty), Resend + Airtable writes are recorded. */
function installFetch({ memberRows = [] } = {}) {
  const calls = { resend: 0, authWrite: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (url.includes(RESEND)) { calls.resend++; return { ok: true, text: async () => 'ok', json: async () => ({}) }; }
    if (url.includes(MEMBERS)) return { ok: true, json: async () => ({ records: memberRows }) };
    if ((opts.method === 'POST' || opts.method === 'PATCH')) { calls.authWrite++; return { ok: true, json: async () => ({ id: 'rec1' }) }; }
    return { ok: true, json: async () => ({ records: [] }) }; // NFT / Payments / auth GET
  }));
  return calls;
}

describe('portal auth membership gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AIRTABLE_PAT = 'pat_test';
    process.env.RESEND_API_KEY = 're_test';
  });

  it('non-member: returns uniform success but sends no email and writes no auth row', async () => {
    const calls = installFetch({ memberRows: [] });
    const r = res();
    await handler(authReq('stranger@example.com'), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Check your email for a login link.' });
    expect(calls.resend).toBe(0);
    expect(calls.authWrite).toBe(0);
  });

  it('member: proceeds to issue a link (email is sent)', async () => {
    const calls = installFetch({ memberRows: [{ id: 'm1', fields: { Email: 'member@example.com' } }] });
    const r = res();
    await handler(authReq('member@example.com'), r);
    expect(r.statusCode).toBe(200);
    expect(calls.resend).toBe(1);
  });

  it('non-member response is byte-identical to the member success message (no oracle)', async () => {
    const calls = installFetch({ memberRows: [] });
    const r = res();
    await handler(authReq('nobody@example.com'), r);
    expect(r.body.message).toBe('Check your email for a login link.');
    expect(calls.resend).toBe(0);
  });
});
