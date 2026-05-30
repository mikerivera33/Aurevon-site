# Aurevon — Launch Inputs Checklist

Everything I need from you to finish wiring the site end-to-end. Organized by **how**
you give it to me:

- **🟢 Paste in chat → I wire it into the repo** (public, non-secret values)
- **🔴 You set in Vercel yourself → never paste in chat** (secrets / API keys)
- **📎 Add the file to the repo** (binary assets I can't receive in chat)
- **🛠️ Dashboard action only you can do** (verify domain, create webhook, etc.)
- **🤖 I can do via MCP** if you say go

> Security rule: anything labeled 🔴 is a secret. Don't paste it in chat or commit it.
> Set it in Vercel → Project → Settings → Environment Variables (or use
> `scripts/set-vercel-env.sh` for the non-secret ones).

---

## 🟢 A. Public values — paste these and I'll wire them in

### A1. PayPal add-on links (6) → `aurevon-re.html` `AUREVON_CONFIG`
Create each in PayPal Business → Pay & Get Paid → PayPal buttons, then send me the NCP URLs:
- [ ] 12-Hour Rush ($99) → `PAYPAL_ADDON_RUSH_URL`
- [ ] Investor Memo ($149) → `PAYPAL_ADDON_MEMO_URL`
- [ ] Lender Presentation ($199) → `PAYPAL_ADDON_LENDER_URL`
- [ ] Sensitivity Modeling ($125) → `PAYPAL_ADDON_SENSITIVITY_URL`
- [ ] Portfolio Review ($499) → `PAYPAL_ADDON_PORTFOLIO_URL`
- [ ] White-Label ($175) → `PAYPAL_ADDON_WHITELABEL_URL`

### A2. PayPal links for currently-unmirrored items (optional)
- [ ] Community Monthly $29.99, Community Lifetime $349.99 (verify these exist)
- [ ] Web3 tiers $49 / $149 / $349 / $799 (if you want PayPal, not just Stripe)

### A3. Brand / contact facts to confirm or correct
- [ ] **Business mailing address** — set to `4129 Saltburn Dr, Plano, TX` in email footers + Crossmint metadata. Confirm or give the correct one.
- [ ] **Phone** `(856) 693-8249` — confirm (already wired into site + emails).
- [ ] **Social handles** — confirm: X `@AurevonLabs`, IG `aurevon.vc`, LinkedIn `company/aurevon`, TikTok `@aurevon.vc`, YouTube `@aurevon.vc`.
- [ ] **Discord permanent invite** — currently `discord.gg/2fwFjMEh`. Confirm it won't expire.

### A4. Pricing/discrepancy decisions (from PAYMENT_BUTTONS_CHECKLIST.md)
- [ ] Keep or remove the PayPal-only **GENESIS "$500 Founder Pass"** (no Stripe match)
- [ ] Confirm the 5-tier pricing is final: $299.99 / $189.99 / $250 / $1,499mo / $2,499mo

---

## 📎 B. Files to add to the repo (I can't receive binaries in chat)

Drop these into `assets/` (commit them, or attach them and tell me the filename):
- [ ] **`assets/aurevon-wordmark.png`** — the chrome AUREVON wordmark (LOGO1). Used as the homepage hero brandmark. *(code already points here)*
- [ ] **`assets/aurevon-labs-banner.png`** — the AUREVON LABS banner. Used as the Web3 + NFT page hero. *(code already points here)*
- [ ] *(optional)* 5 enhanced NFT images + animations per `docs/NFT_ART_BRIEF.md` (these get pinned to IPFS, not committed).

---

## 🔴 C. Secrets — you set these in Vercel (never paste in chat)

Exact env-var names the code reads. Use `scripts/set-vercel-env.sh` for the non-secret
config; set the secrets below by hand in Vercel:

| Env var | From |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → your endpoint (`whsec_…`) |
| `RESEND_API_KEY` | Resend → API Keys (`re_…`) |
| `CROSSMINT_API_KEY` | Crossmint Console → API Keys (server-side) |
| `CROSSMINT_WEBHOOK_SECRET` | Crossmint Console → Webhooks |
| `AIRTABLE_PAT` | Airtable → Personal Access Tokens (`pat…`) |
| `DISCORD_BOT_TOKEN` | Discord Dev Portal → Bot |
| `DISCORD_CLIENT_SECRET` | Discord Dev Portal → OAuth2 |
| `PAYPAL_SECRET` + `PAYPAL_CLIENT_ID` | PayPal Developer → your app |
| `INTERNAL_API_SECRET` · `STATE_SECRET` · `SYNC_SECRET` · `RECONCILE_SECRET` · `CRON_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Non-secret config (the `set-vercel-env.sh` script sets these): `RESEND_FROM_EMAIL=mike@aurevonvc.com`,
`RESEND_FROM_NAME=Aurevon`, `BASE_URL`/`DOMAIN`/`SITE_URL=https://www.aurevonvc.com`,
`CROSSMINT_ENV=production`, `CROSSMINT_CHAIN=base`.

### Crossmint IDs (semi-public — paste in chat OR set in Vercel, your call)
- [ ] `CROSSMINT_COLLECTION_ID` (production)
- [ ] `CROSSMINT_TEMPLATE_INSIDER` / `_EMBER` / `_OBSIDIAN` / `_GENESIS` / `_CHROME`
- [ ] `AIRTABLE_BASE_ID` (currently `appI9X8vcRcK1QZ1l` in .env.example — confirm)
- [ ] `DISCORD_CLIENT_ID` + `DISCORD_GUILD_ID` (confirm the ones in .env.example)

---

## 🛠️ D. Dashboard actions only you can do
- [ ] **Resend**: add + verify domain `aurevonvc.com` (SPF/DKIM/DMARC DNS records)
- [ ] **Stripe**: confirm support/receipt email = `mike@aurevonvc.com`; add webhook endpoint `https://www.aurevonvc.com/api/webhooks/stripe`
- [ ] **PayPal**: create the 6 add-on buttons (A1); set webhook/IPN to `https://www.aurevonvc.com/api/webhooks/paypal`
- [ ] **Crossmint**: confirm production collection is verified; webhook → `/api/webhooks/crossmint`
- [ ] **Vercel**: point domain `www.aurevonvc.com`; run `bash scripts/set-vercel-env.sh`; set the 🔴 secrets; `vercel --prod`
- [ ] **DNS**: A/CNAME for `aurevonvc.com` → Vercel

---

## 🤖 E. Things I can do via MCP once you confirm
- [x] **Stripe** — verified: I can create payment links (tested the $99 Rush price; it's live). I can also create missing Products/Prices via MCP if any add-on price is wrong.
- [ ] **Stripe** — want me to create the remaining add-on payment links, or leave the site on checkout-sessions (recommended — cleaner)?
- [ ] **Canva** — generate the 5 enhanced NFT artworks (blocked: your Canva quota is maxed; free it and I'll run them).
- [ ] **Airtable** — I can verify the base schema (Payments/Members/Leads/NFT_Mints tables) if you want.

> ⚠️ Cleanup: delete the throwaway test payment link `plink_1TccGw8e9ZIjX9wL3PbQ7imt`
> in Stripe → Payment Links (it was only created to confirm the connection).

---

## Fastest path to "everything works"
1. You: add the 2 image files (B) + run `set-vercel-env.sh` + set the 🔴 secrets (C) + the 🛠️ webhooks (D).
2. Me: wire any 🟢 values you paste (A) — PayPal add-on links, address, confirmations.
3. You: `vercel --prod`, then we run the test plan in `PAYMENT_BUTTONS_CHECKLIST.md`.
