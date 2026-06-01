# Aurevon Site — Master Task List
> Generated: May 10, 2026 | Sub-agent analysis of full UI test run + codebase audit

---

## ✅ COMPLETED (Already Fixed by Sub-agent)

| # | Task | File(s) | Status |
|---|------|---------|--------|
| 1 | Created `.github/workflows/deploy.yml` — full CI/CD pipeline: lint, validate, Vercel preview+prod deploy, post-deploy health check | `.github/workflows/deploy.yml` | ✅ Done |
| 2 | Created `.github/workflows/health-check.yml` — scheduled every 6h, checks all page routes + env var status | `.github/workflows/health-check.yml` | ✅ Done |
| 3 | Fixed `vercel.json` — added explicit API routes, webhook `maxDuration` (30s), CORS headers, security headers, `/success` + `/cancel` routes, all HTML page rewrites | `vercel.json` | ✅ Done |
| 4 | Fixed `aurevon-re.html` — added `showPaymentError()` helper, inline error banner `#bkt-pay-error`, improved button loading state to ⏳ emoji + descriptive text | `aurevon-re.html` | ✅ Done |
| 5 | Fixed `operator.html` — improved error message to guide user to enter Airtable PAT in Setup when not configured | `operator.html` | ✅ Done |
| 6 | Created `scripts/merch-patch.js` — broken image fallback to `.product-placeholder`, cart button guard when Snipcart key not set, "Store setup in progress" banner | `scripts/merch-patch.js` | ✅ Done |
| 7 | Fixed `merch.html` — added `<script src="/scripts/merch-patch.js" defer>`, replaced `YOUR_SNIPCART_PUBLIC_API_KEY` placeholder with `SNIPCART_KEY_PENDING_SETUP` sentinel | `merch.html` | ✅ Done |

---

## 🔴 CRITICAL — Requires Your Keys/Credentials (You Provide, I Deploy)

### 1. GitHub Secrets for CI/CD Workflow
**Blocks:** Every automated deploy via GitHub Actions

| Secret Name | Where to get it | Instructions |
|------------|----------------|-------------|
| `VERCEL_TOKEN` | vercel.com → Settings → Tokens → Create | Create a token named "GitHub Actions" |
| `VERCEL_ORG_ID` | vercel.com → Settings → General → Your ID | Copy the Team/Personal ID |
| `VERCEL_PROJECT_ID` | vercel.com → Project Settings → General | Copy Project ID |

**Add to GitHub:** `github.com/mikerivera33/Aurevon-site/settings/secrets/actions` → New repository secret

**Once you provide these → I will:** Test the full workflow run, verify preview deploys on PRs work, confirm health check post-deploy passes.

---

### 2. Missing Vercel Environment Variables (13 Missing)
**Blocks:** NFT minting pipeline, email delivery, merch checkout, Discord automation

From `/api/health` audit — currently configured: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`

| Env Var | What it enables | Where to get |
|---------|----------------|-------------|
| `PAYPAL_BUSINESS_EMAIL` | PayPal webhook processing | Your PayPal account email |
| `CROSSMINT_API_KEY` | NFT minting via Crossmint | crossmint.com → Developer → API Keys |
| `CROSSMINT_PROJECT_ID` | NFT project identifier | crossmint.com → Your project |
| `CROSSMINT_COLLECTION_ID` | NFT collection | crossmint.com → Collections |
| `CROSSMINT_TEMPLATE_INSIDER` | Insider NFT template ID | crossmint.com → Templates |
| `CROSSMINT_TEMPLATE_EMBER` | Ember NFT template ID | crossmint.com → Templates |
| `CROSSMINT_TEMPLATE_OBSIDIAN` | Obsidian NFT template ID | crossmint.com → Templates |
| `CROSSMINT_TEMPLATE_GENESIS` | Genesis NFT template ID | crossmint.com → Templates |
| `CROSSMINT_TEMPLATE_CHROME` | Chrome NFT template ID | crossmint.com → Templates |
| `RESEND_API_KEY` | All transactional emails (magic links, NFT delivery, confirmations) | resend.com → API Keys |
| `RESEND_FROM_EMAIL` | Email sender address | e.g. `mike@aurevonvc.com` (must be verified in Resend) |
| `RESEND_FROM_NAME` | Email sender display name | e.g. `Aurevon Group` |
| `DISCORD_INVITE_URL` | Discord link in NFT delivery emails | Your Discord server invite link |

**Add to Vercel:** `vercel.com → Aurevon-site project → Settings → Environment Variables`

**Once you provide these → I will:** Trigger a test checkout session, verify NFT mints, confirm email delivery, test the full post-purchase pipeline end-to-end.

---

### 3. Stripe Webhook Endpoint Registration
**Blocks:** NFT minting after payment, Airtable payment records, confirmation emails

**Steps:**
1. Go to `dashboard.stripe.com → Developers → Webhooks → Add endpoint`
2. Endpoint URL: `https://www.aurevonvc.com/api/webhooks/stripe` (or your Vercel domain)
3. Events to listen for: `checkout.session.completed`, `payment_intent.succeeded`
4. Copy the **Webhook Signing Secret** → Add to Vercel as `STRIPE_WEBHOOK_SECRET` (update if already set)

**Once confirmed → I will:** Run a test purchase, verify signature validation passes, check Airtable Payment record creation.

---

### 4. PayPal Webhook Configuration
**Blocks:** PayPal payment processing pipeline

**Steps:**
1. `developer.paypal.com → My Apps → Your App → Webhooks`
2. Webhook URL: `https://www.aurevonvc.com/api/webhooks/paypal`
3. Events: `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED`
4. Set `PAYPAL_BUSINESS_EMAIL` in Vercel env vars

---

### 5. Snipcart Store Setup (Merch Page)
**Blocks:** All merch cart/checkout functionality

**Steps:**
1. Sign up at `snipcart.com` (free up to $500/mo revenue)
2. Connect Stripe (Settings → Payment Gateway → Stripe)
3. Copy Public API Key from Dashboard → API Keys
4. Add domain: Dashboard → Domains & URLs → add `www.aurevonvc.com`

**Once you provide the key → I will:** Replace `SNIPCART_KEY_PENDING_SETUP` in `merch.html` with the real key, update `merch-patch.js` sentinel value, test add-to-cart and checkout flow.

---

### 6. Printify Product Setup (Merch Page — Physical Products)
**Blocks:** Actual product fulfillment for merch

**Required per product:**
- Aurevon Shield Hoodie → upload Aurevon artwork, set price $65
- Operator Snapback → upload logo art, set price $35
- Operator Tee → upload artwork, set price $45
- Black Ops Bomber → upload art, set price $89
- Utility Crewneck → upload art, set price $75
- XL Desk Mat → "Gaming Mouse Pad 36x18" by Monster Digital
- Operator Mug → "Glossy Black Mug 15oz" by Printify
- Laptop Sleeve → "Laptop Sleeve" by Printify

**Once you upload artwork to Printify → I will:** Sync Printify product IDs to `data-item-id` attributes in `merch.html`, update product images, configure Snipcart `data-item-price` to match Printify prices.

---

### 7. Product Images for Merch Page
**Blocks:** Merch page visual appeal (currently showing SVG placeholders)

**Required:**
- `assets/merch-hoodie.jpg` (1:1, min 800x800px)
- `assets/merch-snapback.jpg`
- `assets/merch-tee.jpg`
- `assets/merch-bomber.jpg`
- `assets/merch-crewneck.jpg`
- `assets/merch-deskmat.jpg`
- `assets/merch-mug.jpg`
- `assets/merch-laptop-sleeve.jpg`

**Once you upload images to `/assets/` → I will:** Update `merch.html` `<img src>` paths, remove `product-placeholder` fallbacks for those products, optimize `loading="lazy"` attributes.

---

### 8. Crossmint NFT Templates & Collections
**Blocks:** Automated NFT minting after purchase

**Required setup in Crossmint:**
1. Create project at `crossmint.com`
2. Create NFT collection (EVM or Solana — confirm chain preference)
3. Create templates for each tier:
   - `INSIDER` template — RE Insider NFT
   - `EMBER` template — Ember Access NFT
   - `OBSIDIAN` template — Obsidian Premium NFT
   - `GENESIS` template — Genesis Drop NFT (001_Genesis.html design)
   - `CHROME` template — Chrome Edition NFT (004_Chrome.html design)
4. Upload artwork for each template

**Once you provide template IDs → I will:** Update `TIER_NFT_MAP` in `api/lib/tiers.js`, test mint flow with test email, verify `api/lib/crossmint.js` properly calls templates, confirm Airtable `NFT_Mints` table records are created.

---

### 9. Airtable Tables Verification
**Blocks:** Portal auth, payment records, NFT mint tracking

**Verify these tables exist in Airtable base `appI9X8vcRcK1QZ1l`:**

| Table | Table ID | Required Fields |
|-------|----------|----------------|
| Leads | `tbllVIcSRXdZwofbs` | Email, Name |
| Payments | `tbl6KlhM9fIH19W5i` | Email, Customer Name, Service Product, Transaction ID, Amount, Status |
| CustomerAuth | `tblbCS7TL65FcOiWn` | Email, Customer Name, Magic Token, Token Expires, Session Active |
| NFT_Mints | *(check api/lib/airtable.js)* | Reference, Customer Email, NFT Type, Tier Source, Status, Sent Date, Mint ID |

**Once confirmed → I will:** Run portal auth flow test, verify magic link generation, test portal data loading.

---

### 10. Resend Domain Verification
**Blocks:** Magic link emails, NFT delivery emails, purchase confirmations

**Steps:**
1. `resend.com → Domains → Add Domain`
2. Add `aurevonvc.com`
3. Add the DNS records Resend provides (SPF, DKIM, DMARC)
4. Verify domain → status turns green
5. Update `RESEND_FROM_EMAIL` to `mike@aurevonvc.com` in Vercel

---

### 11. Custom Domain Routing (Production)
**Blocks:** `www.aurevonvc.com` resolving to Vercel deployment

**Steps:**
1. Vercel project → Settings → Domains → Add `www.aurevonvc.com` and `aurevonvc.com`
2. Add DNS records at your domain registrar pointing to Vercel
3. Update `BASE_URL` env var in Vercel: `https://www.aurevonvc.com`
4. Update Stripe webhook URL to use custom domain
5. Update PayPal webhook URL to use custom domain

---

### 12. Operator Hub — Airtable PAT Entry
**Blocks:** Live KPI dashboard, lead counts, payment history in Operator Hub

**Steps:**
1. Visit `https://www.aurevonvc.com/operator`
2. Scroll to Setup section
3. Enter your Airtable Personal Access Token (`patXXXXXXXXXX`)
4. Enter Base ID: `appI9X8vcRcK1QZ1l` (pre-filled)
5. Click Connect → dashboard data loads live

*Note: PAT is stored in `localStorage` — private to your browser. Never committed to repo.*

---

## 🟡 MEDIUM PRIORITY — I Can Fix Once Above Is Done

| # | Task | Details |
|---|------|--------|
| 13 | Add `/success` and `/cancel` pages | Currently redirect to `index.html`. Need dedicated pages with order confirmation, next steps, upsell. |
| 14 | Portal slow load issue | portal.html has no loading skeleton. Need skeleton screens while Airtable data fetches. |
| 15 | `aurevon-nft.html` buy buttons | Need to verify all NFT tier buy buttons are wired to correct Stripe price IDs. |
| 16 | `aurevon-web3.html` buy buttons | Same as above — verify Web3 tier checkout flow. |
| 17 | Discord welcome automation | `discord-welcome.html` exists but no Discord bot webhook is configured. |
| 18 | CRM integration | `aurevon-crm.html` is the canonical CRM. Verify Airtable CRM view is configured. |
| 19 | Aurevon RE Intake form | `aurevon-re-intake.html` — form submission needs Airtable or email endpoint. |
| 20 | `setup-wizard.html` completion | Walk-through wizard for initial config — verify all steps still align with current env vars. |

---

## 🟢 LOW PRIORITY — Polish & Optimization

| # | Task | Details |
|---|------|--------|
| 21 | Add `robots.txt` | Currently missing — SEO crawlers see nothing. Add with Sitemap reference. |
| 22 | Add `sitemap.xml` | List all public pages for Google indexing. |
| 23 | Add `favicon.ico` | Site has no favicon — shows browser default in tabs. |
| 24 | Vercel Analytics event tracking | Vercel Web Analytics PR is merged. Add custom events for checkout clicks, portal logins. |
| 25 | Add rate limiting to API routes | No rate limiting on `/api/portal/auth` — email enumeration risk. |
| 26 | Error page (404.html) | Vercel shows default 404. Add branded 404 page. |
| 27 | Compress assets | NFT images in `/assets/` are uncompressed. Add WebP versions. |
| 28 | Mobile nav audit | Run mobile viewport test on all pages — confirm hamburger menus work. |

---

## 🚀 DEPLOY SEQUENCE (Execute in this order)

```
Step 1: Add GitHub Secrets (VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID)
   → GitHub Actions CI/CD becomes live

Step 2: Add 13 missing Vercel env vars (RESEND, CROSSMINT, PAYPAL, DISCORD)
   → Full pipeline enabled

Step 3: Verify Airtable table structure matches expected fields
   → Portal + payment records work

Step 4: Verify Resend domain (aurevonvc.com)
   → Email delivery works

Step 5: Register Stripe + PayPal webhooks with production URLs
   → Payment → NFT → Email pipeline fires

Step 6: Set up Snipcart + Printify (provide Snipcart public key)
   → Merch store goes live

Step 7: Set up Crossmint templates (provide 5 template IDs)
   → NFT auto-minting enabled

Step 8: Point custom domain (aurevonvc.com → Vercel)
   → Production goes live at real domain
```

---

*Generated by Comet sub-agent. All fixable items have been committed. Credential-dependent items require your input, then I can install, test, and deploy to finalization.*
