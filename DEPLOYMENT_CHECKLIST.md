# Aurevon — Pre-Launch Deployment Checklist

> Complete every item on this list before announcing the site publicly.
> Date: ________________  Deployed by: ________________  Version: ________________
>
> For the NFT pipeline (env vars, webhooks, Discord, the bot on Google Cloud), `docs/nft-pipeline-setup.md` is the single setup source and wins over anything below.

---

## 1. Vercel Configuration

| # | Item | Done | Notes |
|---|---|---|---|
| 1.1 | Project linked to Vercel (`vercel link` completed) | [ ] | |
| 1.2 | All environment variables set in Vercel Dashboard | [ ] | See `.env.example` for full list |
| 1.3 | `vercel --prod` deployment completed without errors | [ ] | |
| 1.4 | Vercel build logs show no warnings or errors | [ ] | |
| 1.5 | `/api/health` returns `{"status":"healthy","env":"complete"}` | [ ] | |
| 1.6 | Vercel cron jobs visible in Dashboard → Crons | [ ] | retry-mints + check-membership |

---

## 2. Custom Domain & SSL

| # | Item | Done | Notes |
|---|---|---|---|
| 2.1 | Custom domain added in Vercel → Domains | [ ] | e.g., aurevonvc.com |
| 2.2 | DNS records pointed to Vercel (A record or CNAME) | [ ] | Check with `dig yourdomain.com` |
| 2.3 | DNS propagation complete (may take up to 48 hours) | [ ] | Use https://dnschecker.org |
| 2.4 | SSL certificate issued and active (green padlock) | [ ] | Vercel auto-provisions via Let's Encrypt |
| 2.5 | `http://` redirects to `https://` automatically | [ ] | |
| 2.6 | `www.` redirects to apex (or vice versa, per your preference) | [ ] | Set redirect in Vercel Domains |

---

## 3. Stripe

| # | Item | Done | Notes |
|---|---|---|---|
| 3.1 | Stripe account in **Live mode** (not test mode) | [ ] | Toggle at top of Stripe Dashboard |
| 3.2 | Payment links created for all 7 tiers with correct prices | [ ] | |
| 3.3 | Each payment link has `metadata.tier` set | [ ] | Required for webhook to identify tier |
| 3.4 | Webhook endpoint added: `https://yourdomain.com/api/webhooks/stripe` | [ ] | |
| 3.5 | Webhook signing secret added to `STRIPE_WEBHOOK_SECRET` env var | [ ] | |
| 3.6 | Webhook events selected: all 9 in `api/_lib/stripe-events.js` (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`) | [ ] | Authed `/api/health` lists any missing |
| 3.7 | Cash App Pay enabled in Stripe Settings → Payment methods | [ ] | |
| 3.8 | Afterpay enabled in Stripe Settings → Payment methods | [ ] | |
| 3.9 | Live test purchase made with a real card | [ ] | Use your own card, then refund |
| 3.10 | Live purchase triggered webhook (visible in Stripe → Webhooks) | [ ] | |

---

## 4. PayPal

| # | Item | Done | Notes |
|---|---|---|---|
| 4.1 | PayPal Business account is live (not sandbox) | [ ] | |
| 4.2 | REST API app created with live credentials | [ ] | |
| 4.3 | `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` set to live values | [ ] | |
| 4.4 | `PAYPAL_MODE=live` in env vars | [ ] | |
| 4.5 | Webhook configured: `https://yourdomain.com/api/webhooks/paypal` | [ ] | |
| 4.6 | `PAYPAL_WEBHOOK_ID` set in env vars | [ ] | |

---

## 5. Crossmint

| # | Item | Done | Notes |
|---|---|---|---|
| 5.1 | Crossmint business verification approved | [ ] | Takes 1–2 business days |
| 5.2 | Collection deployed on **Base Mainnet** | [ ] | Not staging, not testnet (base-sepolia) |
| 5.3 | `CROSSMINT_API_KEY`, `CROSSMINT_COLLECTION_ID` set (templates are no longer used; metadata is inline) | [ ] | |
| 5.4 | Crossmint webhook → `/api/webhooks/crossmint`, events `nfts.create.succeeded` + `nfts.create.failed`, Svix `whsec_` secret in `CROSSMINT_WEBHOOK_SECRET` | [ ] | |
| 5.5 | `CROSSMINT_ENV` unset (production) | [ ] | |
| 5.6 | `CROSSMINT_CHAIN` unset (defaults to `base`) | [ ] | |
| 5.7 | Test mint in production environment succeeded | [ ] | Use a test email address |
| 5.8 | Crossmint wallet funded with enough ETH (Base) for gas | [ ] | $5 worth covers ~100+ mints |

---

## 6. Discord

| # | Item | Done | Notes |
|---|---|---|---|
| 6.1 | Discord server is live and public (not invite-only for new members) | [ ] | Or linked invite is active |
| 6.2 | Aurevon bot is installed and showing as online | [ ] | Green dot next to bot in member list |
| 6.3 | Bot role is higher than all membership roles in hierarchy | [ ] | Critical for role assignment to work |
| 6.4 | All 5 NFT roles created (Genesis, Chrome, Insider, Ember, Obsidian) | [ ] | |
| 6.5 | `DISCORD_ROLE_MONTHLY` (Genesis), `_LIFETIME` (Chrome), `_PRODUCT_A` (Insider), `_PRODUCT_B` (Ember), `_PRODUCT_C` (Obsidian) set | [ ] | |
| 6.6 | OAuth2 redirect URI set to `https://www.aurevonvc.com/api/discord?action=callback` | [ ] | Exact `REDIRECT_URI` in `api/discord.js` |
| 6.7 | `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID` all set | [ ] | |
| 6.8 | Discord OAuth flow tested end-to-end (authorize → role assigned) | [ ] | |
| 6.9 | Read [`api/discord/SERVER_SETUP.md`](api/discord/SERVER_SETUP.md) completely | [ ] | |

---

## 7. Resend

| # | Item | Done | Notes |
|---|---|---|---|
| 7.1 | Sending domain verified in Resend (SPF + DKIM green) | [ ] | |
| 7.2 | DMARC record added (recommended) | [ ] | |
| 7.3 | `RESEND_API_KEY` set in env vars | [ ] | |
| 7.4 | `RESEND_FROM_EMAIL` set to verified domain address | [ ] | |
| 7.5 | Test email sent and received in inbox (not spam) | [ ] | |

---

## 8. Database (Supabase — replaced Airtable, Nov 2026)

`SUPABASE_URL` + `SUPABASE_SECRET_KEY` and the migrations: see O4 in `docs/nft-pipeline-setup.md`. `AIRTABLE_*` is only a temporary import bridge.

---

## 9. Testing

| # | Item | Done | Notes |
|---|---|---|---|
| 9.1 | `npm run test:qa` passes all tests | [ ] | |
| 9.2 | `npm run test:qa --full-pipeline` passes all tests | [ ] | |
| 9.3 | End-to-end live purchase made for at least one tier | [ ] | Real card, refund after |
| 9.4 | End-to-end Discord flow tested | [ ] | |
| 9.5 | Operator Hub displays live data correctly | [ ] | |
| 9.6 | QUALITY_CHECKLIST.md reviewed and all items checked | [ ] | |

---

## 10. Final Steps

| # | Item | Done | Notes |
|---|---|---|---|
| 10.1 | Analytics installed (Plausible, Fathom, or GA4) | [ ] | Plausible recommended for privacy |
| 10.2 | Analytics tracking verified (visit site → check dashboard) | [ ] | |
| 10.3 | Backup created (export Airtable as CSV, save to secure location) | [ ] | |
| 10.4 | All team members who need operator access have Airtable PAT | [ ] | |
| 10.5 | Financial disclaimer visible on all relevant pages | [ ] | |
| 10.6 | Privacy Policy and Terms of Service published | [ ] | |
| 10.7 | Social media links in footer are correct | [ ] | |
| 10.8 | Support/contact email is monitored and working | [ ] | |

---

**All items complete:** Yes / No  
**Launch approved by:** ________________  
**Launch date/time:** ________________  
**Rollback plan:** `vercel rollback` to previous deployment if critical issues found within first hour.
