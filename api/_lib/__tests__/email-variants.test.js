/**
 * NFT delivery email variants (pending vs minted), display names, deal-intake
 * link, send-failure contract and the unsigned-Discord-link alert.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../alert.js', () => ({ sendAlert: vi.fn() }));

import { sendAlert } from '../alert.js';
import {
  buildNftDeliveryHtml,
  buildNftDeliveryText,
  buildPurchaseConfirmHtml,
  sendNftDelivery,
  sendPurchaseConfirmation,
  sendDiscordAccessLink,
  discordLinkIsSigned,
} from '../email.js';

const SAVED = { ...process.env };
const INTAKE = 'https://www.aurevonvc.com/aurevon-re-intake.html';

let fetchMock;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.STATE_SECRET = 'test-state-secret';
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'email_1' }), text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.unstubAllGlobals();
});

const BASE = {
  customerName: 'Pat Doe',
  mintId: 'mint_abc',
  nftImageUrl: null,
  discordInviteUrl: 'https://discord.gg/plain',
  discordAccessUrl: 'https://www.aurevonvc.com/api/discord?action=auth&token=t',
  serial: null,
  edition: null,
};

describe('pending variant', () => {
  const opts = { ...BASE, status: 'pending', nftType: 'Aurevon Ember', tier: 're_retainer' };

  it('html has no minted claim, Mint ID, art or Discord CTA', () => {
    const html = buildNftDeliveryHtml(opts);
    expect(html).toContain('Payment received.');
    expect(html).toContain('Your Aurevon Ember is being minted. A second email with your Discord link arrives within 24 hours.');
    expect(html).not.toMatch(/has been minted|is minted/i);
    expect(html).not.toContain('Mint ID');
    expect(html).not.toContain('CONNECT DISCORD');
    expect(html).not.toContain('NFT Image Loading');
    expect(html).not.toContain('action=auth');
    expect(html).toContain('mike@aurevonvc.com');
  });

  it('text mirrors the html facts', () => {
    const text = buildNftDeliveryText(opts);
    expect(text).toContain('Payment received.');
    expect(text).toContain('Your Aurevon Ember is being minted. A second email with your Discord link arrives within 24 hours.');
    expect(text).not.toMatch(/has been minted|is minted/i);
    expect(text).not.toContain('Mint ID');
    expect(text).not.toContain('Discord and unlock');
    expect(text).not.toContain('discord.gg');
    expect(text).toContain('mike@aurevonvc.com');
  });

  it('send uses the "Payment received" subject and no Discord link', async () => {
    const res = await sendNftDelivery({ email: 'p@example.com', ...opts, mintId: 'pending', transactionId: 'cs_test_1' });
    expect(res).toEqual({ ok: true, id: 'email_1' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toBe('Payment received: your Aurevon Ember is being finalized');
    expect(body.subject.startsWith('Payment received')).toBe(true);
    expect(body.html).not.toContain('Mint ID');
    expect(body.html).not.toContain('CONNECT DISCORD');
    expect(body.text).not.toContain('Mint ID');
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('minted variant', () => {
  it('shows the NFT name, not a raw "TIER: RE" pill', () => {
    const html = buildNftDeliveryHtml({ ...BASE, nftType: 'Aurevon Ember', tier: 're_retainer' });
    expect(html).toContain('Aurevon Ember');
    expect(html).not.toMatch(/TIER: RE/i);
    expect(html).not.toMatch(/Tier:/);
    expect(html).toContain('Mint ID');
    expect(html).toContain('CONNECT DISCORD');
  });

  it.each(['Aurevon Insider', 'Aurevon Ember', 'Aurevon Obsidian Executive'])('underwriting NFT %s links to deal intake', (nftType) => {
    const html = buildNftDeliveryHtml({ ...BASE, nftType });
    const text = buildNftDeliveryText({ ...BASE, nftType });
    expect(html).toContain('Submit your deal');
    expect(html).toContain(INTAKE);
    expect(text).toContain('Submit your deal');
    expect(text).toContain(INTAKE);
  });

  it('appends session_id only for a Stripe cs_ transaction id', () => {
    const stripe = buildNftDeliveryHtml({ ...BASE, nftType: 'Aurevon Insider', transactionId: 'cs_test_abc' });
    expect(stripe).toContain(`${INTAKE}?session_id=cs_test_abc`);
    const paypal = buildNftDeliveryHtml({ ...BASE, nftType: 'Aurevon Insider', transactionId: '8AB12345CD678901E' });
    expect(paypal).toContain(INTAKE);
    expect(paypal).not.toContain('session_id=');
  });

  it('a PayPal txn id adds ?txn_id=; a manual mint id adds nothing', () => {
    const paypal = buildNftDeliveryHtml({ ...BASE, nftType: 'Aurevon Insider', transactionId: '8AB12345CD678901E' });
    expect(paypal).toContain(`${INTAKE}?txn_id=8AB12345CD678901E`);
    const manual = buildNftDeliveryHtml({ ...BASE, nftType: 'Aurevon Insider', transactionId: 'manual-1b2c3d4e-0000-4000-8000-000000000000' });
    expect(manual).toContain(`${INTAKE}"`);
    expect(manual).not.toMatch(/txn_id=|session_id=/);
  });

  it.each(['001 Genesis', '004 Chrome'])('community NFT %s has no intake link', (nftType) => {
    const html = buildNftDeliveryHtml({ ...BASE, nftType });
    expect(html).not.toContain('aurevon-re-intake');
    expect(html).not.toContain('Submit your deal');
    expect(buildNftDeliveryText({ ...BASE, nftType })).not.toContain('aurevon-re-intake');
  });

  it('edition guard treats undefined like null', () => {
    const html = buildNftDeliveryHtml({ ...BASE, nftType: '001 Genesis', edition: undefined });
    expect(html).not.toContain('#und');
    expect(html).not.toContain('Edition');
    const withEd = buildNftDeliveryHtml({ ...BASE, nftType: '001 Genesis', edition: 7 });
    expect(withEd).toContain('#007');
  });

  it('existing webhook call shape (no status) still sends the minted email', async () => {
    const res = await sendNftDelivery({ email: 'm@example.com', customerName: 'Pat', nftType: '004 Chrome', mintId: 'mint_1', nftImageUrl: null, discordInviteUrl: null, tier: 'comm_lifetime', serial: 'CHROME_014', edition: null });
    expect(res).toEqual({ ok: true, id: 'email_1' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toBe('Your 004 Chrome #014 is here — Welcome to Aurevon');
    expect(body.html).toContain('action=auth&token=');
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('purchase confirmation display names', () => {
  it('re_bogo renders the friendly name', () => {
    const html = buildPurchaseConfirmHtml({ customerName: 'Pat', tier: 're_bogo' });
    expect(html).toContain('First-Timer BOGO');
    expect(html).not.toContain('RE_BOGO');
  });

  it('an unknown / missing / unmapped tier reads "your purchase", never UNKNOWN or a raw key', () => {
    for (const tier of ['unknown', undefined, '', 'deal']) {
      const html = buildPurchaseConfirmHtml({ customerName: 'Pat', tier });
      expect(html).toContain('your purchase');
      expect(html).not.toMatch(/UNKNOWN|>DEAL</);
    }
  });

  it('re_single renders "Second Opinion"', () => {
    expect(buildPurchaseConfirmHtml({ customerName: 'Pat', tier: 're_single' })).toContain('Second Opinion');
  });

  it('underwriting tiers get the Submit your deal button; add-ons do not', () => {
    const uw = buildPurchaseConfirmHtml({ customerName: 'Pat', tier: 're_bogo', transactionId: 'cs_live_9' });
    expect(uw).toContain('Submit your deal');
    expect(uw).toContain(`${INTAKE}?session_id=cs_live_9`);
    expect(uw).not.toContain('intake form');
    const addon = buildPurchaseConfirmHtml({ customerName: 'Pat', tier: 'addon_rush' });
    expect(addon).not.toContain('Submit your deal');
  });

  it('a PayPal purchase confirmation links the intake form with ?txn_id=', () => {
    const pp = buildPurchaseConfirmHtml({ customerName: 'Pat', tier: 'single', transactionId: '5TY12345AB678901C' });
    expect(pp).toContain(`${INTAKE}?txn_id=5TY12345AB678901C`);
  });
});

describe('send failures throw', () => {
  it('Resend 500 rejects', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '{"message":"internal"}' });
    await expect(sendNftDelivery({ email: 'x@example.com', ...BASE, nftType: '004 Chrome' })).rejects.toThrow('Resend 500: internal');
  });

  it('network error rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(sendNftDelivery({ email: 'x@example.com', ...BASE, nftType: '004 Chrome' })).rejects.toThrow('ECONNRESET');
  });

  it('missing RESEND_API_KEY rejects', async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendNftDelivery({ email: 'x@example.com', ...BASE, nftType: '004 Chrome' })).rejects.toThrow('Missing RESEND_API_KEY');
  });
});

describe('Discord access-link email (final fix 8)', () => {
  it('the CONNECT DISCORD button text on the blue gradient is white', async () => {
    await expect(sendDiscordAccessLink({ email: 'member@example.com' })).resolves.toEqual({ ok: true, id: 'email_1' });
    const { html } = JSON.parse(fetchMock.mock.calls[0][1].body);
    const button = html.match(/<a [^>]*>CONNECT DISCORD/)[0];
    expect(button).toContain('linear-gradient(90deg,#1E3A8A,#3B82F6)');
    expect(button).toContain('color:#FFFFFF');
    expect(button).not.toContain('color:#0A0A0A');
  });
});

describe('unsigned Discord link', () => {
  it('discordLinkIsSigned', () => {
    expect(discordLinkIsSigned('https://www.aurevonvc.com/api/discord?action=auth&token=abc')).toBe(true);
    expect(discordLinkIsSigned('https://discord.gg/plain')).toBe(false);
    expect(discordLinkIsSigned(null)).toBe(false);
  });

  it('alerts when STATE_SECRET is unset and the plain invite is used', async () => {
    delete process.env.STATE_SECRET;
    await sendNftDelivery({ email: 'x@example.com', ...BASE, nftType: '004 Chrome' });
    expect(sendAlert).toHaveBeenCalledWith(
      'delivery.discord_link_unsigned',
      { reason: 'STATE_SECRET unset' },
      { severity: 'high', dedupeKey: 'state_secret' },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.html).toContain('https://discord.gg/plain');
  });
});
