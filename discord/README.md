# ⬛ Aurevon Discord Server Setup Bot

> **Plug-and-play.** Run one command and your entire Aurevon Operators Discord server is built — roles, channels, permission overwrites, welcome embeds, verify button, and everything else — in about 2 minutes.

---

## What Gets Built

### 7 Roles (top → bottom in role list)

| Role | Color | Vercel Env Var | Entitlement |
|---|---|---|---|
| Aurevon Bot | `#5865F2` Blurple | — | Bot seat — stays at top |
| 001 Genesis | `#C8A96E` Gold | `DISCORD_ROLE_MONTHLY` | `monthly_membership` |
| 004 Chrome | `#9E9E9E` Silver | `DISCORD_ROLE_LIFETIME` | `lifetime_membership` |
| Aurevon Obsidian Executive | `#4A4A6A` Dark Purple | `DISCORD_ROLE_PRODUCT_C` | `product_c_reward` |
| Aurevon Ember | `#C0542C` Ember Orange | `DISCORD_ROLE_PRODUCT_B` | `product_b_reward` |
| Aurevon Insider | `#2A7A4F` Forest Green | `DISCORD_ROLE_PRODUCT_A` | `product_a_reward` |
| Verified Member | `#808080` Grey | `DISCORD_ROLE_VERIFIED` | — |

### 7 Categories + 24 Channels

| Category | Channels | Access |
|---|---|---|
| 🚪 START HERE | #rules, #verify, #faq | @everyone sees #verify; Verified Member+ sees rest |
| 📢 GENERAL | #welcome, #announcements, #intros, #general-chat | All verified members |
| 💼 DEAL FLOW | #multifamily, #mixed-use, #small-cre, #self-storage, #deal-reviews, #market-intel | Tier-locked (Ember+, Obsidian+, Genesis) |
| 🏨 TIER LOUNGES | #insider-lounge, #ember-lounge, #obsidian-lounge, #genesis-lounge, #chrome-lounge | **Exclusive** — each role sees only its own lounge |
| 🤝 VENDORS & REFERRALS | #lender-referrals, #broker-referrals, #vendor-referrals | Tier-locked (Obsidian+, Genesis, Chrome+) |
| 🎙️ VOICE ROOMS | General Lounge, Deal Room, Operator Suite, Genesis War Room | Tier-gated voice channels |
| 🔧 BOT & LOGS | #bot-commands, #join-logs, #role-logs, #audit-log, #mod-actions | **Invisible to all members — bot only** |

### Deal Flow Tier Access

| Channel | Minimum Role |
|---|---|
| #market-intel | Aurevon Insider+ |
| #multifamily, #deal-reviews | Aurevon Ember+ |
| #mixed-use, #self-storage | Aurevon Obsidian Executive+ |
| #small-cre | 001 Genesis only |
| #lender-referrals | Aurevon Obsidian Executive+ |
| #vendor-referrals | 004 Chrome+ |
| #broker-referrals | 001 Genesis only |

### 3 Embedded Messages Posted Automatically

- **#rules** — Aurevon 7-rule community standards embed
- **#verify** — Membership verification embed with **Member Portal** and **Visit Aurevon** buttons
- **#welcome** — Full onboarding embed with tier breakdown and channel navigation

---

## Prerequisites

1. **Node.js 18+** — [nodejs.org](https://nodejs.org)
2. **A Discord account** with a server already created (blank — the bot will populate it)
3. **A Discord bot** created at [discord.com/developers/applications](https://discord.com/developers/applications)

---

## Step-by-Step Setup

### 1. Create the Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it **Aurevon Bot** → Create
3. Go to **Bot** in the left sidebar
4. Click **Reset Token** → copy the token (you'll need it in step 4)
5. Under **Privileged Gateway Intents**, enable:
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent**
6. Uncheck **Public Bot** (keep it private)

### 2. Invite the Bot to Your Server

Build the invite URL (replace `YOUR_CLIENT_ID` with the value from **General Information**):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=268437508&scope=bot
```

> Permissions integer `268437508` grants: **Manage Roles** + **Manage Channels** + **Read Messages** + **Send Messages** + **Manage Server**

Open the URL → select your server → **Authorize**.

### 3. Enable Developer Mode + Get Your Server ID

1. Open Discord → **User Settings → Advanced** → toggle **Developer Mode** ON
2. Right-click your server icon → **Copy Server ID**

### 4. Configure .env

```bash
cd discord
cp .env.example .env
```

Open `.env` and fill in:

```
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_GUILD_ID=your_server_id_here
SITE_URL=https://www.aurevonvc.com
```

### 5. Install + Run

```bash
cd discord
npm install
npm run setup
```

The script will:
- Print live progress as each role and channel is created
- Post all three embeds with buttons automatically
- Print a full env-var block at the end ready to paste into Vercel

**Total runtime: ~1–2 minutes** (Discord rate limits require small delays between API calls)

---

## After Running

### Copy the Env-Var Block into Vercel

At the end of the script you'll see output like:

```
DISCORD_GUILD_ID=1234567890123456789
DISCORD_ROLE_MONTHLY=1234567890123456790
DISCORD_ROLE_LIFETIME=1234567890123456791
DISCORD_ROLE_PRODUCT_A=1234567890123456792
DISCORD_ROLE_PRODUCT_B=1234567890123456793
DISCORD_ROLE_PRODUCT_C=1234567890123456794
DISCORD_ROLE_VERIFIED=1234567890123456795
```

Paste these into **Vercel project → Settings → Environment Variables** (alongside your existing `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`).

> The entitlement engine in `api/_lib/entitlements.js` reads `DISCORD_ROLE_MONTHLY`, `DISCORD_ROLE_LIFETIME`, `DISCORD_ROLE_PRODUCT_A/B/C` to assign roles during the OAuth callback and sync flows.

### OAuth2 Setup (Vercel backend)

In the Discord Developer Portal → your application → **OAuth2**:

1. Add redirect URI: `https://www.aurevonvc.com/api/discord/callback`
2. Copy **Client ID** → `DISCORD_CLIENT_ID` in Vercel
3. Copy **Client Secret** → `DISCORD_CLIENT_SECRET` in Vercel

These enable the `/api/discord/auth` → `/api/discord/callback` OAuth flow that links a member's email to their Discord account and assigns their tier role.

### Manual Steps (Discord UI — cannot be automated via API)

1. **Server Settings → Safety Setup**
   - Enable Community Mode
   - Rules Channel → `#rules`
   - Community Updates Channel → `#announcements`

2. **Server Settings → Onboarding**
   - Add `#verify` as the first onboarding step
   - Add `#rules` as a required read channel

3. **Server Settings → Moderation**
   - Verification Level: **Medium** (verified email required)
   - Explicit Media Content Filter: **All members**

4. **Role List** — confirm **Aurevon Bot** sits at the very top (drag it if needed). The bot must be above all tier roles or Discord returns 403 when assigning roles.

---

## How the Vercel Backend Uses These Roles

The role IDs you paste into Vercel are consumed by three flows:

| Flow | File | Trigger |
|---|---|---|
| OAuth Discord link | `api/discord.js` → `action=callback` | Member clicks "Connect Discord" in portal |
| Bot sync (manual) | `api/discord.js` → `action=sync` | POST with `{ email }` + sync secret |
| Daily cron reconcile | `api/discord.js` → `action=check-membership` | Vercel Cron at `0 9 * * *` |

The cron runs daily at 09:00 UTC and re-syncs any members whose Discord role assignment failed or was never completed.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing env var: DISCORD_BOT_TOKEN` | Copy `.env.example` → `.env` and fill in values |
| `Unknown Guild` | Bot isn't in the server — redo the OAuth invite step |
| `Missing Permissions` | Bot role needs **Manage Roles** + **Manage Channels** |
| Role positions not saving | Drag **Aurevon Bot** to top manually in Server Settings → Roles |
| `403` on role assign (from Vercel) | Aurevon Bot role must be ABOVE all tier roles in the list |
| State HMAC failure (OAuth) | `STATE_SECRET` env var differs between deployments |
| Redirect URI mismatch | URI in Developer Portal must exactly match `DOMAIN` env var |

---

## Re-Running

To start fresh: go to **Server Settings → Roles** and **Server Settings → Channels**, delete everything Aurevon created, then run `npm run setup` again. (Or create a new blank server and run it there.)

The script checks for existing roles by name and skips duplicates — safe to re-run if interrupted.

---

*Aurevon Ventures LLC — Built for Operators.*
