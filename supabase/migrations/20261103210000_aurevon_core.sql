-- Aurevon operational data (replaces the Airtable "Aurevon Operations" base).
-- Applied to Supabase project aurevon-site (ref mcpgkrumizsaygasoovn).
--
-- Server-only: the site's serverless functions use the secret key (service_role).
-- RLS is on with no policies, and anon/authenticated have no grants, so the
-- publishable key can read or write nothing. Display names used by the code
-- (e.g. 'Mint Status') map to these columns in api/_lib/db.js FIELDS.

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, public;

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table public.members (
  id                      uuid primary key default gen_random_uuid(),
  email                   text not null unique check (email = lower(btrim(email)) and email <> ''),
  customer_name           text,
  member_tier             text,
  active                  boolean,
  join_date               timestamptz,
  wallet_address          text,
  nft_holdings            text,
  discord_id              text,
  discord_username        text,
  discord_linked_at       timestamptz,
  discord_sync_status     text,
  discord_sync_at         timestamptz,
  discord_sync_error      text,
  discord_auth_nonce_used text,
  entitlement_type        text,
  entitlement_status      text,
  entitlement_expires_at  timestamptz,
  billing_state           text,
  notes                   text,
  airtable_id             text unique,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index members_discord_sync_status_idx on public.members (discord_sync_status) where discord_sync_status = 'pending';
create index members_entitlement_idx on public.members (entitlement_type, entitlement_status, entitlement_expires_at);

-- transaction_id is UNIQUE: it is the webhook idempotency marker.
create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  transaction_id     text not null unique,
  payment_provider   text,
  pass_type          text,
  service_product    text,
  amount             numeric(12,2),
  customer_email     text check (customer_email is null or customer_email = lower(btrim(customer_email))),
  customer_name      text,
  status             text,
  token              text,
  payment_date       timestamptz not null default now(),
  deliverable_status text not null default 'Not Started',
  delivery_notes     text,
  airtable_id        text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index payments_email_tier_idx on public.payments (customer_email, pass_type, payment_date desc);
create index payments_payment_date_idx on public.payments (payment_date desc);

create table public.nft_mints (
  id                uuid primary key default gen_random_uuid(),
  reference         text,
  email             text not null check (email = lower(btrim(email)) and email <> ''),
  nft_type          text,
  tier_source       text,
  mint_status       text,
  mint_date         timestamptz,
  email_delivered   boolean not null default false,
  notes             text,
  token_id          text,
  retry_count       integer not null default 0,
  entitlement_type  text,
  discord_synced    boolean not null default false,
  discord_synced_at timestamptz,
  transaction_hash  text,
  wallet_address    text,
  airtable_id       text unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index nft_mints_email_idx on public.nft_mints (email, nft_type);
create index nft_mints_status_idx on public.nft_mints (mint_status, discord_synced);
create index nft_mints_token_id_idx on public.nft_mints (token_id) where token_id is not null and token_id <> '';
create index nft_mints_reference_idx on public.nft_mints (reference text_pattern_ops);

create table public.customer_auth (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique check (email = lower(btrim(email)) and email <> ''),
  customer_name  text,
  member_tier    text,
  magic_token    text,
  token_expires  timestamptz,
  session_token  text,
  session_active boolean not null default false,
  last_login     timestamptz,
  airtable_id    text unique,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Deal-intake submissions (the CRM pipeline) and other lead sources.
create table public.leads (
  id               uuid primary key default gen_random_uuid(),
  name             text,
  email            text check (email is null or email = lower(btrim(email))),
  phone            text,
  company          text,
  tier             text,
  source           text,
  status           text not null default 'New',
  property_address text,
  purchase_price   numeric(14,2),
  asset_type       text,
  hold_period      text,
  deal_summary     text,
  addons           text,
  promo_code       text,
  payment_token    text,
  analyst          text,
  notes            text,
  airtable_id      text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index leads_created_at_idx on public.leads (created_at desc);
create index leads_status_idx on public.leads (status);
create index leads_payment_token_idx on public.leads (payment_token);

do $$
declare t text;
begin
  foreach t in array array['members','payments','nft_mints','customer_auth','leads'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;
