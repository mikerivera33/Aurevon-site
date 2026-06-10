# Aurevon Audit Remediation — Phase 1 (Quick Wins + Low-Risk Fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land the unblocked, low-risk audit fixes — correct doc-vs-code contradictions, lock CORS, unbreak the QA harness + onboarding, supervise the Discord bot, sync the dev server, harden the CI secret scan, and add coverage tooling.

**Architecture:** Pure config/doc/small-code edits. No change to the live payment→mint→role→email runtime. Decision locked: **production mints on Base** → docs are corrected to match the code (not the reverse).

**Tech Stack:** Vercel serverless (Node 20, ESM), vanilla HTML, vitest, eslint, GitHub Actions, Railway (Discord bot).

**Branch:** `claude/audit-remediation-phase1` off `main`. Squash-merge via PR (repo convention; `main` requires the `Lint & Validate` check).

**Out of scope (Phase 2, separate plan — L effort and/or open questions):** webhook/OAuth happy-path integration tests (M0-2/M0-3), moving admin tooling off the client-side Airtable PAT (M1-2, needs Open Q#2), server-validating the intake `paid` token (M1-3, needs Open Q#3), extracting a shared client JS/CSS module (M2-1).

---

### Task 1: Unbreak the QA harness (QW1)

**Files:**
- Modify: `qa-test.sh:79-82`
- Modify: `DEPLOYMENT_CHECKLIST.md:16`

The health endpoint returns `"status":"healthy"` (`api/health.js:92`) but `qa-test.sh` asserts `"ok"`, so `npm run test:qa` always reports failure.

- [ ] **Step 1: Fix the assertion**

In `qa-test.sh`, change:
```bash
  if [[ "$STATUS" == "ok" ]]; then
    pass "GET /api/health returned status=ok"
```
to:
```bash
  if [[ "$STATUS" == "healthy" ]]; then
    pass "GET /api/health returned status=healthy"
```

- [ ] **Step 2: Fix the stale checklist expectation**

In `DEPLOYMENT_CHECKLIST.md:16`, replace the documented `{"status":"ok",...}` with `{"status":"healthy",...}`.

- [ ] **Step 3: Verify it parses**

Run: `bash -n qa-test.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add qa-test.sh DEPLOYMENT_CHECKLIST.md
git commit -m "fix(qa): health check asserts 'healthy' to match api/health.js"
```

---

### Task 2: Fix README onboarding step 1 (QW2)

**Files:** Modify: `README.md:170`

The quick-start says `cd aurevon-site/site && npm install`; there is no `site/` directory (the manifest is at repo root).

- [ ] **Step 1: Correct the path**

In `README.md` around line 170, change `cd aurevon-site/site` to `cd aurevon-site`. Grep to confirm no other `/site` references: `grep -n "aurevon-site/site" README.md` → expect zero hits afterward.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): fix quick-start cd path (no site/ subdir)"
```

---

### Task 3: Lock API CORS to the domain (QW3)

**Files:** Modify: `vercel.json:151-152`

`vercel.json` sets `Access-Control-Allow-Origin: *` for `/api/(.*)`; the handlers already set it to `DOMAIN`. Align the platform header to the domain (no ambient-credential risk today, but `*` is needlessly broad).

- [ ] **Step 1: Replace the wildcard**

In `vercel.json`, change:
```json
        {
          "key": "Access-Control-Allow-Origin",
          "value": "*"
        },
```
to:
```json
        {
          "key": "Access-Control-Allow-Origin",
          "value": "https://www.aurevonvc.com"
        },
```

- [ ] **Step 2: Verify valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'));console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "sec(cors): lock /api/* Access-Control-Allow-Origin to the domain"
```

---

### Task 4: Correct stale CLAUDE.md claims (QW4)

**Files:** Modify: `CLAUDE.md` (the CSP "Report-Only" claims in patterns #1, #7 and limitation #4; the "function count 12" claim in limitation #1)

`CLAUDE.md` is the anti-false-positive guide; keeping it accurate preserves its value. Two stale claims: the CSP header is **enforcing** `Content-Security-Policy` (`vercel.json:197`), not Report-Only; and `api/health.js:99` now reports `function_count: 11`, not 12.

- [ ] **Step 1: Fix the CSP references**

Replace mentions of `Content-Security-Policy-Report-Only` / "CSP-Report-Only" with the fact that `vercel.json` ships an **enforcing** `Content-Security-Policy` with `'unsafe-inline'` allowed for scripts/styles (the documented trade-off), `report-uri /api/csp-report`.

- [ ] **Step 2: Fix the function count**

In limitation #1, change "12/12" / "hardcodes the 12 number" to reflect `function_count: 11` (`api/health.js:99`), Pro confirmed.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): correct stale CSP (enforcing) + function-count (11) claims"
```

---

### Task 5: Reconcile minting-chain docs to Base (M1-1)

**Files:** Modify: `README.md` (lines ~112, 369, 417-421, 508, 805, 856), `DEPLOYMENT_CHECKLIST.md` (items 5.2 line 69, 5.6 line 73)

Code mints on **Base** (`api/_lib/entitlements.js:186` default `'base'`; `api/_lib/crossmint.js:14`; metadata label `crossmint.js:137,145`). Docs say Polygon and instruct `CROSSMINT_CHAIN=polygon`. Decision: **docs are wrong** — correct them to Base.

- [ ] **Step 1: Rewrite README chain references**

Replace each Polygon reference with Base:
- `README.md:112` ASCII box `│  Chain: Polygon       │` → `│  Chain: Base (ETH L2) │`
- `:369` "Chain: `polygon` (recommended…)" → "Chain: `base` (Base Ethereum L2)"
- `:417` heading "Go Live on Polygon Mainnet" → "Go Live on Base Mainnet"
- `:421` "Set `CROSSMINT_CHAIN=polygon`…" → "Set `CROSSMINT_CHAIN=base`…"
- `:508` table value `polygon` → `base`
- `:805` "Gas fees (Polygon)" → "Gas fees (Base)" (drop the Polygon-specific $0.01–0.05 figure or mark approximate)
- `:856` roadmap "Expand from Polygon to Solana" → "Expand from Base to Solana"

- [ ] **Step 2: Fix the deployment checklist**

- `DEPLOYMENT_CHECKLIST.md:69` "Collection deployed on **Polygon Mainnet**" → "**Base Mainnet**"
- `:73` "`CROSSMINT_CHAIN=polygon`" → "`CROSSMINT_CHAIN=base`"

- [ ] **Step 3: Verify no stray Polygon references remain in docs**

Run: `grep -rin "polygon" README.md DEPLOYMENT_CHECKLIST.md`
Expected: zero hits (or only an explicit historical note, if you add one).

- [ ] **Step 4: Commit**

```bash
git add README.md DEPLOYMENT_CHECKLIST.md
git commit -m "docs(chain): correct minting chain Polygon->Base to match code"
```

---

### Task 6: Document the cron schedule accurately (M3 doc)

**Files:** Modify: `README.md:37,157` (and the API-functions table)

README says retries run "hourly"; actual is daily `0 3 * * *`, and the `reconcile` cron (daily `0 2`) is undocumented.

- [ ] **Step 1: Correct cadence + add reconcile**

Change "hourly" → "daily at 03:00 UTC" at `:37` and `:157`. Add a row for `/api/cron/reconcile` (daily 02:00 UTC — Discord-sync reconcile + orphan recovery) to the API-functions/cron list.

- [ ] **Step 2: Verify against source of truth**

Run: `grep -n "schedule" vercel.json` and confirm the doc matches (`0 3 * * *` retry-mints, `0 2 * * *` reconcile).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(cron): correct retry cadence (daily) + document reconcile cron"
```

---

### Task 7: Supervise the Discord bot (M2-2)

**Files:** Modify: `discord/bot.js:1818` (process handlers)

`bot.js` logs `unhandledRejection` but never exits, and has no `uncaughtException` handler — so a wedged-but-alive process is never restarted by Railway's `ON_FAILURE` policy. Adding a fatal-exit handler lets Railway recycle it. (A true HTTP healthcheck requires adding an HTTP listener to the bot — deferred as optional follow-up since the bot has no web server.)

- [ ] **Step 1: Add an uncaughtException handler that exits non-zero**

After `discord/bot.js:1818`, add:
```javascript
process.on('uncaughtException', (err) => {
  console.error('[Bot] Uncaught exception — exiting for Railway restart:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it parses**

Run: `node --check discord/bot.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add discord/bot.js
git commit -m "fix(bot): exit non-zero on uncaughtException so Railway restarts a wedged bot"
```

---

### Task 8: Sync the local dev-server route map (M2-3)

**Files:** Modify: `scripts/dev-server.js` (route map ~lines 24-37)

The map points `/api/crossmint/mint` at a nonexistent `api/crossmint/mint.js` (prod rewrites it to `member/claim.js?action=mint`) and omits `/api/portal/auth`, `/api/portal/verify`, `/api/cron/reconcile`. Align it with `vercel.json` rewrites so `npm run dev` matches production.

- [ ] **Step 1: Fix/add the routes**

In the route map: change `'/api/crossmint/mint': 'api/crossmint/mint.js'` to map to `api/member/claim.js` (matching `vercel.json`'s `?action=mint`), and add entries for `/api/portal/auth`, `/api/portal/verify` (→ `api/portal/data.js`) and `/api/cron/reconcile` (→ `api/member/claim.js`). Mirror the action-routing the server already does for `/api/cron/retry-mints` (see `dev-server.js:179`).

- [ ] **Step 2: Cross-check against vercel.json**

Run: `grep -n '"source": "/api/' vercel.json` and confirm every prod `/api/*` source has a corresponding dev-server entry pointing at a file that exists (`ls api/...`).

- [ ] **Step 3: Verify it parses**

Run: `node --check scripts/dev-server.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/dev-server.js
git commit -m "fix(devx): sync dev-server route map with vercel.json rewrites"
```

---

### Task 9: Broaden the CI secret scan (M2-4)

**Files:** Modify: `.github/workflows/deploy.yml:44`

The `.env.example` secret-scan regex only catches `sk_live_`/`whsec_`/Airtable-PAT formats. Add Crossmint/Discord/PayPal/Resend token shapes and `sk_test_`.

- [ ] **Step 1: Extend the regex**

In `deploy.yml:44`, extend the alternation to also match: `sk_(live|test)_[a-zA-Z0-9]{20,}`, `whsec_[a-zA-Z0-9]{20,}`, the Airtable `pat….` pattern, `sk_[a-zA-Z0-9]{20,}` (Crossmint server keys), Discord bot tokens (`[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}`), and `re_[A-Za-z0-9_]{20,}` (Resend). Keep it a single `grep -qE` guard that fails the job on match.

- [ ] **Step 2: Verify the workflow still parses + the guard works**

Run locally: `grep -qE "<your-new-regex>" .env.example && echo "WOULD FAIL" || echo "clean"` → expect `clean` (`.env.example` holds only placeholders). Confirm YAML is valid: `node -e "require('fs').readFileSync('.github/workflows/deploy.yml','utf8')"`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(sec): broaden .env.example secret scan (crossmint/discord/paypal/resend/test keys)"
```

---

### Task 10: Add coverage tooling (M0-1)

**Files:** Modify: `package.json` (devDeps + scripts), `package-lock.json`

Enables measuring core-handler coverage (prereq for the Phase-2 integration-test work).

- [ ] **Step 1: Install the v8 coverage provider**

Run: `npm install -D @vitest/coverage-v8`
Expected: adds to devDependencies + updates lock.

- [ ] **Step 2: Add a coverage script**

In `package.json` scripts, add: `"test:coverage": "vitest run --coverage"`.

- [ ] **Step 3: Run it and record the baseline**

Run: `npm run test:coverage`
Expected: 76 tests pass + a coverage table printed (note `api/` baseline % for Phase 2 targets).

- [ ] **Step 4: Verify CI lock sync**

Run: `npm ci --dry-run` → exit 0 (lock in sync with package.json).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "test: add @vitest/coverage-v8 + test:coverage script"
```

---

## Final verification (whole plan)

1. `npx vitest run` → 76 passing (Task 10 adds coverage output, same test count).
2. `npx eslint api/` → clean.
3. `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"` → valid.
4. `node --check discord/bot.js && node --check scripts/dev-server.js` → exit 0.
5. `grep -rin "polygon" README.md DEPLOYMENT_CHECKLIST.md` → zero hits.
6. `bash -n qa-test.sh` → exit 0.
7. Open PR to `main`; the required `Lint & Validate` check must go green before (auto-)merge.

## Self-review notes
- Every step has exact files + commands + expected output; no placeholders.
- Chain decision (Base) applied consistently in Task 5.
- Tasks are independent and individually committable; Task 10 is the only one that touches deps/lock.
