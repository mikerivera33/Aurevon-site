# Aurevon — Operator Playbook

> The complete guide to deploying, configuring, and operating the Aurevon autonomous investment backend and membership portal.

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Quick Start (15 Minutes)](#3-quick-start-15-minutes)
4. [Stripe Setup](#4-stripe-setup)
5. [PayPal Setup](#5-paypal-setup)
6. [Crossmint NFT Setup](#6-crossmint-nft-setup)
7. [Resend Email Setup](#7-resend-email-setup)
8. [Airtable Setup](#8-airtable-setup)
9. [Discord Setup](#9-discord-setup)
10. [Operator Hub Usage](#10-operator-hub-usage)
11. [QA Checklist](#11-qa-checklist)
12. [Troubleshooting](#12-troubleshooting)
13. [Cost Breakdown](#13-cost-breakdown)
14. [Roadmap](#14-roadmap)

---

## 1. What This Is

Aurevon is a fully autonomous investment education and Web3 membership platform. Once deployed, it operates without manual intervention:

- **Customers visit** `aurevongroup.com` and select a membership tier (Insider, Ember, Obsidian Executive, 001 Genesis, 004 Chrome) or a Real Estate service (Pro Retainer, Enterprise).
- **They pay** via Stripe (card, Cash App Pay, Afterpay) or PayPal.
- **A webhook fires** to the Aurevon backend (Vercel serverless function), which verifies the payment signature.
- **Crossmint mints** the corresponding NFT membership token directly to the customer's email address — no crypto wallet required.
- **Resend delivers** a branded confirmation email with the NFT and Discord invite link.
- **The customer clicks** the Discord OAuth link, which auto-assigns the correct server role based on their tier.
- **Airtable is updated** with the payment, NFT mint record, and member row — all visible in the Operator Hub.
- **Retries are automatic**: a cron job runs hourly to reattempt any failed mints.

**What you (the operator) do:** Nothing after setup. Open `operator.html` to monitor KPIs, view leads, and trigger manual actions if needed.

### Pages

| Page | Purpose |
|---|---|
| `index.html` | Main landing — hero, tiers, pricing |
| `BLOCKT_Web3.html` | Web3/NFT membership detail |
| `BLOCKT_NFT_Collection.html` | NFT collection gallery |
| `001_Genesis.html` | 001 Genesis tier detail |
| `004_Chrome.html` | 004 Chrome tier detail |
| `BLOCKT_RE_Final.html` | Real Estate services |
| `BLOCKT_RE_Intake.html` | Gated intake form (leads) |
| `membership_confirmation.html` | Post-payment confirmation |
| `operator.html` | Owner-only dashboard (Airtable-powered) |

### API Functions

| Route | Purpose |
|---|---|
| `GET /api/health` | Health check — verifies env vars |
| `POST /api/webhooks/stripe` | Stripe payment events |
| `POST /api/webhooks/paypal` | PayPal IPN events |
| `POST /api/crossmint/mint` | Trigger NFT mint |
| `GET /api/discord/callback` | OAuth2 callback → role assignment |
| `GET /api/discord/check-membership` | Cron: verify active memberships |
| `POST /api/airtable/submit-lead` | Intake form submission |
| `GET /api/cron/retry-mints` | Cron: retry failed NFT mints |

---

## 2. Architecture Diagram

```
                        AUREVON AUTONOMOUS BACKEND
                        ====================================

  CUSTOMER JOURNEY
  ────────────────
  Customer visits aurevongroup.com
           │
           ▼
  Selects tier & clicks "Join Now"
           │
           ├─────────────────────────────────────┐
           ▼                                     ▼
    [Stripe Payment Link]              [PayPal Checkout]
    Card / Cash App / Afterpay         PayPal balance / card
           │                                     │
           ▼                                     ▼
    Stripe Checkout                    PayPal Order
           │                                     │
           └──────────────┬──────────────────────┘
                          │ Payment Confirmed
                          ▼
              ┌───────────────────────┐
              │  Vercel Serverless    │
              │  Webhook Handler      │
              │  /api/webhooks/stripe │
              │  /api/webhooks/paypal │
              └───────────┬───────────┘
                          │ Verify signature
                          │ Extract: email, tier, amount
                          ▼
              ┌───────────────────────┐
              │  Airtable             │
              │  Write: Payments row  │◄──────── Cron: /api/cron/retry-mints (hourly)
              └───────────┬───────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  Crossmint API        │
              │  Mint NFT to email    │
              │  Chain: Polygon       │
              └───────────┬───────────┘
                          │ mint_id
                          ▼
              ┌───────────────────────┐
              │  Airtable             │
              │  Write: NFT_Mints row │
              └───────────┬───────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  Resend               │
              │  Send confirmation    │
              │  email with NFT +     │
              │  Discord invite link  │
              └───────────┬───────────┘
                          │ Customer clicks link
                          ▼
              ┌───────────────────────┐
              │  Discord OAuth2       │
              │  /api/discord/        │
              │    callback           │
              └───────────┬───────────┘
                          │ Access token
                          ▼
              ┌───────────────────────┐
              │  Discord Bot          │
              │  Assign role for tier │
              │  Post welcome message │
              └───────────┬───────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  Airtable             │
              │  Update: Members row  │
              │  discord_joined = ✓   │
              └───────────────────────┘

  OPERATOR MONITORING
  ───────────────────
  operator.html ──► Airtable API ──► KPI tiles, leads table, mint log
                └─► Manual triggers (retry mint, resend email)

  DAILY CRON (8am UTC)
  ─────────────────────
  /api/discord/check-membership ──► verify roles still match paid status
```

---

## 3. Quick Start (15 Minutes)

Follow these steps in order. Each step has a time estimate.

### Step 1 — Fork / Clone the Repo (1 min)

```bash
git clone https://github.com/YOUR_ORG/blockt-ventures-site.git
cd blockt-ventures-site/site
npm install
```

### Step 2 — Create Accounts (5 min total, mostly clicking)

Open all six tabs and create accounts if you haven't:

| Service | URL | Free tier |
|---|---|---|
| Stripe | https://dashboard.stripe.com/register | Yes |
| PayPal Business | https://www.paypal.com/us/bizsignup | Yes |
| Crossmint | https://www.crossmint.com/signin | Yes (staging) |
| Resend | https://resend.com/signup | 3,000 emails/mo |
| Airtable | https://airtable.com/signup | 1,000 rows/base |
| Discord | https://discord.com/register | Free |

### Step 3 — Link to Vercel and Pull Env Vars (2 min)

```bash
# Install Vercel CLI globally if not already installed
npm install -g vercel

# Link this project to a Vercel project
vercel link

# Pull existing env vars from Vercel (if already configured)
vercel env pull .env.local

# OR: copy the template and fill in values manually
cp .env.example .env.local
```

### Step 4 — Fill in Environment Variables (5 min)

Open `.env.local` and fill in values for each service. See sections 4–9 below for exactly where to find each value.

The required minimum to go live:
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- `CROSSMINT_API_KEY` + `CROSSMINT_COLLECTION_ID` + template IDs
- `RESEND_API_KEY` + `RESEND_FROM_EMAIL`
- `AIRTABLE_PAT` + `AIRTABLE_BASE_ID`
- `DISCORD_BOT_TOKEN` + `DISCORD_CLIENT_ID` + `DISCORD_CLIENT_SECRET` + `DISCORD_GUILD_ID`

### Step 5 — Deploy to Production (1 min)

```bash
npm run deploy
# OR directly:
vercel --prod
```

Vercel prints your deployment URL (e.g., `https://blockt-ventures-xxxx.vercel.app`). Add your custom domain in the Vercel dashboard.

### Step 6 — Configure Webhooks (2 min)

After deploying, configure the webhook endpoints:

**Stripe:**
1. Go to https://dashboard.stripe.com/webhooks
2. Click "Add endpoint"
3. URL: `https://yourdomain.com/api/webhooks/stripe`
4. Select events: `checkout.session.completed`, `payment_intent.succeeded`, `customer.subscription.created`, `customer.subscription.deleted`
5. Copy the "Signing secret" (starts with `whsec_`) → paste into `STRIPE_WEBHOOK_SECRET` in Vercel env vars

**PayPal:**
1. Go to https://developer.paypal.com/dashboard/webhooks
2. Add webhook URL: `https://yourdomain.com/api/webhooks/paypal`
3. Select events: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.SALE.COMPLETED`, `BILLING.SUBSCRIPTION.ACTIVATED`

### Step 7 — Test the Full Flow (1 min)

```bash
npm run test:qa
```

Or manually: visit your deployed site → click a tier → use Stripe test card `4242 4242 4242 4242` → check Airtable for the new row → check your email for the confirmation.

---

## 4. Stripe Setup

### 4.1 Create Payment Links for Each Tier

Each Aurevon membership tier needs its own Stripe Payment Link so the customer lands on a pre-configured checkout.

1. Go to **Stripe Dashboard → Products → Payment Links → New**
2. Create a product for each tier with the correct price:

| Tier | Price | Billing |
|---|---|---|
| Insider | $297 | One-time |
| Ember | $497 | One-time |
| Obsidian Executive | $997 | One-time |
| 001 Genesis | $2,497 | One-time |
| 004 Chrome | $4,997 | One-time |
| RE Pro Retainer | $2,500 | Monthly |
| RE Enterprise | $5,000 | Monthly |

3. **Critical:** For each payment link, click **"Advanced options"** and add a metadata field:
   - Key: `tier`
   - Value: one of `insider`, `ember`, `obsidian`, `001_genesis`, `004_chrome`, `re_retainer`, `re_enterprise`

   This metadata field is how the webhook handler knows which NFT template to mint.

4. Collect the customer's email by enabling **"Collect customer's email address"** (required for NFT delivery).

5. For the Retainer and Enterprise tiers, set billing to **Recurring → Monthly**.

### 4.2 Configure the Webhook Endpoint

1. **Stripe Dashboard → Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://yourdomain.com/api/webhooks/stripe`
3. Select these events:
   - `checkout.session.completed` — fires after one-time purchases
   - `payment_intent.succeeded` — backup trigger
   - `customer.subscription.created` — fires for new retainer/enterprise subscriptions
   - `customer.subscription.deleted` — use to revoke Discord role on cancellation
4. Click **Add endpoint** → wait for the endpoint to appear
5. Click the endpoint → expand **Signing secret** → click **Reveal** → copy it
6. Add to Vercel env vars: `STRIPE_WEBHOOK_SECRET=whsec_xxxxx`

### 4.3 Enable Alternative Payment Methods

1. **Stripe Dashboard → Settings → Payment methods**
2. Toggle ON: **Cash App Pay**, **Afterpay / Clearpay**
3. These appear automatically in Stripe-hosted checkout — no code changes needed.

### 4.4 Test in Stripe Test Mode

Before going live, use Stripe's test mode:
- Test card: `4242 4242 4242 4242` (any future date, any CVC)
- Cash App Pay test: use the Stripe test environment controls
- Switch your API keys from `sk_test_` to `sk_live_` when ready to go live

---

## 5. PayPal Setup

### 5.1 Create a REST App

1. Go to https://developer.paypal.com/dashboard/applications/live
2. Click **Create App**
3. Name it "Aurevon"
4. Copy the **Client ID** and **Secret** → add to env vars

### 5.2 Create Payment Buttons

For one-time tiers, create PayPal Checkout buttons:
1. PayPal Business Dashboard → Pay & Get Paid → PayPal buttons
2. Set the amount to match the tier price
3. After payment, PayPal will POST to your IPN URL

### 5.3 Configure IPN (Instant Payment Notification)

1. **PayPal Business Dashboard → Account Settings → Notifications → Instant Payment Notifications**
2. IPN URL: `https://yourdomain.com/api/webhooks/paypal`
3. Enable IPN notifications

### 5.4 Configure Webhooks via API (Recommended)

For production, use the PayPal REST Webhooks API instead of IPN:
1. Developer Dashboard → [your app] → Webhooks → Add Webhook
2. URL: `https://yourdomain.com/api/webhooks/paypal`
3. Select: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.SALE.COMPLETED`
4. Copy the **Webhook ID** → add to `PAYPAL_WEBHOOK_ID` env var

### 5.5 Enable Subscriptions for Retainer / Enterprise

1. Your PayPal app must have the **Subscriptions** feature enabled
2. Contact PayPal Business support if not available — approval takes 1–3 business days
3. Create subscription plans matching the monthly retainer amounts

---

## 6. Crossmint NFT Setup

Crossmint allows you to mint NFTs directly to a customer's email — they can claim a wallet later, or never deal with crypto at all.

### 6.1 Sign Up and Verify Your Business

1. Go to https://www.crossmint.com/signin and sign up
2. Navigate to **Console → Settings → Business Verification**
3. Submit your business details (takes 1–2 business days for approval)
4. While waiting, you can develop on **Staging** environment

### 6.2 Create the "BLOCKT Genesis Drop" Collection

1. **Crossmint Console → Collections → Create Collection**
2. Name: `BLOCKT Genesis Drop`
3. Chain: `polygon` (recommended — fees average $0.01–0.05 per mint)
4. Collection type: `Semi-fungible (ERC-1155)` — allows multiple copies of each template
5. Upload a collection banner image
6. Copy the **Collection ID** → add to `CROSSMINT_COLLECTION_ID`

### 6.3 Create NFT Templates (One Per Tier)

For each membership tier, create a template in the collection:

1. **Collection → Templates → Create Template**
2. Use these names and descriptions:

**Insider Template**
- Name: `BLOCKT Insider`
- Description: `Foundation access to the Aurevon ecosystem. Community, education, and deal flow.`
- Image: Upload insider artwork (750×750px recommended)

**Ember Template**
- Name: `BLOCKT Ember`
- Description: `Elevated access with live Q&As, monthly deal breakdowns, and priority support.`
- Image: Upload ember artwork

**Obsidian Executive Template**
- Name: `BLOCKT Obsidian Executive`
- Description: `Premium membership with 1:1 advisory sessions, vetted deal access, and co-investment rights.`
- Image: Upload obsidian artwork

**001 Genesis Template**
- Name: `BLOCKT 001 Genesis`
- Description: `Founding member of the Aurevon Genesis cohort. Early access to all future drops, permanent Discord role, legacy pricing lock.`
- Image: Upload 001 Genesis artwork

**004 Chrome Template**
- Name: `BLOCKT 004 Chrome`
- Description: `Top-tier Aurevon membership. Direct founder access, Chrome-level co-investment rights, and lifetime benefits.`
- Image: Upload 004 Chrome artwork

3. After creating each template, copy its **Template ID** (format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
4. Add each to the corresponding `CROSSMINT_TEMPLATE_*` env var

### 6.4 Create a Server-Side API Key

1. **Crossmint Console → Settings → API Keys → Create Key**
2. Select **Server-side** (not client-side)
3. Scope: at minimum, enable `nfts.create` and `nfts.read`
4. Copy the key → add to `CROSSMINT_API_KEY`
5. Change `CROSSMINT_ENVIRONMENT` to `production` when verified

### 6.5 Go Live on Polygon Mainnet

1. Ensure your Crossmint business is verified
2. Fund your Crossmint wallet with a small amount of MATIC for gas (usually auto-handled by Crossmint)
3. Set `CROSSMINT_CHAIN=polygon` and `CROSSMINT_ENVIRONMENT=production`
4. Do a live test mint using a real email address

---

## 7. Resend Email Setup

Resend is a developer-first transactional email service. It handles all Aurevon customer emails.

### 7.1 Create Account and Verify Domain

1. Sign up at https://resend.com/signup
2. Go to **Settings → Domains → Add Domain**
3. Enter your domain (e.g., `aurevongroup.com`)
4. Resend shows you DNS records to add:
   - **SPF record** (TXT): add to your DNS provider (Cloudflare, GoDaddy, etc.)
   - **DKIM record** (TXT): two records, add both
   - **DMARC record** (optional but recommended): `v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com`
5. Click **Verify** in Resend — DNS propagation can take up to 24 hours

### 7.2 Generate an API Key

1. **Resend Dashboard → API Keys → Create API Key**
2. Name it: `BLOCKT Production`
3. Permission: **Full access** (needed to send and check email status)
4. Copy the key → add to `RESEND_API_KEY`
5. Set `RESEND_FROM_EMAIL=noreply@aurevongroup.com` (must be on your verified domain)

### 7.3 Email Templates

The webhook handler sends two emails:
- **Confirmation email** — sent immediately after payment, includes NFT metadata and Discord link
- **Welcome email** — sent after Discord role is assigned, includes onboarding guide

You can customize email HTML in `/api/email/templates/` (created by the email agent).

### 7.4 Monitor Deliverability

- **Resend Dashboard → Emails** — see every sent email, open rate, bounce, complaints
- Target: <0.1% bounce rate, <0.05% complaint rate
- If bounces spike, check DNS records are still valid

---

## 8. Airtable Setup

The Aurevon Airtable base is the central data store for all payments, NFT mints, leads, and members. The Operator Hub reads from it directly.

### 8.1 Get Your Personal Access Token (PAT)

1. Go to https://airtable.com/create/tokens
2. Click **Create new token**
3. Name: `BLOCKT Production`
4. Scopes: `data.records:read`, `data.records:write`, `schema.bases:read`
5. Access: select your Aurevon base
6. Copy the token (starts with `pat`) → add to `AIRTABLE_PAT`

### 8.2 Get Your Base ID

1. Go to https://airtable.com/api
2. Select your Aurevon base
3. The URL contains your Base ID: `https://airtable.com/appXXXXXXXXXXXXX/api/docs`
4. Copy `appXXXXXXXXXXXXX` → add to `AIRTABLE_BASE_ID`

### 8.3 Required Tables and Fields

Your base must have these tables with these field names (exact match):

**Payments table:**
| Field | Type | Notes |
|---|---|---|
| id | Auto number | Primary key |
| email | Email | Customer email |
| tier | Single line text | `insider`, `ember`, etc. |
| amount | Currency | Payment amount |
| payment_provider | Single select | `stripe` or `paypal` |
| payment_id | Single line text | Stripe session ID or PayPal order ID |
| status | Single select | `pending`, `completed`, `failed` |
| created_at | Date/time | Set automatically |

**NFT_Mints table:**
| Field | Type | Notes |
|---|---|---|
| payment_id | Single line text | FK to Payments |
| email | Email | Customer email |
| tier | Single line text | Tier name |
| crossmint_order_id | Single line text | From Crossmint API |
| chain | Single line text | `polygon` |
| status | Single select | `pending`, `minted`, `failed` |
| mint_at | Date/time | When minted |
| retry_count | Number | Increments on retry |

**Leads table:**
| Field | Type | Notes |
|---|---|---|
| name | Single line text | From intake form |
| email | Email | From intake form |
| phone | Phone | From intake form |
| service | Single line text | RE service requested |
| message | Long text | Additional details |
| status | Single select | `new`, `contacted`, `qualified`, `closed` |
| created_at | Date/time | Submission timestamp |

**Members table:**
| Field | Type | Notes |
|---|---|---|
| email | Email | Member email |
| tier | Single line text | Current tier |
| discord_id | Single line text | Discord user ID after OAuth |
| discord_joined | Checkbox | True after OAuth completes |
| nft_token_id | Single line text | On-chain token ID |
| active | Checkbox | True while subscription active |
| joined_at | Date/time | First payment date |

### 8.4 Airtable PAT in Operator Hub

The Operator Hub (`operator.html`) reads Airtable directly from the browser using your PAT:
1. Open `operator.html` in your browser
2. Click **"Enter PAT"** when prompted
3. Paste your PAT — it is stored in `localStorage` and never sent to any server
4. Data loads immediately

---

## 9. Discord Setup

See the full Discord setup guide in [`api/discord/SERVER_SETUP.md`](api/discord/SERVER_SETUP.md). Summary:

### 9.1 Create a Discord Application and Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it "AUREVON"
3. Go to **Bot** → click **Add Bot** → confirm
4. Under **Token** → click **Reset Token** → copy it → `DISCORD_BOT_TOKEN`
5. Enable **Server Members Intent** and **Message Content Intent** (under Privileged Gateway Intents)

### 9.2 Configure OAuth2

1. Go to **OAuth2 → General**
2. Add redirect URI: `https://yourdomain.com/api/discord/callback`
3. Copy **Client ID** → `DISCORD_CLIENT_ID`
4. Copy **Client Secret** → `DISCORD_CLIENT_SECRET`

### 9.3 Invite the Bot to Your Server

1. **OAuth2 → URL Generator**
2. Scopes: `bot`, `applications.commands`
3. Bot permissions: `Manage Roles`, `Send Messages`, `Read Message History`, `View Channels`
4. Copy the generated URL → open in browser → select your server → Authorize

### 9.4 Create Membership Roles

In your Discord server, create one role per tier:
1. Server Settings → Roles → Create Role
2. Name each role: `Insider`, `Ember`, `Obsidian Executive`, `001 Genesis`, `004 Chrome`, `RE Pro Retainer`, `RE Enterprise`
3. Right-click each role → Copy ID → add to the corresponding `DISCORD_ROLE_*` env var
4. Ensure the bot's role is higher than all membership roles in the hierarchy

### 9.5 Get Your Guild ID

1. In Discord, enable Developer Mode: Settings → Advanced → Developer Mode
2. Right-click your server icon → **Copy Server ID**
3. Add to `DISCORD_GUILD_ID`

---

## 10. Operator Hub Usage

The Operator Hub (`https://yourdomain.com/operator.html`) is your real-time command center.

### KPI Tiles
- **Total Revenue** — sum of `amount` from Payments where `status = completed`
- **Active Members** — count of Members where `active = true`
- **Pending Mints** — count of NFT_Mints where `status = pending`
- **New Leads (7d)** — count of Leads created in last 7 days

### Leads Table
- Filterable by status: New, Contacted, Qualified, Closed
- Click any row to see full lead detail
- "Send Intro Email" button triggers a Resend email to the lead
- "Mark Contacted" updates the Airtable status

### NFT Mint Log
- Shows all mints with status indicators (minted = green, pending = yellow, failed = red)
- "Retry" button on failed mints calls `/api/cron/retry-mints` with that specific record
- Crossmint order ID links to the Crossmint console

### Payments Feed
- Real-time list of payments, newest first
- Stripe and PayPal payments appear together
- Click to see the full Stripe session or PayPal order in the respective dashboard

### Automation Playbooks
- 8 pre-configured automation playbooks (see `AUTOMATION_PLAYBOOKS.md`)
- Toggle each playbook ON/OFF from the hub
- Status shows last run time and result

### Refresh
- KPI tiles auto-refresh every 60 seconds
- Click **Refresh** button to force an immediate reload
- PAT is stored in `localStorage` — click **Change PAT** if you rotate your Airtable token

---

## 11. QA Checklist

Print this before going live. Mark each item.

### Deployment
- [ ] `vercel env pull` returns all expected vars
- [ ] `vercel --prod` completes without errors
- [ ] Custom domain is pointed (A record or CNAME)
- [ ] SSL certificate is active (green lock in browser)
- [ ] `/api/health` returns `{"status":"ok","env":"complete"}`

### Stripe
- [ ] Payment link opens for each of the 7 tiers
- [ ] Test purchase with card `4242 4242 4242 4242` succeeds
- [ ] Stripe dashboard shows the test payment
- [ ] Webhook fires (visible in Stripe → Developers → Webhooks → [endpoint] → Recent deliveries)
- [ ] Webhook returns HTTP 200 (not 4xx or 5xx)

### PayPal
- [ ] PayPal sandbox test purchase completes
- [ ] IPN fires and returns HTTP 200
- [ ] PayPal dashboard shows the test payment

### Crossmint
- [ ] Test mint from staging environment succeeds
- [ ] NFT appears in the Crossmint staging console
- [ ] Customer email receives NFT confirmation from Crossmint

### Resend
- [ ] Domain is verified (green checkmark in Resend → Domains)
- [ ] Test email sends successfully
- [ ] Email lands in inbox (not spam)
- [ ] Confirmation email template renders correctly

### Airtable
- [ ] PAT authenticates successfully in Operator Hub
- [ ] After test payment, a new row appears in Payments table
- [ ] After test mint, a new row appears in NFT_Mints table
- [ ] After intake form submission, a new row appears in Leads table

### Discord
- [ ] Bot is online in your server (green dot)
- [ ] Bot has correct role hierarchy (above all membership roles)
- [ ] OAuth link from confirmation email opens Discord authorization page
- [ ] After authorizing, correct role is assigned
- [ ] Airtable Members row shows `discord_joined = true`

### Pages
- [ ] `index.html` loads without console errors
- [ ] `BLOCKT_Web3.html` loads
- [ ] `BLOCKT_NFT_Collection.html` loads
- [ ] `001_Genesis.html` loads
- [ ] `004_Chrome.html` loads
- [ ] `BLOCKT_RE_Final.html` loads
- [ ] `BLOCKT_RE_Intake.html` shows gate for unauthenticated users
- [ ] `membership_confirmation.html` loads
- [ ] `operator.html` loads and populates data

### Mobile
- [ ] Index page renders at 390px width (iPhone 14)
- [ ] Navigation menu is usable on mobile
- [ ] Payment modals open on mobile
- [ ] Intake form is usable on mobile

---

## 12. Troubleshooting

### Error: "Webhook signature verification failed"
**Cause:** The `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint's signing secret.
**Fix:**
1. Go to Stripe Dashboard → Developers → Webhooks → [your endpoint]
2. Click "Reveal" next to Signing secret
3. Update `STRIPE_WEBHOOK_SECRET` in Vercel env vars
4. Redeploy: `vercel --prod`

### Error: "Crossmint 403 Forbidden"
**Cause:** API key doesn't have `nfts.create` permission, or business isn't verified yet.
**Fix:**
1. Go to Crossmint Console → Settings → API Keys → [your key]
2. Ensure `nfts.create` is checked
3. Check Business Verification status

### Error: "Airtable 422 Unprocessable Entity"
**Cause:** A field name in the API call doesn't match the actual Airtable field name.
**Fix:**
1. Open Airtable base → the exact field names are case-sensitive
2. Check `AIRTABLE_TABLE_PAYMENTS`, `AIRTABLE_TABLE_LEADS`, etc. match exactly
3. Field names in the API calls must match the table schema

### Error: "Discord 50013 Missing Permissions"
**Cause:** The bot's role is below the membership role it's trying to assign.
**Fix:**
1. Discord Server Settings → Roles
2. Drag the "AUREVON" bot role ABOVE all membership roles in the list
3. The role hierarchy must be: Bot > 004 Chrome > 001 Genesis > ... > Insider

### Error: "Resend 403 — Domain not verified"
**Cause:** DNS records haven't propagated yet, or SPF/DKIM records are missing.
**Fix:**
1. Resend Dashboard → Domains → [your domain] → Check DNS
2. Add any missing records to your DNS provider
3. Wait up to 24 hours for propagation
4. Click Verify again

### NFT never delivered (mint stuck in "pending")
**Cause:** Crossmint API returned an error, or the mint is queued.
**Fix:**
1. Check `/api/health` — if Crossmint env vars are missing, add them
2. Check Crossmint Console → Orders for the order status
3. Run `npm run test:qa` to trigger a retry
4. Check the NFT_Mints table — `retry_count` shows how many attempts

### Operator Hub shows no data
**Cause:** PAT is expired, invalid, or doesn't have access to the base.
**Fix:**
1. Generate a new PAT at https://airtable.com/create/tokens
2. In Operator Hub, click "Change PAT" and paste the new token
3. Verify the PAT has `data.records:read` scope for your base

### PayPal webhook not firing
**Cause:** IPN might be disabled, or the webhook URL is wrong.
**Fix:**
1. Verify the webhook URL in PayPal is exactly: `https://yourdomain.com/api/webhooks/paypal`
2. No trailing slash, no query parameters
3. Check PayPal Developer Dashboard → [app] → Webhooks for recent delivery attempts

### Vercel 504 Gateway Timeout on webhooks
**Cause:** Webhook handler is taking too long (limit is 30s).
**Fix:**
1. Check `vercel.json` — `maxDuration` should be 30 for webhook functions
2. If Crossmint is slow, move the mint to an async queue
3. Return HTTP 200 to Stripe immediately and process asynchronously

### "Cannot read properties of undefined" in operator.html
**Cause:** Airtable returned unexpected data structure.
**Fix:**
1. Open browser DevTools → Console — the error shows which field is null
2. Check the Airtable table has all required fields as listed in section 8.3
3. The field may be empty for old records — add a null-check in the Operator Hub JS

---

## 13. Cost Breakdown

All costs at the time of writing. Check service websites for current pricing.

### Vercel
| Feature | Free (Hobby) | Pro ($20/mo) |
|---|---|---|
| Serverless functions | 100 GB-hours/mo | 1,000 GB-hours/mo |
| Bandwidth | 100 GB/mo | 1 TB/mo |
| Cron jobs | 2 cron jobs | Unlimited |
| Deployments | Unlimited | Unlimited |
| Custom domains | Yes | Yes |
| **Recommendation** | Start free | Upgrade at ~500 members |

**Note:** With 2 cron jobs (retry-mints + check-membership), the free tier is sufficient to start. You'll need Pro if you add more crons.

### Stripe
- **Card processing:** 2.9% + $0.30 per successful charge
- **Cash App Pay:** 2.9% + $0.30
- **Afterpay:** 6% + $0.30 (Stripe receives this; Afterpay manages installments)
- **International cards:** +1.5%
- **Subscriptions (retainer/enterprise):** Same rates, charged monthly automatically
- **No monthly fee**

At $10,000/month revenue, Stripe fees ≈ $320.

### PayPal
- **Standard:** 3.49% + $0.49 per transaction
- **PayPal Checkout:** 3.49% + $0.49
- **Subscriptions:** 3.49% + $0.49/mo per subscription
- **No monthly fee**

PayPal is typically 0.6% more expensive than Stripe. Offer it for customer preference.

### Crossmint
- **Staging:** Free (unlimited test mints)
- **Production minting fee:** ~$0.10–$0.30 per NFT mint (Crossmint takes a fee)
- **Gas fees (Polygon):** ~$0.01–$0.05 per mint (paid from your Crossmint wallet)
- **Total per mint:** ~$0.15–$0.40

At 100 mints/month, cost ≈ $15–$40.

### Resend
| Plan | Price | Emails/month |
|---|---|---|
| Free | $0 | 3,000 |
| Pro | $20/mo | 50,000 |
| Scale | $90/mo | 100,000 |

At 1 email per member + 1 per lead, 500 members uses ~1,000/month. Free tier works well into growth.

### Airtable
| Plan | Price | Rows/base |
|---|---|---|
| Free | $0 | 1,000 |
| Team | $20/seat/mo | 50,000 |

At 1,000 payments + 1,000 members + leads, you'll hit the free tier around 300–400 members. Upgrade to Team when approaching the limit.

### Discord
- **Free forever** for servers
- **Discord Nitro** (optional): $9.99/mo — gives you more emoji slots, better audio quality for voice channels

### Total Estimated Monthly Cost at Launch
| Service | Cost |
|---|---|
| Vercel | $0 (free tier) |
| Stripe fees (at $5,000 revenue) | ~$175 |
| PayPal fees (at $2,000 revenue) | ~$90 |
| Crossmint (50 mints) | ~$20 |
| Resend | $0 (free tier) |
| Airtable | $0 (free tier) |
| Discord | $0 |
| **Total overhead** | **~$285/month** |

---

## 14. Roadmap

### Near Term (Next 90 Days)
- **Investments module:** `/investments.html` — curated deal flow for 001 Genesis and 004 Chrome members, with real-time cap table updates via Airtable
- **Live Q&A scheduling:** Calendly integration so Ember+ members can book monthly advisor calls
- **Referral program:** Unique referral links for members, tracked in Airtable, with automatic tier upgrade on 3 successful referrals
- **Mobile app (PWA):** Progressive Web App wrapper for the membership portal — installable on iOS and Android

### Mid Term (6 Months)
- **IoT portfolio tracking:** Connect Aurevon's physical asset holdings (real estate sensors, energy monitors) to the Operator Hub
- **On-chain revenue sharing:** Smart contract that distributes a % of deal profits to 001 Genesis and 004 Chrome holders
- **Multi-chain NFTs:** Expand from Polygon to Solana (lower fees, larger NFT community)
- **White-label licensing:** License the autonomous backend to other investment communities

### Long Term (12+ Months)
- **DAO governance:** Convert to a member-governed DAO where tier holders vote on investment decisions
- **DeFi integration:** Connect to Aave/Compound for yield on idle treasury funds
- **Institutional tier:** Enterprise+ tier for family offices, $25K/year, with dedicated advisors and direct co-investment rights
- **Custom blockchain:** Aurevon Chain — purpose-built L2 for investment community tokens and governance
