/**
 * Portal data must look up Payments by 'Customer Email'.
 *
 * handleAuth already queries that field (add-on-only buyers have a Payments
 * row and no Members/NFT row). handleData used to reuse the Members/NFT
 * `{Email}` filter against Payments, so a successful login still returned
 * payments: [] — empty history and zero pending-deliverable stats.
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

/** CustomerAuth holds a fresh session for addon@example.com; Payments returns `paymentRows`. */
function install({ paymentRows = [] } = {}) {
  const token = `${Date.now().toString(36)}.${RAND}`;
  db.findCustomerAuth.mockResolvedValue({
    id: 'recAuth',
    fields: { Email: 'addon@example.com', 'Session Active': true, 'Session Token': token },
  });
  db.listPaymentsByEmail.mockResolvedValue(paymentRows);
  db.listMintsByEmail.mockResolvedValue([]);
  db.findMemberByEmail.mockResolvedValue(null);
  return { token };
}

describe('portal data Payments field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.dbConfigured.mockReturnValue(true);
  });

  it('queries Payments by Customer Email and returns those rows', async () => {
    const { token } = install({
      paymentRows: [{
        id: 'p1',
        fields: {
          'Customer Email': 'addon@example.com',
          'Pass Type': '12-Hour Rush',
          Amount: 99,
          Status: 'paid',
          'Deliverable Status': 'In Progress',
        },
      }],
    });
    const r = res();
    await handler(dataReq('Addon@Example.com', token), r);

    expect(r.statusCode).toBe(200);
    // Payments are looked up by the buyer's (normalized) email — listPaymentsByEmail
    // filters on customer_email (asserted in db.test.js); mints + member by email.
    expect(db.findCustomerAuth).toHaveBeenCalledWith('addon@example.com');
    expect(db.listPaymentsByEmail).toHaveBeenCalledWith('addon@example.com');
    expect(db.listMintsByEmail).toHaveBeenCalledWith('addon@example.com');
    expect(db.findMemberByEmail).toHaveBeenCalledWith('addon@example.com');
    expect(r.body.payments).toHaveLength(1);
    expect(r.body.payments[0].serviceProduct).toBe('12-Hour Rush');
    expect(r.body.payments[0].amount).toBe(99);
    expect(r.body.summary.totalPayments).toBe(1);
    expect(r.body.summary.pendingDeliverables).toBe(1);
  });

  it('does not read any customer data when the session is invalid', async () => {
    install();
    const r = res();
    await handler(dataReq('addon@example.com', `${Date.now().toString(36)}.${'b'.repeat(64)}`), r);

    expect(r.statusCode).toBe(401);
    expect(db.listPaymentsByEmail).not.toHaveBeenCalled();
    expect(db.listMintsByEmail).not.toHaveBeenCalled();
    expect(db.findMemberByEmail).not.toHaveBeenCalled();
  });
});
