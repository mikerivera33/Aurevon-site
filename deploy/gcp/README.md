# Discord bot on Google Cloud

`discord/bot.js` runs as one always-on process on a Compute Engine **e2-micro** VM in `us-east1`. This replaces Railway. It stays inside Google's always-free tier: one e2-micro, a 30 GB standard disk, a few MB in Cloud Storage, and one secret.

| Piece | Name |
|---|---|
| Project | `nifty-formula-513621-d4` |
| VM | `aurevon-discord-bot` (us-east1-b, Debian 12) |
| Bot bundle | `gs://nifty-formula-513621-d4-aurevon-bot/discord-bot.tgz` |
| Bot env | Secret Manager → `aurevon-bot-env` (a dotenv file) |
| Runtime identity | `aurevon-discord-bot@…` (reads the bundle and the secret, nothing else) |
| Deploy identity | `aurevon-bot-deployer@…` (uploads the bundle; GitHub `main` only, no key) |

## How it works

- `startup.sh` runs on every boot. It installs Node 22 and two systemd services: `aurevon-bot`, which restarts the bot on any exit, and `aurevon-bot-deploy`.
- `aurevon-bot-deploy` checks the bundle in Cloud Storage every 2 minutes. When a new upload appears, it:
  1. reads the secret again,
  2. runs `npm ci`,
  3. swaps in the new code and restarts the bot.

  If the install fails, the running version stays.
- A push to `main` that touches `discord/**` runs `.github/workflows/deploy-discord-bot.yml`, which uploads the bundle. This is the same auto-deploy Railway had.

## The bot's env (secret `aurevon-bot-env`)

The secret holds one `KEY=value` per line, the same lines as Railway's Variables → Raw Editor:

```
DISCORD_BOT_TOKEN=…
DISCORD_CLIENT_ID=…
DISCORD_GUILD_ID=…
DISCORD_INVITE_URL=…
DISCORD_ROLE_MONTHLY=…
DISCORD_ROLE_LIFETIME=…
DISCORD_ROLE_PRODUCT_A=…
DISCORD_ROLE_PRODUCT_B=…
DISCORD_ROLE_PRODUCT_C=…
DISCORD_ROLE_VERIFIED=…
SITE_URL=https://www.aurevonvc.com
SUPABASE_URL=https://mcpgkrumizsaygasoovn.supabase.co
SUPABASE_SECRET_KEY=sb_secret_…
```

The `AIRTABLE_*` lines are no longer used. Use plain `KEY=value` lines: no `export`, and no `# comment` after a value (systemd would keep it as part of the value).

To change a value, open Secret Manager → `aurevon-bot-env` → **New version**, paste the whole file, then run **Actions → Deploy Discord bot → Run workflow**.

## Everyday commands

```bash
export PROJECT=nifty-formula-513621-d4

deploy/gcp/deploy.sh                 # deploy the committed discord/ by hand
gcloud compute instances get-serial-port-output aurevon-discord-bot \
  --zone us-east1-b --project $PROJECT | tail -50        # bot + deploy logs, no SSH needed
gcloud compute instances reset aurevon-discord-bot --zone us-east1-b --project $PROJECT   # hard restart
```

Rollback: revert the commit on `main`, or run `deploy/gcp/deploy.sh <good-sha>`.

## First-time setup

1. Open billing on the project (Billing → link an open billing account). The free tier still needs a card on file.
2. Run `PROJECT=nifty-formula-513621-d4 deploy/gcp/provision.sh`.
3. Add the first version of `aurevon-bot-env`.
4. Stop the Railway service so only one copy of the bot is online, then run `deploy/gcp/deploy.sh`. If two copies run, members get every reply and DM twice. Stop Railway before merging this change too: the merge itself triggers the deploy workflow.
5. Check the serial output for `Aurevon Bot online`, or confirm the bot shows online in Discord.
