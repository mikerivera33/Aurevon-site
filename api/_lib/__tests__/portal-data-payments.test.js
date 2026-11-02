/**
 * Portal data must look up Payments by 'Customer Email'.
 *
 * handleAuth already queries that field (add-on-only buyers have a Payments
 * row and no Members/NFT row). handleData used to reuse the Members/NFT
 * `{Email}` formula against Payments, so a successful login still returned
 * payments: [] — empty history and zero pending-deliverable stats.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../portal/data.js';

const AUTH = process.env.AIRTABLE_TABLE_CUSTOMER_AUTH ?? 'tblbCS7TL65FcOiWn';
const PAYMENTS = process.env.AIRTABLE_TABLE_PAYMENTS ?? 'tbl6KlhM9fIH19W5i';
const MEMBERS = process.env.AIRTABLE_TABLE_MEMBERS ?? 'tblYPn7hxnrgH723B';
const NFTS = process.env.AIRTABLE_TABLE_NFT_MINTS ?? 'tbliXEGJdoEIAJU06';
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

function installFetch({ paymentRows = [] } = {}) {
  const token = `${Date.now().toString(36)}.${RAND}`;
  const calls = { paymentQuery: null, nftQuery: null, memberQuery: null, token };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.includes(AUTH)) {
      return {
        ok: true,
        json: async () => ({
          records: [{
            id: 'recAuth',
            fields: {
              Email: 'addon@example.com',
              'Session Active': true,
              'Session Token': token,
            },
          }],
        }),
      };
    }
    if (url.includes(PAYMENTS)) {
      calls.paymentQuery = decodeURIComponent(url);
      return { ok: true, json: async () => ({ records: paymentRows }) };
    }
    if (url.includes(NFTS)) {
      calls.nftQuery = decodeURIComponent(url);
      return { ok: true, json: async () => ({ records: [] }) };
    }
    if (url.includes(MEMBERS)) {
      calls.memberQuery = decodeURIComponent(url);
      return { ok: true, json: async () => ({ records: [] }) };
    }
    return { ok: true, json: async () => ({ records: [] }) };
  }));
  return calls;
}

describe('portal data Payments field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AIRTABLE_PAT = 'pat_test';
    process.env.AIRTABLE_BASE_ID = 'app_test';
  });

  it('queries Payments by Customer Email and returns those rows', async () => {
    const calls = installFetch({
      paymentRows: [{
        id: 'p1',
        fields: {
          'Customer Email': 'addon@example.com',
          'Service Product': '12-Hour Rush',
          Amount: 99,
          Status: 'paid',
          'Deliverable Status': 'In Progress',
        },
      }],
    });
    const r = res();
    await handler(dataReq('addon@example.com', calls.token), r);

    expect(r.statusCode).toBe(200);
    const paymentQuery = calls.paymentQuery.replace(/\+/g, ' ');
    expect(paymentQuery).toContain('Customer Email');
    expect(paymentQuery).not.toMatch(/LOWER\(\{Email\}\)/);
    expect(calls.nftQuery.replace(/\+/g, ' ')).toContain('{Email}');
    expect(calls.memberQuery.replace(/\+/g, ' ')).toContain('{Email}');
    expect(r.body.payments).toHaveLength(1);
    expect(r.body.payments[0].serviceProduct).toBe('12-Hour Rush');
    expect(r.body.summary.totalPayments).toBe(1);
    expect(r.body.summary.pendingDeliverables).toBe(1);
  });
});
