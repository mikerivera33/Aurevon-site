# Aurevon Operators Discord Server — Setup Guide

This document walks you through creating the Aurevon Discord server, configuring
roles and channels, connecting the bot, and wiring everything into the Vercel backend.

---

## 1. Create the Discord Server

1. Open Discord → click the **+** icon in the server list → **Create My Own**.
2. Choose **For a club or community**.
3. Name it **BLOCKT Operators**.
4. Upload the Aurevon logo as the server icon (use the gold-on-black logo variant).
5. Click **Create**.

---

## 2. Enable Developer Mode

You need this to copy role and channel IDs.

1. Go to **User Settings** (gear icon) → **Advanced**.
2. Toggle **Developer Mode** on.

---

## 3. Create Roles

Go to **Server Settings → Roles → Create Role** for each role below.
Order matters: drag them from top to bottom as listed (higher = more permissions).

| Role Name                  | Color (hex)  | Position |
|---------------------------|-------------|----------|
| Aurevon Bot                 | `#5865F2`   | 1 (top)  |
| 001 Genesis                | `#C8A96E`   | 2        |
| 004 Chrome                 | `#888888`   | 3        |
| Aurevon Obsidian Executive  | `#4A4A6A`   | 4        |
| Aurevon Ember               | `#C0542C`   | 5        |
| Aurevon Insider             | `#2A7A4F`   | 6        |

For each role:
- **Display role separately** → ON
- **Allow anyone to @mention** → OFF
- Permissions → leave all OFF (channels will grant access via role overrides).

### Copy Role IDs

Right-click each role → **Copy Role ID** → paste into your Vercel env vars:

```
DISCORD_ROLE_INSIDER=<id for Aurevon Insider>
DISCORD_ROLE_EMBER=<id for Aurevon Ember>
DISCORD_ROLE_OBSIDIAN=<id for Aurevon Obsidian Executive>
DISCORD_ROLE_GENESIS=<id for 001 Genesis>
DISCORD_ROLE_CHROME=<id for 004 Chrome>
```

---

## 4. Create Channel Categories and Channels

### Category: General (visible to all verified members)

| Channel        | Type | Purpose                        |
|----------------|------|--------------------------------|
| #welcome       | Text | Automated welcome messages     |
| #intros        | Text | Member introductions           |
| #announcements | Text | Aurevon deal and news updates   |

**Permission overrides for General:**
- `@everyone` → View Channel: DENY
- Each Aurevon role → View Channel: ALLOW

### Category: Deal Flow (locked by tier)

| Channel       | Minimum Role             |
|---------------|--------------------------|
| #multifamily  | Aurevon Ember             |
| #mixed-use    | Aurevon Obsidian Executive|
| #small-cre    | 001 Genesis              |
| #self-storage | Aurevon Obsidian Executive|

**Per channel, deny @everyone, then allow only the minimum role and all roles above it.**

### Category: Tier Lounges (private — each role sees only its own)

| Channel           | Exclusive Role             |
|-------------------|---------------------------|
| #insider-lounge   | Aurevon Insider             |
| #ember-lounge     | Aurevon Ember               |
| #obsidian-lounge  | Aurevon Obsidian Executive  |
| #genesis-lounge   | 001 Genesis                |
| #chrome-lounge    | 004 Chrome                 |

**Per channel:**
- `@everyone` → View Channel: DENY
- Only the specific role → View Channel: ALLOW, Send Messages: ALLOW

### Category: Vendors (RE tiers only)

| Channel            | Minimum Role             |
|--------------------|--------------------------|
| #lender-referrals  | Aurevon Obsidian Executive|
| #broker-referrals  | 001 Genesis              |
| #vendor-referrals  | 004 Chrome               |

---

## 5. Create the Discord Application and Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications).
2. Click **New Application** → name it **BLOCKT Bot** → **Create**.
3. Go to **Bot** → **Add Bot** → confirm.
4. Under **Bot**:
   - Uncheck **Public Bot** (so only you can invite it).
   - Uncheck **Requires OAuth2 Code Grant**.
   - Copy the **Token** → save as `DISCORD_BOT_TOKEN` in Vercel.
5. Under **Privileged Gateway Intents** enable:
   - **Server Members Intent** (required to manage member roles).

---

## 6. Invite the Bot to Your Server

Construct the invite URL with permissions integer `268437504`:
(Manage Roles + Read Messages + Send Messages + Manage Server)

```
https://discord.com/api/oauth2/authorize
  ?client_id=YOUR_BOT_CLIENT_ID
  &permissions=268437504
  &scope=bot
```

Replace `YOUR_BOT_CLIENT_ID` with the value on the **General Information** page.

Open the URL in your browser, select **BLOCKT Operators** from the server dropdown, and click **Authorize**.

**Critical:** The **BLOCKT Bot** role must sit ABOVE all member roles in the role list (step 3), or Discord will return 403 when assigning roles.

---

## 7. Configure OAuth2 for User Login

In the Developer Portal → your application → **OAuth2**:

1. Add redirect URI:
   ```
   https://yourdomain.com/api/discord/callback
   ```
2. Copy **Client ID** → `DISCORD_CLIENT_ID`
3. Copy **Client Secret** → `DISCORD_CLIENT_SECRET`

---

## 8. Get the Guild (Server) ID

Right-click the Aurevon Operators server icon → **Copy Server ID**.
Save as `DISCORD_GUILD_ID` in Vercel.

---

## 9. Vercel Environment Variables

Add all of the following to your Vercel project (Settings → Environment Variables):

```
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_ROLE_INSIDER=
DISCORD_ROLE_EMBER=
DISCORD_ROLE_OBSIDIAN=
DISCORD_ROLE_GENESIS=
DISCORD_ROLE_CHROME=
DISCORD_INVITE_URL=https://discord.gg/YOUR_INVITE_CODE
STATE_SECRET=         # 32+ random chars — generate with: openssl rand -hex 16
DOMAIN=https://yourdomain.com
AIRTABLE_API_KEY=
AIRTABLE_BASE_ID=
AIRTABLE_TABLE=NFT_Mints
CRON_SECRET=          # Optional — protects /api/discord/check-membership
```

---

## 10. Set Up the Daily Reminder Cron

In your `vercel.json`, add:

```json
{
  "crons": [
    {
      "path": "/api/discord/check-membership",
      "schedule": "0 9 * * *"
    }
  ]
}
```

This runs `check-membership` every day at 09:00 UTC. Wire up your email provider
inside `check-membership.js` (Resend snippet is pre-commented in the file).

---

## 11. Test the Full OAuth Flow

1. Generate a test invite URL manually:
   ```
   https://yourdomain.com/api/discord/auth?email=test@example.com
   ```
2. Open it in an incognito window.
3. You should be redirected to the Discord consent screen.
4. Authorize → Discord redirects to `/api/discord/callback`.
5. Callback verifies state, exchanges code, looks up Airtable, assigns role.
6. You land on `/discord-welcome.html` with your role displayed.
7. Open Discord → Aurevon Operators → confirm the role appears on your profile.

### Troubleshooting

| Symptom                      | Likely cause                                      |
|------------------------------|---------------------------------------------------|
| 403 on role assign           | Bot role is BELOW the target role in server list  |
| "Bot token invalid"          | Token was reset in developer portal — regenerate  |
| Airtable returns no record   | Email case mismatch or Status not Sent/Minted     |
| State HMAC failure           | `STATE_SECRET` mismatch between deployments       |
| Redirect URI mismatch        | URI in dev portal must match `DOMAIN` env var exactly |
