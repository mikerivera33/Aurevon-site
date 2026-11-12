# CLAUDE.md — Aurevon Site

Read this BEFORE you start any task on this repo. It exists to stop the false-positive findings that cost a re-do (brand renames, "dead" config that isn't dead, refactor recommendations that miss intent).

## What this is

`aurevonvc.com` — vanilla HTML + Vercel serverless functions for **Aurevon Ventures LLC** (parent) and its three product surfaces.

- **No framework.** No React, no Next.js, no build step. 23 hand-written HTML files at the repo root + 5 under `nfts/`. ES-module Node functions in `/api/*`. The `framework: null` + `buildCommand: null` in `vercel.json` is intentional.
- **Deployed on Vercel** (Pro). Static files served as-is; `/api/*` files become serverless functions automatically.
- **Tests:** Vitest (run with `npm test`). **Lint:** ESLint on `api/` only (no frontend bundler to lint).

## Brand naming — the #1 source of false positives

**Aurevon Ventures LLC** is the parent. Three product surfaces underneath:

| Public brand | URL slug | What it is | Status |
|---|---|---|---|
| **Aurevon Capital** | `/aurevon-re` | Real-estate underwriting service. Public brand on the page; "Aurevon RE" appears only as URL/footer/nav slug. | Live |
| **Aurevon Capital Investments** | (none yet) | Separate future CRE acquisition arm. Listed on home page as "Coming 2026". | Future, distinct product |
| **Aurevon Labs** | `/aurevon-web3`, `/aurevon-nft` | Web3 / NFT / community subsidiary of Aurevon Ventures LLC. | Live |

**Never rename "Aurevon Capital" → "Aurevon RE" as a "consistency fix."** They are different things: Aurevon Capital is the *brand*, `/aurevon-re` is the *route*. The audit subagent that did this in PR #21 was wrong.

## The 5 canonical NFTs

These are the **only** NFT products that exist. If anything looks like it suggests a 6th, that's a bug.

| NFT | Earned by | Discord role env | Collection override env |
|---|---|---|---|
| **Aurevon Insider** | Full Package ($250) purchase | `DISCORD_ROLE_PRODUCT_A` | `CROSSMINT_COLLECTION_PRODUCT_A` |
| **Aurevon Ember** | Pro Retainer ($1,499/mo) subscription | `DISCORD_ROLE_PRODUCT_B` | `CROSSMINT_COLLECTION_PRODUCT_B` |
| **Aurevon Obsidian Executive** | Enterprise ($2,499/mo) subscription | `DISCORD_ROLE_PRODUCT_C` | `CROSSMINT_COLLECTION_PRODUCT_C` |
| **001 Genesis** | Community Monthly ($29.99/mo) | `DISCORD_ROLE_MONTHLY` | `CROSSMINT_COLLECTION_MONTHLY` |
| **004 Chrome** | Community Lifetime ($349.99) | `DISCORD_ROLE_LIFETIME` | `CROSSMINT_COLLECTION_LIFETIME` |

An unset collection override falls back to `CROSSMINT_COLLECTION_ID`. `CROSSMINT_TEMPLATE_*` are no longer read (metadata is sent inline with each mint); the `template` / `templateEnv` fields left in `tiers.js` / `entitlements.js` are inert.

Canonical mapping lives in `api/_lib/tiers.js _BASE` and `api/_lib/entitlements.js ENTITLEMENT_MAP`. The wire copy "Tier 1 Genesis for Full Package" (anywhere) is **wrong** — Full Package → Insider.

## Pricing (canonical)

Source of truth: `api/stripe/checkout.js PRODUCT_CATALOG` + `api/_lib/tiers.js _BASE`. If the displayed price disagrees with the catalog, fix the displayed price, not the catalog.

**Aurevon Capital (RE):**
- BOGO First-Timer: $299.99 · Second Opinion: $189.99 · Full Package: $250 · Pro Retainer: $1,499/mo · Enterprise: $2,499/mo

**Add-ons (à la carte, no NFT):**
- 12-Hour Rush: $99 · Investor Memo: $149 · Lender Presentation: $199 · Sensitivity Modeling: $125 · Portfolio Review: $499 · White-Label Reports: $175

**Community (Aurevon Labs):**
- Community Monthly: $29.99/mo · Community Lifetime: $349.99

## Tier-key conventions (read before flagging "wrong key")

`api/stripe/checkout.js PRODUCT_CATALOG` uses **prefixed keys** for the customer-facing checkout entry-points:
- `re_full`, `re_bogo`, `re_single`, `re_retainer`, `re_enterprise` (NOT bare `full`/`bogo`/etc.)
- `comm_monthly`, `comm_lifetime`, `addon_*`

`api/_lib/tiers.js _BASE` uses **bare keys** as the canonical webhook-side resolution:
- `full`, `bogo`, `single`, `retainer`, `enterprise`, `comm_monthly`, `comm_lifetime`, `deal`, `addon_*`

The two are bridged by a Proxy + alias map in `tiers.js` so webhook handlers can read `metadata.tier = "re_full"` and get the correct entitlement. **This is intentional.** Don't "unify" the keys without understanding the checkout↔webhook split.

## Page design rule (Nov 2026 simplicity pass)

Headings, facts, actions. No eyebrow labels, taglines, intro paragraphs under headings, "Live Now" badges, decorative emoji, or helper text that explains the obvious. If a section only makes sense with extra copy, fix the layout or the heading instead. Keep verbatim: prices, what's included, legal/disclaimer text, form labels, JS-referenced ids. Footer is `© <year> Aurevon Ventures LLC` + links. Text on blue gradient buttons is white (contrast). Only hero sections are full-height. Owner-only notes (Printify setup, merch margins) live in `docs/merch-printify.md`, not in public HTML.

## Data layer — Supabase Postgres (replaced Airtable, Nov 2026)

- `api/_lib/db.js` is the only module that talks to the database (supabase-js, secret key, server-only). It keeps the old Airtable record shape `{ id, fields: { 'Mint Status': … } }`; `FIELDS` maps display names to columns, and writing an unknown field throws.
- Schema lives in `supabase/migrations/` (not deployed). Tables: `members`, `payments`, `nft_mints`, `customer_auth`, `leads`, `nft_serials`, `ops_events`. RLS is on with no policies and the anon/authenticated roles have no grants — the publishable key can read nothing. Don't add client-side Supabase access without designing policies first.
- `payments.transaction_id` is UNIQUE: `createPayment` is the atomic webhook idempotency marker. A concurrent redelivery gets `err.code === 'DUPLICATE_PAYMENT'` and the webhook returns quietly — that is not an error.
- Owner consoles (`aurevon-crm.html`, `operator.html`) read through `/api/admin/data` with `Authorization: Bearer <ADMIN_SECRET>`; only lead `Status`/`Notes`/`Analyst` are writable there. Owners can also edit rows in the Supabase Table Editor.
- Deal intake: the form still posts to Formspree (owner email + attachments); `/api/intake/submit` re-verifies payment and saves the lead to Supabase.
- `discord/bot.js` (Google Compute Engine VM, see `deploy/gcp/README.md`) reads/writes the same tables via Supabase REST with its own `SUPABASE_URL` + `SUPABASE_SECRET_KEY`.

## Archive index — code that's been removed but kept for re-activation

| What | Where | Why archived | How to re-activate |
|---|---|---|---|
| `web3_starter/growth/scale/enterprise` subscription tiers (4 products, $49/$149/$349/$799) | `api/_lib/_archived/web3-subscription-tiers.js` | No UI sold them on `/aurevon-web3`; risk of advertising products with no buy button | See 10-step header in that file |
| `setup-wizard.html` | Deleted Nov 2026 — git history has it | Stale 7-tier model and retired template env names | Don't. Owner setup lives in `docs/nft-pipeline-setup.md` |
| `api/email/send.js` (+ `/api/email/send` rewrite) | Deleted Nov 2026 — git history has it | Stale prices; nothing called it. Transactional email is `api/_lib/email.js` | Don't. Add templates to `api/_lib/email.js` |

If you're about to flag a missing "Web3 Starter" product — first check the archive. It's deliberate, not a bug.

## Intentional patterns that look like bugs (don't flag)

Each of these has been flagged by a code-review or audit subagent and is **not** a bug:

1. **Inline `onclick=` / `onsubmit=` handlers everywhere** (100+ across all HTML files). Vanilla site, no event-delegation framework. The enforcing `Content-Security-Policy` in `vercel.json` allows `'unsafe-inline'` for scripts/styles to permit these — necessary trade-off, documented.
2. **Inline `<style>` attributes** — same reason. No build step to extract.
3. **`<img src="assets/MAIN AUREVON HEADER.png">` with literal spaces** — browsers auto-encode for `<img src>` (lenient). For `<source srcset>` and `<link rel=preload>` use `%20` (strict). The `site-guards.test.js` test enforces this.
4. **`framework: null` + `buildCommand: null` in `vercel.json`** — static site, deliberate.
5. **`installCommand: null`** — `package.json` has `engines.node: 24.x` (Vercel discontinued Node 20 builds); Vercel auto-runs `npm install` for `/api/*` deps.
6. **`images:` block in `vercel.json` but no `/_vercel/image` references** — forward-looking config, not dead. Allows the optimizer if we ever wire it up.
7. **Single global enforcing CSP without per-page customization** — one policy in `vercel.json` is fine for a static site.
8. **`NFT_TIERS = new Set()` (empty) in `checkout.js`** — pre-existing, the branch is unreachable; not from any recent PR; not in scope to clean up unless you're doing a checkout.js refactor.
9. **`api/_lib/tiers.js` Proxy with `re_*` aliases** — see "Tier-key conventions" above.
10. **`vercel.json` `"/cancel"` rewrite is GONE** as of PR #21. Stripe checkout builds per-session cancel URLs (`checkout.js:196`).
11. **`docs/` is `.vercelignore`d** — design briefs, brand masters, this file's neighbors. None of it ships.
12. **`apple-touch-icon.png` is 194 KB at root** — under the 500 KB CI budget; iOS retina home-screen icon needs the resolution. Don't shrink.
13. **`/motion/` is a vendored package, not site code** — the shared motion-lightning background (same as labs.aurevonvc.com and forge.aurevonvc.com). This repo's `motion/` is the **canonical copy**; Forge-ai's `storefront/public/motion/` must be byte-identical. Change it only as described in `motion/README.md` (bump `VERSION`, regenerate `MANIFEST.json`, copy to Forge). `ticker.js`, `lightning.js`, `scene3d.js` and `vendor/` are verbatim from Labs — don't "clean them up". The vendored three.js is ~800 KB but lazy-loaded after `load`. Every public page carries one stylesheet link + four script tags; admin consoles don't (guarded by `motion-background.test.js`).
14. **NFT pass pages (`nfts/*.html`) have no `perspective` on `<body>`** — deliberately removed: it made `<body>` the containing block for the fixed motion layers. The card's spin was flat before and still is.
15. **`/motion/*` caching is split** — bootstraps/CSS `max-age=0, must-revalidate` (an update can never mix versions), `motion/vendor/*` one week. Don't collapse into one long-cache rule.
16. **`__CHECKOUT__…` redirects in `vercel.json`** — the buy buttons carry `href="__CHECKOUT__<tier>"` placeholders that a click handler turns into a Stripe session. The redirects only catch a raw navigation (crawler, open-in-new-tab): `comm_*` → `/aurevon-web3#community-nft`, everything else → `/aurevon-re#pricing`.
17. **Pay-modal Cash App / Afterpay tabs open the same Stripe Checkout** (dynamic payment methods). The link carries `?payment_method=…` after the tier; the handler strips it and sends it as `paymentMethod`. Afterpay is hidden for subscriptions (`retainer`, `enterprise`, `comm_monthly`) because Stripe can't charge a subscription with it, and the API refuses that combination.

18. **Deal-intake gate is server-verified** — `aurevon-re-intake.html` unlocks only via `POST /api/intake/verify` with a Stripe `session_id` (retrieved live, must be `paid`) or a PayPal `txn_id`/`tx` (Payments row `Succeeded`), and only for underwriting tiers (`bogo|single|full|retainer|enterprise|deal`, `re_` optional). Client-minted `paid_…` tokens are not proof. The form itself still posts to Formspree from the browser (follow-up: server submit proxy).
19. **Stripe subscription identity** — checkout stamps only `tier` into `subscription_data.metadata` (never the unauthenticated request email). Lifecycle handlers resolve the member from the **Stripe Customer** first, ignore `incomplete_expired` subs, and hold a monthly cancel/past-due (alert `stripe.monthly_change_held`) when the email has another active monthly sub or the scan can't complete.
20. **Discord grants every grantable pass's role** — `findActiveMintsByEmail` + `grantableEntitlements` / `grantableRoleIds` (entitlements.js): a lapsed monthly Genesis row never hides a permanent pass; a cancelled monthly member isn't re-granted. `pickGrantableMint` remains only for compatibility. The bot uses `discord/entitlements.js` (parity-tested). A paid monthly checkout resets `Billing State` to active (gated on the live subscription status).

## CI guards (`.github/workflows/deploy.yml`) — what they actually enforce

Whole-tree scoped (`**/*.html`, `find . -type f --not -path './docs/*'`):

1. **Asset budget**: any image > 500 KB fails. Suggests pngquant / cwebp / `<picture>` migration.
2. **Critical asset refs**: `<link rel=icon>`, `<link rel=apple-touch-icon>`, `<meta property=og:image>`, `<meta name=twitter:image>` must all point to files that exist on disk. Catches dead links after asset deletions.
3. **Analytics coverage**: every HTML must include both Speed Insights + Web Analytics scripts before `</head>`, AND must NOT include the legacy `cdn.vercel-insights.com/v1/script.js` (causes double-counted pageviews).

If you're touching analytics or assets, run the guards locally before pushing — they fail in CI otherwise.

## Production configuration that the code depends on (verified 2026-11-02)

- **Stripe webhook events** — the live endpoint `https://www.aurevonvc.com/api/webhooks/stripe` must be subscribed to all 9 in `api/_lib/stripe-events.js REQUIRED_STRIPE_EVENTS`: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`. Authed `/api/health` reports any missing (`missing_events`). On 2026-11-02 only 3 were enabled.
- **Supabase** — project `aurevon-site` (ref `mcpgkrumizsaygasoovn`, us-east-1, org on Pro). Vercel needs `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) from the Supabase → Vercel integration, plus `ADMIN_SECRET` for the owner consoles. `GET /api/health` reports `database: ok|unconfigured|unavailable`. While `AIRTABLE_PAT` + `AIRTABLE_BASE_ID` stay set, the nightly reconcile copies any leftover Airtable rows into Supabase (`api/_lib/airtable-import.js`); remove them once it reports nothing new.

## NFT fulfilment

- `api/_lib/fulfil.js fulfilNft()` is the only mint path: Stripe, PayPal, manual mints (`/api/crossmint/mint` → `claim.js handleMint`) and retries all go through it, after the caller has written its `payments` marker.
- One mint per NFT-earning payment, deduped by `nft_mints.payment_transaction_id` (UNIQUE). Serials come from `next_serial()` (`nft_serials`). Subscription renewals never mint.
- Crossmint: idempotent `PUT /2022-06-09/collections/{id}/nfts/{paymentTxnId}` to the recipient `email:<email>:<chain>`, metadata inline. `/api/webhooks/crossmint` verifies Svix (`whsec_` secret) and handles `nfts.create.succeeded` / `nfts.create.failed`.
- Honest emails: "minted" only after a successful mint; otherwise "Payment received", NFT being finalized.
- Stripe webhook writes the Payments marker before acking (500 on DB failure so Stripe redelivers). Full refunds and disputes revoke the pass and its role (for subscriptions, only the first invoice).
- PayPal IPN verifies with PayPal and writes the Payments marker before acking (`acceptIPN`): verify error / DB failure → 500 so PayPal redelivers; INVALID → 200, no writes. Mint / email run in `waitUntil` after the 200.
- Retry key: `nfts.create.failed` bumps `nft_mints.mint_key_suffix`; the next retry mints under `<payment>-r<n>`. A synchronous HTTP error / timeout keeps the same key (that PUT may have landed).
- Reconcile polls Crossmint (`GET /actions/{id}`) for up to 20 rows stuck in `Sent` > 60 min and settles them through the webhook's own `settleMintSucceeded` / `settleMintFailed`.
- Reconcile retries `failed` Discord syncs (> 6 h old, 20 per run); after 3 consecutive failures (`members.discord_sync_attempts`) it stops and alerts `discord.sync_gave_up`.
- Crons: `/api/cron/retry-mints` every 15 min (backoff via `nft_mints.next_retry_at`, gives up after 8 → `retry_mints.gave_up`); `/api/cron/reconcile` daily 02:00 UTC (orphans, unrecorded Stripe sessions, pending Discord syncs, revocations). Heartbeats in `ops_events`.
- Alerts: `ALERT_WEBHOOK_URL` (warn and above) + `OWNER_ALERT_EMAIL` via Resend (high/critical), deduped through `ops_events`.
- Health: public `GET /api/health` → `{ ok, status, database }`. With `Authorization: Bearer <INTERNAL_API_SECRET>` it returns the full readiness report and 503 when not ready.

## Required env vars

Names, by purpose, plus the owner setup checklist: `docs/nft-pipeline-setup.md`. Authed `/api/health` reports what's missing or misnamed. `.env.example` has placeholders only.

Local dev WILL fail at the catalog → Stripe step because `STRIPE_SECRET_KEY` is unset. That's expected — it means you got past the catalog lookup.

## Workflow

1. **Branch:** `claude/<short-description>-Sz1pk` from `main`
2. **Commits:** descriptive; multi-line body when the change has multiple concerns
3. **Tests:** `npm test` (Vitest, ~880 tests across 47 files) + `npm run lint` (must be clean)
4. **PR:** squash-merge to `main`; Vercel auto-deploys to production on merge
5. **Verify:** after merge, hit `https://www.aurevonvc.com` with `curl` to confirm new behavior, not the preview URL (preview is deployment-protected → HTTP 401)

## Known limitations (don't fix unless asked)

1. **Function count is computed** — `api/health.js` counts `api/**` functions at load (no hardcoded literal any more). Project is on **Pro**, so the 12-function Hobby cap doesn't bind.
2. **`/merch` Snipcart placeholder key** — `SNIPCART_KEY_PENDING_SETUP`. Real key needs to be set in Vercel env; until then `/merch` checkout is broken by design.
3. **`/merch` product images return 401** from `hyperagent.com` — need real images self-hosted at `/assets/merch/*`. Until then the cards show broken images.
4. **CSP is ENFORCING** (`Content-Security-Policy` in `vercel.json:197`, not Report-Only) with `'unsafe-inline'` allowed for scripts/styles and `report-uri /api/csp-report` — violations log to Vercel runtime logs. For a production rollout, point the report-uri at an aggregator (Sentry / Report URI).
