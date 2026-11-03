/**
 * POST /api/intake/submit — payment re-verification, input cleaning, lead write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../intake-verify.js', () => ({
  verifyIntakePayment: vi.fn(),
}));
vi.mock('../db.js', () => ({
  createLead: vi.fn(),
  listLeadsByPaymentToken: vi.fn(),
}));

import handler, { parsePrice, clean } from '../../intake/submit.js';
import { verifyIntakePayment } from '../intake-verify.js';
import { createLead, listLeadsByPaymentToken } from '../db.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const baseBody = {
  sessionId: 'cs_test_abc123',
  full_name: '  Jane Investor ',
  email: ' Jane@Example.COM ',
  phone: '(555) 555-1234',
  company: 'Acme Capital LLC',
  tier: 're_full',
  plan: 'Full Package ($250)',
  property_address: '123 Main St, Yeadon, PA 19050',
  purchase_price: '$1,250,000',
  asset_type: 'Multifamily',
  hold_period: '5–7 years',
  deal_summary: '24 units, value-add.',
  addons: ['12-Hour Rush ($99)', 'Investor Memo ($149)'],
  promo_code: 'aurevonfam',
};

describe('POST /api/intake/submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLeadsByPaymentToken.mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('rejects non-POST without verifying or writing', async () => {
    const res = mockRes();
    await handler({ method: 'GET', body: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(verifyIntakePayment).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });

  it('refuses to write a lead when the payment does not verify', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: false, status: 402, error: 'unpaid' });
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    expect(verifyIntakePayment).toHaveBeenCalledWith({ sessionId: 'cs_test_abc123', txnId: undefined });
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ ok: false, error: 'payment_not_verified' });
    expect(createLead).not.toHaveBeenCalled();
  });

  it('refuses a non-underwriting purchase (403 from the verifier)', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: false, status: 403, error: 'not_intake_purchase' });
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, sessionId: undefined, txnId: 'ABCDEF123456' } }, res);
    expect(verifyIntakePayment).toHaveBeenCalledWith({ sessionId: undefined, txnId: 'ABCDEF123456' });
    expect(res.statusCode).toBe(403);
    expect(createLead).not.toHaveBeenCalled();
  });

  it('writes a cleaned lead with canonical field names', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 're_full', method: 'stripe' });
    createLead.mockResolvedValueOnce({ id: 'uuid-1', fields: {} });
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(createLead).toHaveBeenCalledWith({
      'Name': 'Jane Investor',
      'Email': 'jane@example.com',
      'Phone': '(555) 555-1234',
      'Company': 'Acme Capital LLC',
      'Tier': 're_full',
      'Source': 'Deal intake',
      'Status': 'New',
      'Property Address': '123 Main St, Yeadon, PA 19050',
      'Purchase Price': 1250000,
      'Asset Type': 'Multifamily',
      'Hold Period': '5–7 years',
      'Deal Summary': '24 units, value-add.',
      'Add-ons': '12-Hour Rush ($99), Investor Memo ($149)',
      'Promo Code': 'AUREVONFAM',
      'Payment Token': 'cs_test_abc123',
    });
  });

  it('prefers the verified tier over the tier the page sent', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 'bogo', method: 'paypal' });
    createLead.mockResolvedValueOnce({ id: 'uuid-2', fields: {} });
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, sessionId: undefined, txnId: 'ABCDEF123456', tier: 're_enterprise' } }, res);
    expect(res.statusCode).toBe(200);
    const fields = createLead.mock.calls[0][0];
    expect(fields['Tier']).toBe('bogo');
    expect(fields['Payment Token']).toBe('ABCDEF123456');
  });

  it('falls back to plan when the verifier returns no tier', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: null, method: 'stripe' });
    createLead.mockResolvedValueOnce({ id: 'uuid-3', fields: {} });
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, tier: '' } }, res);
    expect(createLead.mock.calls[0][0]['Tier']).toBe('Full Package ($250)');
  });

  it('caps long inputs and drops non-string values', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 'full', method: 'stripe' });
    createLead.mockResolvedValueOnce({ id: 'uuid-4', fields: {} });
    const res = mockRes();
    await handler({
      method: 'POST',
      body: {
        ...baseBody,
        deal_summary: 'x'.repeat(20000),
        company: { $ne: 1 },
        addons: Array.from({ length: 30 }, (_, i) => `addon-${i}`),
        purchase_price: 'about a million',
      },
    }, res);
    const fields = createLead.mock.calls[0][0];
    expect(fields['Deal Summary']).toHaveLength(5000);
    expect(fields['Company']).toBe('');
    expect(fields['Add-ons'].split(', ')).toHaveLength(12);
    expect(fields['Purchase Price']).toBeNull();
  });

  it('rejects a missing name or malformed email after verification', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 'full', method: 'stripe' });
    const res = mockRes();
    await handler({ method: 'POST', body: { ...baseBody, email: 'not-an-email' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_input' });
    expect(createLead).not.toHaveBeenCalled();
  });

  it('returns a generic 500 when the database write fails', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 'full', method: 'stripe' });
    createLead.mockRejectedValueOnce(new Error('Supabase insert leads: relation "leads" secret detail'));
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'submit_failed' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('returns a generic 500 when verification throws', async () => {
    verifyIntakePayment.mockRejectedValueOnce(new Error('stripe exploded'));
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'submit_failed' });
    expect(createLead).not.toHaveBeenCalled();
  });
});

describe('intake submit helpers', () => {
  it('parsePrice handles common formats', () => {
    expect(parsePrice('$1,250,000')).toBe(1250000);
    expect(parsePrice('950000.50')).toBe(950000.5);
    expect(parsePrice(400000)).toBe(400000);
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('1.2M')).toBeNull();
    expect(parsePrice('-5')).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
  });

  it('clean trims, caps and ignores objects', () => {
    expect(clean('  hi  ')).toBe('hi');
    expect(clean('abcdef', 3)).toBe('abc');
    expect(clean({ a: 1 })).toBe('');
    expect(clean(null)).toBe('');
  });

  it('treats a repeat of the same deal for the same payment as already saved', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 'full', method: 'stripe' });
    listLeadsByPaymentToken.mockResolvedValueOnce([
      { id: 'l1', fields: { 'Property Address': '123 main st, yeadon, pa 19050', 'Email': 'jane@example.com' } },
    ]);
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, duplicate: true });
    expect(createLead).not.toHaveBeenCalled();
  });

  it('caps leads per payment per day', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 'retainer', method: 'stripe' });
    listLeadsByPaymentToken.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, fields: { 'Property Address': `${i} Other St`, 'Email': 'jane@example.com' } })),
    );
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    expect(res.statusCode).toBe(429);
    expect(createLead).not.toHaveBeenCalled();
  });

  it('a second, different deal on the same payment (BOGO) is saved', async () => {
    verifyIntakePayment.mockResolvedValueOnce({ ok: true, tier: 'bogo', method: 'stripe' });
    listLeadsByPaymentToken.mockResolvedValueOnce([
      { id: 'l1', fields: { 'Property Address': '9 Elm Ave', 'Email': 'jane@example.com' } },
    ]);
    createLead.mockResolvedValueOnce({ id: 'uuid-3', fields: {} });
    const res = mockRes();
    await handler({ method: 'POST', body: baseBody }, res);
    expect(res.statusCode).toBe(200);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
});
