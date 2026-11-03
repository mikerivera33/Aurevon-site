-- NFT pipeline reliability (additive only).
--   * nft_mints keyed by payment: one mint per NFT-earning payment (payment_transaction_id UNIQUE),
--     plus the Crossmint action id, revocation time and last error.
--   * nft_serials + next_serial(): atomic per-prefix serial counter (replaces count+1),
--     seeded from the highest existing PREFIX_NNN reference.
--   * ops_events: pipeline health / alert dedupe log.
-- RLS on, no policies, no anon/authenticated grants (service_role only), like the core schema.

alter table public.nft_mints
  add column payment_transaction_id text,
  add column crossmint_action_id text,
  add column revoked_at timestamptz,
  add column last_error text;
create unique index nft_mints_payment_txn_key on public.nft_mints (payment_transaction_id) where payment_transaction_id is not null;
create index nft_mints_action_id_idx on public.nft_mints (crossmint_action_id) where crossmint_action_id is not null;

create table public.nft_serials (
  prefix text primary key,
  last   integer not null default 0,
  updated_at timestamptz not null default now()
);
create or replace function public.next_serial(p_prefix text) returns integer
language sql security definer set search_path = public as $$
  insert into public.nft_serials (prefix, last) values (p_prefix, 1)
  on conflict (prefix) do update set last = nft_serials.last + 1, updated_at = now()
  returning last;
$$;
revoke all on function public.next_serial(text) from public, anon, authenticated;
insert into public.nft_serials (prefix, last)
select split_part(reference, '_', 1), max(nullif(regexp_replace(split_part(reference, '_', 2), '\D', '', 'g'), '')::int)
from public.nft_mints where reference ~ '^[A-Z]+_[0-9]+$' group by 1
on conflict (prefix) do update set last = greatest(nft_serials.last, excluded.last);

create table public.ops_events (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  severity text not null default 'info',
  dedupe_key text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index ops_events_event_idx on public.ops_events (event, created_at desc);
alter table public.nft_serials enable row level security;
alter table public.ops_events enable row level security;
revoke all on public.nft_serials, public.ops_events from anon, authenticated;
