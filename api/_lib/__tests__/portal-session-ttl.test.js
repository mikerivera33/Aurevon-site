/**
 * Portal session tokens expire after 30 days, and the Magic Link Token is no
 * longer accepted as a data-access credential.
 *
 * Session tokens are `<base36 issue-ms>.<random hex>`; handleData enforces the
 * TTL from the embedded timestamp (no extra database column). A token with no
 * timestamp prefix (legacy/malformed) is treated as expired. The former
 * `Session Token ?? Magic Token` fallback is removed — a captured one-time
 * magic link must not act as a durable session.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const RAND = 'a'.repeat(64);

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

/** CustomerAuth returns the given auth record; every other lookup is empty. */
function install(authFields) {
  db.findCustomerAuth.mockResolvedValue({ id: 'recAuth', fields: authFields });
  db.listPaymentsByEmail.mockResolvedValue([]);
  db.listMintsByEmail.mockResolvedValue([]);
  db.findMemberByEmail.mockResolvedValue(null);
}

describe('portal session TTL + magic-link fallback removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.dbConfigured.mockReturnValue(true);
  });

  it('accepts a fresh session token (issued now)', async () => {
    const token = `${Date.now().toString(36)}.${RAND}`;
    install({ Email: 'u@example.com', 'Session Active': true, 'Session Token': token });
    const r = res();
    await handler(dataReq('u@example.com', token), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.success).toBe(true);
  });

  it('rejects a token older than the 30-day TTL', async () => {
    const token = `${(Date.now() - 31 * DAY_MS).toString(36)}.${RAND}`;
    install({ Email: 'u@example.com', 'Session Active': true, 'Session Token': token });
    const r = res();
    await handler(dataReq('u@example.com', token), r);
    expect(r.statusCode).toBe(401);
    expect(r.body.error).toMatch(/expired/i);
    expect(db.listPaymentsByEmail).not.toHaveBeenCalled();
  });

  it('rejects a legacy token with no timestamp prefix', async () => {
    const token = RAND; // no "<ts>." prefix
    install({ Email: 'u@example.com', 'Session Active': true, 'Session Token': token });
    const r = res();
    await handler(dataReq('u@example.com', token), r);
    expect(r.statusCode).toBe(401);
  });

  it('rejects a matching token when Session Active is false', async () => {
    const token = `${Date.now().toString(36)}.${RAND}`;
    install({ Email: 'u@example.com', 'Session Active': false, 'Session Token': token });
    const r = res();
    await handler(dataReq('u@example.com', token), r);
    expect(r.statusCode).toBe(401);
  });

  it('does NOT accept a Magic Token as a session credential', async () => {
    const magic = `${Date.now().toString(36)}.${RAND}`;
    // No 'Session Token' at all — only the one-time Magic Token. Client presents it.
    install({ Email: 'u@example.com', 'Session Active': true, 'Magic Token': magic });
    const r = res();
    await handler(dataReq('u@example.com', magic), r);
    expect(r.statusCode).toBe(401);
    expect(db.listPaymentsByEmail).not.toHaveBeenCalled();
  });
});
