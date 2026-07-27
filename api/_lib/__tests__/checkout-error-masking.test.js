/**
 * POST /api/stripe/checkout must not leak internal error detail to the client.
 *
 * The endpoint is unauthenticated. On failure it previously returned
 * `{ error: err.message }`, echoing Stripe SDK internals / env-config state to
 * any caller. It now logs the real reason server-side and returns a fixed,
 * generic message. This guards against a regression back to err.message.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Make sessions.create throw so we hit the catch block. The message is
// deliberately distinctive so we can assert it does NOT appear in the response.
const SECRET_DETAIL = 'No such price: price_secret_internal_id';
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.checkout = { sessions: { create: async () => { throw new Error(SECRET_DETAIL); } } };
      this.promotionCodes = { list: vi.fn().mockResolvedValue({ data: [] }) };
    }
  },
}));

import handler from '../../stripe/checkout.js';

function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const SAVED = { ...process.env };

describe('stripe checkout error masking', () => {
  beforeEach(() => {
    process.env = { ...SAVED, STRIPE_SECRET_KEY: 'sk_test_x', BASE_URL: 'https://www.aurevonvc.com' };
  });

  it('returns a generic 500 and never echoes the underlying error message', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { tier: 're_full' } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Unable to start checkout. Please try again or contact mike@aurevonvc.com.');
    // The raw Stripe detail must not reach the client.
    expect(JSON.stringify(res.body)).not.toContain(SECRET_DETAIL);
    expect(JSON.stringify(res.body)).not.toContain('price_secret');
  });
});
