# Aurevon Discord Bot — Railway Deployment Guide

Deploy `discord/bot.js` as a permanent 24/7 service on Railway (free tier available).
Total time: ~10 minutes.

---

## Step 1 — Get Your Discord Bot Token

1. Go to https://discord.com/developers/applications/1506515165003255889/bot
2. Click **Reset Token** → confirm → copy the token immediately
3. Save it somewhere safe — you'll need it in Step 4

## Step 2 — Get Your Guild ID

1. Open Discord
2. Go to **User Settings → Advanced → enable Developer Mode**
3. Right-click the **Aurevon Ventures** server icon → **Copy Server ID**
4. Your Guild ID: `1499526813490221207` (already pre-filled in `.env.example`)

## Step 3 — Invite the Bot to Aurevon Ventures

Open this URL in your browser (already scoped to the correct app):

```
https://discord.com/oauth2/authorize?client_id=1506515165003255889&permissions=268437508&scope=bot+applications.commands
```

- Select **Aurevon Ventures** from the server dropdown
- Click **Authorize**
- Complete the CAPTCHA

The bot will appear offline in your server — that's normal until it's deployed.

## Step 4 — Deploy on Railway

### 4a. Create Railway account
Go to https://railway.app → sign in with GitHub

### 4b. New Project from GitHub
1. Click **New Project**
2. Select **Deploy from GitHub repo**
3. Choose `mikerivera33/Aurevon-site`
4. Railway detects `railway.json` automatically — no config needed

### 4c. Add Environment Variables
In the Railway dashboard for your new service, go to **Variables** and add:

| Variable | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | (from Step 1) |
| `DISCORD_GUILD_ID` | `1499526813490221207` |
| `DISCORD_CLIENT_ID` | `1506515165003255889` |
| `DISCORD_CLIENT_SECRET` | (from Developer Portal → OAuth2 → Reset Secret) |
| `AIRTABLE_PAT` | (your Airtable PAT — same as in Vercel) |
| `AIRTABLE_BASE_ID` | `appI9X8vcRcK1QZ1l` |
| `SITE_URL` | `https://www.aurevonvc.com` |
| `DISCORD_ROLE_MONTHLY` | (after running setup — see Step 5) |
| `DISCORD_ROLE_LIFETIME` | (after running setup — see Step 5) |
| `DISCORD_ROLE_PRODUCT_A` | (after running setup — see Step 5) |
| `DISCORD_ROLE_PRODUCT_B` | (after running setup — see Step 5) |
| `DISCORD_ROLE_PRODUCT_C` | (after running setup — see Step 5) |
| `DISCORD_ROLE_VERIFIED` | (after running setup — see Step 5) |

### 4d. Deploy
Click **Deploy** — Railway builds and starts `node bot.js` inside `discord/`.
The service will show **Active** with a green dot when the bot is online.

---

## Step 5 — Run Server Setup (builds channels, roles, embeds)

Run this once from your local machine to scaffold the entire Aurevon Ventures server:

```bash
git clone https://github.com/mikerivera33/Aurevon-site.git
cd Aurevon-site/discord
cp .env.example .env
# Edit .env — fill in DISCORD_BOT_TOKEN and DISCORD_GUILD_ID
npm install
npm run setup
```

At the end the script prints:

```
DISCORD_GUILD_ID=1499526813490221207
DISCORD_ROLE_MONTHLY=xxxxxxxxxxxxxxxxxxxx
DISCORD_ROLE_LIFETIME=xxxxxxxxxxxxxxxxxxxx
DISCORD_ROLE_PRODUCT_A=xxxxxxxxxxxxxxxxxxxx
DISCORD_ROLE_PRODUCT_B=xxxxxxxxxxxxxxxxxxxx
DISCORD_ROLE_PRODUCT_C=xxxxxxxxxxxxxxxxxxxx
DISCORD_ROLE_VERIFIED=xxxxxxxxxxxxxxxxxxxx
```

Copy these values and:
1. Add them to **Railway Variables** (update the placeholders from Step 4c)
2. Add them to **Vercel** → Settings → Environment Variables (same project)

---

## Step 6 — Fix Role Hierarchy in Discord

After setup completes:
1. Open **Aurevon Ventures** → **Server Settings → Roles**
2. Drag **Aurevon Bot** role to the very **top** of the list (above all tier roles)
3. This is required — the bot cannot assign roles higher than its own role

---

## Step 7 — Register Slash Commands

Once the bot is running on Railway, trigger command registration once by running:

```bash
# In discord/ directory with .env filled in:
node -e "import('./bot.js')" 
```

Or simply let the bot start normally — it auto-registers all slash commands on startup.

---

## Step 8 — Add Role IDs to Vercel

Go to https://vercel.com/mikerivera9917-7312s-projects/aurevon-site/settings/environment-variables

Add/update these from the setup script output:
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_GUILD_ID`
- `DISCORD_ROLE_MONTHLY`
- `DISCORD_ROLE_LIFETIME`
- `DISCORD_ROLE_PRODUCT_A`
- `DISCORD_ROLE_PRODUCT_B`
- `DISCORD_ROLE_PRODUCT_C`
- `DISCORD_ROLE_VERIFIED`

Then redeploy Vercel (or wait for next commit to auto-deploy).

---

## Verification Checklist

- [ ] Bot appears online in Aurevon Ventures server
- [ ] All slash commands visible when typing `/` in any channel
- [ ] Purchase on website → role assigned in Discord within 30 seconds
- [ ] NFT minted and emailed automatically
- [ ] `/sync-member user@email.com` works in #bot-commands
- [ ] `/stats` shows member counts

---

## Bot Commands Reference

### Moderation
`/warn @user reason` — issue a formal warning (logged to Airtable)
`/timeout @user duration reason` — temporary mute
`/kick @user reason` — remove from server
`/ban @user reason` — permanent ban
`/unban user_id` — reverse ban
`/purge 1-100` — bulk delete messages
`/slowmode seconds` — channel rate limit
`/lock` / `/unlock` — freeze/unfreeze channel
`/modnote @user note` — private mod note

### Authorization & Role Sync
`/sync-member email` — pull role from Airtable by email
`/revoke-member @user` — remove all tier roles
`/sync-all` — batch sync all Airtable members (run after bulk import)
`/verify-member @user email` — force-link Discord ID to email in Airtable

### Role Management
`/add-role @user role` — assign any role manually
`/remove-role @user role` — remove any role manually
`/role-info role` — show role details and member count

### Marketing
`/announce #channel title body color` — branded embed to any channel
`/dm-tier tier message` — DM all members of a specific tier
`/promo code discount expires` — broadcast promo code with embed
`/poll question opt1 opt2 opt3 opt4` — reaction poll (up to 4 options)

### Support
`/ticket-setup` — post support ticket button in channel
`/close-ticket` — close and archive current ticket thread

### Analytics
`/stats` — server overview (members, tier breakdown, NFT mints)
`/lookup email` — full member record from Airtable
`/member-report` — export CSV summary of all members

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot shows offline | Check Railway logs — likely missing `DISCORD_BOT_TOKEN` |
| `Unknown Guild` error | Bot wasn't invited — redo Step 3 |
| `Missing Permissions` on role assign | Drag Aurevon Bot role to top in Server Settings → Roles |
| `403 on role assign` (from Vercel) | Same — bot role must be above all tier roles |
| Commands not showing | Restart Railway service to re-register slash commands |
| `State HMAC failure` in OAuth | `STATE_SECRET` mismatch between Railway and Vercel |

---

*Aurevon Ventures LLC — Built for Operators.*
