-- VVP Portal — core schema
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE throughout.

create extension if not exists "pgcrypto"; -- gives us gen_random_uuid()

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'practitioner', 'client')),
  full_name text,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists practitioners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  public_intake_code text,
  created_at timestamptz not null default now()
);
create unique index if not exists practitioners_user_id_key on practitioners(user_id);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  practitioner_id uuid not null references practitioners(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  full_name text not null,
  email text not null,
  phone text,
  ghl_contact_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists clients_ghl_contact_id_key on clients(ghl_contact_id) where ghl_contact_id is not null;

create table if not exists intake_requests (
  id uuid primary key default gen_random_uuid(),
  practitioner_id uuid not null references practitioners(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  client_name text not null,
  client_email text not null,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'pending' check (status in ('pending', 'submitted', 'expired')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists client_intake_submissions (
  id uuid primary key default gen_random_uuid(),
  intake_request_id uuid not null references intake_requests(id) on delete cascade,
  practitioner_id uuid not null references practitioners(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  client_name text not null,
  client_email text not null,
  form_data jsonb not null,
  status text not null default 'submitted',
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists practitioner_readings (
  id uuid primary key default gen_random_uuid(),
  practitioner_id uuid not null references practitioners(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  intake_submission_id uuid references client_intake_submissions(id) on delete set null,
  reading_data jsonb,
  report_url text,
  created_at timestamptz not null default now()
);

create table if not exists client_results (
  id uuid primary key default gen_random_uuid(),
  practitioner_id uuid not null references practitioners(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  reading_id uuid references practitioner_readings(id) on delete set null,
  result_data jsonb,
  visible_to_client boolean not null default false,
  created_at timestamptz not null default now()
);

-- Practitioner<->client SMS/Email thread, sent via GoHighLevel's Conversations
-- API on both ends. Practitioners never get GHL inbox access for this on
-- purpose -- RLS here is what actually keeps one practitioner's (or the
-- other business's) conversations invisible to everyone else, rather than
-- relying on GHL's own per-user permission settings.
create table if not exists client_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  practitioner_id uuid not null references practitioners(id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  channel text not null check (channel in ('sms', 'email')),
  body text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- AUTO-CREATE A PROFILE ROW WHEN SOMEONE SIGNS UP
-- Role comes from the "role" value passed in signUp() options.data,
-- defaulting to 'client' if none is given.
-- ============================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(new.raw_user_meta_data ->> 'role', 'client');
begin
  insert into profiles (id, role, full_name, email)
  values (
    new.id,
    v_role,
    new.raw_user_meta_data ->> 'full_name',
    new.email
  );

  -- A practitioner may have already created a `clients` row for this
  -- person's email (from sending them an intake) before they ever signed
  -- up for portal access. Link it now so RLS recognizes them as that
  -- client. Safe even before email confirmation: an unconfirmed account
  -- can't actually authenticate yet, so this can't be used to hijack
  -- someone else's client record without controlling their inbox.
  if v_role = 'client' then
    update clients set user_id = new.id where email = new.email and user_id is null;
  end if;

  -- Same pattern for practitioners: Tammy pre-creates a practitioners row
  -- (name, email, booking_url, etc.) before the practitioner ever signs up
  -- themselves; this links their new auth account to that existing row.
  if v_role = 'practitioner' then
    update practitioners set user_id = new.id where email = new.email and user_id is null;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table profiles enable row level security;
alter table practitioners enable row level security;
alter table clients enable row level security;
alter table intake_requests enable row level security;
alter table client_intake_submissions enable row level security;
alter table practitioner_readings enable row level security;
alter table client_results enable row level security;
alter table client_messages enable row level security;

-- Helper: is the current user an admin?
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Helper: practitioner row id for the current logged-in user, if any
create or replace function current_practitioner_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from practitioners where user_id = auth.uid();
$$;

-- profiles: users see/update their own row; admins see all
create policy "profiles_select_own_or_admin" on profiles
  for select using (id = auth.uid() or is_admin());
create policy "profiles_update_own" on profiles
  for update using (id = auth.uid());

-- practitioners: a practitioner manages their own row; admins see all;
-- a client can view the practitioner they belong to (needed for the
-- client-facing practitioner profile: name, photo, commission level).
create policy "practitioners_select_own_admin_or_client" on practitioners
  for select using (
    user_id = auth.uid()
    or is_admin()
    or id in (select practitioner_id from clients where user_id = auth.uid())
  );
create policy "practitioners_update_own" on practitioners
  for update using (user_id = auth.uid());
create policy "practitioners_insert_own" on practitioners
  for insert with check (user_id = auth.uid());

-- clients: practitioners manage their own clients; clients see their own row; admins see all
create policy "clients_select_own_practitioner_or_self_or_admin" on clients
  for select using (
    practitioner_id = current_practitioner_id()
    or user_id = auth.uid()
    or is_admin()
  );
create policy "clients_insert_own_practitioner" on clients
  for insert with check (practitioner_id = current_practitioner_id());
create policy "clients_update_own_practitioner" on clients
  for update using (practitioner_id = current_practitioner_id());

-- intake_requests: practitioners manage their own requests; admins see all
-- NOTE: no public/anon policy here on purpose. The intake link's token is
-- validated and consumed through the SECURITY DEFINER functions below, so an
-- anonymous visitor never gets a direct SELECT/INSERT grant on this table.
create policy "intake_requests_select_own_or_admin" on intake_requests
  for select using (practitioner_id = current_practitioner_id() or is_admin());
create policy "intake_requests_insert_own" on intake_requests
  for insert with check (practitioner_id = current_practitioner_id());
create policy "intake_requests_update_own" on intake_requests
  for update using (practitioner_id = current_practitioner_id());

-- client_intake_submissions: practitioners see their own; admins see all
-- (also no anon policy — inserted only via submit_client_intake() below)
create policy "submissions_select_own_or_admin" on client_intake_submissions
  for select using (practitioner_id = current_practitioner_id() or is_admin());

-- practitioner_readings: practitioner manages own; admins see all
create policy "readings_select_own_or_admin" on practitioner_readings
  for select using (practitioner_id = current_practitioner_id() or is_admin());
create policy "readings_insert_own" on practitioner_readings
  for insert with check (practitioner_id = current_practitioner_id());
create policy "readings_update_own" on practitioner_readings
  for update using (practitioner_id = current_practitioner_id());

-- client_results: practitioner manages own; client sees own only when visible_to_client; admins see all
create policy "results_select_practitioner_or_admin" on client_results
  for select using (practitioner_id = current_practitioner_id() or is_admin());
create policy "results_select_client_when_visible" on client_results
  for select using (
    visible_to_client = true
    and client_id in (select id from clients where user_id = auth.uid())
  );
create policy "results_insert_own_practitioner" on client_results
  for insert with check (practitioner_id = current_practitioner_id());
create policy "results_update_own_practitioner" on client_results
  for update using (practitioner_id = current_practitioner_id());

-- client_messages: practitioner sees/sends only their own clients' threads;
-- admins see all. No anon/client policy -- inbound rows are inserted only
-- via the SECURITY DEFINER record_inbound_message() function below.
create policy "messages_select_own_or_admin" on client_messages
  for select using (practitioner_id = current_practitioner_id() or is_admin());
create policy "messages_insert_own_practitioner" on client_messages
  for insert with check (practitioner_id = current_practitioner_id());

-- ============================================================
-- SECURE TOKEN FUNCTIONS
-- These run as SECURITY DEFINER (owner privileges), so they bypass RLS
-- internally, but they are the ONLY way an anonymous client-intake page can
-- touch intake_requests / client_intake_submissions. The practitioner_id is
-- resolved server-side from the token — it is never sent by the browser.
-- ============================================================

-- 1. Look up a pending intake request by token (for the intake page to
--    greet the client and confirm the link is valid before showing the form).
-- Dropped first because Postgres won't let CREATE OR REPLACE change a
-- function's return columns — only re-running this exact block is safe.
drop function if exists get_intake_request_by_token(text);
create or replace function get_intake_request_by_token(p_token text)
returns table (
  client_name text,
  client_email text,
  status text,
  expires_at timestamptz,
  practitioner_full_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select ir.client_name, ir.client_email, ir.status, ir.expires_at, p.full_name
  from intake_requests ir
  join practitioners p on p.id = ir.practitioner_id
  where ir.token = p_token;
end;
$$;

grant execute on function get_intake_request_by_token(text) to anon, authenticated;

-- 2. Submit a completed intake. Validates the token, resolves practitioner_id
--    /client_id, inserts the submission, and marks the request submitted —
--    all in one transaction so a partial/duplicate submit can't happen.
create or replace function submit_client_intake(p_token text, p_form_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request intake_requests%rowtype;
  v_submission_id uuid;
begin
  select * into v_request
  from intake_requests
  where token = p_token
  for update; -- lock the row so two simultaneous submits can't both succeed

  if v_request.id is null then
    raise exception 'Invalid intake link.';
  end if;

  if v_request.status = 'submitted' then
    raise exception 'This intake has already been submitted.';
  end if;

  if v_request.status = 'expired' or v_request.expires_at < now() then
    raise exception 'This intake link has expired.';
  end if;

  insert into client_intake_submissions (
    intake_request_id, practitioner_id, client_id, client_name, client_email, form_data
  ) values (
    v_request.id, v_request.practitioner_id, v_request.client_id,
    v_request.client_name, v_request.client_email, p_form_data
  )
  returning id into v_submission_id;

  update intake_requests
  set status = 'submitted', submitted_at = now()
  where id = v_request.id;

  return v_submission_id;
end;
$$;

grant execute on function submit_client_intake(text, jsonb) to anon, authenticated;

-- 3. Record an inbound reply from a client. Called by n8n (anon key only --
--    no service_role key ever handed to n8n) after GHL's "Customer replied"
--    workflow webhook fires. Resolves the client purely from the GHL contact
--    id, so n8n never needs to know or pass along a practitioner_id.
create or replace function record_inbound_message(p_ghl_contact_id text, p_channel text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client clients%rowtype;
  v_message_id uuid;
begin
  select * into v_client from clients where ghl_contact_id = p_ghl_contact_id;

  if v_client.id is null then
    raise exception 'No client found for GHL contact %', p_ghl_contact_id;
  end if;

  insert into client_messages (client_id, practitioner_id, direction, channel, body)
  values (v_client.id, v_client.practitioner_id, 'inbound', p_channel, p_body)
  returning id into v_message_id;

  return v_message_id;
end;
$$;

grant execute on function record_inbound_message(text, text, text) to anon, authenticated;

-- 4. Link a client to their GHL contact id. Called by n8n right after the
--    existing contact-upsert step, using the same practitioner_id +
--    client_email identity key already used for is_first_submission --
--    n8n never needs our internal client_id at all.
create or replace function link_ghl_contact(p_practitioner_id uuid, p_client_email text, p_ghl_contact_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update clients
  set ghl_contact_id = p_ghl_contact_id
  where practitioner_id = p_practitioner_id and email = p_client_email;
end;
$$;

grant execute on function link_ghl_contact(uuid, text, text) to anon, authenticated;

-- ============================================================
-- N8N NOTIFICATION ON NEW INTAKE SUBMISSION
-- Fires after a client_intake_submissions row lands (i.e. after Supabase
-- has already durably stored it — n8n is notified, never the first stop).
-- Resolves the practitioner's email/name server-side and POSTs a clean
-- payload to n8n's webhook, so n8n needs no Supabase credentials at all.
-- pg_net's http_post is async/fire-and-forget: a slow or down n8n can
-- never block or fail the insert itself.
-- ============================================================

create extension if not exists pg_net;

create or replace function notify_n8n_on_intake_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_practitioner practitioners%rowtype;
  v_is_first_submission boolean;
begin
  select * into v_practitioner from practitioners where id = new.practitioner_id;

  -- "First submission" is keyed on practitioner + client email rather than
  -- client_id, since client_id can be null (intake not yet linked to a
  -- clients row) — this stays accurate either way.
  select not exists (
    select 1 from client_intake_submissions
    where id <> new.id
      and practitioner_id = new.practitioner_id
      and client_email = new.client_email
  ) into v_is_first_submission;

  perform net.http_post(
    url := 'https://deft-bison-84.nbg1-3.instapods.app/webhook/c56b83b4-068b-4e83-add8-d46cda55ab5a',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'submission_id', new.id,
      'practitioner_id', new.practitioner_id,
      'practitioner_email', v_practitioner.email,
      'practitioner_name', v_practitioner.full_name,
      'practitioner_booking_url', v_practitioner.booking_url,
      'client_name', new.client_name,
      'client_email', new.client_email,
      'client_phone', new.form_data ->> 'phone',
      'is_first_submission', v_is_first_submission,
      'submitted_at', new.submitted_at
    )
  );

  return new;
end;
$$;

drop trigger if exists on_intake_submission_notify_n8n on client_intake_submissions;
create trigger on_intake_submission_notify_n8n
  after insert on client_intake_submissions
  for each row execute function notify_n8n_on_intake_submission();

-- ============================================================
-- PER-PRACTITIONER BOOKING LINK + PRE-CREATED PRACTITIONER ONBOARDING
-- Each practitioner has their own GHL calendar/booking widget URL.
-- Mirrors the existing clients.user_id pattern: Tammy can now
-- pre-create a practitioners row (name, email, booking_url) before
-- that person has ever signed up, and handle_new_user() links it to
-- their real auth account the moment they self-serve sign up with a
-- matching email (see the updated trigger above). Column/constraint
-- changes only — actual practitioner data is real people's info and
-- gets set with a one-off UPDATE, never committed as literal data in
-- this schema file.
-- ============================================================

alter table practitioners alter column user_id drop not null;
alter table practitioners add column if not exists booking_url text;
-- The GHL internal calendarId (distinct from booking_url, which is the
-- public widget link) -- needed to query that practitioner's upcoming
-- events via GHL's Calendar Events API.
alter table practitioners add column if not exists calendar_id text;

-- ============================================================
-- COMMISSION LEVEL & CERTIFICATIONS
-- Client-facing: shown on a client's dashboard for their own
-- practitioner. Self-reported by the practitioner (Tammy's explicit
-- choice) via their own Settings page, using the same self-row RLS
-- pattern as everything else on practitioners.
-- ============================================================

alter table practitioners add column if not exists commission_level text;
alter table practitioners add column if not exists commission_id text;
alter table practitioners add column if not exists commission_next_review date;

create table if not exists practitioner_certifications (
  id uuid primary key default gen_random_uuid(),
  practitioner_id uuid not null references practitioners(id) on delete cascade,
  name text not null,
  level text,
  created_at timestamptz not null default now()
);

alter table practitioner_certifications enable row level security;

-- Practitioner manages their own; admins see all; a client can view
-- certifications for whichever practitioner(s) they have a clients row
-- under -- this is what makes the client-facing profile possible.
create policy "certifications_select_own_admin_or_client" on practitioner_certifications
  for select using (
    practitioner_id = current_practitioner_id()
    or is_admin()
    or practitioner_id in (select practitioner_id from clients where user_id = auth.uid())
  );
create policy "certifications_insert_own" on practitioner_certifications
  for insert with check (practitioner_id = current_practitioner_id());
create policy "certifications_update_own" on practitioner_certifications
  for update using (practitioner_id = current_practitioner_id());
create policy "certifications_delete_own" on practitioner_certifications
  for delete using (practitioner_id = current_practitioner_id());

-- ============================================================
-- PROFILE PHOTOS
-- One shared "avatars" bucket, path-scoped per practitioner:
--   practitioner/{practitioner_id}/xxx.jpg
--   client/{client_id}/xxx.jpg
-- Public read (these are just portal profile photos, same
-- sensitivity as the site's other branding images), write
-- restricted to the owning practitioner.
-- ============================================================

alter table practitioners add column if not exists avatar_url text;
alter table clients add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars_practitioner_write_own" on storage.objects;
create policy "avatars_practitioner_write_own" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'practitioner'
    and (storage.foldername(name))[2] = current_practitioner_id()::text
  );

drop policy if exists "avatars_practitioner_update_own" on storage.objects;
create policy "avatars_practitioner_update_own" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'practitioner'
    and (storage.foldername(name))[2] = current_practitioner_id()::text
  );

drop policy if exists "avatars_practitioner_write_client" on storage.objects;
create policy "avatars_practitioner_write_client" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'client'
    and exists (
      select 1 from clients
      where id::text = (storage.foldername(name))[2]
        and practitioner_id = current_practitioner_id()
    )
  );

drop policy if exists "avatars_practitioner_update_client" on storage.objects;
create policy "avatars_practitioner_update_client" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'client'
    and exists (
      select 1 from clients
      where id::text = (storage.foldername(name))[2]
        and practitioner_id = current_practitioner_id()
    )
  );
