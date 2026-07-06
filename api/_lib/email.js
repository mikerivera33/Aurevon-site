/**
 * Resend email client for Aurevon transactional emails.
 * All CSS is inline for email client compatibility.
 */

import { signDiscordAccessToken } from '../discord.js';

const RESEND_BASE_URL = 'https://api.resend.com';
const DOMAIN = process.env.DOMAIN ?? 'https://www.aurevonvc.com';

/**
 * Build the one-click Discord linking URL carrying a signed, email-bound,
 * expiring, single-use access token (H2). Possession of this URL — delivered only
 * to the member's inbox — is the proof of email ownership that /api/discord?action=auth
 * requires. Falls back to a plain (non-linking) URL only if signing is impossible
 * (STATE_SECRET unset) so the email still delivers.
 */
export function buildDiscordAccessUrl(email, fallbackUrl = null) {
  try {
    const token = signDiscordAccessToken(email);
    return `${DOMAIN}/api/discord?action=auth&token=${encodeURIComponent(token)}`;
  } catch (err) {
    console.error(`[email] Could not sign Discord access token: ${err.message}`);
    return fallbackUrl;
  }
}

/**
 * HTML-escape a user-controlled value before interpolating it into an email
 * template (L4). Prevents HTML/phishing-content injection via payment-provider
 * name fields and other caller-supplied text. Coerces null/undefined to ''.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getFromAddress() {
  const name = process.env.RESEND_FROM_NAME ?? 'Aurevon';
  const email = process.env.RESEND_FROM_EMAIL ?? 'mike@aurevonvc.com';
  return `${name} <${email}>`;
}

/**
 * Build the branded HTML email for NFT delivery.
 */
export function buildNftDeliveryHtml({ customerName, nftType, mintId, nftImageUrl, discordInviteUrl, discordAccessUrl, tier, serial, edition }) {
  // Prefer the tokenized one-click linking URL; fall back to a plain invite.
  const discordCtaUrl = discordAccessUrl ?? discordInviteUrl;
  // User/provider-controlled text fields — escape before interpolating into HTML.
  const firstName = escapeHtml(customerName?.split(' ')[0] ?? 'Operator');
  const tierLabel = escapeHtml(tier ? tier.toUpperCase().replace('_', ' ') : 'MEMBER');
  const safeNftType = escapeHtml(nftType);
  const safeMintId = escapeHtml(mintId);
  const safeSerial = escapeHtml(serial);
  const imageBlock = nftImageUrl
    ? `<img src="${nftImageUrl}" alt="${safeNftType} NFT" style="display:block;width:100%;max-width:380px;margin:0 auto 12px;border-radius:12px;border:1px solid rgba(59,130,246,0.25);" />`
    : `<div style="width:100%;max-width:380px;height:200px;margin:0 auto 12px;background:linear-gradient(135deg,#1a1206,#2a1c08);border-radius:12px;border:1px solid rgba(59,130,246,0.25);display:flex;align-items:center;justify-content:center;"><span style="color:#3B82F6;font-size:14px;font-family:sans-serif;">NFT Image Loading...</span></div>`;

  const serialBlock = serial
    ? `<div style="font-family:'Courier New',monospace;font-size:1.2rem;color:#3B82F6;letter-spacing:0.15em;text-align:center;margin:0.8rem 0;">${safeSerial}</div>`
    : '';

  const editionDisplay = edition !== null ? String(edition).padStart(3, '0') : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to Aurevon</title>
</head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;color:#d4d4d8;">
  <!-- Preheader -->
  <div style="display:none;max-height:0;overflow:hidden;color:#0A0A0A;">Your ${safeNftType} NFT has been minted and delivered. Welcome to the operator tier.</div>

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 16px;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#111827;border:1px solid rgba(59,130,246,0.18);border-radius:14px;overflow:hidden;">

          <!-- Header bar -->
          <tr>
            <td style="background:linear-gradient(90deg,#1E3A8A,#3B82F6);padding:3px 0;"></td>
          </tr>

          <!-- Logo row -->
          <tr>
            <td align="center" style="padding:36px 40px 20px;">
              <span style="font-family:'Archivo Black',Impact,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;background:linear-gradient(90deg,#1E3A8A,#3B82F6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:#1E3A8A;">Aurevon</span>
              <span style="display:block;font-size:11px;letter-spacing:3px;color:#6b6b70;margin-top:4px;text-transform:uppercase;">VENTURES</span>
            </td>
          </tr>

          <!-- Headline -->
          <tr>
            <td align="center" style="padding:0 40px 28px;">
              <h1 style="margin:0;font-family:'Archivo Black',Impact,sans-serif;font-size:32px;font-weight:900;line-height:1.15;background:linear-gradient(90deg,#1E3A8A,#3B82F6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:#1E3A8A;">
                Welcome to Aurevon.
              </h1>
              <p style="margin:12px 0 0;font-size:16px;color:#a1a1aa;line-height:1.5;">
                Your NFT is minted. Your access is live. Let's get to work.
              </p>
            </td>
          </tr>

          <!-- NFT Image -->
          <tr>
            <td align="center" style="padding:0 40px 4px;">
              ${imageBlock}
              ${serialBlock}
            </td>
          </tr>

          <!-- Tier badge -->
          <tr>
            <td align="center" style="padding:0 40px 28px;">
              <div style="display:inline-block;padding:8px 24px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.3);border-radius:999px;">
                <span style="font-size:12px;font-weight:700;letter-spacing:2px;color:#3B82F6;text-transform:uppercase;">Tier: ${tierLabel}</span>
              </div>
            </td>
          </tr>

          <!-- Body copy -->
          <tr>
            <td style="padding:0 40px 28px;">
              <p style="margin:0 0 16px;font-size:16px;color:#d4d4d8;line-height:1.6;">
                ${firstName}, you're now holding the <strong style="color:#3B82F6;">${safeNftType}</strong> — your proof-of-access on-chain. This NFT lives in your email wallet, no MetaMask required.
              </p>
              <p style="margin:0;font-size:15px;color:#a1a1aa;line-height:1.6;">
                Inside the Aurevon community you'll find deal flow, operator resources, and direct access to the team. No fluff. No noise.
              </p>
            </td>
          </tr>

          <!-- Mint details box -->
          <tr>
            <td style="padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px;">
                <tr>
                  <td style="padding:0 0 12px;">
                    <span style="font-size:11px;letter-spacing:2px;color:#52525b;text-transform:uppercase;font-weight:600;">NFT Details</span>
                  </td>
                </tr>
                <tr>
                  <td>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;">Token Name</td>
                        <td align="right" style="padding:6px 0;font-size:14px;color:#3B82F6;font-weight:600;">${safeNftType}</td>
                      </tr>
                      ${serial ? `
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Serial</td>
                        <td align="right" style="padding:6px 0;font-size:13px;color:#3B82F6;font-family:monospace;font-weight:600;letter-spacing:0.1em;border-top:1px solid rgba(255,255,255,0.05);">${safeSerial}</td>
                      </tr>` : ''}
                      ${editionDisplay ? `
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Edition</td>
                        <td align="right" style="padding:6px 0;font-size:14px;color:#a1a1aa;border-top:1px solid rgba(255,255,255,0.05);">#${editionDisplay} of &infin;</td>
                      </tr>` : ''}
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Mint ID</td>
                        <td align="right" style="padding:6px 0;font-size:13px;color:#a1a1aa;font-family:monospace;word-break:break-all;border-top:1px solid rgba(255,255,255,0.05);">${safeMintId}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Delivery</td>
                        <td align="right" style="padding:6px 0;font-size:14px;color:#a1a1aa;border-top:1px solid rgba(255,255,255,0.05);">Email wallet (custodial)</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Chain</td>
                        <td align="right" style="padding:6px 0;font-size:14px;color:#a1a1aa;border-top:1px solid rgba(255,255,255,0.05);">Base (Ethereum L2)</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Discord CTA -->
          ${discordCtaUrl ? `
          <tr>
            <td align="center" style="padding:0 40px 36px;">
              <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;text-align:center;">Click below to connect your Discord and unlock your role. Introductions go up in the first 24 hours.</p>
              <a href="${discordCtaUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(90deg,#1E3A8A,#3B82F6);border-radius:8px;font-family:'Archivo Black',Impact,sans-serif;font-size:15px;font-weight:900;color:#0A0A0A;text-decoration:none;letter-spacing:0.5px;box-shadow:0 8px 24px rgba(30,58,138,0.32);">
                CONNECT DISCORD &rarr;
              </a>
            </td>
          </tr>` : ''}

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <div style="height:1px;background:rgba(255,255,255,0.06);"></div>
            </td>
          </tr>

          <!-- Support row -->
          <tr>
            <td style="padding:24px 40px;">
              <p style="margin:0;font-size:13px;color:#52525b;line-height:1.6;">
                Questions? Reply to this email or reach us at <a href="mailto:mike@aurevonvc.com" style="color:#3B82F6;text-decoration:none;">mike@aurevonvc.com</a>. We respond within one business day.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0A0A0A;border-top:1px solid rgba(255,255,255,0.05);padding:20px 40px;text-align:center;">
              <p style="margin:0 0 6px;font-size:11px;color:#3f3f46;letter-spacing:1px;text-transform:uppercase;">Aurevon Ventures LLC &middot; 4129 Saltburn Dr, Plano, TX</p>
              <p style="margin:0;font-size:11px;color:#3f3f46;">
                You received this because you completed a purchase on aurevonvc.com.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Build plain-text fallback for NFT delivery email.
 */
function buildNftDeliveryText({ customerName, nftType, mintId, discordInviteUrl, discordAccessUrl, tier, serial, edition }) {
  const discordCtaUrl = discordAccessUrl ?? discordInviteUrl;
  const firstName = customerName?.split(' ')[0] ?? 'Operator';
  const tierLabel = tier ? tier.toUpperCase().replace('_', ' ') : 'MEMBER';
  const editionDisplay = edition !== null ? String(edition).padStart(3, '0') : null;

  return `Aurevon — NFT DELIVERY
================================

${firstName},

Your ${nftType} NFT has been minted and delivered to your email wallet.

Tier: ${tierLabel}
Token: ${nftType}
${serial ? `Serial: ${serial}\n` : ''}${editionDisplay ? `Edition: #${editionDisplay} of ∞\n` : ''}Mint ID: ${mintId}
Chain: Base (Ethereum L2)
Delivery: Email wallet (no wallet setup required)

${discordCtaUrl ? `Connect your Discord and unlock your role:\n${discordCtaUrl}\n` : ''}Questions? mike@aurevonvc.com

---
Aurevon Ventures LLC · 4129 Saltburn Dr, Plano, TX
You received this because you completed a purchase on aurevonvc.com.
`;
}

/**
 * Build a generic "thanks for your purchase" email (no NFT — e.g. Second Opinion tier).
 */
// Friendly customer-facing labels for tier/add-on identifiers
const TIER_DISPLAY_NAMES = {
  bogo:              'First-Timer BOGO — 2 Full Package Deals (no NFT)',
  single:            'Second Opinion — Underwriting + Analysis (no NFT)',
  full:              'Full Package — All 3 Documents + Aurevon Insider NFT (Tier 1)',
  retainer:          'Pro Retainer — Membership + Aurevon Ember NFT (Tier 2)',
  enterprise:        'Enterprise — Unlimited Deals + Aurevon Obsidian Executive NFT (Tier 3)',
  comm_monthly:      '001 Genesis Community Pass — Monthly Member',
  comm_lifetime:     '004 Chrome Community Pass — Lifetime Member',
  addon_rush:        '12-Hour Rush Delivery Add-On',
  addon_memo:        'Investor Memo Formatting Add-On',
  addon_lender:      'Lender Presentation Package Add-On',
  addon_sensitivity: 'Sensitivity Modeling Add-On',
  addon_portfolio:   'Portfolio Review Bundle Add-On',
  addon_whitelabel:  'White-Label Reports Add-On',
};

function tierDisplay(tier) {
  return TIER_DISPLAY_NAMES[tier] ?? (tier ?? '').toUpperCase();
}

export function buildPurchaseConfirmHtml({ customerName, tier }) {
  const firstName = escapeHtml(customerName?.split(' ')[0] ?? 'Client');
  const tierLabel = escapeHtml(tierDisplay(tier));
  const isAddon = (tier ?? '').startsWith('addon_');
  const heading = isAddon ? 'Add-On Confirmed.' : 'Purchase Confirmed.';
  const blurb = isAddon
    ? `${firstName}, your add-on payment has been received. It's now attached to your active deal — we'll fold it into your delivery.`
    : `${firstName}, your payment has been received. We'll be in touch within one business day with next steps and your intake form.`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>Purchase Confirmed — Aurevon</title></head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;color:#d4d4d8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#111827;border:1px solid rgba(59,130,246,0.18);border-radius:14px;overflow:hidden;">
        <tr><td style="background:linear-gradient(90deg,#1E3A8A,#3B82F6);padding:3px 0;"></td></tr>
        <tr>
          <td align="center" style="padding:36px 40px 20px;">
            <span style="font-family:'Archivo Black',Impact,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#1E3A8A;">Aurevon</span>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px;">
            <h1 style="margin:0 0 16px;font-family:'Archivo Black',Impact,sans-serif;font-size:28px;color:#3B82F6;">${heading}</h1>
            <p style="margin:0 0 16px;font-size:16px;color:#d4d4d8;line-height:1.6;">${blurb}</p>
            <p style="margin:0 0 12px;font-size:15px;color:#a1a1aa;">Item: <strong style="color:#3B82F6;">${tierLabel}</strong></p>
            <p style="margin:0;font-size:13px;color:#71717a;">Questions? Reply to this email, call <a href="tel:+18566938249" style="color:#3B82F6;text-decoration:none;">(856) 693-8249</a>, or visit <a href="https://www.aurevonvc.com" style="color:#3B82F6;text-decoration:none;">www.aurevonvc.com</a>.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#0A0A0A;border-top:1px solid rgba(255,255,255,0.05);padding:20px 40px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#3f3f46;">Aurevon Ventures LLC &middot; 4129 Saltburn Dr, Plano, TX</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a branded NFT delivery email via Resend.
 *
 * @param {{ email, customerName, nftType, mintId, nftImageUrl, discordInviteUrl, tier, serial, edition }} opts
 *   serial  — e.g. "EMBER_014" (displayed as monospace badge in the email)
 *   edition — numeric edition (e.g. 14); derived from serial when omitted
 */
export async function sendNftDelivery({ email, customerName, nftType, mintId, nftImageUrl, discordInviteUrl, tier, serial, edition }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Missing RESEND_API_KEY env var');

  // Derive edition from serial if not provided directly
  let resolvedEdition = edition;
  if (resolvedEdition === null && serial) {
    const parts = serial.split('_');
    if (parts[1]) resolvedEdition = parseInt(parts[1], 10);
  }
  const editionDisplay = resolvedEdition !== null ? String(resolvedEdition).padStart(3, '0') : null;

  const subject = editionDisplay
    ? `Your ${nftType} #${editionDisplay} is here — Welcome to Aurevon`
    : `Your ${nftType} NFT is live — Welcome to Aurevon`;

  // One-click Discord linking URL carrying the email-ownership token (H2). The
  // static DISCORD_INVITE_URL (if any) is only a fallback when signing is impossible.
  const discordAccessUrl = buildDiscordAccessUrl(email, discordInviteUrl);

  const payload = {
    from: getFromAddress(),
    to: [email],
    subject,
    html: buildNftDeliveryHtml({ customerName, nftType, mintId, nftImageUrl, discordInviteUrl, discordAccessUrl, tier, serial, edition: resolvedEdition }),
    text: buildNftDeliveryText({ customerName, nftType, mintId, discordInviteUrl, discordAccessUrl, tier, serial, edition: resolvedEdition }),
  };

  console.log(`[Resend] Sending NFT delivery email to ${email} — "${subject}"`);

  let response;
  try {
    response = await fetch(`${RESEND_BASE_URL}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Resend] Network error sending NFT delivery email:`, err.message);
    return { ok: false, error: err.message };
  }

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Resend] Send failed (${response.status}): ${errText}`);
    return { ok: false, error: `Resend send failed (${response.status}): ${errText}` };
  }

  const data = await response.json();
  console.log(`[Resend] Email sent. id=${data.id}`);
  return data;
}

/**
 * Send a generic purchase confirmation (no NFT) for tiers like 'single'.
 */
export async function sendPurchaseConfirmation({ email, customerName, tier }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Missing RESEND_API_KEY env var');

  const subject = (tier ?? '').startsWith('addon_')
    ? `Your Aurevon add-on (${tierDisplay(tier)}) is confirmed`
    : 'Your Aurevon purchase is confirmed';

  const payload = {
    from: getFromAddress(),
    to: [email],
    subject,
    html: buildPurchaseConfirmHtml({ customerName, tier }),
    text: `${customerName?.split(' ')[0] ?? 'Client'}, your payment has been received. We'll be in touch within one business day.\n\nItem: ${tierDisplay(tier)}\n\nQuestions? mike@aurevonvc.com · (856) 693-8249 · www.aurevonvc.com\n\n— Aurevon Ventures LLC`,
  };

  console.log(`[Resend] Sending purchase confirmation email to ${email}`);

  let response;
  try {
    response = await fetch(`${RESEND_BASE_URL}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Resend] Network error sending purchase confirmation email:`, err.message);
    return { ok: false, error: err.message };
  }

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Resend] Send failed (${response.status}): ${errText}`);
    return { ok: false, error: `Resend send failed (${response.status}): ${errText}` };
  }

  const data = await response.json();
  console.log(`[Resend] Confirmation email sent. id=${data.id}`);
  return data;
}

/**
 * Build the branded HTML for the Discord access-link email (claim-request flow).
 */
function buildDiscordAccessHtml(discordAccessUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Your Aurevon Discord Access Link</title></head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;color:#d4d4d8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#111827;border:1px solid rgba(59,130,246,0.18);border-radius:14px;overflow:hidden;">
        <tr><td style="background:linear-gradient(90deg,#1E3A8A,#3B82F6);padding:3px 0;"></td></tr>
        <tr><td align="center" style="padding:36px 40px 12px;">
          <span style="font-family:'Archivo Black',Impact,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#1E3A8A;">Aurevon</span>
        </td></tr>
        <tr><td style="padding:0 40px 24px;">
          <h1 style="margin:0 0 16px;font-family:'Archivo Black',Impact,sans-serif;font-size:26px;color:#3B82F6;">Your Discord access link</h1>
          <p style="margin:0 0 24px;font-size:16px;color:#d4d4d8;line-height:1.6;">Click below to connect your Discord account and unlock your member role. This secure link is tied to your email, expires soon, and can be used once.</p>
        </td></tr>
        <tr><td align="center" style="padding:0 40px 32px;">
          <a href="${discordAccessUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(90deg,#1E3A8A,#3B82F6);border-radius:8px;font-family:'Archivo Black',Impact,sans-serif;font-size:15px;font-weight:900;color:#0A0A0A;text-decoration:none;letter-spacing:0.5px;">CONNECT DISCORD &rarr;</a>
        </td></tr>
        <tr><td style="padding:0 40px 32px;">
          <p style="margin:0;font-size:13px;color:#52525b;line-height:1.6;">If you did not request this, you can safely ignore this email — no changes were made to your account.</p>
        </td></tr>
        <tr><td style="background:#0A0A0A;border-top:1px solid rgba(255,255,255,0.05);padding:20px 40px;text-align:center;">
          <p style="margin:0;font-size:11px;color:#3f3f46;">Aurevon Ventures LLC &middot; 4129 Saltburn Dr, Plano, TX</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send the Discord access link to a member's inbox (claim-request flow).
 *
 * The email carries a signed, email-bound, expiring, single-use token so that
 * ONLY the inbox owner can complete Discord linking (H2). Callers MUST have already
 * confirmed a real membership/mint exists for this email — this function does not
 * itself check entitlement, it just delivers the link. Returns { ok:false } on
 * failure (never throws for send errors) so the caller can respond uniformly.
 */
export async function sendDiscordAccessLink({ email }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'Missing RESEND_API_KEY env var' };

  const discordAccessUrl = buildDiscordAccessUrl(email);
  if (!discordAccessUrl) return { ok: false, error: 'Could not sign access token (STATE_SECRET unset)' };

  const payload = {
    from: getFromAddress(),
    to: [email],
    subject: 'Your Aurevon Discord access link',
    html: buildDiscordAccessHtml(discordAccessUrl),
    text: `Connect your Discord account and unlock your Aurevon member role:\n\n${discordAccessUrl}\n\nThis secure link is tied to your email, expires soon, and can be used once. If you did not request it, you can safely ignore this email.\n\n— Aurevon Ventures LLC`,
  };

  let response;
  try {
    response = await fetch(`${RESEND_BASE_URL}/emails`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Resend] Network error sending Discord access link:`, err.message);
    return { ok: false, error: err.message };
  }

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Resend] Discord access link send failed (${response.status}): ${errText}`);
    return { ok: false, error: `Resend send failed (${response.status})` };
  }

  const data = await response.json();
  console.log(`[Resend] Discord access link sent. id=${data.id}`);
  return { ok: true, id: data.id };
}
