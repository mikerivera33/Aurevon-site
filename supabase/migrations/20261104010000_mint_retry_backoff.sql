-- Mint retry backoff: an additive column + index, and a one-time park of rows
-- that gave up under the old 5-retry cap.
--   retry-mints (every 15 min) picks Failed rows whose next_retry_at is null or due.
--   fulfilNft sets it on every failed attempt: now + 15 min x 2^retry_count, capped at 32 h.
alter table public.nft_mints add column next_retry_at timestamptz;
create index nft_mints_retry_idx on public.nft_mints (next_retry_at) where mint_status = 'Failed';

-- The cap rises 5 -> 8. A Failed row at 5..7 already gave up under the old cap
-- (an operator may have minted it by hand); park it at 8 so it is never retried.
update public.nft_mints set retry_count = 8 where mint_status = 'Failed' and retry_count >= 5;
