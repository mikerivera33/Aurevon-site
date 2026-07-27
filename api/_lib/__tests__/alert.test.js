/**
 * Alert sink behavior. Must be a safe no-op when unconfigured, must never throw
 * into a caller, and must not require any env beyond ALERT_WEBHOOK_URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendAlert } from '../alert.js';

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });
beforeEach(() => vi.clearAllMocks());

describe('sendAlert', () => {
  it('is a no-op when ALERT_WEBHOOK_URL is unset (never calls fetch)', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await sendAlert('stripe.mint_failed', { sessionId: 'cs_1' });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a Slack-compatible payload with event + detail when configured', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/abc';
    let sent;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true }; }));
    const res = await sendAlert('reconcile.errors', { count: 3 });
    expect(res.ok).toBe(true);
    expect(sent.url).toBe('https://hooks.example.com/abc');
    expect(sent.body.text).toContain('reconcile.errors');
    expect(sent.body.text).toContain('count=3');
    expect(sent.body.event).toBe('reconcile.errors');
    expect(sent.body.detail).toEqual({ count: 3 });
  });

  it('swallows send failures and returns an error result instead of throwing', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/abc';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const res = await sendAlert('paypal.mint_failed', { txnId: 'pp_1' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('network down');
  });
});
