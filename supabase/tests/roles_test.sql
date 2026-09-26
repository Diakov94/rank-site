-- ============================================================================
-- ESportsBattle Rank: test of the roles migration (20260927000000_roles.sql)
--
-- Run it after applying the migrations: paste the whole file into the Supabase
-- SQL editor and run it, or
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/roles_test.sql
-- Run the whole file at once. It works inside BEGIN ... ROLLBACK, so nothing it
-- creates or changes is kept: throwaway auth users, roles, players, settings,
-- log entries and storage rows all disappear at the end.
--
-- Each check prints NOTICE "PASS <what>" (psql shows notices). The first failed
-- check stops the script with ERROR "FAIL <what>: ...". When every check passes,
-- the last result is one row: "roles test: all checks passed".
--
-- Users are simulated the way PostgREST does it: SET LOCAL ROLE authenticated (or
-- anon) plus request.jwt.claims with the user's id and email.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.user_roles') is null
     or to_regprocedure('public.my_access()') is null
     or to_regprocedure('private.can_grant_role(bigint)') is null then
    raise exception 'Apply supabase/migrations/20260927000000_roles.sql before running this test';
  end if;
end
$$;

-- ── Test helpers (schema roles_test, rolled back with everything else) ──────
create schema roles_test;
grant usage on schema roles_test to anon, authenticated;

create table roles_test.users (
  name text primary key,
  id   uuid not null default gen_random_uuid(),
  role text
);
create table roles_test.flags (name text primary key);
-- Numbers the checks compare against, captured once from the database as the SQL
-- editor's role (see the test data below), so they follow the migration instead of
-- being written into the checks.
create table roles_test.counts (name text primary key, n bigint not null);
grant select on roles_test.users, roles_test.flags, roles_test.counts to anon, authenticated;

-- Email of a test user.
create function roles_test.email(p_name text) returns text
language sql immutable
as $$ select 'roles-test-' || p_name || '@example.invalid' $$;

-- Id of a test user, and of a role by name (SECURITY DEFINER: works for any caller).
create function roles_test.uid(p_name text) returns uuid
language sql stable security definer set search_path = ''
as $$ select u.id from roles_test.users u where u.name = p_name $$;

create function roles_test.rid(p_name text) returns bigint
language sql stable security definer set search_path = ''
as $$ select r.id from public.roles r where r.name = p_name $$;

create function roles_test.flag(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from roles_test.flags f where f.name = p_name) $$;

-- A captured number (null, so the check fails, if it was never captured).
create function roles_test.expected(p_name text) returns bigint
language sql stable security definer set search_path = ''
as $$ select c.n from roles_test.counts c where c.name = p_name $$;

-- Act as a test user, as anon, or as the SQL editor's own role again.
create function roles_test.login(p_name text) returns void
language plpgsql
as $$
declare
  v_id uuid := roles_test.uid(p_name);
begin
  if v_id is null then
    raise exception 'roles_test: unknown user %', p_name;
  end if;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', v_id, 'email', roles_test.email(p_name), 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function roles_test.login_anon() returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end
$$;

create function roles_test.logout() returns void
language plpgsql
as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- Runs one statement as the current role: 'ok <rows>' or 'error <sqlstate>: <message>'.
-- A failed statement is undone; a successful one stays (until the final ROLLBACK).
create function roles_test.run(p_sql text) returns text
language plpgsql
as $$
declare
  n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok ' || n;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end
$$;

create function roles_test.scalar(p_sql text) returns text
language plpgsql
as $$
declare
  v text;
begin
  execute p_sql into v;
  return v;
end
$$;

-- Assertions. Each prints PASS or raises FAIL.
create function roles_test.expect(p_label text, p_ok boolean, p_got text) returns void
language plpgsql
as $$
begin
  if p_ok then
    raise notice 'PASS %', p_label;
  else
    raise exception 'FAIL %: got %', p_label, coalesce(p_got, 'null');
  end if;
end
$$;

-- The statement works and changes (or returns) at least one row.
create function roles_test.allow(p_label text, p_sql text) returns void
language plpgsql
as $$
declare
  r text := roles_test.run(p_sql);
begin
  perform roles_test.expect(p_label, r like 'ok %' and r <> 'ok 0', r);
end
$$;

-- The statement is refused: a privilege or RLS error (42501), or no row is changed.
create function roles_test.deny(p_label text, p_sql text) returns void
language plpgsql
as $$
declare
  r text := roles_test.run(p_sql);
begin
  perform roles_test.expect(p_label, r = 'ok 0' or r like 'error 42501:%', r);
end
$$;

-- The statement fails with an error whose text contains p_expected.
create function roles_test.expect_error(p_label text, p_sql text, p_expected text) returns void
language plpgsql
as $$
declare
  r text := roles_test.run(p_sql);
begin
  perform roles_test.expect(p_label, r like 'error %' and strpos(r, p_expected) > 0, r);
end
$$;

grant execute on all functions in schema roles_test to anon, authenticated;

-- ── Test data (as the SQL editor's role, which bypasses RLS) ────────────────
-- How many permissions the migration left (nothing in this test adds or removes one).
insert into roles_test.counts (name, n)
select 'permissions', count(*) from public.permissions;

insert into roles_test.users (name, role)
select v.name, v.role
from (values
  ('super',      'Super admin'),
  ('super2',     'Super admin'),
  ('vis',        'roles_test visibility'),
  ('players',    'roles_test players'),
  ('badges',     'roles_test badges'),
  ('groups',     'roles_test groups'),
  ('reset',      'roles_test reset'),
  ('adjust',     'roles_test adjust'),
  ('formula',    'roles_test formula'),
  ('avatars',    'roles_test avatars'),
  ('achiever',   'roles_test achievements'),
  ('usermgr',    'roles_test users manager'),
  ('logreader',  'roles_test log reader'),
  ('logclearer', 'roles_test log clearer'),
  ('allperms',   'roles_test everything'),
  ('nobody',     null),
  ('fresh',      null),
  ('fresh2',     null)
) as v (name, role);

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       roles_test.email(u.name), now(), now()
from roles_test.users u;

insert into public.roles (name, description)
select v.name, 'roles_test throwaway role'
from (values
  ('roles_test visibility'), ('roles_test players'), ('roles_test badges'),
  ('roles_test groups'), ('roles_test reset'), ('roles_test adjust'),
  ('roles_test formula'), ('roles_test avatars'), ('roles_test achievements'),
  ('roles_test users manager'), ('roles_test log reader'),
  ('roles_test log clearer'), ('roles_test everything'), ('roles_test empty')
) as v (name);

insert into public.role_permissions (role_id, permission_key)
select roles_test.rid(v.role_name), v.permission_key
from (values
  ('roles_test visibility',    'players.visibility'),
  ('roles_test players',       'players.edit'),
  ('roles_test badges',        'badges.assign'),
  ('roles_test groups',        'groups.edit'),
  ('roles_test reset',         'reset.run'),
  ('roles_test adjust',        'adjustments.edit'),
  ('roles_test formula',       'formula.edit'),
  ('roles_test avatars',       'avatars.upload'),
  ('roles_test achievements',  'achievements.edit'),
  ('roles_test users manager', 'users.manage'),
  ('roles_test users manager', 'players.visibility'),
  ('roles_test log reader',    'log.read'),
  ('roles_test log clearer',   'log.read'),
  ('roles_test log clearer',   'log.clear')
) as v (role_name, permission_key);

insert into public.role_permissions (role_id, permission_key)
select roles_test.rid('roles_test everything'), p.key from public.permissions p;

insert into public.user_roles (user_id, role_id)
select u.id, roles_test.rid(u.role) from roles_test.users u where u.role is not null;

insert into public.player_config (nickname, initial_rating, active) values ('roles_test_p1', 1000, true);
insert into public.achievements (name, icon_url, url)
values ('roles_test_ach', 'https://example.invalid/roles_test.png', null);
insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values
  ('roles_test_p1', 1000, '2000-01-01', 'monthly_reset'),
  ('roles_test_p1', 1001, '2000-01-01', 'roles_test manual');
insert into public.settings (key, value) values ('roles_test_key', '1');
insert into public.admin_log (action, details, email)
values ('roles_test setup', null, 'setup@example.invalid');
insert into public.rating_groups (name, min_rating, color, coef)
select 'roles_test group', 0, '#888888', 1
where not exists (select 1 from public.rating_groups);

-- The site's two buckets normally exist already; create them if not.
do $$
begin
  insert into storage.buckets (id, name, public) values
    ('player-avatars', 'player-avatars', true),
    ('achievements',   'achievements',   true)
  on conflict (id) do nothing;
exception when others then
  raise notice 'Could not check the storage buckets (%); the storage checks need them', sqlerrm;
end
$$;

-- The matches checks need at least one row.
insert into roles_test.flags (name)
select 'matches_rows' where exists (select 1 from public.matches);

-- The admin_log columns the log checks need.
insert into roles_test.flags (name)
select f.name
from (values ('log_created_at', 'created_at', false), ('log_integer_id', 'id', true)) as f (name, col, needs_int)
where exists (
  select 1 from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'admin_log' and c.column_name = f.col
    and (not f.needs_int or c.data_type in ('bigint', 'integer', 'smallint'))
);

-- A third bucket with its own policy, to show the site's policies leave it alone.
do $$
begin
  insert into storage.buckets (id, name, public) values ('roles-test-other', 'roles-test-other', false);
  create policy roles_test_other_insert on storage.objects
    as permissive for insert to authenticated
    with check (bucket_id = 'roles-test-other');
  insert into roles_test.flags (name) values ('other_bucket');
exception when others then
  raise notice 'SKIP other-bucket storage check: could not set it up (%)', sqlerrm;
end
$$;

-- ── my_access() and is_admin() ──────────────────────────────────────────────
select roles_test.login('super');
do $$
declare
  a jsonb := public.my_access();
begin
  perform roles_test.expect('my_access: super admin gets {role: {id, name, is_super}, permissions}',
    (select count(*) from jsonb_object_keys(a)) = 2
      and jsonb_typeof(a -> 'role') = 'object'
      and (select count(*) from jsonb_object_keys(a -> 'role')) = 3
      and (a -> 'role' ->> 'id')::bigint = roles_test.rid('Super admin')
      and a -> 'role' ->> 'name' = 'Super admin'
      and (a -> 'role' ->> 'is_super')::boolean
      and jsonb_typeof(a -> 'permissions') = 'array',
    a::text);
  perform roles_test.expect('my_access: super admin gets every permission key',
    jsonb_array_length(a -> 'permissions') = roles_test.expected('permissions')
      and (a -> 'permissions') @> '["players.edit", "players.visibility", "avatars.upload",
        "achievements.edit", "badges.assign", "groups.edit", "reset.run", "adjustments.edit",
        "formula.edit", "log.read", "log.clear", "users.manage"]'::jsonb,
    a::text);
end
$$;
select roles_test.logout();

select roles_test.login('vis');
do $$
declare
  a jsonb := public.my_access();
begin
  perform roles_test.expect('my_access: a one-permission role gets that role and that key',
    (a -> 'role' ->> 'id')::bigint = roles_test.rid('roles_test visibility')
      and a -> 'role' ->> 'name' = 'roles_test visibility'
      and (a -> 'role' ->> 'is_super')::boolean = false
      and a -> 'permissions' = '["players.visibility"]'::jsonb,
    a::text);
  perform roles_test.expect('is_admin() is true for a user with a role', public.is_admin(), null);
end
$$;
select roles_test.logout();

select roles_test.login('nobody');
do $$
declare
  a jsonb := public.my_access();
begin
  perform roles_test.expect('my_access: a user without a role gets role null and no permissions',
    a -> 'role' = 'null'::jsonb and a -> 'permissions' = '[]'::jsonb,
    a::text);
  perform roles_test.expect('is_admin() is false for a user without a role', not public.is_admin(), null);
end
$$;
select roles_test.logout();

-- ── players.visibility only ─────────────────────────────────────────────────
select roles_test.login('vis');
do $$
begin
  perform roles_test.allow('players.visibility: can hide a player',
    $q$insert into public.hidden_players (nick) values ('roles_test_p1')$q$);
  perform roles_test.allow('players.visibility: can show the player again',
    $q$delete from public.hidden_players where nick = 'roles_test_p1'$q$);
  perform roles_test.deny('players.visibility: cannot add a player',
    $q$insert into public.player_config (nickname, initial_rating, active) values ('roles_test_p2', 1000, true)$q$);
  perform roles_test.deny('players.visibility: cannot delete a player',
    $q$delete from public.player_config where nickname = 'roles_test_p1'$q$);
  perform roles_test.deny('players.visibility: cannot change rating groups',
    $q$update public.rating_groups set name = name where id = (select g.id from public.rating_groups g order by g.id limit 1)$q$);
  perform roles_test.expect('players.visibility: cannot read the activity log',
    roles_test.scalar('select count(*) from public.admin_log')::bigint = 0, null);
  perform roles_test.deny('players.visibility: cannot create roles',
    $q$insert into public.roles (name) values ('roles_test by vis')$q$);
  perform roles_test.deny('players.visibility: cannot edit roles',
    $q$update public.roles set description = 'changed' where name = 'roles_test reset'$q$);
  perform roles_test.deny('players.visibility: cannot delete roles',
    $q$delete from public.roles where name = 'roles_test empty'$q$);
  perform roles_test.deny('players.visibility: cannot change role permissions',
    $q$insert into public.role_permissions (role_id, permission_key) values (roles_test.rid('roles_test empty'), 'players.visibility')$q$);
  perform roles_test.deny('players.visibility: cannot assign roles',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh'), roles_test.rid('roles_test empty'))$q$);
  perform roles_test.deny('players.visibility: cannot create achievements',
    $q$insert into public.achievements (name, icon_url, url) values ('roles_test by vis', 'https://example.invalid/x.png', null)$q$);
  perform roles_test.deny('players.visibility: cannot assign achievements',
    $q$insert into public.player_achievements (nick, achievement_id) select 'roles_test_p1', a.id from public.achievements a where a.name = 'roles_test_ach'$q$);
  perform roles_test.deny('players.visibility: cannot save a monthly reset',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 900, '2000-03-01', 'monthly_reset')$q$);
  perform roles_test.deny('players.visibility: cannot add an adjustment',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 900, '2000-03-01', null)$q$);
  perform roles_test.deny('players.visibility: cannot change the formula',
    $q$insert into public.settings (key, value) values ('WinMin', '3') on conflict (key) do update set value = excluded.value$q$);
  perform roles_test.deny('players.visibility: cannot upload a player photo',
    $q$insert into storage.objects (bucket_id, name) values ('player-avatars', 'roles_test_vis.png')$q$);
  perform roles_test.deny('players.visibility: cannot upload an achievement icon',
    $q$insert into storage.objects (bucket_id, name) values ('achievements', 'roles_test_vis.png')$q$);
  perform roles_test.expect('an admin can read the roles and the permission list',
    roles_test.scalar('select count(*) from public.roles')::bigint > 0
      and roles_test.scalar('select count(*) from public.permissions')::bigint = roles_test.expected('permissions')
      and roles_test.scalar('select count(*) from public.role_permissions')::bigint > 0,
    null);
  perform roles_test.expect('an admin without users.manage sees only their own user_roles row',
    roles_test.scalar('select count(*) from public.user_roles')::bigint = 1
      and roles_test.scalar('select user_id::text from public.user_roles') = roles_test.uid('vis')::text,
    null);
end
$$;
select roles_test.logout();

-- ── players.edit, badges.assign, groups.edit: one table each ────────────────
select roles_test.login('players');
do $$
begin
  perform roles_test.allow('players.edit: can add a player',
    $q$insert into public.player_config (nickname, initial_rating, active) values ('roles_test_p3', 1000, true)$q$);
  perform roles_test.allow('players.edit: can delete a player',
    $q$delete from public.player_config where nickname = 'roles_test_p3'$q$);
  perform roles_test.deny('players.edit: cannot hide players (players.visibility)',
    $q$insert into public.hidden_players (nick) values ('roles_test_p1')$q$);
  perform roles_test.deny('players.edit: cannot upload a player photo (avatars.upload)',
    $q$insert into storage.objects (bucket_id, name) values ('player-avatars', 'roles_test_players.png')$q$);
  perform roles_test.deny('players.edit: cannot assign achievements (badges.assign)',
    $q$insert into public.player_achievements (nick, achievement_id) select 'roles_test_p1', a.id from public.achievements a where a.name = 'roles_test_ach'$q$);
end
$$;
select roles_test.logout();

select roles_test.login('badges');
do $$
begin
  perform roles_test.allow('badges.assign: can assign an achievement',
    $q$insert into public.player_achievements (nick, achievement_id) select 'roles_test_p1', a.id from public.achievements a where a.name = 'roles_test_ach'$q$);
  perform roles_test.allow('badges.assign: can take an achievement away',
    $q$delete from public.player_achievements where nick = 'roles_test_p1'$q$);
  perform roles_test.deny('badges.assign: cannot edit achievements (achievements.edit)',
    $q$update public.achievements set url = 'https://example.invalid/badges' where name = 'roles_test_ach'$q$);
  perform roles_test.deny('badges.assign: cannot add a player (players.edit)',
    $q$insert into public.player_config (nickname, initial_rating, active) values ('roles_test_p4', 1000, true)$q$);
end
$$;
select roles_test.logout();

select roles_test.login('groups');
do $$
begin
  perform roles_test.allow('groups.edit: can edit rating groups',
    $q$update public.rating_groups set name = name where id = (select g.id from public.rating_groups g order by g.id limit 1)$q$);
  perform roles_test.deny('groups.edit: cannot change the formula (formula.edit)',
    $q$insert into public.settings (key, value) values ('WinMin', '3') on conflict (key) do update set value = excluded.value$q$);
  perform roles_test.deny('groups.edit: cannot read the activity log (log.read)',
    $q$select 1 from public.admin_log$q$);
end
$$;
select roles_test.logout();

-- ── adjustments.edit vs reset.run (rating_adjustments by reason) ────────────
select roles_test.login('adjust');
do $$
begin
  perform roles_test.allow('adjustments.edit: can add an adjustment with a reason',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1100, '2000-01-15', 'roles_test manual 2')$q$);
  perform roles_test.allow('adjustments.edit: can add an adjustment without a reason',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1110, '2000-01-16', null)$q$);
  perform roles_test.deny('adjustments.edit: cannot save a monthly reset',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1000, '2000-02-01', 'monthly_reset')$q$);
  perform roles_test.deny('adjustments.edit: cannot delete a monthly reset',
    $q$delete from public.rating_adjustments where nickname = 'roles_test_p1' and reason = 'monthly_reset'$q$);
  perform roles_test.deny('adjustments.edit: cannot turn an adjustment into a monthly reset',
    $q$update public.rating_adjustments set reason = 'monthly_reset' where nickname = 'roles_test_p1' and reason = 'roles_test manual'$q$);
  perform roles_test.allow('adjustments.edit: can delete an adjustment',
    $q$delete from public.rating_adjustments where nickname = 'roles_test_p1' and reason = 'roles_test manual'$q$);
  perform roles_test.deny('adjustments.edit: cannot change the formula',
    $q$insert into public.settings (key, value) values ('WinMin', '3') on conflict (key) do update set value = excluded.value$q$);
end
$$;
select roles_test.logout();

select roles_test.login('reset');
do $$
begin
  perform roles_test.allow('reset.run: can save a monthly reset',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1000, '2000-02-01', 'monthly_reset')$q$);
  perform roles_test.deny('reset.run: cannot add an adjustment with a reason',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1200, '2000-02-02', 'roles_test manual 3')$q$);
  perform roles_test.deny('reset.run: cannot add an adjustment without a reason',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1200, '2000-02-02', null)$q$);
  perform roles_test.deny('reset.run: cannot delete an adjustment without a reason',
    $q$delete from public.rating_adjustments where nickname = 'roles_test_p1' and reason is null$q$);
  perform roles_test.deny('reset.run: cannot turn a monthly reset into an adjustment',
    $q$update public.rating_adjustments set reason = 'roles_test moved' where nickname = 'roles_test_p1' and reason = 'monthly_reset' and applied_date = '2000-01-01'$q$);
  perform roles_test.allow('reset.run: can delete a monthly reset',
    $q$delete from public.rating_adjustments where nickname = 'roles_test_p1' and reason = 'monthly_reset' and applied_date = '2000-01-01'$q$);
end
$$;
select roles_test.logout();

-- ── formula.edit: formula keys only ─────────────────────────────────────────
select roles_test.login('formula');
do $$
begin
  perform roles_test.allow('formula.edit: can save WinMin',
    $q$insert into public.settings (key, value) values ('WinMin', '3') on conflict (key) do update set value = excluded.value$q$);
  perform roles_test.allow('formula.edit: can save DrawMax',
    $q$insert into public.settings (key, value) values ('DrawMax', '1') on conflict (key) do update set value = excluded.value$q$);
  perform roles_test.deny('formula.edit: cannot add another settings key',
    $q$insert into public.settings (key, value) values ('roles_test_other_key', '1')$q$);
  perform roles_test.deny('formula.edit: cannot change another settings key',
    $q$update public.settings set value = '2' where key = 'roles_test_key'$q$);
  perform roles_test.deny('formula.edit: cannot delete another settings key',
    $q$delete from public.settings where key = 'roles_test_key'$q$);
  perform roles_test.deny('formula.edit: cannot hide players',
    $q$insert into public.hidden_players (nick) values ('roles_test_p1')$q$);
end
$$;
select roles_test.logout();

-- ── Storage per bucket ──────────────────────────────────────────────────────
select roles_test.login('avatars');
do $$
begin
  perform roles_test.allow('avatars.upload: can upload a player photo',
    $q$insert into storage.objects (bucket_id, name) values ('player-avatars', 'roles_test_avatar_1.png')$q$);
  perform roles_test.deny('avatars.upload: cannot upload an achievement icon',
    $q$insert into storage.objects (bucket_id, name) values ('achievements', 'roles_test_icon_1.png')$q$);
end
$$;
select roles_test.logout();

select roles_test.login('achiever');
do $$
begin
  perform roles_test.allow('achievements.edit: can upload an achievement icon',
    $q$insert into storage.objects (bucket_id, name) values ('achievements', 'roles_test_icon_2.png')$q$);
  perform roles_test.deny('achievements.edit: cannot upload a player photo',
    $q$insert into storage.objects (bucket_id, name) values ('player-avatars', 'roles_test_avatar_2.png')$q$);
  perform roles_test.allow('achievements.edit: can create an achievement',
    $q$insert into public.achievements (name, icon_url, url) values ('roles_test_ach2', 'https://example.invalid/2.png', null)$q$);
  perform roles_test.allow('achievements.edit: can edit an achievement',
    $q$update public.achievements set url = 'https://example.invalid/about' where name = 'roles_test_ach2'$q$);
  perform roles_test.deny('achievements.edit: cannot assign achievements (badges.assign)',
    $q$insert into public.player_achievements (nick, achievement_id) select 'roles_test_p1', a.id from public.achievements a where a.name = 'roles_test_ach'$q$);
  perform roles_test.allow('achievements.edit: can delete an achievement',
    $q$delete from public.achievements where name = 'roles_test_ach2'$q$);
end
$$;
select roles_test.logout();

select roles_test.login('nobody');
do $$
begin
  if roles_test.flag('other_bucket') then
    perform roles_test.allow('storage: other buckets are left to their own policies',
      $q$insert into storage.objects (bucket_id, name) values ('roles-test-other', 'roles_test_other.png')$q$);
  else
    raise notice 'SKIP storage: other buckets are left to their own policies';
  end if;
  perform roles_test.deny('no role: cannot upload a player photo',
    $q$insert into storage.objects (bucket_id, name) values ('player-avatars', 'roles_test_avatar_3.png')$q$);
end
$$;
select roles_test.logout();

-- ── Roles and their permissions: super admin only ──────────────────────────
do $$
begin
  perform roles_test.expect('roles.manage is gone: roles are managed by the super admin only',
    not exists (select 1 from public.permissions where key = 'roles.manage'), null);
end
$$;

select roles_test.login('allperms');
do $$
begin
  perform roles_test.deny('every permission: cannot create a role (super admin only)',
    $q$insert into public.roles (name, description) values ('roles_test by allperms', 'not allowed')$q$);
  perform roles_test.deny('every permission: cannot rename a role (super admin only)',
    $q$update public.roles set name = 'roles_test renamed by allperms' where name = 'roles_test empty'$q$);
  perform roles_test.deny('every permission: cannot delete a role nobody has (super admin only)',
    $q$delete from public.roles where name = 'roles_test empty'$q$);
  perform roles_test.deny('every permission: cannot grant a permission to a role (super admin only)',
    $q$insert into public.role_permissions (role_id, permission_key) values (roles_test.rid('roles_test empty'), 'players.visibility')$q$);
  perform roles_test.deny('every permission: cannot remove a permission from a role (super admin only)',
    $q$delete from public.role_permissions where role_id = roles_test.rid('roles_test reset') and permission_key = 'reset.run'$q$);
  perform roles_test.deny('every permission: cannot strip a users manager''s role of users.manage',
    $q$delete from public.role_permissions where role_id = roles_test.rid('roles_test users manager') and permission_key = 'users.manage'$q$);
end
$$;
select roles_test.logout();

select roles_test.login('super');
do $$
begin
  perform roles_test.allow('super: can create a role with a description',
    $q$insert into public.roles (name, description) values ('roles_test created', 'made by the super admin')$q$);
  perform roles_test.allow('super: can grant a permission',
    $q$insert into public.role_permissions (role_id, permission_key) values (roles_test.rid('roles_test created'), 'players.visibility')$q$);
  perform roles_test.expect_error('super: roles.manage cannot be granted, it does not exist',
    $q$insert into public.role_permissions (role_id, permission_key) values (roles_test.rid('roles_test created'), 'roles.manage')$q$, '23503');
  perform roles_test.deny('super: cannot create a second super role',
    $q$insert into public.roles (name, is_super) values ('roles_test fake super', true)$q$);
  perform roles_test.deny('super: cannot make a role super',
    $q$update public.roles set is_super = true where name = 'roles_test created'$q$);
  perform roles_test.deny('super: cannot rename the super role',
    $q$update public.roles set name = 'roles_test hacked' where is_super$q$);
  perform roles_test.deny('super: cannot add permissions to the super role',
    $q$insert into public.role_permissions (role_id, permission_key) values (roles_test.rid('Super admin'), 'players.visibility')$q$);
  perform roles_test.allow('super: can rename and describe a role',
    $q$update public.roles set name = 'roles_test renamed', description = 'renamed' where name = 'roles_test created'$q$);
  perform roles_test.allow('super: can remove a permission from a role',
    $q$delete from public.role_permissions where role_id = roles_test.rid('roles_test renamed') and permission_key = 'players.visibility'$q$);
  perform roles_test.expect_error('super: a role still assigned to users cannot be deleted',
    $q$delete from public.roles where name = 'roles_test visibility'$q$, '23503');
  perform roles_test.allow('super: can delete a role nobody has',
    $q$delete from public.roles where name = 'roles_test renamed'$q$);
end
$$;
select roles_test.logout();

-- ── users.manage (+ players.visibility) ─────────────────────────────────────
select roles_test.login('usermgr');
do $$
begin
  perform roles_test.expect('users.manage: sees every user_roles row',
    roles_test.scalar($q$select count(*) from public.user_roles where user_id in (select u.id from roles_test.users u where u.role is not null)$q$)::bigint
      = (select count(*) from roles_test.users u where u.role is not null),
    null);
  perform roles_test.allow('users.manage: can assign a role whose permissions they hold',
    $q$insert into public.user_roles (user_id, role_id, assigned_by) values (roles_test.uid('fresh'), roles_test.rid('roles_test visibility'), roles_test.uid('super'))$q$);
  perform roles_test.expect('user_roles.assigned_by is the caller, not what the client sent',
    roles_test.scalar($q$select assigned_by::text from public.user_roles where user_id = roles_test.uid('fresh')$q$)
      = roles_test.uid('usermgr')::text,
    null);
  perform roles_test.deny('users.manage: cannot assign a role with a permission they lack',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh2'), roles_test.rid('roles_test reset'))$q$);
  perform roles_test.deny('users.manage: cannot assign a role with every permission',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh2'), roles_test.rid('roles_test everything'))$q$);
  perform roles_test.deny('users.manage: cannot assign the super role',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh2'), roles_test.rid('Super admin'))$q$);
  perform roles_test.allow('users.manage: can change a role to another grantable role',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test empty') where user_id = roles_test.uid('fresh')$q$);
  perform roles_test.deny('users.manage: cannot change a role to one with a permission they lack',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test reset') where user_id = roles_test.uid('fresh')$q$);
  perform roles_test.deny('users.manage: cannot change their own role',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test empty') where user_id = roles_test.uid('usermgr')$q$);
  perform roles_test.deny('users.manage: cannot change their own role by upsert',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('usermgr'), roles_test.rid('roles_test empty')) on conflict (user_id) do update set role_id = excluded.role_id$q$);
  perform roles_test.deny('users.manage: cannot remove their own role',
    $q$delete from public.user_roles where user_id = roles_test.uid('usermgr')$q$);
  perform roles_test.deny('users.manage: cannot change a super admin''s role',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test empty') where user_id = roles_test.uid('super')$q$);
  perform roles_test.deny('users.manage: cannot remove a super admin (so not the last one either)',
    $q$delete from public.user_roles where user_id = roles_test.uid('super')$q$);
  perform roles_test.deny('users.manage: cannot change the role of a user whose role they could not grant',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test empty') where user_id = roles_test.uid('reset')$q$);
  perform roles_test.deny('users.manage: cannot remove the role of a user whose role they could not grant',
    $q$delete from public.user_roles where user_id = roles_test.uid('reset')$q$);
  perform roles_test.allow('users.manage: can remove a role they could grant',
    $q$delete from public.user_roles where user_id = roles_test.uid('fresh')$q$);
  perform roles_test.deny('users.manage: cannot create roles (super admin only)',
    $q$insert into public.roles (name) values ('roles_test by usermgr')$q$);
end
$$;
select roles_test.logout();

-- ── Every permission, but not the super role ────────────────────────────────
select roles_test.login('allperms');
do $$
begin
  if roles_test.flag('matches_rows') then
    perform roles_test.deny('every permission: still cannot change matches (super only)',
      $q$update public.matches set external_id = external_id where ctid = (select m.ctid from public.matches m limit 1)$q$);
  else
    raise notice 'SKIP every permission: still cannot change matches (the table is empty)';
  end if;
  perform roles_test.deny('every permission: still cannot add non-formula settings (super only)',
    $q$insert into public.settings (key, value) values ('roles_test_other_key', '1')$q$);
  perform roles_test.deny('every permission: still cannot change non-formula settings (super only)',
    $q$update public.settings set value = '2' where key = 'roles_test_key'$q$);
  perform roles_test.deny('every permission: cannot assign the super role',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh2'), roles_test.rid('Super admin'))$q$);
  perform roles_test.deny('every permission: cannot change a super admin''s role',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test empty') where user_id = roles_test.uid('super2')$q$);
  perform roles_test.deny('every permission: cannot create a super role',
    $q$insert into public.roles (name, is_super) values ('roles_test fake super', true)$q$);
  perform roles_test.allow('every permission: can assign a role with some of their permissions',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh2'), roles_test.rid('roles_test reset'))$q$);
  perform roles_test.allow('every permission: can assign a role with all of their permissions',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh'), roles_test.rid('roles_test everything'))$q$);
  perform roles_test.allow('every permission: can remove those roles again',
    $q$delete from public.user_roles where user_id in (roles_test.uid('fresh'), roles_test.uid('fresh2'))$q$);
end
$$;
select roles_test.logout();

-- ── Activity log ────────────────────────────────────────────────────────────
select roles_test.login('nobody');
do $$
begin
  perform roles_test.deny('no role: cannot write the log',
    $q$insert into public.admin_log (action, details, email) values ('roles_test by nobody', null, null)$q$);
  perform roles_test.expect('no role: cannot read the log, the roles or user_roles',
    roles_test.scalar('select count(*) from public.admin_log')::bigint = 0
      and roles_test.scalar('select count(*) from public.roles')::bigint = 0
      and roles_test.scalar('select count(*) from public.permissions')::bigint = 0
      and roles_test.scalar('select count(*) from public.user_roles')::bigint = 0,
    null);
  perform roles_test.deny('no role: cannot hide players',
    $q$insert into public.hidden_players (nick) values ('roles_test_p1')$q$);
end
$$;
select roles_test.logout();

select roles_test.login('vis');
do $$
begin
  perform roles_test.allow('any admin can write the log',
    $q$insert into public.admin_log (action, details, email) values ('roles_test by vis', null, 'forged@example.invalid')$q$);
  if roles_test.flag('log_created_at') then
    perform roles_test.deny('an admin cannot choose a log entry''s created_at',
      $q$insert into public.admin_log (action, details, email, created_at) values ('roles_test backdated', null, null, now() + interval '100 years')$q$);
  end if;
  if roles_test.flag('log_integer_id') then
    -- 428C9: an identity column GENERATED ALWAYS refuses a chosen value by itself.
    perform roles_test.expect('an admin cannot choose a log entry''s id',
      roles_test.run($q$insert into public.admin_log (id, action, details, email) values (32000, 'roles_test chosen id', null, null)$q$)
        similar to '(ok 0|error 42501:%|error 428C9:%)',
      null);
  end if;
end
$$;
select roles_test.logout();

-- A signed-in admin whose token carries no email (a phone or anonymous sign-in).
select roles_test.login('vis');
select set_config('request.jwt.claims', json_build_object(
  'sub', roles_test.uid('vis'), 'role', 'authenticated', 'aud', 'authenticated')::text, true);
do $$
declare
  r text := roles_test.run($q$insert into public.admin_log (action, details, email) values ('roles_test no email', null, 'forged2@example.invalid')$q$);
begin
  -- Refused outright only if admin_log.email is NOT NULL in this project.
  perform roles_test.expect('an admin without an email in the JWT can still log',
    r = 'ok 1' or r like 'error 23502:%', r);
end
$$;
select roles_test.logout();

do $$
begin
  perform roles_test.expect('admin_log.email comes from the JWT, not from the client',
    (select l.email from public.admin_log l where l.action = 'roles_test by vis') = roles_test.email('vis'),
    (select l.email from public.admin_log l where l.action = 'roles_test by vis'));
  perform roles_test.expect('admin_log.email is never the client''s for a signed-in user, even without a JWT email',
    not exists (select 1 from public.admin_log l where l.action = 'roles_test no email' and l.email is not null),
    (select l.email from public.admin_log l where l.action = 'roles_test no email'));
  insert into public.admin_log (action, details, email) values ('roles_test no jwt', null, 'kept@example.invalid');
  perform roles_test.expect('admin_log.email is kept when there is no JWT (SQL editor)',
    (select l.email from public.admin_log l where l.action = 'roles_test no jwt') = 'kept@example.invalid',
    null);
end
$$;

select roles_test.login('logreader');
do $$
begin
  perform roles_test.expect('log.read: can read the log',
    roles_test.scalar($q$select count(*) from public.admin_log where action like 'roles_test%'$q$)::bigint >= 3,
    null);
  perform roles_test.deny('log.read: cannot clear the log without log.clear',
    $q$delete from public.admin_log where action like 'roles_test%'$q$);
  perform roles_test.deny('log.read: cannot edit log entries',
    $q$update public.admin_log set details = 'changed' where action like 'roles_test%'$q$);
end
$$;
select roles_test.logout();

select roles_test.login('super');
do $$
begin
  perform roles_test.deny('nobody can edit log entries, not even a super admin',
    $q$update public.admin_log set details = 'changed' where action like 'roles_test%'$q$);
end
$$;
select roles_test.logout();

select roles_test.login('logclearer');
do $$
begin
  perform roles_test.allow('log.clear: can clear the log',
    $q$delete from public.admin_log where action like 'roles_test%'$q$);
end
$$;
select roles_test.logout();

-- ── Super admin: everything ─────────────────────────────────────────────────
select roles_test.login('super');
do $$
begin
  perform roles_test.allow('super: can add a player',
    $q$insert into public.player_config (nickname, initial_rating, active) values ('roles_test_p2', 1000, true)$q$);
  perform roles_test.allow('super: can delete a player',
    $q$delete from public.player_config where nickname = 'roles_test_p2'$q$);
  perform roles_test.allow('super: can hide a player',
    $q$insert into public.hidden_players (nick) values ('roles_test_p1')$q$);
  perform roles_test.allow('super: can show a player',
    $q$delete from public.hidden_players where nick = 'roles_test_p1'$q$);
  perform roles_test.allow('super: can create an achievement',
    $q$insert into public.achievements (name, icon_url, url) values ('roles_test_ach3', 'https://example.invalid/3.png', null)$q$);
  perform roles_test.allow('super: can edit an achievement',
    $q$update public.achievements set url = 'https://example.invalid/3' where name = 'roles_test_ach3'$q$);
  perform roles_test.allow('super: can delete an achievement',
    $q$delete from public.achievements where name = 'roles_test_ach3'$q$);
  perform roles_test.allow('super: can assign an achievement',
    $q$insert into public.player_achievements (nick, achievement_id) select 'roles_test_p1', a.id from public.achievements a where a.name = 'roles_test_ach'$q$);
  perform roles_test.allow('super: can take an achievement away',
    $q$delete from public.player_achievements where nick = 'roles_test_p1'$q$);
  perform roles_test.allow('super: can edit rating groups',
    $q$update public.rating_groups set name = name where id = (select g.id from public.rating_groups g order by g.id limit 1)$q$);
  perform roles_test.allow('super: can save a monthly reset',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1000, '2000-03-01', 'monthly_reset')$q$);
  perform roles_test.allow('super: can add an adjustment',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1300, '2000-03-02', 'roles_test super')$q$);
  perform roles_test.allow('super: can delete resets and adjustments',
    $q$delete from public.rating_adjustments where nickname = 'roles_test_p1'$q$);
  perform roles_test.allow('super: can change the formula',
    $q$insert into public.settings (key, value) values ('WinMax', '3') on conflict (key) do update set value = excluded.value$q$);
  perform roles_test.allow('super: can add other settings',
    $q$insert into public.settings (key, value) values ('roles_test_other_key', '1')$q$);
  perform roles_test.allow('super: can change other settings',
    $q$update public.settings set value = '2' where key = 'roles_test_key'$q$);
  perform roles_test.allow('super: can delete other settings',
    $q$delete from public.settings where key in ('roles_test_key', 'roles_test_other_key')$q$);
  if roles_test.flag('matches_rows') then
    perform roles_test.allow('super: can change matches',
      $q$update public.matches set external_id = external_id where ctid = (select m.ctid from public.matches m limit 1)$q$);
  else
    raise notice 'SKIP super: can change matches (the table is empty)';
  end if;
  perform roles_test.allow('super: can write the log',
    $q$insert into public.admin_log (action, details, email) values ('roles_test by super', null, null)$q$);
  perform roles_test.allow('super: can read the log',
    $q$select 1 from public.admin_log where action = 'roles_test by super'$q$);
  perform roles_test.allow('super: can clear the log',
    $q$delete from public.admin_log where action = 'roles_test by super'$q$);
  perform roles_test.allow('super: can upload a player photo',
    $q$insert into storage.objects (bucket_id, name) values ('player-avatars', 'roles_test_avatar_4.png')$q$);
  perform roles_test.allow('super: can upload an achievement icon',
    $q$insert into storage.objects (bucket_id, name) values ('achievements', 'roles_test_icon_4.png')$q$);
  perform roles_test.allow('super: can create a role',
    $q$insert into public.roles (name) values ('roles_test by super')$q$);
  perform roles_test.allow('super: can grant any permission',
    $q$insert into public.role_permissions (role_id, permission_key) select roles_test.rid('roles_test by super'), p.key from public.permissions p$q$);
  perform roles_test.allow('super: can delete a role',
    $q$delete from public.roles where name = 'roles_test by super'$q$);
  perform roles_test.allow('super: can assign the super role',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh2'), roles_test.rid('Super admin'))$q$);
  perform roles_test.allow('super: can demote another super admin',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test empty') where user_id = roles_test.uid('fresh2')$q$);
  perform roles_test.allow('super: can remove a role',
    $q$delete from public.user_roles where user_id = roles_test.uid('fresh2')$q$);
  perform roles_test.deny('super: cannot change their own role',
    $q$update public.user_roles set role_id = roles_test.rid('roles_test empty') where user_id = roles_test.uid('super')$q$);
  perform roles_test.deny('super: cannot remove their own role',
    $q$delete from public.user_roles where user_id = roles_test.uid('super')$q$);
  perform roles_test.deny('super: cannot edit the super role',
    $q$update public.roles set description = 'changed' where is_super$q$);
  perform roles_test.deny('super: cannot delete the super role',
    $q$delete from public.roles where is_super$q$);
end
$$;
select roles_test.logout();

-- ── The last super admin (trigger; applies to the SQL editor too) ───────────
-- Removes every other super admin inside a block that undoes itself, then tries
-- to remove the one left.
do $$
begin
  begin
    delete from public.user_roles ur
    using public.roles r
    where r.id = ur.role_id and r.is_super and ur.user_id <> roles_test.uid('super');
    perform roles_test.expect('setup: one super admin left',
      (select count(*) from public.user_roles ur join public.roles r on r.id = ur.role_id where r.is_super) = 1,
      null);
    perform roles_test.expect_error('the last super admin''s role cannot be removed',
      format('delete from public.user_roles where user_id = %L', roles_test.uid('super')),
      'Cannot remove the last super admin');
    perform roles_test.expect_error('the last super admin cannot be given another role',
      format('update public.user_roles set role_id = %s where user_id = %L',
             roles_test.rid('roles_test empty'), roles_test.uid('super')),
      'Cannot remove the last super admin');
    perform roles_test.expect_error('the last super admin''s auth user cannot be deleted',
      format('delete from auth.users where id = %L', roles_test.uid('super')),
      'Cannot remove the last super admin');
    raise exception 'roles_test: undo';
  exception when raise_exception then
    if sqlerrm <> 'roles_test: undo' then
      raise;
    end if;
  end;
  perform roles_test.expect('the other super admins are back',
    (select count(*) from public.user_roles ur join public.roles r on r.id = ur.role_id where r.is_super) >= 2,
    null);
  perform roles_test.expect('the super role cannot be deleted from the SQL editor either',
    roles_test.run('delete from public.roles where is_super') like 'error 42501:%', null);
  perform roles_test.expect('is_super cannot change from the SQL editor either',
    roles_test.run($q$update public.roles set is_super = true where name = 'roles_test empty'$q$) like 'error 42501:%', null);
end
$$;

-- ── anon (the publishable key) cannot write anything ────────────────────────
select roles_test.login_anon();
do $$
begin
  perform roles_test.deny('anon: cannot add a player',
    $q$insert into public.player_config (nickname, initial_rating, active) values ('roles_test_anon', 1000, true)$q$);
  perform roles_test.deny('anon: cannot delete a player',
    $q$delete from public.player_config where nickname = 'roles_test_p1'$q$);
  perform roles_test.deny('anon: cannot hide a player',
    $q$insert into public.hidden_players (nick) values ('roles_test_p1')$q$);
  perform roles_test.deny('anon: cannot create an achievement',
    $q$insert into public.achievements (name, icon_url, url) values ('roles_test_anon', 'https://example.invalid/a.png', null)$q$);
  perform roles_test.deny('anon: cannot delete an achievement',
    $q$delete from public.achievements where name = 'roles_test_ach'$q$);
  perform roles_test.deny('anon: cannot assign an achievement',
    $q$insert into public.player_achievements (nick, achievement_id) select 'roles_test_p1', a.id from public.achievements a where a.name = 'roles_test_ach'$q$);
  perform roles_test.deny('anon: cannot add a rating group',
    $q$insert into public.rating_groups (name, min_rating, color, coef) values ('roles_test_anon', 0, '#000000', 1)$q$);
  perform roles_test.deny('anon: cannot change rating groups',
    $q$update public.rating_groups set name = name$q$);
  perform roles_test.deny('anon: cannot save a monthly reset',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1, '2000-04-01', 'monthly_reset')$q$);
  perform roles_test.deny('anon: cannot add an adjustment',
    $q$insert into public.rating_adjustments (nickname, new_rating, applied_date, reason) values ('roles_test_p1', 1, '2000-04-01', null)$q$);
  perform roles_test.deny('anon: cannot change the formula',
    $q$insert into public.settings (key, value) values ('WinMin', '3') on conflict (key) do update set value = excluded.value$q$);
  perform roles_test.deny('anon: cannot add settings',
    $q$insert into public.settings (key, value) values ('roles_test_anon', '1')$q$);
  perform roles_test.deny('anon: cannot add matches',
    $q$insert into public.matches default values$q$);
  perform roles_test.deny('anon: cannot write the log',
    $q$insert into public.admin_log (action, details, email) values ('roles_test by anon', null, null)$q$);
  perform roles_test.deny('anon: cannot clear the log',
    $q$delete from public.admin_log$q$);
  perform roles_test.deny('anon: cannot read the log',
    $q$select 1 from public.admin_log$q$);
  perform roles_test.deny('anon: cannot upload a player photo',
    $q$insert into storage.objects (bucket_id, name) values ('player-avatars', 'roles_test_anon.png')$q$);
  perform roles_test.deny('anon: cannot upload an achievement icon',
    $q$insert into storage.objects (bucket_id, name) values ('achievements', 'roles_test_anon.png')$q$);
  perform roles_test.deny('anon: cannot change the permission list',
    $q$insert into public.permissions (key, label) values ('roles_test.anon', 'x')$q$);
  perform roles_test.deny('anon: cannot read roles',
    $q$select 1 from public.roles$q$);
  perform roles_test.deny('anon: cannot create roles',
    $q$insert into public.roles (name) values ('roles_test by anon')$q$);
  perform roles_test.deny('anon: cannot grant permissions',
    $q$insert into public.role_permissions (role_id, permission_key) values (roles_test.rid('roles_test empty'), 'players.edit')$q$);
  perform roles_test.deny('anon: cannot assign roles',
    $q$insert into public.user_roles (user_id, role_id) values (roles_test.uid('fresh'), roles_test.rid('Super admin'))$q$);
  perform roles_test.deny('anon: cannot call my_access()',
    $q$select public.my_access()$q$);
  perform roles_test.expect('anon: is_admin() is false', not public.is_admin(), null);
end
$$;
select roles_test.logout();

rollback;

-- Reached only when every check above passed: the SQL editor stops at the first error
-- (in psql, use -v ON_ERROR_STOP=1). Placed after the rollback so it is the result shown.
select 'roles test: all checks passed' as result;
