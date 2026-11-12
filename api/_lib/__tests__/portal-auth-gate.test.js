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

vi.mock('../db.js', () => ({
  dbConfigured: vi.fn(() => true),
  findMemberByEmail: vi.fn(),
  listMintsByEmail: vi.fn(),
  listPaymentsByEmail: vi.fn(),
  findCustomerAuth: vi.fn(),
  upsertCustomerAuth: vi.fn(),
  updateCustomerAuth: vi.fn(),
}));

import handler from '../../portal/data.js';
import * as db from '../db.js';

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

/** Membership lookups return the given rows; Resend sends are counted via fetch. */
function install({ memberRow = null, mintRows = [], paymentRows = [] } = {}) {
  const calls = { resend: 0 };
  db.findMemberByEmail.mockResolvedValue(memberRow);
  db.listMintsByEmail.mockResolvedValue(mintRows);
  db.listPaymentsByEmail.mockResolvedValue(paymentRows);
  db.findCustomerAuth.mockResolvedValue(null);
  db.upsertCustomerAuth.mockResolvedValue({ id: 'rec1', fields: {} });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes(RESEND)) { calls.resend++; return { ok: true, text: async () => 'ok', json: async () => ({}) }; }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}

const authWrites = () => db.upsertCustomerAuth.mock.calls.length + db.updateCustomerAuth.mock.calls.length;

describe('portal auth membership gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.dbConfigured.mockReturnValue(true);
    process.env.RESEND_API_KEY = 're_test';
  });

  it('non-member: returns uniform success but sends no email and writes no auth row', async () => {
    const calls = install();
    const r = res();
    await handler(authReq('stranger@example.com'), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Check your email for a login link.' });
    expect(calls.resend).toBe(0);
    expect(authWrites()).toBe(0);
  });

  it('member: proceeds to issue a link (email is sent)', async () => {
    const calls = install({ memberRow: { id: 'm1', fields: { Email: 'member@example.com' } } });
    const r = res();
    await handler(authReq('member@example.com'), r);
    expect(r.statusCode).toBe(200);
    expect(calls.resend).toBe(1);
    expect(db.upsertCustomerAuth).toHaveBeenCalledWith('member@example.com', expect.objectContaining({
      'Magic Token': expect.stringMatching(/^[0-9a-f]{64}$/),
      'Session Active': false,
    }));
  });

  it('NFT-only member (mint row, no Members/Payments) is NOT locked out', async () => {
    const calls = install({ mintRows: [{ id: 'n1', fields: { Email: 'nft@example.com', 'Mint Status': 'Sent' } }] });
    const r = res();
    await handler(authReq('nft@example.com'), r);
    expect(r.statusCode).toBe(200);
    expect(calls.resend).toBe(1);
  });

  it('add-on-only buyer (Payments row, no Members/NFT) is NOT locked out', async () => {
    // Regression: an add-on purchase creates only a Payments row (keyed by
    // 'Customer Email', not 'Email'). The gate must consult Payments by email,
    // or a real payer is silently denied their portal login link. The column
    // choice itself is covered in db.test.js (listPaymentsByEmail → customer_email).
    const calls = install({ paymentRows: [{ id: 'p1', fields: { 'Customer Email': 'addon@example.com' } }] });
    const r = res();
    await handler(authReq('Addon@Example.com'), r);
    expect(r.statusCode).toBe(200);
    expect(calls.resend).toBe(1); // link WAS sent
    expect(db.listPaymentsByEmail).toHaveBeenCalledWith('addon@example.com', 1);
  });

  it('a failing membership lookup fails closed (treated as non-member, uniform body)', async () => {
    const calls = install();
    db.findMemberByEmail.mockRejectedValueOnce(new Error('Supabase timeout'));
    const r = res();
    await handler(authReq('maybe@example.com'), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Check your email for a login link.' });
    expect(calls.resend).toBe(0);
    expect(authWrites()).toBe(0);
  });

  it('non-member response is byte-identical to the member success message (no oracle)', async () => {
    const calls = install({ memberRow: { id: 'm1', fields: {} } });
    const member = res();
    await handler(authReq('member@example.com'), member);

    install();
    const nonMember = res();
    await handler(authReq('nobody@example.com'), nonMember);

    expect(nonMember.statusCode).toBe(member.statusCode);
    expect(JSON.stringify(nonMember.body)).toBe(JSON.stringify(member.body));
    expect(nonMember.body.message).toBe('Check your email for a login link.');
    expect(calls.resend).toBe(1); // only the member's link went out
  });

  it('refuses with 500 (no lookups, no email) when the database is not configured', async () => {
    const calls = install({ memberRow: { id: 'm1', fields: {} } });
    db.dbConfigured.mockReturnValue(false);
    const r = res();
    await handler(authReq('member@example.com'), r);
    expect(r.statusCode).toBe(500);
    expect(db.findMemberByEmail).not.toHaveBeenCalled();
    expect(calls.resend).toBe(0);
  });
});
