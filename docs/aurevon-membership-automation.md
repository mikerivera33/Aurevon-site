# Aurevon NFT Membership + Discord Automation

## Architecture Overview

```
Purchase (Stripe/PayPal)
       │
       ▼
Webhook Handler ──► Airtable (Payments + NFT_Mints)
       │
       ▼
Crossmint Mint ──► Crossmint Webhook ──► Update NFT_Mints (Minted)
                           │
                           ▼
                   Member has Discord ID? ─── YES ──► Bot assigns role
                           │                                │
                          NO                        Update Airtable
                           │                        Fire Engage event
                           ▼
                   Mark sync=pending
                   (reconcile job picks it up)

Member visits /member-claim
       │
       ▼
POST /api/member/claim ──► Airtable upsert
       │
       ▼
Discord linked? ─── YES ──► Assign role immediately
       │
      NO
       │
       ▼
Show "Connect Discord" button
       │
       ▼
GET /api/discord?action=auth&email=...
       │
OAuth flow ──► /api/discord?action=callback
                   │
                   ▼
           Assign role + update Airtable
```

---

## Entitlement Map

| Entitlement Key      | NFT                    | Discord Role Env         | Tier (legacy)                  | Mode      | Revocable |
|---------------------|------------------------|--------------------------|-------------------------------|-----------|-----------|
| monthly_membership  | 001 Genesis            | DISCORD_ROLE_MONTHLY     | comm_monthly                   | recurring | ✓ |
| lifetime_membership | 004 Chrome             | DISCORD_ROLE_LIFETIME    | comm_lifetime                  | lifetime  | ✗ |
| product_a_reward    | Aurevon Insider        | DISCORD_ROLE_PRODUCT_A   | full, bogo, re_full, re_bogo   | permanent | ✗ |
| product_b_reward    | Aurevon Ember          | DISCORD_ROLE_PRODUCT_B   | retainer, re_retainer          | permanent | ✗ |
| product_c_reward    | Aurevon Obsidian Exec  | DISCORD_ROLE_PRODUCT_C   | enterprise, re_enterprise      | permanent | ✗ |

---

## Airtable Schema

### Base Used
**Aurevon Operations** — `appI9X8vcRcK1QZ1l`

### Tables Reused (existing)

| App Concept   | Airtable Table   | Table ID              |
|---------------|------------------|-----------------------|
| Orders        | Payments         | tbl6KlhM9fIH19W5i    |
| NFT_Issuance  | NFT_Mints        | tbliXEGJdoEIAJU06    |
| Members       | Members          | tblYPn7hxnrgH723B    |
| Auth          | CustomerAuth     | tblbCS7TL65FcOiWn    |
| Leads         | Leads            | tblDuezyOsxy7sNES    |

### Fields Added to Existing Tables

You must add the following fields manually in Airtable (Settings → Customize fields).

#### `Members` table — add these fields:

| Field Name            | Type                | Notes                                    |
|-----------------------|---------------------|------------------------------------------|
| Discord ID            | Single line text    | Filled after OAuth                        |
| Discord Linked At     | Date/time           | When Discord was connected                |
| Discord Username      | Single line text    | username#discriminator                    |
| Wallet Address        | Single line text    | Optional — for Collab.Land NFT gating     |
| Entitlement Type      | Single line text    | e.g. monthly_membership                  |
| Entitlement Status    | Single select       | Options: active, expired, revoked         |
| Entitlement Expires At| Date                | For monthly — set by billing system       |
| Billing State         | Single line text    | active / cancelled / past_due             |
| Discord Sync Status   | Single select       | Options: pending, synced, failed, revoked |
| Discord Sync At       | Date/time           | Last sync attempt                         |
| Discord Sync Error    | Long text           | Error message if sync failed              |

#### `NFT_Mints` table — add these fields:

| Field Name       | Type             | Notes                               |
|------------------|------------------|-------------------------------------|
| Entitlement Type | Single line text | e.g. monthly_membership             |
| Discord Synced   | Checkbox         | True once role assigned             |
| Discord Synced At| Date/time        | When role was assigned              |
| Revoked At       | Date/time        | Set when monthly access is revoked  |

### No New Tables Required
All functionality uses existing tables extended with new fields.

---

## API Endpoints

| Method | Path                            | Purpose                                         |
|--------|----------------------------------|-------------------------------------------------|
| POST   | /api/webhooks/stripe            | Stripe checkout.session.completed → mint NFT    |
| POST   | /api/webhooks/paypal            | PayPal IPN → mint NFT                           |
| POST   | /api/webhooks/crossmint         | Mint status callback → activate entitlement      |
| GET    | /api/discord?action=auth        | Start Discord OAuth                              |
| GET    | /api/discord?action=callback    | Finish OAuth → assign role                      |
| POST   | /api/discord?action=sync        | Bot-assign role for a linked member              |
| POST   | /api/member/claim               | Link Discord/wallet → assign role if ready       |
| GET    | /api/member/claim?action=status | Check entitlement + sync status                 |
| GET    | /api/member/claim?action=reconcile | Re-sync pending + revoke expired monthly     |
| GET    | /api/health                     | Env var check + function inventory              |

---

## Environment Variables Setup

Set ALL in **Vercel Dashboard → Your Project → Settings → Environment Variables** (select Production + Preview + Development).

See `.env.example` for the full list. Do not commit real values.

### Minimum required to go live:
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- `CROSSMINT_API_KEY` + `CROSSMINT_COLLECTION_ID` + templates
- `AIRTABLE_PAT` + `AIRTABLE_BASE_ID`
- `DISCORD_BOT_TOKEN` + `DISCORD_CLIENT_ID` + `DISCORD_CLIENT_SECRET` + `DISCORD_GUILD_ID`
- `DISCORD_ROLE_MONTHLY` + `DISCORD_ROLE_LIFETIME` + `DISCORD_ROLE_PRODUCT_A/B/C`
- `STATE_SECRET` + `SYNC_SECRET` + `RECONCILE_SECRET`
- `RESEND_API_KEY` + `RESEND_FROM_EMAIL`
- `DOMAIN=https://www.aurevonvc.com`

---

## Discord Setup Checklist

### 1. Create 5 membership roles (in order, top = highest)
```
Aurevon Obsidian Executive    ← product_c_reward
Aurevon Ember                 ← product_b_reward
Aurevon Insider               ← product_a_reward
Aurevon Chrome Lifetime       ← lifetime_membership
Aurevon Genesis Monthly       ← monthly_membership
```

### 2. Bot setup
1. Go to https://discord.com/developers/applications → your app → Bot
2. Enable **Server Members Intent** (Privileged Gateway Intents)
3. Copy **Bot Token** → set as `DISCORD_BOT_TOKEN`
4. Invite bot with URL:  
   `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=268435456&scope=bot`  
   (268435456 = Manage Roles)
5. In Discord server: **move the bot's role ABOVE all 5 membership roles**

### 3. OAuth setup
1. Discord Developer Portal → your app → OAuth2 → Redirects
2. Add: `https://www.aurevonvc.com/api/discord?action=callback`
3. Copy Client ID → `DISCORD_CLIENT_ID`
4. Copy Client Secret → `DISCORD_CLIENT_SECRET`

### 4. Get Role IDs
1. Discord Settings → Advanced → Enable Developer Mode
2. Right-click each role → Copy Role ID
3. Set: `DISCORD_ROLE_MONTHLY`, `DISCORD_ROLE_LIFETIME`, `DISCORD_ROLE_PRODUCT_A/B/C`

---

## Collab.Land Setup Checklist

Collab.Land provides token-gated channel access. It reads the wallet holding the NFT.

1. Add Collab.Land bot to your Discord server: https://collab.land/setup
2. Go to https://cc.collab.land → your community → Token Rules
3. For each NFT collection, create a rule:
   - **Chain**: Base (Ethereum L2)
   - **Token type**: ERC-721 or ERC-1155 (match your Crossmint collection)
   - **Contract address**: get from Crossmint Console → your collection → Contract Address
   - **Required balance**: ≥ 1
   - **Assign role**: the matching Discord role (e.g. Aurevon Genesis Monthly)
4. Ensure Collab.Land bot role is **above** all 5 membership roles
5. Create gated channels and set permissions to each role
6. Members with email wallets (Crossmint custodial) must export their wallet or link to Collab.Land — see Crossmint export docs

---

## Crossmint Webhook Setup

1. Go to https://www.crossmint.com/console → your project → Webhooks
2. Add endpoint: `https://www.aurevonvc.com/api/webhooks/crossmint`
3. Select events: `action.succeeded`, `action.failed`
4. Copy the signing secret → set as `CROSSMINT_WEBHOOK_SECRET`

---

## Engage.io Setup

1. Sign up at https://engage.so
2. Go to Settings → API Keys → create key
3. Copy API Key → `ENGAGE_IO_API_KEY`
4. Copy Workspace ID → `ENGAGE_IO_WORKSPACE_ID`

Events fired automatically:
- `entitlement_activated` — on successful mint + role assign
- `discord_link_reminder` — on reconcile pass for unlinked buyers (24h+)
- `subscription_cancelled` — on monthly revocation

Build sequences in Engage around these events.

---

## Reconciliation Job

Run `GET /api/member/claim?action=reconcile&secret=YOUR_RECONCILE_SECRET` periodically.

Recommended: set up a daily cron (GitHub Actions, Vercel Cron, or external scheduler):
```yaml
# .github/workflows/reconcile.yml (optional — add separately)
on:
  schedule:
    - cron: '0 6 * * *'   # Daily at 6am UTC
jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - name: Run reconcile
        run: |
          curl -f -X GET \
            "https://www.aurevonvc.com/api/member/claim?action=reconcile&secret=${{ secrets.RECONCILE_SECRET }}"
```

What the reconcile job does:
1. Finds members with `Discord Sync Status = pending` → assigns roles
2. Finds monthly members past their grace period → removes roles
3. Finds buyers who haven't linked Discord after 24h → sends Engage reminder

---

## Deployment Notes

1. Push to `main` → GitHub Actions runs lint + function count check + Vercel deploy
2. The CI gate fails if function count exceeds 12 (Hobby plan limit)
3. Always use `vercel --force` to bust Vercel's build cache after config changes
4. After deploy, check `https://www.aurevonvc.com/api/health` — all env vars should show `true`

---

## Test Checklist

- [ ] `/api/health` returns all `true` (no missing env vars)
- [ ] Stripe test checkout → `checkout.session.completed` fires → NFT mint initiated → Airtable `NFT_Mints` row created
- [ ] Crossmint webhook fires → `Mint Status` updated to `Minted`
- [ ] Member visits `/member-claim` → enters email → sees NFT status
- [ ] Member clicks "Connect Discord" → OAuth flow → Discord role assigned → `Discord Sync Status = synced`
- [ ] `GET /api/member/claim?action=reconcile&secret=xxx` → pending syncs resolved
- [ ] Monthly member: expire `Entitlement Expires At` to past, set `Billing State=cancelled` → reconcile removes role
- [ ] Collab.Land bot verifies NFT ownership and gates channels

---

## Manual Configuration Remaining

| Item | Who | What |
|------|-----|------|
| Airtable — add fields to Members | You | 11 new fields (see schema section) |
| Airtable — add fields to NFT_Mints | You | 4 new fields (see schema section) |
| Discord — create 5 roles | You | In Discord server settings |
| Discord — configure bot intents | You | Developer Portal → Bot → Server Members Intent |
| Discord — move bot role above membership roles | You | Server Settings → Roles |
| Crossmint — create webhook | You | Crossmint Console |
| Stripe — create webhook | You | Stripe Dashboard |
| Collab.Land — create 5 token rules | You | cc.collab.land |
| Vercel — set all env vars | You | Vercel Dashboard |
| GitHub — set VERCEL_TOKEN + RECONCILE_SECRET secrets | You | Repo Settings → Secrets |
| Engage.io — build sequences for 3 events | You | Engage Dashboard |
