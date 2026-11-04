import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../webhooks/stripe.js', () => ({ default: vi.fn() }));
vi.mock('../../webhooks/paypal.js', () => ({ default: vi.fn() }));
vi.mock('../../webhooks/crossmint.js', () => ({ default: vi.fn() }));

import stripeHandler from '../../webhooks/stripe.js';
import paypalHandler from '../../webhooks/paypal.js';
import crossmintHandler from '../../webhooks/crossmint.js';
import router, { config } from '../../webhooks/index.js';

function mkRes() {
  const res = { statusCode: null, body: null };
  res.status = vi.fn((c) => { res.statusCode = c; return res; });
  res.json = vi.fn((b) => { res.body = b; return res; });
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe('webhooks router', () => {
  it('rejects non-POST with 405 and calls no handler', () => {
    const res = mkRes();
    router({ method: 'GET', query: { provider: 'stripe' } }, res);
    expect(res.statusCode).toBe(405);
    for (const h of [stripeHandler, paypalHandler, crossmintHandler]) expect(h).not.toHaveBeenCalled();
  });

  it('returns 400 with the valid list when provider is missing', () => {
    const res = mkRes();
    router({ method: 'POST', query: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.valid).toEqual(['stripe', 'paypal', 'crossmint']);
  });

  it('returns 400 for an unknown provider', () => {
    const res = mkRes();
    router({ method: 'POST', query: { provider: 'nope' } }, res);
    expect(res.statusCode).toBe(400);
    for (const h of [stripeHandler, paypalHandler, crossmintHandler]) expect(h).not.toHaveBeenCalled();
  });

  it.each([
    ['stripe', stripeHandler],
    ['paypal', paypalHandler],
    ['crossmint', crossmintHandler],
  ])('delegates %s to exactly its handler with (req, res)', (provider, handler) => {
    const req = { method: 'POST', query: { provider } };
    const res = mkRes();
    router(req, res);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(req, res);
    for (const h of [stripeHandler, paypalHandler, crossmintHandler]) {
      if (h !== handler) expect(h).not.toHaveBeenCalled();
    }
  });

  it('disables the body parser so providers read the raw stream', () => {
    expect(config.api.bodyParser).toBe(false);
  });
});
