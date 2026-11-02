/**
 * HTTP contract for POST /api/intake/verify — method gate + body mapping.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../intake-verify.js', () => ({
  verifyIntakePayment: vi.fn(),
}));

import handler from '../../intake/verify.js';
import { verifyIntakePayment } from '../intake-verify.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('POST /api/intake/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-POST', async () => {
    const res = mockRes();
    await handler({ method: 'GET', body: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(verifyIntakePayment).not.toHaveBeenCalled();
  });

  it('does not pass a client paid_ token through to the verifier', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: false, status: 400, error: 'missing_id' });
    const res = mockRes();
    await handler({ method: 'POST', body: { token: 'paid_full_abc123xyz' } }, res);
    expect(verifyIntakePayment).toHaveBeenCalledWith({ sessionId: undefined, txnId: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns ok + tier on a verified Stripe session', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 're_full', method: 'stripe' });
    const res = mockRes();
    await handler({ method: 'POST', body: { sessionId: 'cs_test_abc123' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, tier: 're_full', method: 'stripe' });
  });
});
