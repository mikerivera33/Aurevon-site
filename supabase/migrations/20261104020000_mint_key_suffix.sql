-- Final-review fixes: two additive integer columns, both defaulting to 0.
--
-- nft_mints.mint_key_suffix — 0: the Crossmint idempotency key is the payment
--   id. The Crossmint webhook (nfts.create.failed) and reconcile's Sent-row poll
--   bump it when Crossmint reports the mint action FAILED, so the next retry
--   PUTs `<payment>-r<n>` instead of replaying the failed action. A synchronous
--   timeout / HTTP error leaves it alone (that PUT may have landed).
--
-- members.discord_sync_attempts — consecutive failed Discord role syncs.
--   Reconcile retries `failed` members (older than 6 h, 20 per run) through the
--   normal grant path; after 3 consecutive failures it stops and alerts
--   `discord.sync_gave_up`. A successful sync resets it to 0.
alter table public.nft_mints add column mint_key_suffix integer not null default 0;
alter table public.members add column discord_sync_attempts integer not null default 0;
