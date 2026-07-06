/**
 * HTML-injection regression for transactional email templates (finding L4).
 *
 * customerName (and other caller / payment-provider-supplied fields) were
 * interpolated into email HTML with no escaping. Mail clients don't run JS, so
 * this isn't script-XSS, but unescaped markup enables phishing-content injection
 * (fake buttons/links, forged branding). Fix: HTML-escape all user-controlled
 * interpolated values.
 */
import { describe, it, expect } from 'vitest';
import { buildEmailHTML } from '../../email/send.js';
import { buildNftDeliveryHtml, buildPurchaseConfirmHtml } from '../email.js';

const PAYLOAD = `<b>x</b>"'&`;
const ESCAPED = '&lt;b&gt;x&lt;/b&gt;';

describe('email HTML escaping (L4)', () => {
  it('escapes customerName in the pass confirmation email (send.js)', () => {
    const html = buildEmailHTML('INSIDER', PAYLOAD, 'https://x/portal', null);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain(ESCAPED);
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  it('falls back to "Member" when customerName is empty (behavior preserved)', () => {
    const html = buildEmailHTML('INSIDER', '', 'https://x/portal', null);
    expect(html).toContain('Member');
  });

  it('escapes the customerName-derived name and nftType in the NFT delivery email (email.js)', () => {
    const html = buildNftDeliveryHtml({
      customerName: `${PAYLOAD} Smith`,
      nftType: '<i>evil</i>',
      mintId: 'mint_123',
      nftImageUrl: null,
      discordInviteUrl: null,
      tier: 'full',
      serial: null,
      edition: null,
    });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain('<i>evil</i>');
    expect(html).toContain('&lt;i&gt;evil&lt;/i&gt;');
  });

  it('escapes customerName in the purchase confirmation email (email.js)', () => {
    const html = buildPurchaseConfirmHtml({ customerName: PAYLOAD, tier: 'single' });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain(ESCAPED);
  });
});
