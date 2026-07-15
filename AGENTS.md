# AGENTS.md

Operating rules for AI coding agents in this repo. Domain specifics (brand naming,
canonical NFTs, pricing, tier-key conventions, intentional-patterns-that-look-like-bugs)
live in `CLAUDE.md` — read it before flagging or "fixing" anything. This file covers
architecture, gates, and the Never-Touch list.

## Architecture

Vanilla static site + Vercel serverless + a separately deployed Discord bot. There is
no framework and no build step — `framework: null` in `vercel.json` is intentional.

- Static frontend: hand-written HTML at repo root and `nfts/`, served as-is
  (`outputDirectory: "."`, `cleanUrls: true`).
- Serverless API: `api/*.js`, ES modules, Node 20.x. Shared business logic lives in
  `api/_lib/` (airtable, crossmint, tiers, entitlements, email, discord-bot, alert).
- Discord bot: `discord/bot.js` (discord.js v14), deployed to Railway via
  `railway.json` — the only thing that runs off Vercel. It has its own
  `discord/package.json`.
- Routing is defined entirely by `vercel.json` rewrites; several endpoints fan out
  through one file via `?action=` query params (`/api/portal/*`, `/api/discord/*`,
  `/api/cron/*`).

## Coding Rules

- ESM only (`"type": "module"`); handlers are `export default async function handler(req, res)`.
- ESLint flat config lints `api/**/*.js` only: `eqeqeq`, `no-var`, `prefer-const`,
  `no-undef`, `no-unused-vars` (prefix intentional unused with `_`). HTML is not linted.
- New shared logic goes in `api/_lib/`, imported by thin handlers.
- `api/_lib/_archived/` holds deliberately retired products — never "restore" archived
  code as a bug fix.

## Testing

- Unit tests: Vitest — `npm test` (expect ~43–45 passing). Coverage: `npm run test:coverage`.
- Tests in `api/_lib/__tests__/` are heavily security-focused (auth gates, injection,
  timing oracles, fail-closed, idempotency, webhook signatures). Never weaken or delete
  a security test to make a change pass — fix the change or escalate.
- Live smoke tests: `./qa-test.sh` curls a running site (`--env prod` targets
  aurevonvc.com); env-gated sections skip when secrets are absent.
- Run `npm test` and `npm run lint` before every commit.

## Git

- Branch from `main`; never commit to `main` directly (protected — requires the
  "CI — Lint & Validate" check).
- Squash-merge PRs. Vercel auto-deploys prod on merge; verify against
  `https://www.aurevonvc.com` afterwards (preview URLs 401 by design).
- CI will fail on: real-looking secrets in `.env.example`, images >500 KB, broken
  favicon/og-image refs, missing Vercel analytics snippets in any HTML page.

## Never Touch (human approval required)

- `api/stripe/checkout.js` — `PRODUCT_CATALOG` is the pricing source of truth.
- `api/webhooks/` — all of it (Stripe, PayPal IPN, Crossmint): signature-verified,
  raw-body configs, money-moving side effects.
- `api/_lib/crossmint.js`, `api/member/claim.js`, `api/webhooks/crossmint.js` — the
  minting pipeline (mint, retry-mints, reconcile).
- `api/_lib/tiers.js`, `api/_lib/entitlements.js` — tier→NFT mapping; the 5 canonical
  NFTs are fixed.
- `api/portal/data.js`, `api/discord.js`, `api/_lib/discord-bot.js` — auth, OAuth,
  and live role grant/revoke.
- `vercel.json` `crons` and `headers` blocks — cron auth and the enforcing CSP are
  load-bearing; CSP source changes can break Stripe/PayPal/Discord/IPFS.
- `discord/bot.js` — moderates and DMs real members on Railway.
- `.env` files — never read, write, or commit; secrets stay in Vercel/Railway env.

## How to Handle Uncertainty

If a pattern looks wrong, check CLAUDE.md's "intentional patterns" list first — this
repo has 12+ documented things that look like bugs and are not. When still unsure,
ask instead of changing; a wrong "fix" here can affect payments, minting, or live
Discord members.
