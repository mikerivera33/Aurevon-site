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

## Archive index — code that's been removed but kept for re-activation

| What | Where | Why archived | How to re-activate |
|---|---|---|---|
| `web3_starter/growth/scale/enterprise` subscription tiers (4 products, $49/$149/$349/$799) | `api/_lib/_archived/web3-subscription-tiers.js` | No UI sold them on `/aurevon-web3`; risk of advertising products with no buy button | See 10-step header in that file |

If you're about to flag a missing "Web3 Starter" product — first check the archive. It's deliberate, not a bug.

## Intentional patterns that look like bugs (don't flag)

Each of these has been flagged by a code-review or audit subagent and is **not** a bug:

1. **Inline `onclick=` / `onsubmit=` handlers everywhere** (100+ across all HTML files). Vanilla site, no event-delegation framework. The strict-CSP question lives at `Content-Security-Policy-Report-Only` in `vercel.json` with `'unsafe-inline'` allowed — necessary trade-off, documented.
2. **Inline `<style>` attributes** — same reason. No build step to extract.
3. **`<img src="assets/MAIN AUREVON HEADER.png">` with literal spaces** — browsers auto-encode for `<img src>` (lenient). For `<source srcset>` and `<link rel=preload>` use `%20` (strict). The `site-guards.test.js` test enforces this.
4. **`framework: null` + `buildCommand: null` in `vercel.json`** — static site, deliberate.
5. **`installCommand: null`** — `package.json` has `engines.node: 20.x`; Vercel auto-runs `npm install` for `/api/*` deps.
6. **`images:` block in `vercel.json` but no `/_vercel/image` references** — forward-looking config, not dead. Allows the optimizer if we ever wire it up.
7. **CSP-Report-Only without per-page CSP customization** — single global policy is fine for a static site.
8. **`NFT_TIERS = new Set()` (empty) in `checkout.js`** — pre-existing, the branch is unreachable; not from any recent PR; not in scope to clean up unless you're doing a checkout.js refactor.
9. **`api/_lib/tiers.js` Proxy with `re_*` aliases** — see "Tier-key conventions" above.
10. **`vercel.json` `"/cancel"` rewrite is GONE** as of PR #21. Stripe checkout builds per-session cancel URLs (`checkout.js:196`).
11. **`docs/` is `.vercelignore`d** — design briefs, brand masters, this file's neighbors. None of it ships.
12. **`apple-touch-icon.png` is 194 KB at root** — under the 500 KB CI budget; iOS retina home-screen icon needs the resolution. Don't shrink.

## CI guards (`.github/workflows/deploy.yml`) — what they actually enforce

Whole-tree scoped (`**/*.html`, `find . -type f --not -path './docs/*'`):

1. **Asset budget**: any image > 500 KB fails. Suggests pngquant / cwebp / `<picture>` migration.
2. **Critical asset refs**: `<link rel=icon>`, `<link rel=apple-touch-icon>`, `<meta property=og:image>`, `<meta name=twitter:image>` must all point to files that exist on disk. Catches dead links after asset deletions.
3. **Analytics coverage**: every HTML must include both Speed Insights + Web Analytics scripts before `</head>`, AND must NOT include the legacy `cdn.vercel-insights.com/v1/script.js` (causes double-counted pageviews).

If you're touching analytics or assets, run the guards locally before pushing — they fail in CI otherwise.

## Env vars assumed present in production (not in dev)

Local dev WILL fail at the catalog → Stripe step because `STRIPE_SECRET_KEY` is unset. This is correct behavior — it's a signal you've gotten past the catalog lookup. If you see "Stripe secret key not configured" you're checking the right code path.

For a full env list see `.env.example`. For monitoring see `api/health.js` (reports `env: "complete"` or `"partial"` with the missing list).

Production also needs: `STRIPE_WEBHOOK_SECRET`, `PAYPAL_*`, `CROSSMINT_*` (API key + 5 templates + collection IDs), `RESEND_API_KEY`, `AIRTABLE_PAT` + `AIRTABLE_BASE_ID`, `DISCORD_*` (bot, OAuth, 5 role IDs), `STATE_SECRET`, `SYNC_SECRET`, `RECONCILE_SECRET`.

## Workflow

1. **Branch:** `claude/<short-description>-Sz1pk` from `main`
2. **Commits:** descriptive; multi-line body when the change has multiple concerns
3. **Tests:** `npm test` (43–45 tests, depends on which PRs landed) + `npm run lint` (must be clean)
4. **PR:** squash-merge to `main`; Vercel auto-deploys to production on merge
5. **Verify:** after merge, hit `https://www.aurevonvc.com` with `curl` to confirm new behavior, not the preview URL (preview is deployment-protected → HTTP 401)

## Known limitations (don't fix unless asked)

1. **Function count is 12/12** on `/api/health` — at the Hobby cap. PR #19 added `/api/csp-report` to fill the last slot. Project may be on Pro now; `api/health.js` hardcodes the 12 number. Update only if you've confirmed Pro is active and want accurate reporting.
2. **`/merch` Snipcart placeholder key** — `SNIPCART_KEY_PENDING_SETUP`. Real key needs to be set in Vercel env; until then `/merch` checkout is broken by design.
3. **`/merch` product images return 401** from `hyperagent.com` — need real images self-hosted at `/assets/merch/*`. Until then the cards show broken images.
4. **CSP-Report-Only has `report-uri /api/csp-report`** — violations log to Vercel runtime logs. Useful for one-engineer-at-a-time inspection; for a production rollout, point at an aggregator (Sentry / Report URI).
