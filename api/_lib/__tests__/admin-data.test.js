/**
 * Owner console API — /api/admin/data.
 *
 * It exposes every lead, payment, mint and member row, so it must:
 *   - fail CLOSED when ADMIN_SECRET is unset (nobody gets in),
 *   - reject a wrong / missing / byte-length-mismatched bearer,
 *   - only read the four allow-listed tables (no customer_auth: it holds session tokens),
 *   - only write lead Status / Notes / Analyst (everything else is pipeline-owned).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  listRecent: vi.fn(),
  updateRecord: vi.fn(),
}));

import handler from '../../admin/data.js';

const ID = '00000000-0000-4000-8000-000000000001';
import * as db from '../db.js';

const SECRET = 'admin_console_secret_0123456789';
const SAVED = { ...process.env };

function mockRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

async function call({ method = 'GET', query = {}, body, auth = `Bearer ${SECRET}` } = {}) {
  const res = mockRes();
  const headers = auth === null ? {} : { authorization: auth };
  await handler({ method, query, headers, body }, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...SAVED, ADMIN_SECRET: SECRET };
  db.listRecent.mockResolvedValue([{ id: 'l1', fields: { Name: 'Lead', Status: 'New' } }]);
  db.updateRecord.mockImplementation(async (_t, id, fields) => ({ id, fields }));
});
afterEach(() => { process.env = { ...SAVED }; });

describe('/api/admin/data auth', () => {
  it('fails closed (401, no DB access) when ADMIN_SECRET is unset — even with a bearer', async () => {
    delete process.env.ADMIN_SECRET;
    const res = await call({ query: { table: 'leads' }, auth: 'Bearer anything' });
    expect(res.statusCode).toBe(401);
    expect(db.listRecent).not.toHaveBeenCalled();
  });

  it('fails closed when ADMIN_SECRET is set to an empty string', async () => {
    process.env.ADMIN_SECRET = '';
    const res = await call({ query: { table: 'leads' }, auth: 'Bearer ' });
    expect(res.statusCode).toBe(401);
    expect(db.listRecent).not.toHaveBeenCalled();
  });

  it('rejects a wrong token', async () => {
    const res = await call({ query: { table: 'leads' }, auth: 'Bearer wrong-secret' });
    expect(res.statusCode).toBe(401);
    expect(db.listRecent).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header and a non-Bearer scheme', async () => {
    expect((await call({ query: { table: 'leads' }, auth: null })).statusCode).toBe(401);
    expect((await call({ query: { table: 'leads' }, auth: SECRET })).statusCode).toBe(401);
    expect(db.listRecent).not.toHaveBeenCalled();
  });

  it('rejects (without throwing) a token of equal string length but different byte length', async () => {
    const sameChars = `${SECRET.slice(0, -1)}é`; // same JS length, one more UTF-8 byte
    const res = await call({ query: { table: 'leads' }, auth: `Bearer ${sameChars}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bad PATCH before touching the database', async () => {
    const res = await call({ method: 'PATCH', query: { table: 'leads', id: ID }, body: { fields: { Status: 'Won' } }, auth: 'Bearer nope' });
    expect(res.statusCode).toBe(401);
    expect(db.updateRecord).not.toHaveBeenCalled();
  });

  it('marks every response no-store', async () => {
    const res = await call({ query: { table: 'leads' }, auth: 'Bearer nope' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('/api/admin/data tables', () => {
  it.each(['customer_auth', 'users', '', 'leads;drop'])('rejects unknown/unlisted table %j', async (table) => {
    const res = await call({ query: { table } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_table' });
    expect(db.listRecent).not.toHaveBeenCalled();
  });

  it.each(['leads', 'payments', 'nft_mints', 'members'])('GET %s returns records', async (table) => {
    const res = await call({ query: { table } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ records: [{ id: 'l1', fields: { Name: 'Lead', Status: 'New' } }], nextOffset: null });
    expect(db.listRecent).toHaveBeenCalledWith(table, { limit: 200, offset: 0 });
  });

  it('clamps ?limit to 1..1000', async () => {
    await call({ query: { table: 'leads', limit: '5000' } });
    await call({ query: { table: 'leads', limit: '-3' } });
    await call({ query: { table: 'leads', limit: '25' } });
    expect(db.listRecent.mock.calls.map(([, o]) => o.limit)).toEqual([1000, 1, 25]);
  });

  it('a database error returns a generic 500 without leaking the message', async () => {
    db.listRecent.mockRejectedValueOnce(new Error('Supabase listRecent leads: permission denied for table leads'));
    const res = await call({ query: { table: 'leads' } });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'database_error' });
  });

  it('rejects other methods with 405', async () => {
    const res = await call({ method: 'DELETE', query: { table: 'leads', id: ID } });
    expect(res.statusCode).toBe(405);
  });
});

describe('/api/admin/data PATCH', () => {
  it('updates lead Status / Notes / Analyst', async () => {
    const fields = { Status: 'Qualified', Notes: 'Called back', Analyst: 'Mike' };
    const res = await call({ method: 'PATCH', query: { table: 'leads', id: ID }, body: { fields } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ record: { id: ID, fields } });
    expect(db.updateRecord).toHaveBeenCalledWith('leads', ID, fields);
  });

  it('refuses any other lead field (and names it), writing nothing', async () => {
    const res = await call({
      method: 'PATCH', query: { table: 'leads', id: ID },
      body: { fields: { Status: 'Won', Email: 'attacker@example.com', 'Payment Token': 'x' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('field_not_writable');
    expect(res.body.fields).toEqual(['Email', 'Payment Token']);
    expect(db.updateRecord).not.toHaveBeenCalled();
  });

  it.each(['payments', 'nft_mints', 'members'])('refuses PATCH on pipeline-owned table %s', async (table) => {
    const res = await call({ method: 'PATCH', query: { table, id: 'r1' }, body: { fields: { Status: 'Refunded' } } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'not_writable' });
    expect(db.updateRecord).not.toHaveBeenCalled();
  });

  it('requires an id', async () => {
    const res = await call({ method: 'PATCH', query: { table: 'leads' }, body: { fields: { Status: 'Won' } } });
    expect(res.statusCode).toBe(400);
    expect(db.updateRecord).not.toHaveBeenCalled();
  });
});

describe('/api/admin/data paging and ids', () => {
  beforeEach(() => { process.env.ADMIN_SECRET = 'admin_secret_for_tests_0123456789'; });
  const auth = { authorization: 'Bearer admin_secret_for_tests_0123456789' };
  const run = async (req) => { const res = mockRes(); await handler({ headers: auth, method: 'GET', query: {}, ...req }, res); return res; };

  it('returns nextOffset when a full page comes back', async () => {
    db.listRecent.mockResolvedValueOnce([{ id: 'a', fields: {} }, { id: 'b', fields: {} }]);
    const res = await run({ query: { table: 'leads', limit: '2', offset: '4' } });
    expect(db.listRecent).toHaveBeenCalledWith('leads', { limit: 2, offset: 4 });
    expect(res.body.nextOffset).toBe(6);
  });

  it('rejects a PATCH id that is not a UUID', async () => {
    const res = await run({ method: 'PATCH', query: { table: 'leads', id: 'l1' }, body: { fields: { Status: 'New' } } });
    expect(res.statusCode).toBe(400);
    expect(db.updateRecord).not.toHaveBeenCalled();
  });

  it('answers 404 when the row does not exist', async () => {
    db.updateRecord.mockRejectedValueOnce(Object.assign(new Error('no rows'), { code: 'PGRST116' }));
    const res = await run({ method: 'PATCH', query: { table: 'leads', id: ID }, body: { fields: { Status: 'New' } } });
    expect(res.statusCode).toBe(404);
  });
});
