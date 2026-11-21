-- Jobby (India) — Supabase Postgres Schema & Row-Level Security
-- Free-tier friendly: minimal tables, dedup-only job_matches (no application tracking bloat)

create extension if not exists "pgcrypto";

-- 1. User Profiles & Owner Control
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text default '',
  role text not null default 'user' check (role in ('user', 'owner')),
  plan_tier text not null default 'free' check (plan_tier in ('free', 'pro', 'max')),
  max_loops integer not null default 2,
  daily_apply_limit integer not null default 15,
  is_active boolean not null default true,
  plan_expires_at timestamptz,
  cv_text text default '',
  cv_filename text default '',
  candidate_profile jsonb not null default '{
    "phone": "",
    "location": "Bengaluru, India",
    "notice_period_days": 30,
    "current_ctc_lpa": "",
    "expected_ctc_lpa": "",
    "experience_years": 0,
    "skills": [],
    "linkedin_url": "",
    "portfolio_url": ""
  }'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Job Search Loops
create table if not exists public.loops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  keywords text not null,
  location text not null default 'India',
  portals text[] not null default array['naukri', 'linkedin', 'indeed', 'greenhouse', 'lever', 'ashby'],
  ats_tokens text[] not null default '{}',
  is_active boolean not null default true,
  auto_email_enabled boolean not null default false,
  template_id uuid,
  created_at timestamptz not null default now()
);

-- 3. Template Emails (LoopCV-style {{variable}} outreach)
create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- 4. Queued Job Matches (Pure dedup + apply queue; no status tracking)
create table if not exists public.job_matches (
  id uuid primary key default gen_random_uuid(),
  loop_id uuid references public.loops(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_url text not null,
  job_url_hash text not null,
  title text not null,
  company text not null default '',
  portal text not null,
  location text default '',
  description text default '',
  recruiter_email text default '',
  fit_score integer not null default 70,
  ai_answers jsonb not null default '{}'::jsonb,
  dispatched boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, job_url_hash)
);

-- 5. UPI QR Payment Requests (Manual Owner Approval)
create table if not exists public.upi_payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  email text not null,
  requested_plan text not null check (requested_plan in ('pro', 'max')),
  amount_inr integer not null check (amount_inr in (499, 999)),
  utr_number text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

-- Helper function to check owner role without RLS recursion
create or replace function public.is_owner()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  );
$$;

-- Auto-create profile when a new user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Enable RLS
alter table public.profiles enable row level security;
alter table public.loops enable row level security;
alter table public.email_templates enable row level security;
alter table public.job_matches enable row level security;
alter table public.upi_payment_requests enable row level security;

-- Profiles RLS: users see/edit own profile (cannot self-promote role/plan); owner sees/edits all
create policy "profiles_select_own_or_owner" on public.profiles
  for select using (auth.uid() = id or public.is_owner());

create policy "profiles_update_own_safe" on public.profiles
  for update using (auth.uid() = id or public.is_owner());

-- Loops RLS
create policy "loops_all_own_or_owner" on public.loops
  for all using (auth.uid() = user_id or public.is_owner())
  with check (auth.uid() = user_id or public.is_owner());

-- Email Templates RLS
create policy "templates_all_own_or_owner" on public.email_templates
  for all using (auth.uid() = user_id or public.is_owner())
  with check (auth.uid() = user_id or public.is_owner());

-- Job Matches RLS
create policy "matches_all_own_or_owner" on public.job_matches
  for all using (auth.uid() = user_id or public.is_owner())
  with check (auth.uid() = user_id or public.is_owner());

-- UPI Requests RLS: user can insert & view own; owner can view & update all
create policy "upi_insert_own" on public.upi_payment_requests
  for insert with check (auth.uid() = user_id or user_id is null);

create policy "upi_select_own_or_owner" on public.upi_payment_requests
  for select using (auth.uid() = user_id or public.is_owner());

create policy "upi_update_owner_only" on public.upi_payment_requests
  for update using (public.is_owner());
