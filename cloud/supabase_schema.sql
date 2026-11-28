-- Web Blender Studio — Supabase schema for the cloud provider.
-- Run once in the Supabase SQL editor. The Python server talks to these
-- tables with the service role; browsers never call Supabase directly for data.
-- RLS is enabled with no client policies, so anon/authenticated keys are denied.

begin;

create table if not exists public.cloud_users (
  id uuid primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.cloud_projects (
  id uuid primary key,
  user_id uuid not null references public.cloud_users(id) on delete cascade,
  name text not null,
  data jsonb not null,
  size_bytes integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cloud_assets (
  id uuid primary key,
  user_id uuid not null references public.cloud_users(id) on delete cascade,
  name text not null,
  title text not null default '',
  category text not null default 'props',
  tags jsonb not null default '[]'::jsonb,
  description text not null default '',
  author_name text not null default '',
  thumb_path text not null default '',
  content_type text not null default 'model/gltf-binary',
  size_bytes integer not null,
  storage_path text not null,
  public boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.cloud_assets add column if not exists title text not null default '';
alter table public.cloud_assets add column if not exists category text not null default 'props';
alter table public.cloud_assets add column if not exists tags jsonb not null default '[]'::jsonb;
alter table public.cloud_assets add column if not exists description text not null default '';
alter table public.cloud_assets add column if not exists author_name text not null default '';
alter table public.cloud_assets add column if not exists thumb_path text not null default '';

create table if not exists public.cloud_ledger (
  id bigserial primary key,
  user_id uuid not null references public.cloud_users(id) on delete cascade,
  delta integer not null,
  reason text not null,
  ref text not null default '',
  idempotency_key text not null,
  balance_after integer not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table if not exists public.cloud_payments (
  id uuid primary key,
  user_id uuid not null references public.cloud_users(id) on delete cascade,
  provider text not null,
  plan_id text not null,
  code text not null unique,
  amount_vnd integer not null,
  credits integer not null,
  status text not null default 'pending',
  external_id text not null default '',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  paid_at timestamptz
);

alter table public.cloud_payments add column if not exists expires_at timestamptz;

create table if not exists public.cloud_refunded_externals (
  provider text not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);

create index if not exists idx_cloud_projects_user on public.cloud_projects(user_id, updated_at desc);
create index if not exists idx_cloud_assets_user on public.cloud_assets(user_id, created_at desc);
create index if not exists idx_cloud_assets_public on public.cloud_assets(public, category, created_at desc);
create index if not exists idx_cloud_ledger_user on public.cloud_ledger(user_id, id desc);
create index if not exists idx_cloud_payments_user on public.cloud_payments(user_id, created_at desc);
create unique index if not exists idx_cloud_payments_provider_ext
  on public.cloud_payments(provider, external_id)
  where external_id <> '';

alter table public.cloud_users enable row level security;
alter table public.cloud_projects enable row level security;
alter table public.cloud_assets enable row level security;
alter table public.cloud_ledger enable row level security;
alter table public.cloud_payments enable row level security;
alter table public.cloud_refunded_externals enable row level security;

-- --------------------------------------------------------------------------
-- Ledger functions (SECURITY DEFINER + per-user advisory lock = atomic credits)
-- --------------------------------------------------------------------------
create or replace function public.cloud_balance(p_user_id uuid)
returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(delta), 0)::integer
  from public.cloud_ledger
  where user_id = p_user_id;
$$;

create or replace function public.cloud_grant_free(p_user_id uuid, p_amount integer)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_amount is null or p_amount <= 0 then
    return public.cloud_balance(p_user_id);
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  insert into public.cloud_ledger
    (user_id, delta, reason, ref, idempotency_key, balance_after, created_at)
  values
    (p_user_id, p_amount, 'signup_bonus', '', 'free:signup',
     public.cloud_balance(p_user_id) + p_amount, now())
  on conflict (user_id, idempotency_key) do nothing;
  return public.cloud_balance(p_user_id);
end;
$$;

create or replace function public.cloud_charge(
  p_user_id uuid, p_amount integer, p_reason text, p_ref text, p_key text)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_balance integer;
begin
  if p_amount is null or p_amount <= 0 then
    return public.cloud_balance(p_user_id);
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  v_balance := public.cloud_balance(p_user_id);
  if v_balance < p_amount then
    raise exception 'insufficient_credits';
  end if;
  insert into public.cloud_ledger
    (user_id, delta, reason, ref, idempotency_key, balance_after, created_at)
  values
    (p_user_id, -p_amount, coalesce(p_reason, 'charge'), coalesce(p_ref, ''), p_key,
     v_balance - p_amount, now())
  on conflict (user_id, idempotency_key) do nothing;
  return public.cloud_balance(p_user_id);
end;
$$;

create or replace function public.cloud_credit(
  p_user_id uuid, p_amount integer, p_reason text, p_ref text, p_key text)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_balance integer;
begin
  if p_amount is null or p_amount = 0 then
    return public.cloud_balance(p_user_id);
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  v_balance := public.cloud_balance(p_user_id);
  insert into public.cloud_ledger
    (user_id, delta, reason, ref, idempotency_key, balance_after, created_at)
  values
    (p_user_id, p_amount, coalesce(p_reason, 'credit'), coalesce(p_ref, ''), p_key,
     v_balance + p_amount, now())
  on conflict (user_id, idempotency_key) do nothing;
  return public.cloud_balance(p_user_id);
end;
$$;

create or replace function public.cloud_stats(p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'projects', (select count(*) from public.cloud_projects where user_id = p_user_id),
    'assets', (select count(*) from public.cloud_assets where user_id = p_user_id),
    'used_bytes', (
      coalesce((select sum(size_bytes) from public.cloud_projects where user_id = p_user_id), 0) +
      coalesce((select sum(size_bytes) from public.cloud_assets where user_id = p_user_id), 0)
    )
  );
$$;

create or replace function public.cloud_mark_payment_paid(
  p_code text, p_external_id text, p_paid_amount integer, p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_payment public.cloud_payments%rowtype;
begin
  select * into v_payment
  from public.cloud_payments
  where code = upper(p_code)
  for update;

  if not found then
    raise exception 'payment_not_found';
  end if;
  if coalesce(p_provider, '') <> '' and v_payment.provider <> p_provider then
    raise exception 'payment_provider_mismatch';
  end if;
  if v_payment.status = 'paid' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_paid',
      'credits', public.cloud_balance(v_payment.user_id),
      'payment', to_jsonb(v_payment));
  end if;
  if v_payment.status = 'refunded' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_refunded',
      'credits', public.cloud_balance(v_payment.user_id),
      'payment', to_jsonb(v_payment));
  end if;
  -- Block crediting if an external-ID-only refund tombstone arrived before the paid webhook
  if coalesce(p_external_id, '') <> '' and exists (
    select 1 from public.cloud_refunded_externals
    where provider = v_payment.provider and external_id = p_external_id
  ) then
    update public.cloud_payments
      set status = 'refunded',
          external_id = case when coalesce(external_id, '') = '' then p_external_id else external_id end
      where id = v_payment.id
      returning * into v_payment;
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_refunded',
      'credits', public.cloud_balance(v_payment.user_id),
      'payment', to_jsonb(v_payment));
  end if;
  if v_payment.status = 'expired' or (v_payment.expires_at is not null and v_payment.expires_at < now()) then
    update public.cloud_payments set status = 'expired' where id = v_payment.id returning * into v_payment;
    return jsonb_build_object(
      'applied', false,
      'reason', 'expired',
      'credits', public.cloud_balance(v_payment.user_id),
      'payment', to_jsonb(v_payment));
  end if;
  if coalesce(p_external_id, '') <> '' and exists (
    select 1 from public.cloud_payments
    where provider = v_payment.provider and external_id = p_external_id and id <> v_payment.id
  ) then
    return jsonb_build_object(
      'applied', false,
      'reason', 'duplicate_external_id',
      'credits', public.cloud_balance(v_payment.user_id),
      'payment', to_jsonb(v_payment));
  end if;
  if p_paid_amount is not null and p_paid_amount < v_payment.amount_vnd then
    update public.cloud_payments
      set status = 'underpaid', external_id = coalesce(p_external_id, '')
      where id = v_payment.id
      returning * into v_payment;
    return jsonb_build_object(
      'applied', false,
      'reason', 'underpaid',
      'credits', public.cloud_balance(v_payment.user_id),
      'payment', to_jsonb(v_payment));
  end if;

  update public.cloud_payments
    set status = 'paid', external_id = coalesce(p_external_id, ''), paid_at = now()
    where id = v_payment.id
    returning * into v_payment;

  insert into public.cloud_ledger
    (user_id, delta, reason, ref, idempotency_key, balance_after, created_at)
  values
    (v_payment.user_id, v_payment.credits, 'topup', v_payment.code,
     'payment:' || v_payment.code,
     public.cloud_balance(v_payment.user_id) + v_payment.credits, now())
  on conflict (user_id, idempotency_key) do nothing;

  return jsonb_build_object(
    'applied', true,
    'reason', 'credited',
    'credits', public.cloud_balance(v_payment.user_id),
    'payment', to_jsonb(v_payment));
end;
$$;

create or replace function public.cloud_refund_payment(
  p_code text, p_external_id text, p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_payment public.cloud_payments%rowtype;
  v_bal integer;
  v_clawback integer;
begin
  if coalesce(p_code, '') <> '' then
    select * into v_payment from public.cloud_payments where code = upper(p_code) for update;
  end if;
  if not found and coalesce(p_external_id, '') <> '' and coalesce(p_provider, '') <> '' then
    select * into v_payment from public.cloud_payments
      where provider = p_provider and external_id = p_external_id for update;
  end if;
  if not found then
    if coalesce(p_external_id, '') <> '' and coalesce(p_provider, '') <> '' then
      insert into public.cloud_refunded_externals (provider, external_id, created_at)
      values (p_provider, p_external_id, now())
      on conflict (provider, external_id) do nothing;
      return jsonb_build_object(
        'applied', true,
        'reason', 'recorded_external_refund',
        'credits', 0,
        'payment', null);
    end if;
    raise exception 'payment_not_found';
  end if;
  if coalesce(p_provider, '') <> '' and v_payment.provider <> p_provider then
    raise exception 'payment_provider_mismatch';
  end if;
  if coalesce(p_external_id, '') <> '' then
    insert into public.cloud_refunded_externals (provider, external_id, created_at)
    values (v_payment.provider, p_external_id, now())
    on conflict (provider, external_id) do nothing;
  end if;
  if v_payment.status = 'refunded' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_refunded',
      'credits', public.cloud_balance(v_payment.user_id),
      'payment', to_jsonb(v_payment));
  end if;
  v_bal := greatest(0, public.cloud_balance(v_payment.user_id));
  v_clawback := case when v_payment.status = 'paid'
    then least(v_bal, greatest(0, v_payment.credits)) else 0 end;
  if v_clawback > 0 then
    insert into public.cloud_ledger
      (user_id, delta, reason, ref, idempotency_key, balance_after, created_at)
    values
      (v_payment.user_id, -v_clawback, 'refund', v_payment.code,
       'refund:' || v_payment.code, v_bal - v_clawback, now())
    on conflict (user_id, idempotency_key) do nothing;
  end if;

  -- Persist early refunds so a later paid webhook cannot credit the order.
  update public.cloud_payments
    set status = 'refunded',
        external_id = case when coalesce(external_id, '') = '' then coalesce(p_external_id, '') else external_id end
    where id = v_payment.id
    returning * into v_payment;
  return jsonb_build_object(
    'applied', true,
    'reason', 'refunded',
    'credits', public.cloud_balance(v_payment.user_id),
    'payment', to_jsonb(v_payment));
end;
$$;

create or replace function public.cloud_reserve_asset(
  p_user_id uuid,
  p_asset_id uuid,
  p_name text,
  p_title text,
  p_category text,
  p_tags jsonb,
  p_description text,
  p_author_name text,
  p_thumb_path text,
  p_content_type text,
  p_size_bytes integer,
  p_storage_path text,
  p_public boolean,
  p_max_assets integer,
  p_max_total_bytes bigint,
  p_cost integer,
  p_charge_key text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_assets integer;
  v_used bigint;
  v_balance integer;
  v_now timestamptz := now();
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select count(*)::integer into v_assets
  from public.cloud_assets
  where user_id = p_user_id;

  if p_max_assets is not null and v_assets >= p_max_assets then
    raise exception 'quota_max_assets';
  end if;

  select (
    coalesce((select sum(size_bytes)::bigint from public.cloud_projects where user_id = p_user_id), 0) +
    coalesce((select sum(size_bytes)::bigint from public.cloud_assets where user_id = p_user_id), 0)
  ) into v_used;

  if p_max_total_bytes is not null and (v_used + greatest(0, coalesce(p_size_bytes, 0))) > p_max_total_bytes then
    raise exception 'quota_max_bytes';
  end if;

  v_balance := public.cloud_balance(p_user_id);
  if coalesce(p_cost, 0) > 0 then
    if v_balance < p_cost then
      raise exception 'insufficient_credits';
    end if;
    insert into public.cloud_ledger
      (user_id, delta, reason, ref, idempotency_key, balance_after, created_at)
    values
      (p_user_id, -p_cost, 'upload_asset', p_asset_id::text, p_charge_key,
       v_balance - p_cost, v_now)
    on conflict (user_id, idempotency_key) do nothing;
    v_balance := public.cloud_balance(p_user_id);
  end if;

  insert into public.cloud_assets (
    id, user_id, name, title, category, tags, description, author_name,
    thumb_path, content_type, size_bytes, storage_path, public, created_at
  ) values (
    p_asset_id, p_user_id, p_name, coalesce(p_title, ''), coalesce(p_category, 'props'),
    coalesce(p_tags, '[]'::jsonb), coalesce(p_description, ''), coalesce(p_author_name, 'Creator'),
    coalesce(p_thumb_path, ''), coalesce(p_content_type, 'model/gltf-binary'),
    greatest(0, coalesce(p_size_bytes, 0)), p_storage_path, coalesce(p_public, true), v_now
  );

  return jsonb_build_object('credits', v_balance, 'created_at', v_now);
end;
$$;

-- Revoke from PUBLIC, anon, and authenticated explicitly (Supabase default privileges grant to anon/authenticated).
revoke all on table public.cloud_users, public.cloud_projects, public.cloud_assets, public.cloud_ledger, public.cloud_payments, public.cloud_refunded_externals from anon, authenticated;
revoke all on function public.cloud_balance(uuid) from public, anon, authenticated;
revoke all on function public.cloud_grant_free(uuid, integer) from public, anon, authenticated;
revoke all on function public.cloud_charge(uuid, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.cloud_credit(uuid, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.cloud_stats(uuid) from public, anon, authenticated;
revoke all on function public.cloud_mark_payment_paid(text, text, integer, text) from public, anon, authenticated;
revoke all on function public.cloud_refund_payment(text, text, text) from public, anon, authenticated;
revoke all on function public.cloud_reserve_asset(uuid, uuid, text, text, text, jsonb, text, text, text, text, integer, text, boolean, integer, bigint, integer, text) from public, anon, authenticated;

grant execute on function public.cloud_balance(uuid) to service_role;
grant execute on function public.cloud_grant_free(uuid, integer) to service_role;
grant execute on function public.cloud_charge(uuid, integer, text, text, text) to service_role;
grant execute on function public.cloud_credit(uuid, integer, text, text, text) to service_role;
grant execute on function public.cloud_stats(uuid) to service_role;
grant execute on function public.cloud_mark_payment_paid(text, text, integer, text) to service_role;
grant execute on function public.cloud_refund_payment(text, text, text) to service_role;
grant execute on function public.cloud_reserve_asset(uuid, uuid, text, text, text, jsonb, text, text, text, text, integer, text, boolean, integer, bigint, integer, text) to service_role;

-- Assets stay private in Storage. Public downloads are authorized by cloud_assets.public
-- through the BFF, which issues short-lived signed URLs; browsers never use Storage directly.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shared-models', 'shared-models', false, 52428800, array['model/gltf-binary', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = 52428800,
      allowed_mime_types = array['model/gltf-binary', 'image/png'];

insert into storage.buckets (id, name, public, file_size_limit)
values ('studio-projects', 'studio-projects', false, 52428800)
on conflict (id) do update set public = false;

-- Supabase manages storage.objects under supabase_storage_admin with RLS enabled by default.
-- Attempt explicit hardening when running as owner, and assert RLS is enabled on storage.objects.
do $$
declare
  v_rls boolean;
begin
  begin
    execute 'alter table storage.objects enable row level security';
    execute 'revoke all on table storage.objects from anon, authenticated';
  exception when insufficient_privilege then
    select c.relrowsecurity into v_rls
    from pg_class c
    join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'storage' and c.relname = 'objects';
    if not coalesce(v_rls, false) then
      raise exception 'storage.objects RLS is not enabled';
    end if;
  end;
end;
$$;

commit;
