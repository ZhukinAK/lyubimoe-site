create extension if not exists pgcrypto with schema extensions;

create table if not exists public.rooms (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique,
  passphrase_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, auth_user_id)
);

create table if not exists public.gallery_items (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  caption text not null default '',
  storage_path text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.memories (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  text text not null,
  memory_date date not null default current_date,
  label text not null default 'момент',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.memories
add column if not exists memory_date date;

update public.memories
set memory_date = created_at::date
where memory_date is null;

alter table public.memories
alter column memory_date set default current_date,
alter column memory_date set not null;

alter table public.memories
add column if not exists label text;

update public.memories
set label = 'момент'
where label is null or label = '';

alter table public.memories
alter column label set default 'момент',
alter column label set not null;

create table if not exists public.game_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  type text not null,
  status text not null default 'draft',
  state jsonb not null default '{}'::jsonb,
  turn text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

insert into public.rooms (slug, passphrase_hash)
values ('preview', 'dbe56f2d3bf0ee960d5950fbb280f4f874c0e9a141eaf2db1fcbe399e813daab')
on conflict (slug) do update
set passphrase_hash = excluded.passphrase_hash;

insert into storage.buckets (id, name, public)
values ('gallery', 'gallery', false)
on conflict (id) do update
set public = false;

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.gallery_items enable row level security;
alter table public.memories enable row level security;
alter table public.game_sessions enable row level security;

create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.room_members
    where room_id = p_room_id
      and auth_user_id = auth.uid()
  );
$$;

create or replace function public.join_room(p_slug text, p_passphrase text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_room public.rooms%rowtype;
  v_hash text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_room
  from public.rooms
  where slug = p_slug;

  if v_room.id is null then
    raise exception 'Room not found';
  end if;

  v_hash := encode(extensions.digest(convert_to(p_passphrase, 'UTF8'), 'sha256'), 'hex');

  if v_hash <> v_room.passphrase_hash then
    raise exception 'Wrong passphrase';
  end if;

  insert into public.room_members (room_id, auth_user_id)
  values (v_room.id, auth.uid())
  on conflict do nothing;

  return v_room.id;
end;
$$;

grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.join_room(text, text) to authenticated;

drop policy if exists "room_members_select_own" on public.room_members;
create policy "room_members_select_own"
on public.room_members
for select
to authenticated
using (auth_user_id = auth.uid());

drop policy if exists "gallery_select_room" on public.gallery_items;
create policy "gallery_select_room"
on public.gallery_items
for select
to authenticated
using (public.is_room_member(room_id));

drop policy if exists "gallery_insert_room" on public.gallery_items;
create policy "gallery_insert_room"
on public.gallery_items
for insert
to authenticated
with check (public.is_room_member(room_id));

drop policy if exists "gallery_update_room" on public.gallery_items;
create policy "gallery_update_room"
on public.gallery_items
for update
to authenticated
using (public.is_room_member(room_id))
with check (public.is_room_member(room_id));

drop policy if exists "memories_select_room" on public.memories;
create policy "memories_select_room"
on public.memories
for select
to authenticated
using (public.is_room_member(room_id));

drop policy if exists "memories_insert_room" on public.memories;
create policy "memories_insert_room"
on public.memories
for insert
to authenticated
with check (public.is_room_member(room_id));

drop policy if exists "memories_update_room" on public.memories;
create policy "memories_update_room"
on public.memories
for update
to authenticated
using (public.is_room_member(room_id))
with check (public.is_room_member(room_id));

drop policy if exists "game_sessions_select_room" on public.game_sessions;
create policy "game_sessions_select_room"
on public.game_sessions
for select
to authenticated
using (public.is_room_member(room_id));

drop policy if exists "game_sessions_insert_room" on public.game_sessions;
create policy "game_sessions_insert_room"
on public.game_sessions
for insert
to authenticated
with check (public.is_room_member(room_id));

drop policy if exists "game_sessions_update_room" on public.game_sessions;
create policy "game_sessions_update_room"
on public.game_sessions
for update
to authenticated
using (public.is_room_member(room_id))
with check (public.is_room_member(room_id));

drop policy if exists "storage_select_gallery_room" on storage.objects;
create policy "storage_select_gallery_room"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'gallery'
  and public.is_room_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "storage_insert_gallery_room" on storage.objects;
create policy "storage_insert_gallery_room"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'gallery'
  and public.is_room_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "storage_update_gallery_room" on storage.objects;
create policy "storage_update_gallery_room"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'gallery'
  and public.is_room_member(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'gallery'
  and public.is_room_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "storage_delete_gallery_room" on storage.objects;
create policy "storage_delete_gallery_room"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'gallery'
  and public.is_room_member(((storage.foldername(name))[1])::uuid)
);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'gallery_items'
  ) then
    alter publication supabase_realtime add table public.gallery_items;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'memories'
  ) then
    alter publication supabase_realtime add table public.memories;
  end if;
end $$;
