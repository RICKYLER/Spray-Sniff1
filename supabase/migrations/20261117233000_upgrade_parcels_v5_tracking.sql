-- Upgrade delivery tracking schema for Parcels API v5
-- 1. Store canonical carrier_hint slug and last sync timestamp on store_orders
-- 2. Persist asynchronous Parcels v5 request sessions, per-request webhook secrets,
--    retention boundaries (expires_at), and cached shipment payloads

alter table public.store_orders
  add column if not exists courier_slug text null,
  add column if not exists parcels_last_synced_at timestamptz null;

comment on column public.store_orders.courier_slug is 'Canonical Parcels API v5 carrier slug accepted by carrier_hint';
comment on column public.store_orders.parcels_last_synced_at is 'Timestamp of the most recent live sync from Parcels API v5';

create table if not exists public.parcels_tracking_requests (
  request_id text primary key,
  tracking_number text not null,
  order_id text null references public.store_orders (id) on delete set null,
  carrier_hint text null,
  webhook_secret text null,
  status text not null default 'processing' check (status in ('processing', 'completed', 'error')),
  expires_at timestamptz null,
  last_payload jsonb null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_parcels_tracking_requests_tracking_number
  on public.parcels_tracking_requests (lower(tracking_number), created_at desc);

create index if not exists idx_parcels_tracking_requests_order_id
  on public.parcels_tracking_requests (order_id, created_at desc)
  where order_id is not null;

drop trigger if exists set_parcels_tracking_requests_updated_at on public.parcels_tracking_requests;
create trigger set_parcels_tracking_requests_updated_at
before update on public.parcels_tracking_requests
for each row
execute function public.set_updated_at();

alter table public.parcels_tracking_requests enable row level security;

drop policy if exists "parcels_tracking_requests_select_backoffice" on public.parcels_tracking_requests;
create policy "parcels_tracking_requests_select_backoffice"
on public.parcels_tracking_requests
for select
to authenticated
using (public.is_backoffice_user());
