// api/email/send.js
// Resend email sender - handles all Aurevon pass confirmation emails
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = process.env.RESEND_FROM_NAME || 'Aurevon';

const PASS_CONFIGS = {
  OBSIDIAN: { color: '#1a1a2e', accent: '#7c3aed', title: 'OBSIDIAN EXECUTIVE', price: '$2,499/mo', tier: 'RE Tier 3 - Apex', benefits: ['Full Enterprise RE Platform Access','Dedicated Account Manager','24/7 Priority Support','OBSIDIAN NFT Pass','Discord Executive Role','All Platform Access'] },
  EMBER:    { color: '#1a0a00', accent: '#f97316', title: 'EMBER',              price: '$1,499/mo', tier: 'RE Tier 2',       benefits: ['Pro RE Platform Access','Priority Support','EMBER NFT Pass','Discord Pro Role','NFT Minting Access'] },
  INSIDER:  { color: '#0f0f14', accent: '#a3a3a3', title: 'INSIDER',            price: '$250',      tier: 'RE Tier 1',       benefits: ['RE Platform Access','INSIDER NFT Pass','Discord Insider Role','Community Access'] },
  CHROME:   { color: '#0a1628', accent: '#60a5fa', title: 'CHROME',             price: '$150',      tier: 'Tier 2',          benefits: ['RE Platform Access','CHROME NFT Pass','Discord Chrome Role','Priority Queue'] },
  GENESIS:  { color: '#100a00', accent: '#fbbf24', title: 'GENESIS',            price: '$500',      tier: 'Genesis Tier',    benefits: ['All Platform Access','GENESIS Founder NFT','Discord Founder Role','Lifetime Membership','All Future Passes'] },
  COMMUNITY:{ color: '#0a0a0f', accent: '#22c55e', title: 'GENESIS COMMUNITY',  price: '$29.99/mo', tier: 'Community',       benefits: ['Community Discord Access','Monthly Newsletters','Early Access Announcements'] },
};

function buildEmailHTML(passType, customerName, portalLink, nftLink) {
  const cfg = PASS_CONFIGS[passType] || PASS_CONFIGS.COMMUNITY;
  const benefitsList = cfg.benefits.map(b => `<li style="margin:6px 0;color:#cbd5e1;">${b}</li>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#080810;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080810;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:${cfg.color};border:1px solid ${cfg.accent}33;border-radius:16px;overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,${cfg.accent}22,transparent);padding:40px;text-align:center;border-bottom:1px solid ${cfg.accent}22;">
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:4px;color:${cfg.accent};text-transform:uppercase;">AUREVON GROUP LLC</p>
    <h1 style="margin:0;font-size:28px;font-weight:700;color:#fff;letter-spacing:2px;">${cfg.title}</h1>
    <p style="margin:8px 0 0;font-size:13px;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;">${cfg.tier}</p>
  </td></tr>
  <tr><td style="padding:32px 40px;">
    <p style="color:#e2e8f0;font-size:16px;">Welcome, <strong style="color:${cfg.accent};">${customerName || 'Member'}</strong></p>
    <p style="color:#94a3b8;font-size:14px;line-height:1.6;">Your <strong>${cfg.title} pass</strong> is now active. You now have access to everything included in your tier.</p>
    <div style="background:${cfg.accent}11;border:1px solid ${cfg.accent}33;border-radius:10px;padding:20px;margin:24px 0;">
      <p style="margin:0 0 12px;font-size:11px;letter-spacing:3px;color:${cfg.accent};text-transform:uppercase;">Your Benefits</p>
      <ul style="margin:0;padding-left:20px;">${benefitsList}</ul>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="padding:0 8px 0 0;width:50%;">
        <a href="${portalLink}" style="display:block;background:linear-gradient(135deg,${cfg.accent},${cfg.accent}cc);color:#fff;text-decoration:none;text-align:center;padding:14px 20px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:1px;">ACCESS PORTAL</a>
      </td>
      <td style="padding:0 0 0 8px;width:50%;">
        <a href="${nftLink || 'https://aurevon-site.vercel.app/aurevon-nft.html'}" style="display:block;background:transparent;color:${cfg.accent};text-decoration:none;text-align:center;padding:13px 20px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:1px;border:1px solid ${cfg.accent}55;">VIEW NFT PASS</a>
      </td>
    </tr></table>
    <p style="margin:32px 0 0;font-size:12px;color:#475569;text-align:center;">Aurevon Group LLC &middot; aurevonvc.com &middot; Questions? Reply to this email.</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const { to, passType, customerName, portalLink, nftLink, subject } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });

  const cfg = PASS_CONFIGS[passType] || PASS_CONFIGS.COMMUNITY;
  const emailSubject = subject || `Your Aurevon ${cfg.title} Pass Is Active`;
  const html = buildEmailHTML(passType, customerName, portalLink || 'https://aurevon-site.vercel.app/portal.html', nftLink);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [to], subject: emailSubject, html })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.message || 'Resend error', detail: data });
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send email', message: err.message });
  }
}
