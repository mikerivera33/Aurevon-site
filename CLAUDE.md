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

| NFT | Earned by | Crossmint template env |
|---|---|---|
| **Aurevon Insider** | Full Package ($250) purchase | `CROSSMINT_TEMPLATE_INSIDER` |
| **Aurevon Ember** | Pro Retainer ($1,499/mo) subscription | `CROSSMINT_TEMPLATE_EMBER` |
| **Aurevon Obsidian Executive** | Enterprise ($2,499/mo) subscription | `CROSSMINT_TEMPLATE_OBSIDIAN` |
| **001 Genesis** | Community Monthly ($29.99/mo) | `CROSSMINT_TEMPLATE_GENESIS` |
| **004 Chrome** | Community Lifetime ($349.99) | `CROSSMINT_TEMPLATE_CHROME` |

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

## Archive index — code that's been removed but kept for re-activation

| What | Where | Why archived | How to re-activate |
|---|---|---|---|
| `web3_starter/growth/scale/enterprise` subscription tiers (4 products, $49/$149/$349/$799) | `api/_lib/_archived/web3-subscription-tiers.js` | No UI sold them on `/aurevon-web3`; risk of advertising products with no buy button | See 10-step header in that file |

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
20. **Discord grants pick a grantable pass** — `findActiveMintsByEmail` + `pickGrantableMint`: a lapsed monthly Genesis row never hides a permanent pass; a cancelled monthly member isn't re-granted. A paid monthly checkout resets `Billing State` to active (gated on the live subscription status).

## CI guards (`.github/workflows/deploy.yml`) — what they actually enforce

Whole-tree scoped (`**/*.html`, `find . -type f --not -path './docs/*'`):

1. **Asset budget**: any image > 500 KB fails. Suggests pngquant / cwebp / `<picture>` migration.
2. **Critical asset refs**: `<link rel=icon>`, `<link rel=apple-touch-icon>`, `<meta property=og:image>`, `<meta name=twitter:image>` must all point to files that exist on disk. Catches dead links after asset deletions.
3. **Analytics coverage**: every HTML must include both Speed Insights + Web Analytics scripts before `</head>`, AND must NOT include the legacy `cdn.vercel-insights.com/v1/script.js` (causes double-counted pageviews).

If you're touching analytics or assets, run the guards locally before pushing — they fail in CI otherwise.

## Production configuration that the code depends on (verified 2026-11-02)

- **Stripe webhook events** — the live endpoint `https://www.aurevonvc.com/api/webhooks/stripe` must be subscribed to: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`. On 2026-11-02 only `checkout.session.completed`, `customer.subscription.deleted` and `invoice.payment_failed` were enabled.
- **Airtable table IDs** — `api/_lib/airtable.js` defaults (`TABLE.*`) come from a different base ("Aurevon Operations"). Production sets `AIRTABLE_TABLE_MEMBERS` and `AIRTABLE_TABLE_NFT_MINTS`; **`AIRTABLE_TABLE_PAYMENTS`, `AIRTABLE_TABLE_CUSTOMER_AUTH` and `AIRTABLE_TABLE_LEADS` were unset**, and the Payments default answered `403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`. Every webhook's idempotency check reads Payments first, so purchases abort before fulfilment until this is set. The production Payments table must have the fields the code writes (`Transaction ID`, `Status`, `Customer Email`, `Pass Type`, `Tier Source`, `Payment Provider`, `Payment Date`, …).

## Env vars assumed present in production (not in dev)

Local dev WILL fail at the catalog → Stripe step because `STRIPE_SECRET_KEY` is unset. This is correct behavior — it's a signal you've gotten past the catalog lookup. If you see "Stripe secret key not configured" you're checking the right code path.

For a full env list see `.env.example`. For monitoring see `api/health.js` (reports `env: "complete"` or `"partial"` with the missing list).

Production also needs: `STRIPE_WEBHOOK_SECRET`, `PAYPAL_*`, `CROSSMINT_*` (API key + 5 templates + collection IDs), `RESEND_API_KEY`, `AIRTABLE_PAT` + `AIRTABLE_BASE_ID`, `DISCORD_*` (bot, OAuth, 5 role IDs), `STATE_SECRET`, `SYNC_SECRET`, `RECONCILE_SECRET`.

## Workflow

1. **Branch:** `claude/<short-description>-Sz1pk` from `main`
2. **Commits:** descriptive; multi-line body when the change has multiple concerns
3. **Tests:** `npm test` (200+ tests across 27 files) + `npm run lint` (must be clean)
4. **PR:** squash-merge to `main`; Vercel auto-deploys to production on merge
5. **Verify:** after merge, hit `https://www.aurevonvc.com` with `curl` to confirm new behavior, not the preview URL (preview is deployment-protected → HTTP 401)

## Known limitations (don't fix unless asked)

1. **Function count is computed** — `api/health.js` counts `api/**` functions at load (no hardcoded literal any more). Project is on **Pro**, so the 12-function Hobby cap doesn't bind.
2. **`/merch` Snipcart placeholder key** — `SNIPCART_KEY_PENDING_SETUP`. Real key needs to be set in Vercel env; until then `/merch` checkout is broken by design.
3. **`/merch` product images return 401** from `hyperagent.com` — need real images self-hosted at `/assets/merch/*`. Until then the cards show broken images.
4. **CSP is ENFORCING** (`Content-Security-Policy` in `vercel.json:197`, not Report-Only) with `'unsafe-inline'` allowed for scripts/styles and `report-uri /api/csp-report` — violations log to Vercel runtime logs. For a production rollout, point the report-uri at an aggregator (Sentry / Report URI).
