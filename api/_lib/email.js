/**
 * Resend email client for Aurevon transactional emails.
 * All CSS is inline for email client compatibility.
 */

const RESEND_BASE_URL = 'https://api.resend.com';

function getFromAddress() {
  const name = process.env.RESEND_FROM_NAME ?? 'Aurevon';
  const email = process.env.RESEND_FROM_EMAIL ?? 'hello@aurevongroup.com';
  return `${name} <${email}>`;
}

/**
 * Build the branded HTML email for NFT delivery.
 */
function buildNftDeliveryHtml({ customerName, nftType, mintId, nftImageUrl, discordInviteUrl, tier, serial, edition }) {
  const firstName = customerName?.split(' ')[0] ?? 'Operator';
  const tierLabel = tier ? tier.toUpperCase().replace('_', ' ') : 'MEMBER';
  const imageBlock = nftImageUrl
    ? `<img src="${nftImageUrl}" alt="${nftType} NFT" style="display:block;width:100%;max-width:380px;margin:0 auto 12px;border-radius:12px;border:1px solid rgba(59,130,246,0.25);" />`
    : `<div style="width:100%;max-width:380px;height:200px;margin:0 auto 12px;background:linear-gradient(135deg,#1a1206,#2a1c08);border-radius:12px;border:1px solid rgba(59,130,246,0.25);display:flex;align-items:center;justify-content:center;"><span style="color:#3B82F6;font-size:14px;font-family:sans-serif;">NFT Image Loading...</span></div>`;

  const serialBlock = serial
    ? `<div style="font-family:'Courier New',monospace;font-size:1.2rem;color:#3B82F6;letter-spacing:0.15em;text-align:center;margin:0.8rem 0;">${serial}</div>`
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
  <div style="display:none;max-height:0;overflow:hidden;color:#0A0A0A;">Your ${nftType} NFT has been minted and delivered. Welcome to the operator tier.</div>

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
                ${firstName}, you're now holding the <strong style="color:#3B82F6;">${nftType}</strong> — your proof-of-access on-chain. This NFT lives in your email wallet, no MetaMask required.
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
                        <td align="right" style="padding:6px 0;font-size:14px;color:#3B82F6;font-weight:600;">${nftType}</td>
                      </tr>
                      ${serial ? `
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Serial</td>
                        <td align="right" style="padding:6px 0;font-size:13px;color:#3B82F6;font-family:monospace;font-weight:600;letter-spacing:0.1em;border-top:1px solid rgba(255,255,255,0.05);">${serial}</td>
                      </tr>` : ''}
                      ${editionDisplay ? `
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Edition</td>
                        <td align="right" style="padding:6px 0;font-size:14px;color:#a1a1aa;border-top:1px solid rgba(255,255,255,0.05);">#${editionDisplay} of &infin;</td>
                      </tr>` : ''}
                      <tr>
                        <td style="padding:6px 0;font-size:14px;color:#71717a;border-top:1px solid rgba(255,255,255,0.05);">Mint ID</td>
                        <td align="right" style="padding:6px 0;font-size:13px;color:#a1a1aa;font-family:monospace;word-break:break-all;border-top:1px solid rgba(255,255,255,0.05);">${mintId}</td>
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
          ${discordInviteUrl ? `
          <tr>
            <td align="center" style="padding:0 40px 36px;">
              <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;text-align:center;">Join the operator community now. Introductions go up in the first 24 hours.</p>
              <a href="${discordInviteUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(90deg,#1E3A8A,#3B82F6);border-radius:8px;font-family:'Archivo Black',Impact,sans-serif;font-size:15px;font-weight:900;color:#0A0A0A;text-decoration:none;letter-spacing:0.5px;box-shadow:0 8px 24px rgba(30,58,138,0.32);">
                JOIN DISCORD &rarr;
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
                Questions? Reply to this email or reach us at <a href="mailto:hello@aurevongroup.com" style="color:#3B82F6;text-decoration:none;">hello@aurevongroup.com</a>. We respond within one business day.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0A0A0A;border-top:1px solid rgba(255,255,255,0.05);padding:20px 40px;text-align:center;">
              <p style="margin:0 0 6px;font-size:11px;color:#3f3f46;letter-spacing:1px;text-transform:uppercase;">Aurevon Group LLC &middot; [Your Address]</p>
              <p style="margin:0;font-size:11px;color:#3f3f46;">
                You received this because you completed a purchase on blockt.co.
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
function buildNftDeliveryText({ customerName, nftType, mintId, discordInviteUrl, tier, serial, edition }) {
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

${discordInviteUrl ? `Join the operator community:\n${discordInviteUrl}\n` : ''}Questions? hello@aurevongroup.com

---
Aurevon Group LLC · [Your Address]
You received this because you completed a purchase on blockt.co.
`;
}

/**
 * Build a generic "thanks for your purchase" email (no NFT — e.g. Second Opinion tier).
 */
function buildPurchaseConfirmHtml({ customerName, tier }) {
  const firstName = customerName?.split(' ')[0] ?? 'Client';

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
            <h1 style="margin:0 0 16px;font-family:'Archivo Black',Impact,sans-serif;font-size:28px;color:#3B82F6;">Purchase Confirmed.</h1>
            <p style="margin:0 0 16px;font-size:16px;color:#d4d4d8;line-height:1.6;">${firstName}, your payment has been received. We'll be in touch within one business day with next steps and your intake form.</p>
            <p style="margin:0;font-size:15px;color:#a1a1aa;">Tier: <strong style="color:#3B82F6;">${(tier ?? '').toUpperCase()}</strong></p>
          </td>
        </tr>
        <tr>
          <td style="background:#0A0A0A;border-top:1px solid rgba(255,255,255,0.05);padding:20px 40px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#3f3f46;">Aurevon Group LLC &middot; [Your Address]</p>
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

  const payload = {
    from: getFromAddress(),
    to: [email],
    subject,
    html: buildNftDeliveryHtml({ customerName, nftType, mintId, nftImageUrl, discordInviteUrl, tier, serial, edition: resolvedEdition }),
    text: buildNftDeliveryText({ customerName, nftType, mintId, discordInviteUrl, tier, serial, edition: resolvedEdition }),
  };

  console.log(`[Resend] Sending NFT delivery email to ${email} — "${subject}"`);

  const response = await fetch(`${RESEND_BASE_URL}/emails`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend send failed (${response.status}): ${errText}`);
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

  const subject = 'Your Aurevon purchase is confirmed';

  const payload = {
    from: getFromAddress(),
    to: [email],
    subject,
    html: buildPurchaseConfirmHtml({ customerName, tier }),
    text: `${customerName?.split(' ')[0] ?? 'Client'}, your payment has been received. We'll be in touch within one business day.\n\nTier: ${tier}\n\n— Aurevon`,
  };

  console.log(`[Resend] Sending purchase confirmation email to ${email}`);

  const response = await fetch(`${RESEND_BASE_URL}/emails`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend send failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  console.log(`[Resend] Confirmation email sent. id=${data.id}`);
  return data;
}
