# Railway Quick Deploy — Aurevon Discord Bot

Get `discord/bot.js` live on Railway in 10 minutes. This complements the existing `RAILWAY_DEPLOY.md` with a no-prose checklist.

## Why Railway, not Vercel

The bot needs a **persistent WebSocket connection** to Discord's gateway. Vercel functions are serverless (max 60s) and cannot hold this connection. The Vercel side of Aurevon handles webhooks; Railway runs the always-on bot. Both talk to the same Airtable.

`railway.json` is already configured at repo root — Railway reads it automatically.

## Phase 1 — Discord Developer Portal (one-time)

- [ ] Open [discord.com/developers/applications](https://discord.com/developers/applications) → select the Aurevon Ventures app (Client ID `1505819653602148372`)
- [ ] **Bot** tab → confirm **SERVER MEMBERS INTENT**, **MESSAGE CONTENT INTENT**, and **PRESENCE INTENT** are all ✅ enabled
- [ ] If you need a new token: **Reset Token** → copy → save for Phase 3
- [ ] Bot must already be in the Aurevon server (Guild ID `1499526813490221207`). If not, build invite URL:
  ```
  https://discord.com/oauth2/authorize?client_id=1505819653602148372&scope=bot+applications.commands&permissions=8
  ```

## Phase 2 — Railway project setup

- [ ] [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → select `mikerivera33/Aurevon-site`
- [ ] Wait for the initial build to fail (expected — no env vars yet)
- [ ] Open the service → **Settings** → confirm:
  - Build command: `cd discord && npm install`
  - Start command: `cd discord && node bot.js`
  - (Both are already in `railway.json`)

## Phase 3 — Railway environment variables

In Railway → service → **Variables** → paste each. Use the **same values** already set in Vercel for the shared keys.

### Required

```
DISCORD_BOT_TOKEN=               # from Phase 1
DISCORD_GUILD_ID=1499526813490221207
DISCORD_CLIENT_ID=1505819653602148372
SITE_URL=https://www.aurevonvc.com

DISCORD_ROLE_MONTHLY=            # Role ID for 001 Genesis
DISCORD_ROLE_LIFETIME=           # Role ID for 004 Chrome
DISCORD_ROLE_PRODUCT_A=          # Role ID for Aurevon Insider
DISCORD_ROLE_PRODUCT_B=          # Role ID for Aurevon Ember
DISCORD_ROLE_PRODUCT_C=          # Role ID for Aurevon Obsidian Executive
DISCORD_ROLE_VERIFIED=           # Role ID for Verified Member

AIRTABLE_PAT=                    # same value as Vercel
AIRTABLE_BASE_ID=appI9X8vcRcK1QZ1l
```

### How to get role IDs fast

If you don't already have them:

1. In Discord (with Developer Mode enabled) — right-click each tier role → **Copy ID**
2. OR run `cd discord && npm run setup` once locally; the setup script creates roles and prints all IDs at the end ready to paste into Railway.

## Phase 4 — Deploy and verify

- [ ] In Railway, click **Deploy** (or push any commit to `main`)
- [ ] Watch logs — you should see:
  ```
  ✓ Loaded N command definitions
  ✓ Aurevon Ventures Bot online as Aurevon Ventures#XXXX
  ✓ Watching guild: Aurevon Ventures (1499526813490221207)
  ```
- [ ] In Discord, type `/server-info` — should respond with embed
- [ ] Run `/stats` — should show member counts per tier (will be 0 across the board if Airtable is empty)
- [ ] If you have a test Airtable Member with email + Discord ID + tier set, run `/sync-member email:<email>` — they should get the tier role

## Phase 5 — Confirm Vercel ↔ Railway wiring

The full purchase pipeline only works when **both** are configured. Quick smoke test:

- [ ] Run a $1 Stripe test purchase via Stripe Test Mode dashboard
- [ ] Vercel logs: should see `[Stripe] checkout.session.completed → mint queued`
- [ ] Crossmint dashboard: action.succeeded for the test email
- [ ] Vercel logs: should see `[Crossmint Webhook] Mint success`
- [ ] If test customer has linked Discord ID → Railway logs: `Role added: Aurevon Insider`

If any step fails, see `docs/AUREVON_INTEGRATION_MAP.md` → "Common failure modes".

## Phase 6 — Make it survive restarts

The bot keeps no local state beyond Discord's own audit log. Railway restarts are safe. However:

- [ ] In Railway → service → **Settings** → confirm **Restart policy** = `on_failure`, max retries `10` (already set in `railway.json`)
- [ ] Optional: enable **Healthcheck** path = leave null for now (bot has no HTTP server by default; would require adding one)
- [ ] Watch the first 24h of logs for any unhandled rejections

## Re-running the slash command deploy

Commands auto-register on bot startup via `bot.js`. If you change `bot.js` command definitions:

```bash
# Locally
cd discord
DISCORD_BOT_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_GUILD_ID=... node -e "
  import('./bot.js')
"
# Wait for ready message, then Ctrl+C
```

Or just push to `main` — Railway redeploys and the bot re-registers on startup.

## When something breaks

| Symptom | First check |
|---|---|
| Bot offline in Discord | Railway logs — token rotated? Intent disabled? |
| Bot online but slash commands missing | `applications.commands` scope not in the OAuth URL — re-invite |
| Bot can't assign roles | Bot role positioned **below** the tier roles — drag it to the top in Server Settings → Roles |
| `/sync-member` says "Member not found" | Airtable Members table row missing `Discord ID` field for that email |
| Crossmint mints succeed but role not assigned | Customer hasn't completed OAuth flow at `/discord-welcome.html` — their email isn't linked to a Discord ID yet |
