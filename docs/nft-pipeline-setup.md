# NFT pipeline setup (owner checklist)

How a paid order becomes an NFT, an email and a Discord role, and everything
the owner has to configure for that to work. This repo is public: this file
names environment variables only. Never paste a value into it, into code or
into chat. Values go only into the Vercel, Railway and GitHub settings fields
named below.

Generate a random secret with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## The five NFTs

| NFT | Earned by | Discord role env | Collection override env |
|---|---|---|---|
| Aurevon Insider | Full Package ($250), one-time | `DISCORD_ROLE_PRODUCT_A` | `CROSSMINT_COLLECTION_PRODUCT_A` |
| Aurevon Ember | Pro Retainer ($1,499/mo), first payment only | `DISCORD_ROLE_PRODUCT_B` | `CROSSMINT_COLLECTION_PRODUCT_B` |
| Aurevon Obsidian Executive | Enterprise ($2,499/mo), first payment only | `DISCORD_ROLE_PRODUCT_C` | `CROSSMINT_COLLECTION_PRODUCT_C` |
| 001 Genesis | Community Monthly ($29.99/mo), first payment only | `DISCORD_ROLE_MONTHLY` | `CROSSMINT_COLLECTION_MONTHLY` |
| 004 Chrome | Community Lifetime ($349.99), one-time | `DISCORD_ROLE_LIFETIME` | `CROSSMINT_COLLECTION_LIFETIME` |

- An unset collection override falls back to `CROSSMINT_COLLECTION_ID`.
- `CROSSMINT_TEMPLATE_*` variables are no longer read. Metadata is sent inline
  with each mint.
- BOGO, Second Opinion and add-ons earn no NFT.
- Subscription renewals never mint again. A full refund or a dispute revokes
  the pass and its role (for a subscription, only when the first payment is
  refunded or disputed).

## How it flows

1. Stripe (`/api/webhooks/stripe`) or PayPal IPN (`/api/webhooks/paypal`)
   records the payment in `payments` first. `payments.transaction_id` is
   unique, so a redelivered event is a no-op.
2. `api/_lib/fulfil.js` is the only mint path (Stripe, PayPal, manual mints
   via `/api/crossmint/mint`, and retries). One mint per NFT-earning payment,
   deduplicated by `nft_mints.payment_transaction_id`. Serials come from
   `next_serial()` in the database.
3. Crossmint mints to an email wallet. The request is an idempotent `PUT`
   keyed by the payment id, so a retry can never mint twice.
4. Email: "minted" only after a successful mint. Otherwise the buyer gets
   "Payment received", and the NFT is still being finalized.
5. `/api/webhooks/crossmint` confirms the mint (`nfts.create.succeeded`) or
   marks it failed (`nfts.create.failed`).
6. `/api/cron/retry-mints` (every 15 min) retries failed mints with backoff
   and gives up after 8 tries (alert `retry_mints.gave_up`).
   `/api/cron/reconcile` (daily 02:00 UTC) recovers payments with no mint
   row, Stripe sessions that were never recorded, pending Discord syncs and
   revocations.
7. Discord: the signed link in the email starts Discord OAuth, which grants
   the role for every pass the member holds. `/member-claim` emails a fresh
   link. Errors land on `/discord-welcome.html?error=<code>`. The Railway bot
   keeps roles in step.

## Environment variables by purpose

Vercel → Project → Settings → Environment Variables (Production). Mark every
secret as Sensitive. Authed `GET /api/health` lists anything missing or
misnamed (for example a mixed-case `Stripe_Webhook_Secret`).

| Purpose | Required | Optional |
|---|---|---|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | |
| PayPal IPN | `PAYPAL_BUSINESS_EMAIL` | `PAYPAL_ITEM_TIERS`, `PAYPAL_MODE` |
| Crossmint | `CROSSMINT_API_KEY`, `CROSSMINT_COLLECTION_ID`, `CROSSMINT_WEBHOOK_SECRET` | `CROSSMINT_COLLECTION_MONTHLY`, `CROSSMINT_COLLECTION_LIFETIME`, `CROSSMINT_COLLECTION_PRODUCT_A`, `CROSSMINT_COLLECTION_PRODUCT_B`, `CROSSMINT_COLLECTION_PRODUCT_C`, `CROSSMINT_ENV`, `CROSSMINT_CHAIN` |
| Email (Resend) | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | `RESEND_FROM_NAME` |
| Database (Supabase) | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) | |
| Alerts | `ALERT_WEBHOOK_URL` | `OWNER_ALERT_EMAIL` |
| Discord (site) | `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_INVITE_URL`, `DISCORD_ROLE_MONTHLY`, `DISCORD_ROLE_LIFETIME`, `DISCORD_ROLE_PRODUCT_A`, `DISCORD_ROLE_PRODUCT_B`, `DISCORD_ROLE_PRODUCT_C` | `DISCORD_ROLE_VERIFIED`, `ENTITLEMENT_GRACE_PERIOD_DAYS` |
| Crons and internal auth | `CRON_SECRET`, `RECONCILE_SECRET`, `SYNC_SECRET`, `STATE_SECRET`, `INTERNAL_API_SECRET` | |
| Owner consoles | `ADMIN_SECRET` | |
| Site URLs | | `DOMAIN`, `BASE_URL`, `SITE_URL` (default `https://www.aurevonvc.com`) |
| Legacy import (remove when done) | | `AIRTABLE_PAT`, `AIRTABLE_BASE_ID` |

GitHub → repo → Settings → Secrets and variables → Actions: `INTERNAL_API_SECRET`
(same value as Vercel) so `.github/workflows/health-check.yml` can read the
full health report.

Railway (Discord bot, `discord/bot.js`): `DISCORD_BOT_TOKEN`,
`DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, the five `DISCORD_ROLE_*` above plus
`DISCORD_ROLE_VERIFIED`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SITE_URL`, `DISCORD_INVITE_URL`,
optional `ENTITLEMENT_GRACE_PERIOD_DAYS`. Railway sets `PORT`.

## Stripe webhook events

Endpoint `https://www.aurevonvc.com/api/webhooks/stripe` must be subscribed to
all 9 (source of truth: `api/_lib/stripe-events.js`):

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `charge.refunded`
- `charge.dispute.created`

## Owner actions, in order

Do O1 to O10 before merging the pipeline branch, then O11 and O12.

**O1. See what Vercel has.** Vercel → project → Settings → Environment
Variables. Also check team Settings → Environment Variables (Shared) for
linked variables. Compare against the table above.

**O2. Stripe keys.**
1. Stripe Dashboard (live mode) → Developers → API keys → reveal the live
   secret key (or create a restricted key with: Checkout Sessions write,
   Customers read, Subscriptions read, Invoices read, Payment Intents read,
   Charges read, Promotion Codes read, Webhook Endpoints read).
2. Vercel → Add `STRIPE_SECRET_KEY` (Production + Preview, Sensitive).
3. Stripe → Developers → Webhooks → the `/api/webhooks/stripe` endpoint →
   Signing secret → Reveal.
4. Vercel → Add `STRIPE_WEBHOOK_SECRET` (exact upper case, Production,
   Sensitive). Remove any mixed-case duplicate such as
   `Stripe_Webhook_Secret`.

**O3. Stripe endpoint and events.**
1. Stripe → Developers → Webhooks → the endpoint. If its status shows
   Disabled (Stripe turns endpoints off after repeated failures), click
   Enable.
2. Update details → Select events → tick all 9 events listed above → Save.
3. The URL must read `https://www.aurevonvc.com/api/webhooks/stripe`.
4. Stripe → Settings → Email notifications: "Webhook endpoint failures" on.

**O4. Supabase.** Supabase Dashboard → project `aurevon-site` → Project
Settings → API Keys: copy the Project URL and the secret key. Vercel → Add
`SUPABASE_URL` and `SUPABASE_SECRET_KEY` (Sensitive). The Supabase → Vercel
integration can create them instead; confirm both names exist afterwards.
The migrations in `supabase/migrations/` are already applied. To confirm:
Supabase → Database → Migrations shows 3 versions: `20261103210000`,
`20261104000000`, `20261104010000`.

**O5. Secrets.** Generate random values and add to Vercel Production, all
Sensitive: `CRON_SECRET`, `RECONCILE_SECRET`, `SYNC_SECRET`, `STATE_SECRET`,
`ADMIN_SECRET` (the owner console password; keep it in your password manager)
and `INTERNAL_API_SECRET`. Add `INTERNAL_API_SECRET` as a GitHub Actions repo
secret too. Optionally set `DOMAIN` and `BASE_URL` to
`https://www.aurevonvc.com`.

**O6. Crossmint.**
1. Crossmint Console (production project) → Integrate → API Keys → create a
   server-side key with scopes `nfts.create`, `nfts.read`,
   `collections.read`. Vercel → `CROSSMINT_API_KEY` (Sensitive).
2. Collections → copy the collection id → Vercel `CROSSMINT_COLLECTION_ID`.
   Set a `CROSSMINT_COLLECTION_*` override only for an NFT that lives in its
   own collection.
3. Leave `CROSSMINT_ENV` unset (production) and `CROSSMINT_CHAIN` unset
   (Base).
4. Integrate → Webhooks → Add Endpoint: URL
   `https://www.aurevonvc.com/api/webhooks/crossmint`, events
   `nfts.create.succeeded` and `nfts.create.failed` → Create.
5. Copy the endpoint's Signing Secret (it starts with `whsec_`; Crossmint
   signs with Svix) → Vercel `CROSSMINT_WEBHOOK_SECRET` (Sensitive).

**O7. Email and alerts.**
1. Resend → Domains: `aurevonvc.com` shows Verified (SPF and DKIM green). If
   not, add the DNS records Resend lists.
2. Vercel → `RESEND_API_KEY` (Sensitive), `RESEND_FROM_EMAIL` (an address on
   the verified domain), optional `RESEND_FROM_NAME`.
3. Discord server → create a private `#ops-alerts` channel → Channel Settings
   → Integrations → Webhooks → New Webhook → Copy Webhook URL → Vercel
   `ALERT_WEBHOOK_URL` (Sensitive). Warn and above go here.
4. Vercel → `OWNER_ALERT_EMAIL` (your inbox). High and critical alerts are
   also emailed; repeats are suppressed for a while.

**O8. PayPal.** Only if PayPal checkout is live.
1. Vercel → `PAYPAL_BUSINESS_EMAIL`: the receiving account's email, exactly
   as in the PayPal profile.
2. PayPal → Account Settings → Notifications → Instant payment notifications
   → IPN History. For each payment link or button, open one real IPN and note
   its `txn_type` and `item_number`.
3. If a PayPal payment's `payments` row shows tier `unknown` (no tier in
   `custom` and the amount matched none), set `PAYPAL_ITEM_TIERS` to a JSON
   object mapping each `item_number` to its tier key (`full`, `retainer`,
   `enterprise`, `comm_monthly`, `comm_lifetime`). A mapping is honoured only
   when the USD amount paid is within $1 of that tier's price. Invalid JSON
   is ignored and alerts once.
4. PayPal subscriptions that started before this change: in Supabase Table
   Editor → `payments`, find each subscription's first payment row and set
   `token` to `subscr:<subscription id>` (or `rpp:<recurring payment id>`
   for recurring-payment profiles) before deploying, so renewals are
   recognised and never mint again.

**O9. Discord.** Developer Portal → your application:
1. General Information → Application ID → Vercel `DISCORD_CLIENT_ID` (must
   equal Railway's). OAuth2 → Client Secret → Vercel `DISCORD_CLIENT_SECRET`.
2. Bot → Privileged Gateway Intents: enable Server Members (and any the bot
   README lists) → Save. Bot token → Vercel and Railway `DISCORD_BOT_TOKEN`.
3. OAuth2 → Redirects → add
   `https://www.aurevonvc.com/api/discord?action=callback` → Save.
4. Discord server → Server Settings → Roles: drag the bot's role above
   Genesis, Chrome, Insider, Ember, Obsidian and Verified, and confirm it has
   Manage Roles.
5. With Developer Mode on, right-click each role → Copy Role ID, and set the
   matching `DISCORD_ROLE_*` on Vercel and Railway (MONTHLY = Genesis,
   LIFETIME = Chrome, PRODUCT_A = Insider, PRODUCT_B = Ember, PRODUCT_C =
   Obsidian). Server ID → `DISCORD_GUILD_ID`. An invite link →
   `DISCORD_INVITE_URL`.

**O10. Railway bot.** Railway → the bot service → Variables: set the Railway
list above. Remove `AIRTABLE_*` once the database migration is confirmed.
Settings → Healthcheck path `/healthz` (already in `railway.json`; it answers
200 once the bot is logged in). Settings → Source: repo and branch `main`.
Deploy and watch the log for the bot coming online.

**O11. Redeploy and verify.** Env changes apply only to new deployments.
1. Vercel → Deployments → latest production → Redeploy.
2. From your own shell:
   `curl -sS -H "Authorization: Bearer $INTERNAL_API_SECRET" https://www.aurevonvc.com/api/health`
   with the secret exported in that shell only. Expect `ok: true`, nothing in
   `missing_required` or `misnamed`, no `missing_events`, and the crons not
   stale.
3. Stripe → the endpoint → Send test webhook `checkout.session.completed` →
   expect 200. Crossmint → the endpoint → send a test event → expect 2xx.
4. Vercel → Settings → Cron Jobs → run both crons once.
5. GitHub → Actions → health check → Run workflow → green.

**O12. Clean-up.** Remove `AIRTABLE_PAT` and `AIRTABLE_BASE_ID` once the
nightly reconcile reports nothing new to import.

## Owner smoke test

One real, low-value purchase end to end, then refund it.

1. Buy 001 Genesis ($29.99/mo) on `/aurevon-web3` with an email you can read.
2. Within a few minutes: a `payments` row, an `nft_mints` row with a
   serial whose status goes `Sent` then `Minted`, and the "minted" email
   with a Discord link.
3. Open the Discord link in that email → authorise → the Genesis role
   appears.
4. `/portal` shows the NFT and your Discord username.
5. Stripe → refund the payment and cancel the subscription. Within a few
   minutes the mint row reads `Revoked` and the Genesis role is removed.
6. Authed `/api/health` is still `ok: true` and `#ops-alerts` shows nothing
   unexpected.
