create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz default now() not null
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.missions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  description text check (char_length(coalesce(description,'')) <= 500),
  status text not null default 'active' check (status in ('active','paused','finished')),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
create index if not exists missions_owner_idx on public.missions (owner_id);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.missions(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  color text not null default '#5688f5' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  join_code text not null unique,
  created_at timestamptz default now() not null
);
create index if not exists teams_mission_idx on public.teams (mission_id);
create index if not exists teams_join_code_idx on public.teams (join_code);

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  session_token text not null unique,
  created_at timestamptz default now() not null,
  last_seen_at timestamptz default now() not null
);
create index if not exists team_members_team_idx on public.team_members (team_id);

create table if not exists public.positions (
  member_id uuid primary key references public.team_members(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  mission_id uuid not null references public.missions(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy integer,
  heading double precision,
  speed double precision,
  updated_at timestamptz default now() not null
);
create index if not exists positions_mission_idx on public.positions (mission_id);
create index if not exists positions_updated_idx on public.positions (updated_at desc);

alter table public.profiles enable row level security;
alter table public.missions enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.positions enable row level security;

drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists missions_owner_all on public.missions;
create policy missions_owner_all on public.missions for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists teams_owner_all on public.teams;
create policy teams_owner_all on public.teams for all to authenticated
  using (exists (select 1 from public.missions m where m.id = teams.mission_id and m.owner_id = auth.uid()))
  with check (exists (select 1 from public.missions m where m.id = teams.mission_id and m.owner_id = auth.uid()));
drop policy if exists team_members_owner_read on public.team_members;
create policy team_members_owner_read on public.team_members for select to authenticated
  using (exists (select 1 from public.teams t join public.missions m on m.id=t.mission_id where t.id=team_members.team_id and m.owner_id=auth.uid()));
drop policy if exists positions_owner_read on public.positions;
create policy positions_owner_read on public.positions for select to authenticated
  using (exists (select 1 from public.missions m where m.id=positions.mission_id and m.owner_id=auth.uid()));

create or replace function public.join_team(p_join_code text, p_display_name text)
returns json language plpgsql security definer set search_path = public as $$
declare v_team record; v_member record; v_token text; v_name text;
begin
  v_name := left(trim(coalesce(p_display_name,'')),32);
  if v_name = '' then raise exception 'display_name_required'; end if;
  select t.id, t.name, t.color, t.mission_id, m.name as mission_name, m.status as mission_status
  into v_team from public.teams t join public.missions m on m.id=t.mission_id
  where upper(t.join_code)=upper(trim(p_join_code));
  if not found then raise exception 'join_code_not_found'; end if;
  if v_team.mission_status <> 'active' then raise exception 'mission_not_active'; end if;
  v_token := encode(gen_random_bytes(24),'hex');
  insert into public.team_members(team_id,display_name,session_token) values(v_team.id,v_name,v_token) returning * into v_member;
  return json_build_object('member_id',v_member.id,'session_token',v_token,'team_id',v_team.id,'team_name',v_team.name,'team_color',v_team.color,'mission_id',v_team.mission_id,'mission_name',v_team.mission_name,'display_name',v_member.display_name);
end; $$;

create or replace function public.publish_position(p_session_token text, p_lat double precision, p_lng double precision, p_accuracy integer default null, p_heading double precision default null, p_speed double precision default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_member record;
begin
  if p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'invalid_position'; end if;
  select tm.id,tm.team_id,t.mission_id,m.status as mission_status into v_member
  from public.team_members tm join public.teams t on t.id=tm.team_id join public.missions m on m.id=t.mission_id
  where tm.session_token=p_session_token;
  if not found then raise exception 'invalid_session'; end if;
  if v_member.mission_status <> 'active' then raise exception 'mission_not_active'; end if;
  insert into public.positions(member_id,team_id,mission_id,lat,lng,accuracy,heading,speed,updated_at)
  values(v_member.id,v_member.team_id,v_member.mission_id,p_lat,p_lng,p_accuracy,p_heading,p_speed,now())
  on conflict(member_id) do update set lat=excluded.lat,lng=excluded.lng,accuracy=excluded.accuracy,heading=excluded.heading,speed=excluded.speed,updated_at=now();
  update public.team_members set last_seen_at=now() where id=v_member.id;
end; $$;

create or replace function public.leave_team(p_session_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.team_members where session_token=p_session_token;
end; $$;

create or replace function public.get_mission_positions(p_session_token text)
returns table(member_id uuid,team_id uuid,team_name text,team_color text,display_name text,lat double precision,lng double precision,accuracy integer,heading double precision,speed double precision,updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_mission_id uuid;
begin
  select t.mission_id into v_mission_id from public.team_members tm join public.teams t on t.id=tm.team_id where tm.session_token=p_session_token;
  if v_mission_id is null then raise exception 'invalid_session'; end if;
  return query select p.member_id,p.team_id,t.name,t.color,tm.display_name,p.lat,p.lng,p.accuracy,p.heading,p.speed,p.updated_at
  from public.positions p join public.teams t on t.id=p.team_id join public.team_members tm on tm.id=p.member_id where p.mission_id=v_mission_id;
end; $$;

grant execute on function public.join_team(text,text) to anon, authenticated;
grant execute on function public.publish_position(text,double precision,double precision,integer,double precision,double precision) to anon, authenticated;
grant execute on function public.leave_team(text) to anon, authenticated;
grant execute on function public.get_mission_positions(text) to anon, authenticated;

do $$ begin
  alter publication supabase_realtime add table public.positions;
exception when duplicate_object then null; when others then
  if sqlstate <> '42710' then raise; end if;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.team_members;
exception when duplicate_object then null; when others then
  if sqlstate <> '42710' then raise; end if;
end $$;

create or replace function public.remove_team_member(p_member_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.team_members tm using public.teams t, public.missions m
  where tm.id = p_member_id and tm.team_id = t.id and t.mission_id = m.id and m.owner_id = auth.uid();
  if not found then raise exception 'member_not_found_or_forbidden'; end if;
end; $$;
grant execute on function public.remove_team_member(uuid) to authenticated;
