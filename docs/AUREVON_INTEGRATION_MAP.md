# Aurevon Integration Map

How every system in this repo connects. Read this before changing webhooks, env vars, or tier logic — every piece has a downstream consequence.

## The 6 systems

| System | Hosted on | Role |
|---|---|---|
| **aurevon-site** (this repo) | Vercel (`www.aurevonvc.com`) | Public marketing site, checkout pages, member portal, all serverless API + webhooks |
| **Discord bot** (`discord/bot.js`) | Railway (persistent process) | Server moderation, marketing, tier role assignment, member analytics |
| **Airtable** (`appI9X8vcRcK1QZ1l`) | Airtable Cloud | Source of truth: members, payments, NFT mints, customer auth, leads |
| **Stripe** | Stripe | Payments for memberships + RE services |
| **Crossmint** | Crossmint Cloud | Custodial NFT minting on Base (no wallet required from customer) |
| **Resend** | Resend Cloud | Transactional email delivery |

## The canonical purchase pipeline

```
Customer pays (Stripe Checkout or PayPal)
        │
        ▼
Vercel webhook  ←─── /api/webhooks/stripe.js   or   /api/webhooks/paypal.js
        │            (verifies HMAC, then:)
        │
        ├─► Airtable: create Payment row
        ├─► Crossmint API: mint NFT to customer email
        │           │
        │           ▼
        │   Crossmint webhook  ←─── /api/webhooks/crossmint.js
        │           │            (verifies HMAC, then:)
        │           │
        │           ├─► Airtable: update NFT_Mints row
        │           ├─► If customer's Discord ID is known: call Discord REST API
        │           │       └─► assign tier role to the member
        │           └─► Engage.io: log entitlement activation
        │
        ├─► Airtable: create NFT_Mint row (pending → minted)
        └─► Resend: send "your pass is on the way" email
```

## Discord ID linkage

Discord IDs enter the system three ways:

1. **OAuth flow** — customer visits `/discord-welcome.html` after purchase → clicks "Connect Discord" → `/api/discord/auth` → callback at `/api/discord/callback` stores Discord ID in Airtable Members table
2. **Manual /verify-member command** — moderator runs the slash command in the server linking an email to a Discord ID
3. **Member portal** — logged-in member adds their Discord ID at `/portal.html`

Once linked, Crossmint webhooks can auto-assign tier roles.

## Tier ↔ NFT ↔ Discord role mapping

Defined canonically in `api/_lib/entitlements.js`. Do not duplicate this elsewhere:

| Entitlement | NFT label | Discord role env | Membership mode |
|---|---|---|---|
| `monthly_membership` | `001 Genesis` | `DISCORD_ROLE_MONTHLY` | recurring (revocable) |
| `lifetime_membership` | `004 Chrome` | `DISCORD_ROLE_LIFETIME` | lifetime |
| `product_a_reward` | `Aurevon Insider` | `DISCORD_ROLE_PRODUCT_A` | permanent |
| `product_b_reward` | `Aurevon Ember` | `DISCORD_ROLE_PRODUCT_B` | permanent |
| `product_c_reward` | `Aurevon Obsidian Executive` | `DISCORD_ROLE_PRODUCT_C` | permanent |

## Env var ownership (which env var goes where)

| Env var | Vercel | Railway (Discord bot) | GitHub Secrets |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | ✅ | — | — |
| `STRIPE_WEBHOOK_SECRET` | ✅ | — | — |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` | ✅ | — | — |
| `CROSSMINT_API_KEY` | ✅ | — | — |
| `CROSSMINT_COLLECTION_ID` (+ per-tier) | ✅ | — | — |
| `CROSSMINT_WEBHOOK_SECRET` | ✅ | — | — |
| `RESEND_API_KEY` | ✅ | — | — |
| `AIRTABLE_PAT` | ✅ | ✅ (bot reads members) | — |
| `AIRTABLE_BASE_ID` | ✅ | ✅ | — |
| `DISCORD_BOT_TOKEN` | ✅ (for `_lib/discord-bot.js`) | ✅ (for the bot itself) | — |
| `DISCORD_CLIENT_ID` / `DISCORD_GUILD_ID` | ✅ | ✅ | — |
| `DISCORD_CLIENT_SECRET` | ✅ (OAuth callback only) | — | — |
| `DISCORD_ROLE_*` (5 tier roles + verified) | ✅ | ✅ | — |
| `STATE_SECRET` / `SYNC_SECRET` / `RECONCILE_SECRET` / `CRON_SECRET` | ✅ | — | — |
| `VERCEL_TOKEN` | — | — | ✅ (for CI deploys) |

**Rule:** any value used by `/api/*` belongs in Vercel. Any value used by `discord/bot.js` belongs in Railway. Many values live in both — keep them in sync.

## Webhook endpoints (configure in each provider's dashboard)

| Provider | URL | Events |
|---|---|---|
| Stripe | `https://www.aurevonvc.com/api/webhooks/stripe` | `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed` |
| PayPal | `https://www.aurevonvc.com/api/webhooks/paypal` | Checkout / IPN |
| Crossmint | `https://www.aurevonvc.com/api/webhooks/crossmint` | `action.succeeded`, `action.failed`, `nft.minted` |

## Cron schedule (Vercel)

Defined in `vercel.json`. Hobby plan limit is 2 crons — do not add more without upgrading.

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/retry-mints` | `0 3 * * *` (03:00) | Retry any failed Crossmint mints |
| `/api/cron/reconcile` | `0 2 * * *` (02:00) | Reconcile Airtable entitlements against Discord roles |

## Health monitoring

GitHub Actions workflow `.github/workflows/health-check.yml` runs every 6h, hits `/api/health`, validates env completeness, and tests page routes. If `/api/health` returns non-200 or env is incomplete, the job fails and surfaces the issue.

To run on demand: GitHub → Actions → Scheduled Health Monitor → Run workflow.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Crossmint webhook fires but Discord role not assigned | Customer's Discord ID not linked in Airtable Members | Have them complete `/discord-welcome.html` OAuth, or run `/verify-member` in server |
| Stripe payment succeeds but no NFT mint | `CROSSMINT_API_KEY` missing in Vercel | Set in Vercel → Settings → Environment Variables → redeploy |
| Bot online but `/sync-member` fails | `AIRTABLE_PAT` missing in Railway | Add to Railway → Variables → restart |
| Vercel build fails on deploy | YAML / merge conflict markers in `.github/workflows/*` | Validate with `python3 -c "import yaml; yaml.safe_load(open('PATH'))"` |
| New tier added but no role assigned | New entitlement not in `entitlements.js` ENTITLEMENT_MAP | Add the SKU and the `discordRoleEnv` mapping |

## When you add a new tier

1. Add the entitlement to `api/_lib/entitlements.js` → `ENTITLEMENT_MAP`
2. Add the legacy mapping to `api/_lib/tiers.js` → `_BASE`
3. Add the Crossmint template ID env var (`CROSSMINT_TEMPLATE_<TIER>`)
4. Add the Discord role env var (`DISCORD_ROLE_<TIER>`) in both Vercel and Railway
5. Create the Discord role in the server, copy the ID
6. Update `discord/bot.js` → `TIER_DEFS` map at the top
7. Add the role to `/sync-member` and `/dm-tier` choices
8. Test the full pipeline with a $1 Stripe test charge in staging

## When you change the Discord server

If you create a new server, the following must change:

- `DISCORD_GUILD_ID` (in both Vercel and Railway)
- Every `DISCORD_ROLE_*` env var (new role IDs)
- `DISCORD_INVITE_URL` (if used in marketing pages)
- Re-run `npm run setup` inside `discord/` to scaffold channels/categories on the new server

Bot token can stay the same — bots can be members of multiple guilds.
