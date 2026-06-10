# Aurevon Site — Autonomous Workflow Audit & Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the remediation tasks. Steps use checkbox (`- [ ]`) syntax.

**Date:** 2026-06-10
**Branch audited:** `fix/payment-durability`
**Goal:** Verify the autonomous membership workflow (payment → mint → Discord role → email + reconcile/retry crons) completes end-to-end, and fix the gaps that are actually real.

---

## Context

The user asked to check Aurevon-site for "errors, mishooks, or anything that doesn't complete the autonomous workflow." Three parallel Explore agents surfaced ~14 candidate issues including four "P0"s. Each claim was then **verified against source** (systematic-debugging discipline). Most of the alarming claims did not survive verification — the recent `fix/payment-durability` work already closed them.

**Headline: the autonomous workflow is largely complete and well-hardened.** Tests are green (68/68, 10 files), eslint is clean, all three webhooks verify signatures + carry idempotency markers + `waitUntil` durability, and the reconcile/retry crons exist and are tested. The genuine gaps are narrow and listed below.

---

## Verified findings (real, ranked)

### F1 — PayPal IPN tier inference is fragile; a failed inference silently drops the mint with no recovery (P1)
- **Where:** `api/webhooks/paypal.js:55-79` (`inferTierFromIPN`) → `:115-116,126` (`tier ?? 'unknown'`) → `:145-153` (no-NFT branch).
- **Mechanism:** Tier is resolved from `ipn.custom`, else an **exact** amount match (`amount === config.amount`, *no tolerance*). The site sells PayPal via hosted NCP links (`paypal.com/ncp/payment/...`, see `aurevon-re.html:38-42`, `aurevon-web3.html:439-451`), which generally don't attach a per-transaction `custom` field — so inference rests on exact amount match. Any drift (link priced `$299` vs `bogo`'s `$299.99`, taxes/fees) → `tier = 'unknown'` → routed to the **no-NFT branch → never mints**.
- **No recovery:** `recoverOrphanPayments` (`api/member/claim.js:219-220`) does `TIER_NFT_MAP['unknown']` → `undefined` → `if (!nftType) continue` → skips it. It cannot distinguish "legit no-NFT add-on" from "NFT-priced payment whose tier inference failed."
- **Contrast (the fix already exists in-repo):** Stripe (`api/webhooks/stripe.js:86-95`) layers `metadata.tier` → `inferTierFromAmount()` (**has $1 tolerance**) → `'unknown'`. PayPal should reuse the same tolerant inference.
- **Caveat (honest scoping):** Whether this *fires in production* depends on PayPal-side config we can't see (do the NCP links set `custom`? do link amounts exactly equal `_BASE` prices?). Treat F1 as a **code-level fragility to harden regardless** + an **operator item to confirm** (O1), not a confirmed customer-facing break.

### F2 — Dead PayPal capture/create-order endpoints are a latent landmine (P2, latent P0)
- **Where:** `api/paypal/index.js` `handleCapture` (`:115-159`) and `handleCreateOrder` (`:72-113`); rewrites at `vercel.json` (`/api/paypal/create-order`, `/api/paypal/capture`).
- **Status:** **Unreachable from the site** — no HTML calls them (PayPal is hosted NCP links + IPN; confirmed by grep across all `*.html`). So this is dead code, not a live break.
- **Why it's still dangerous:** the endpoints remain deployed and POST-able. `handleCapture` captures money, writes `Pass Type` as a **display name** (`'OBSIDIAN'`/`'EMBER'` from `PASS_PRICES`, `:144`), **never mints**, and that display-name key is unrecoverable by `recoverOrphanPayments` (it keys on tier slugs). If any future frontend/automation/manual call hits it → paid, no NFT, no recovery.
- **Recommended:** remove both endpoints + their `vercel.json` rewrites (safest, DRY). Alternatively complete `handleCapture` to mint via the canonical path — not worth it since the live flow is IPN.

### F3 — `.gitignore` doesn't cover `.env.production` / `.env.staging` (P2, secret-leak vector)
- **Where:** `.gitignore:3-5` ignores `.env`, `.env.local`, `.env*.local` but **not** `.env.production`, `.env.staging`, `.env.bak`.
- **Risk:** a dev creating `.env.production` with real Stripe/PayPal/Crossmint/Airtable secrets could commit it. `.env.example:5` already *claims* `.env*` is ignored — so the doc is ahead of the rule.
- **Fix:** change the three lines to `.env*` (keeps `!.env.example` if needed — it has no leading dot issue since pattern is `.env*`; add `!.env.example` to be safe).

### F4 — Health monitor checks the wrong domain if `PRODUCTION_URL` repo var is unset (P2)
- **Where:** `.github/workflows/health-check.yml:25` — `PRODUCTION_URL: ${{ vars.PRODUCTION_URL || 'https://aurevon-site.vercel.app' }}`. The real domain is `www.aurevonvc.com` (the `DOMAIN` default throughout `api/`). If the repo variable isn't set, the 8-hourly monitor greenlights a domain that may not be production → real outages go unnoticed.
- **Fix:** set the GitHub repo variable `PRODUCTION_URL=https://www.aurevonvc.com`, or change the fallback default to the real domain.

---

## Subagent claims refuted / downgraded after verification

These were reported as P0/P1 by Explore agents but **do not survive source review** — do not act on them:

- **"CRON_SECRET silently 401s the crons" (claimed P0):** Already fixed. `api/member/claim.js:38-55` (`getReconcileSecrets`/`validateReconcileSecret`) accepts **either** `RECONCILE_SECRET` or `CRON_SECRET`, with timing-safe compare; covered by `cron-auth.test.js`. Only residual: at least one secret must be set, and Vercel attaches its Bearer header only when `CRON_SECRET` is set → captured as operator item O2.
- **"Buyers never get their Discord role / missing sync cron" (claimed P0/P1):** Not a defect. `handleReconcile` (`claim.js:268-292`) auto-assigns roles to every member who has a linked `Discord ID`. Buyers who never did OAuth have **no Discord ID** — a role *cannot* be assigned without it; they correctly get an Engage reminder (`:342-359`). This is inherent to OAuth linking, not a gap.
- **"Crossmint webhook returns 500 if secret unset" (claimed P0):** Intended fail-closed design, documented in `.env.example`. It's a deploy requirement (O2), not a bug.

## Reported but NOT independently verified (lower confidence)

Carry these as operator checks, not confirmed code defects:

- **O1 — Confirm PayPal NCP link amounts exactly equal `_BASE` prices** in `tiers.js` (and whether links set `custom`). Directly governs whether F1 ever fires.
- **O2 — Deploy config:** ensure `CRON_SECRET` and `CROSSMINT_WEBHOOK_SECRET` are set in Vercel prod (crons + Discord-role sync depend on them).
- **O3 — Vercel plan: ✅ CONFIRMED PRO (2026-06-10).** Crons require Pro; the project is on Pro, so `retry-mints` + `reconcile` fire on schedule and the F1/F2 orphan-recovery durability runs in production. (Defuses the agent's "Hobby crons won't fire" P0.)
- **O4 — Env hygiene (P2/P3):** `.env.example` documents ~11 vars the code never reads (`NEXT_PUBLIC_URL`, `PAYPAL_SANDBOX`, per-entitlement `CROSSMINT_COLLECTION_*`, etc.) and `DISCORD_ROLE_VERIFIED` ships as a `000…` placeholder. Dead config; prune to reduce operator error surface. Not workflow-breaking.

---

## Remediation plan

### Task 1 — Harden PayPal tier inference (fixes F1, code side)
**Files:** Modify `api/webhooks/paypal.js`; Test `api/_lib/__tests__/` (new `paypal-tier-infer.test.js`).
- [ ] Write a failing test: an IPN with `mc_gross` = a tier price ±$0.50 (e.g. `299.49` for `bogo` $299.99) and no `custom` field should resolve to that tier, not `'unknown'`.
- [ ] In `inferTierFromIPN`, after the exact-match loop, fall back to the existing `inferTierFromAmount(amount * 100)` from `api/_lib/tiers.js` (already imported pattern; it has $1 tolerance) **restricted to `IPN_ELIGIBLE_TIERS`** to avoid addon/web3 amount collisions. Reuse — do not write new tolerance logic.
- [ ] Run the test → pass. Run full `npx vitest run` → 69+ green.
- [ ] Commit.

### Task 2 — Make orphan recovery catch inference-failed NFT payments (fixes F1, durability side)
**Files:** Modify `api/member/claim.js` (`recoverOrphanPayments`, `:214-239`); Test `api/_lib/__tests__/orphan-recovery.test.js`.
- [ ] Add a failing test: a payment with `Pass Type: 'unknown'` but an NFT-tier `Amount` should be dead-lettered (currently skipped).
- [ ] Before `if (!nftType) continue`, when `tier` is `'unknown'`/unmapped, re-infer via `inferTierFromAmount(amount*100)` using the payment's `Amount` field; only `continue` if it's genuinely a no-NFT tier.
- [ ] Run tests → pass.
- [ ] Commit.

### Task 3 — Remove dead PayPal capture/create-order endpoints (fixes F2)
**Files:** `api/paypal/index.js`, `vercel.json` (remove `/api/paypal/create-order` + `/api/paypal/capture` rewrites).
- [ ] Confirm once more no `*.html`/`*.js` references either route (grep `create-order|paypal/capture`).
- [ ] Delete `handleCreateOrder`, `handleCapture`, `PASS_PRICES`, and the now-unused helpers; remove the two rewrites.
- [ ] `npx vitest run` + `npx eslint api/` green; `node` parse-check the file.
- [ ] Commit.

### Task 4 — Tighten `.gitignore` (fixes F3)
- [ ] Replace `.env` / `.env.local` / `.env*.local` with `.env*` and add `!.env.example`.
- [ ] `git check-ignore -v .env.production` confirms it's now ignored; `git status` shows `.env.example` still tracked.
- [ ] Commit.

### Task 5 — Point the health monitor at production (fixes F4) — operator action
- [ ] Set GitHub repo variable `PRODUCTION_URL=https://www.aurevonvc.com` (Settings → Secrets and variables → Actions → Variables), **or** change the `||` default in `health-check.yml:25,75,152`.
- [ ] Trigger `workflow_dispatch` once; confirm it checks the real domain.

### Operator checklist (no code) — O1–O4 above
- [ ] O1 PayPal NCP link amounts == `_BASE` prices · [ ] O2 `CRON_SECRET` + `CROSSMINT_WEBHOOK_SECRET` set in prod · [ ] O3 confirm Vercel Pro · [ ] O4 prune dead `.env.example` vars + set real `DISCORD_ROLE_VERIFIED`.

---

## Verification (end-to-end)

1. `npx vitest run` → all green (currently 68; +2–3 after Tasks 1–2).
2. `npx eslint api/` → clean.
3. **PayPal inference:** simulate an IPN POST to `/api/webhooks/paypal` with `mc_gross` slightly off a tier price and no `custom` → assert a mint is attempted (logs show resolved tier, not `unknown`).
4. **Orphan recovery:** seed a Payments row (`Pass Type:'unknown'`, NFT-tier amount, no mint row) → run `?action=reconcile` → assert a `Failed` dead-letter row is created and `retry-mints` then mints it.
5. **Dead route removal:** `curl -X POST $DOMAIN/api/paypal/capture` → 404 (route gone).
6. **Secrets:** `git check-ignore .env.production` returns the path.
7. **Health monitor:** manual `workflow_dispatch` run hits `www.aurevonvc.com/api/health` and reports 200.
