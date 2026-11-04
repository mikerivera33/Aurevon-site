-- Mint retry backoff (additive only).
--   retry-mints (every 15 min) picks Failed rows whose next_retry_at is null or due.
--   fulfilNft sets it on every failed attempt: now + 15 min x 2^retry_count, capped at 32 h.
alter table public.nft_mints add column next_retry_at timestamptz;
create index nft_mints_retry_idx on public.nft_mints (next_retry_at) where mint_status = 'Failed';
