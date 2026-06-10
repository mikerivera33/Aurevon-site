/**
 * Regression for POST /api/stripe/checkout promo + cancelPath handling.
 *
 * Guards three behaviours wired for the RE page:
 *   1. A specific promoCode is resolved and auto-applied as a discount.
 *   2. An unknown/empty promoCode falls back to allow_promotion_codes:true
 *      (never both — they're mutually exclusive in the Stripe API).
 *   3. cancelPath is honored only when it's a safe same-origin relative path
 *      (open-redirect guard), otherwise the per-tier default is used.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the params passed to sessions.create, and control promotionCodes.list.
const created = [];
const listMock = vi.fn();
vi.mock('stripe', () => {
  return {
    default: class StripeMock {
      constructor() {
        this.checkout = { sessions: { create: async (p) => { created.push(p); return { url: 'https://stripe.test/cs_1' }; } } };
        this.promotionCodes = { list: listMock };
      }
    },
  };
});

import handler from '../../stripe/checkout.js';

function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const SAVED = { ...process.env };

describe('stripe checkout promo + cancelPath', () => {
  beforeEach(() => {
    created.length = 0;
    listMock.mockReset();
    process.env = { ...SAVED, STRIPE_SECRET_KEY: 'sk_test_x', BASE_URL: 'https://www.aurevonvc.com' };
  });

  it('auto-applies a resolved promotion code (no allow_promotion_codes)', async () => {
    listMock.mockResolvedValue({ data: [{ id: 'promo_123' }] });
    const res = mockRes();
    await handler({ method: 'POST', body: { tier: 're_full', promoCode: 'LAUNCH20' } }, res);
    expect(res.statusCode).toBe(200);
    const p = created[0];
    expect(p.discounts).toEqual([{ promotion_code: 'promo_123' }]);
    expect(p.allow_promotion_codes).toBeUndefined();
  });

  it('falls back to allow_promotion_codes when the code is unknown', async () => {
    listMock.mockResolvedValue({ data: [] });
    const res = mockRes();
    await handler({ method: 'POST', body: { tier: 're_full', promoCode: 'NOPE' } }, res);
    expect(created[0].allow_promotion_codes).toBe(true);
    expect(created[0].discounts).toBeUndefined();
  });

  it('enables allow_promotion_codes when no code is supplied', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { tier: 're_full' } }, res);
    expect(created[0].allow_promotion_codes).toBe(true);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('honors a safe same-origin cancelPath', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { tier: 're_full', cancelPath: '/aurevon-re?step=2' } }, res);
    expect(created[0].cancel_url).toBe('https://www.aurevonvc.com/aurevon-re?step=2');
  });

  it('rejects an open-redirect cancelPath and uses the default', async () => {
    const res = mockRes();
    await handler({ method: 'POST', body: { tier: 're_full', cancelPath: '//evil.com' } }, res);
    expect(created[0].cancel_url).toBe('https://www.aurevonvc.com/aurevon-re');
  });
});
