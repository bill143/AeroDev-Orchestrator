-- supabase-schema.sql
-- Run this ONCE in your Supabase project: Dashboard → SQL Editor → New query →
-- paste this whole file → click "Run". It creates the tables for projects and
-- work items, and turns on Row-Level Security so each user can only ever see and
-- change THEIR OWN rows. This is the real security boundary for your data.

-- ============================================================
-- PROJECTS
-- ============================================================
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  description text,
  color       text not null default '#e0a542',
  pinned      boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.projects enable row level security;

-- Each policy restricts rows to the signed-in user (auth.uid()).
drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own" on public.projects
  for select using (auth.uid() = user_id);

drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own" on public.projects
  for insert with check (auth.uid() = user_id);

drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own" on public.projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own" on public.projects
  for delete using (auth.uid() = user_id);

-- ============================================================
-- WORK ITEMS (conversations / files / project entries)
-- project_id is nullable: null means "ungrouped".
-- ============================================================
create table if not exists public.work_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null,
  type        text not null check (type in ('project','conversation','file')),
  project_id  uuid references public.projects (id) on delete set null,
  modified    timestamptz not null default now()
);

alter table public.work_items enable row level security;

drop policy if exists "items_select_own" on public.work_items;
create policy "items_select_own" on public.work_items
  for select using (auth.uid() = user_id);

drop policy if exists "items_insert_own" on public.work_items;
create policy "items_insert_own" on public.work_items
  for insert with check (auth.uid() = user_id);

drop policy if exists "items_update_own" on public.work_items;
create policy "items_update_own" on public.work_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "items_delete_own" on public.work_items;
create policy "items_delete_own" on public.work_items
  for delete using (auth.uid() = user_id);

-- Helpful indexes for the sidebar queries.
create index if not exists projects_user_idx   on public.projects (user_id);
create index if not exists items_user_idx       on public.work_items (user_id);
create index if not exists items_project_idx    on public.work_items (project_id);
