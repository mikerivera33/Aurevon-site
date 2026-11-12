/**
 * Manual mint reply — POST /api/member/claim?action=mint.
 *
 * A manual mint with no `transactionId` runs under a generated `manual-<uuid>`
 * key. The reply now carries that key and whether the mint row was recorded,
 * so an operator can repeat the call with the SAME key (the Crossmint PUT is
 * idempotent) instead of minting a second token under a new one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../fulfil.js', async (orig) => ({ ...(await orig()), fulfilNft: vi.fn() }));

import handler from '../../member/claim.js';
import { fulfilNft } from '../fulfil.js';

function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    setHeader() { return this; }, end() { return this; },
  };
}
const SECRET = 'super_secret_value_123456';
const mint = async (body) => {
  const res = mockRes();
  await handler({ method: 'POST', query: { action: 'mint' }, headers: { authorization: `Bearer ${SECRET}` }, body }, res);
  return res;
};

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });
beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.CROSSMINT_API_KEY = 'sk_test_crossmint';
});

describe('manual mint reply', () => {
  it('returns the generated transactionId and recorded:true when the row was written', async () => {
    fulfilNft.mockResolvedValueOnce({ minted: true, nftType: 'Aurevon Insider', serial: 'INSIDER_001', rowId: 'mint_1' });
    const res = await mint({ passType: 'INSIDER', recipientEmail: 'buyer@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, minted: true, recorded: true }));
    expect(res.body.transactionId).toMatch(/^manual-[0-9a-f-]{36}$/);
    expect(fulfilNft.mock.calls[0][0].transactionId).toBe(res.body.transactionId);
  });

  it('minted but the row was dropped: recorded:false and the key to repeat the call with', async () => {
    fulfilNft.mockResolvedValueOnce({ minted: true, nftType: 'Aurevon Insider', serial: 'INSIDER_002', rowId: null });
    const res = await mint({ passType: 'INSIDER', recipientEmail: 'buyer@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ minted: true, recorded: false }));
    expect(res.body.transactionId).toMatch(/^manual-/);
    expect(res.body.warning).toMatch(/same transactionId/);
  });

  it('echoes a caller-supplied transactionId, on a failed mint too', async () => {
    fulfilNft.mockResolvedValueOnce({ minted: false, nftType: 'Aurevon Insider', serial: null, rowId: 'mint_2' });
    const res = await mint({ passType: 'INSIDER', recipientEmail: 'buyer@example.com', transactionId: 'manual-fixed-1' });

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({ minted: false, transactionId: 'manual-fixed-1', recorded: true }));
  });
});
