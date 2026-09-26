-- ============================================================================
-- ESportsBattle Rank: roles and permissions for the admin panel
--
-- What it does
--   * Adds a fixed list of permissions (public.permissions), roles made of those
--     permissions (public.roles, public.role_permissions) and one role per admin
--     user (public.user_roles). One seeded role, "Super admin" (is_super), has
--     every permission; it cannot be edited or deleted, and no other role can be
--     super.
--   * Adds helper functions in the schema `private`, which the API does not expose:
--     private.is_staff(), private.is_super(), private.has_permission(key) and
--     private.can_grant_role(role_id). They only describe the caller.
--   * Adds public.my_access() (POST /rest/v1/rpc/my_access), which returns the
--     caller's role and permission keys, and redefines public.is_admin() as "the
--     caller has a role".
--   * Replaces the "any admin may write" policies of
--     20260926000000_admin_only_writes.sql with per-permission policies on the site
--     tables, admin_log and the two storage buckets. Reads stay public as before.
--     Writes are checked by permissive AND restrictive policies, so an old "allow
--     all" policy cannot let anyone else write.
--   * Only the super admin creates, edits and deletes roles and chooses their
--     permissions; that is not a permission anyone else can be given.
--   * Anti-escalation: a users manager can only assign roles all of whose
--     permissions they hold (super: any role), nobody changes their own role, and
--     the last super admin cannot be removed.
--   * Copies public.admin_users (the admin list of the first migration), if it
--     exists, into user_roles with the Super admin role. This runs only while
--     user_roles is empty, so running the file again never brings back an admin
--     you removed.
--   esb-sync uses the service role, which bypasses RLS (triggers still run).
--   admin-users uses it only for the Auth admin API and for reads; it writes
--   user_roles with the caller's token, so these policies check those writes.
--
-- How to apply
--   Paste this file into the Supabase SQL editor and run it, or run
--   `supabase db push`. It is idempotent and works whether or not the first
--   migration has been applied. A site table that does not exist yet is skipped
--   with a warning; run the file again after creating it. Do not run the first
--   migration again after this one (it would bring back its admin_users checks);
--   if you did, run this one again.
--
-- How to add a super admin by email (the user must exist under
-- Authentication > Users)
--   insert into public.user_roles (user_id, role_id)
--   select u.id, r.id
--   from auth.users u, public.roles r
--   where u.email = 'admin@example.com' and r.is_super
--   on conflict (user_id) do update set role_id = excluded.role_id;
--
-- Test it with supabase/tests/roles_test.sql (it rolls itself back).
-- ============================================================================

begin;

-- ── Schema for the helper functions ─────────────────────────────────────────
-- `private` is not in the API's exposed schemas, so these functions cannot be
-- called over REST. The API roles need USAGE and EXECUTE because RLS policies
-- run with the caller's privileges.
create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

-- ── Tables ──────────────────────────────────────────────────────────────────
create table if not exists public.permissions (
  key         text primary key,
  label       text not null,
  description text not null default '',
  sort        int  not null default 0
);

create table if not exists public.roles (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  description text not null default '',
  is_super    boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint roles_name_not_blank check (btrim(name) <> '')
);

-- At most one super role (the seeded one).
create unique index if not exists roles_one_super on public.roles (is_super) where is_super;

-- The super role has no rows here: it has every permission.
create table if not exists public.role_permissions (
  role_id        bigint not null references public.roles (id) on delete cascade,
  permission_key text   not null references public.permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);

-- One role per user. A role that is still assigned cannot be deleted (restrict).
create table if not exists public.user_roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role_id     bigint not null references public.roles (id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by uuid default auth.uid()
);

create index if not exists user_roles_role_id on public.user_roles (role_id);

alter table public.permissions      enable row level security;
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles       enable row level security;

-- The API reaches these tables only as a signed-in user, and RLS decides the rest.
-- The permission list is fixed: nobody changes it over the API.
revoke all on table public.permissions, public.roles, public.role_permissions, public.user_roles
  from anon, authenticated;
grant select on table public.permissions to authenticated;
grant select, insert, update, delete
  on table public.roles, public.role_permissions, public.user_roles to authenticated;
grant all on table public.permissions, public.roles, public.role_permissions, public.user_roles
  to service_role;

-- ── Seed: permissions and the super role ────────────────────────────────────
insert into public.permissions (key, label, description, sort) values
  ('players.edit',       'Add and delete players',                'Add players to the rating and delete them.',                      10),
  ('players.visibility', 'Hide and show players',                 'Hide players on the public page and show them again.',            20),
  ('avatars.upload',     'Upload player photos',                  'Upload and replace player photos.',                               30),
  ('achievements.edit',  'Create, edit and delete achievements',  'Manage achievements and their icons.',                            40),
  ('badges.assign',      'Assign achievements to players',        'Give achievements to players and take them away.',                50),
  ('groups.edit',        'Edit rating groups',                    'Change the name, minimum rating, colour and coefficient of groups.', 60),
  ('reset.run',          'Save monthly resets',                   'Save the starting ratings of a monthly reset.',                   70),
  ('adjustments.edit',   'Add and delete rating adjustments',     'Set a player''s rating from a chosen date (not a monthly reset).', 80),
  ('formula.edit',       'Edit the rating formula',               'Change the points for wins and draws (WinMin, WinMax, DrawMin, DrawMax).', 90),
  ('log.read',           'Read the activity log',                 'See who changed what in the admin panel.',                       100),
  ('log.clear',          'Clear the activity log',                'Delete every entry of the activity log.',                        110),
  ('users.manage',       'Create and delete users, assign roles', 'Create admin accounts, set their passwords and roles, delete them.', 120)
on conflict (key) do update
  set label = excluded.label, description = excluded.description, sort = excluded.sort;

-- Creating and editing roles is for the super admin only, so it is not a permission that
-- can be handed out. Drop it if an earlier version of this file seeded it (its
-- role_permissions rows go with it).
delete from public.permissions where key = 'roles.manage';

insert into public.roles (name, description, is_super)
select 'Super admin', 'Every permission. This role cannot be edited or deleted.', true
where not exists (select 1 from public.roles where is_super);

-- ── Access helpers (private) ────────────────────────────────────────────────
-- SECURITY DEFINER: they read user_roles and role_permissions, which the caller may
-- not be able to read, and RLS policies on those tables call them without
-- recursion. search_path is empty, so every name is schema-qualified.

-- The caller has a role in the admin panel.
create or replace function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_roles ur where ur.user_id = auth.uid());
$$;

-- The caller has the super role.
create or replace function private.is_super()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.is_super
  );
$$;

-- The caller's role includes permission `p` (the super role includes every one).
create or replace function private.has_permission(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and (
        r.is_super
        or exists (
          select 1 from public.role_permissions rp
          where rp.role_id = r.id and rp.permission_key = has_permission.p
        )
      )
  );
$$;

-- The caller may give role `role_id` to someone (or take it away): a super admin
-- may give any role; anyone else only a role that is not super and whose every
-- permission the caller holds.
create or replace function private.can_grant_role(role_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_super() then true
    else exists (
      select 1
      from public.roles r
      where r.id = can_grant_role.role_id
        and not r.is_super
        and not exists (
          select 1 from public.role_permissions rp
          where rp.role_id = r.id and not private.has_permission(rp.permission_key)
        )
    )
  end;
$$;

grant execute on function
  private.is_staff(), private.is_super(), private.has_permission(text), private.can_grant_role(bigint)
  to anon, authenticated, service_role;

-- ── API functions ───────────────────────────────────────────────────────────
-- POST /rest/v1/rpc/my_access with the user's token:
--   {"role": {"id": 1, "name": "Super admin", "is_super": true} | null,
--    "permissions": ["players.edit", ...]}   (the super role: every key)
create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'role', (
      select jsonb_build_object('id', r.id, 'name', r.name, 'is_super', r.is_super)
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.user_id = auth.uid()
    ),
    'permissions', coalesce((
      select jsonb_agg(p.key order by p.sort, p.key)
      from public.permissions p
      where private.has_permission(p.key)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated, service_role;

-- Kept for older front ends (POST /rest/v1/rpc/is_admin): "has a role".
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_staff();
$$;

grant execute on function public.is_admin() to anon, authenticated, service_role;

-- ── Triggers ────────────────────────────────────────────────────────────────
-- roles: the super role cannot be deleted and is_super never changes, even from
-- the SQL editor. (RLS already keeps API users away from the super role.)
create or replace function private.roles_protect_super()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_super then
      raise exception 'The super admin role cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.is_super is distinct from old.is_super then
    raise exception 'is_super cannot be changed' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists esb_roles_protect_super on public.roles;
create trigger esb_roles_protect_super
  before update or delete on public.roles
  for each row execute function private.roles_protect_super();

-- user_roles: record who assigned the role and when (the caller, not a value the
-- client sends; from the SQL editor, where there is no caller, the value given).
create or replace function private.user_roles_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.role_id is not distinct from old.role_id and new.user_id is not distinct from old.user_id then
      new.assigned_at := old.assigned_at;
      new.assigned_by := old.assigned_by;
      return new;
    end if;
  end if;
  new.assigned_at := now();
  new.assigned_by := coalesce(auth.uid(), new.assigned_by);
  return new;
end
$$;

drop trigger if exists esb_user_roles_stamp on public.user_roles;
create trigger esb_user_roles_stamp
  before insert or update on public.user_roles
  for each row execute function private.user_roles_stamp();

-- user_roles: an update or delete that leaves nobody with the super role fails.
-- This also blocks deleting the last super admin's auth user (the cascade deletes
-- their user_roles row). AFTER ... FOR EACH ROW sees the whole statement's result.
-- SQLSTATE PT409 makes PostgREST answer HTTP 409.
create or replace function private.user_roles_keep_super()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.roles r where r.id = old.role_id and r.is_super)
     and not exists (
       select 1
       from public.user_roles ur
       join public.roles r on r.id = ur.role_id
       where r.is_super
     )
  then
    raise exception 'Cannot remove the last super admin' using errcode = 'PT409';
  end if;
  return null;
end
$$;

drop trigger if exists esb_user_roles_keep_super on public.user_roles;
create trigger esb_user_roles_keep_super
  after update or delete on public.user_roles
  for each row execute function private.user_roles_keep_super();

-- admin_log: for a signed-in user the entry's email is the one in their JWT, whatever
-- the client sent; a token without an email (a phone or anonymous sign-in given a
-- role) leaves it empty rather than taking the client's. Without a signed-in user (SQL
-- editor, service role) the value given is kept.
create or replace function private.admin_log_set_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.email := nullif(auth.jwt() ->> 'email', '');
  end if;
  return new;
end
$$;

-- ── Bootstrap: admins of the first migration become super admins ────────────
do $$
declare
  super_role bigint;
  copied     bigint;
begin
  if to_regclass('public.admin_users') is null then
    raise notice 'public.admin_users does not exist: no admins copied. Add a super admin by email (see the top of this file).';
    return;
  end if;
  if exists (select 1 from public.user_roles) then
    raise notice 'user_roles already has rows: public.admin_users not copied again.';
    return;
  end if;
  select id into super_role from public.roles where is_super;
  execute 'insert into public.user_roles (user_id, role_id) '
       || 'select a.user_id, $1 from public.admin_users a on conflict (user_id) do nothing'
    using super_role;
  get diagnostics copied = row_count;
  raise notice 'Copied % admin(s) from public.admin_users into user_roles as Super admin.', copied;
end
$$;

-- ── Policies: roles tables ──────────────────────────────────────────────────
-- Every admin (anyone with a role) can read the permission list and the roles.
drop policy if exists esb_staff_read on public.permissions;
create policy esb_staff_read on public.permissions
  as permissive for select to authenticated
  using ((select private.is_staff()));

drop policy if exists esb_staff_read on public.roles;
create policy esb_staff_read on public.roles
  as permissive for select to authenticated
  using ((select private.is_staff()));

-- Roles: only the super admin creates, edits and deletes roles, and never the super
-- role itself (no role can become super either).
drop policy if exists esb_roles_insert on public.roles;
create policy esb_roles_insert on public.roles
  as permissive for insert to authenticated
  with check ((select private.is_super()) and not is_super);

drop policy if exists esb_roles_update on public.roles;
create policy esb_roles_update on public.roles
  as permissive for update to authenticated
  using ((select private.is_super()) and not is_super)
  with check ((select private.is_super()) and not is_super);

drop policy if exists esb_roles_delete on public.roles;
create policy esb_roles_delete on public.roles
  as permissive for delete to authenticated
  using ((select private.is_super()) and not is_super);

-- Role permissions: only the super admin chooses them, and never for the super role,
-- which has every permission without rows.
drop policy if exists esb_staff_read on public.role_permissions;
create policy esb_staff_read on public.role_permissions
  as permissive for select to authenticated
  using ((select private.is_staff()));

drop policy if exists esb_role_permissions_insert on public.role_permissions;
create policy esb_role_permissions_insert on public.role_permissions
  as permissive for insert to authenticated
  with check (
    (select private.is_super())
    and not exists (
      select 1 from public.roles r
      where r.id = role_permissions.role_id and r.is_super
    )
  );

drop policy if exists esb_role_permissions_delete on public.role_permissions;
create policy esb_role_permissions_delete on public.role_permissions
  as permissive for delete to authenticated
  using ((select private.is_super()));

-- User roles: you can read your own row; users.manage reads all. Assigning, changing
-- and removing a role needs users.manage, is never about your own row, and needs
-- private.can_grant_role() for the new role and (update, delete) the old one.
drop policy if exists esb_user_roles_read on public.user_roles;
create policy esb_user_roles_read on public.user_roles
  as permissive for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_permission('users.manage')));

drop policy if exists esb_user_roles_insert on public.user_roles;
create policy esb_user_roles_insert on public.user_roles
  as permissive for insert to authenticated
  with check (
    (select private.has_permission('users.manage'))
    and user_id <> (select auth.uid())
    and private.can_grant_role(role_id)
  );

drop policy if exists esb_user_roles_update on public.user_roles;
create policy esb_user_roles_update on public.user_roles
  as permissive for update to authenticated
  using (
    (select private.has_permission('users.manage'))
    and user_id <> (select auth.uid())
    and private.can_grant_role(role_id)
  )
  with check (
    (select private.has_permission('users.manage'))
    and user_id <> (select auth.uid())
    and private.can_grant_role(role_id)
  );

drop policy if exists esb_user_roles_delete on public.user_roles;
create policy esb_user_roles_delete on public.user_roles
  as permissive for delete to authenticated
  using (
    (select private.has_permission('users.manage'))
    and user_id <> (select auth.uid())
    and private.can_grant_role(role_id)
  );

-- ── Policies: site tables ───────────────────────────────────────────────────
-- Anyone reads (esb_public_read, as in the first migration). Writes need the
-- table's permission, checked on the new row (insert, update) and the old row
-- (update, delete):
--   player_config        players.edit
--   hidden_players       players.visibility
--   achievements         achievements.edit
--   player_achievements  badges.assign
--   rating_groups        groups.edit
--   rating_adjustments   reason = 'monthly_reset': reset.run; any other reason
--                        (or none): adjustments.edit
--   settings             WinMin, WinMax, DrawMin, DrawMax: formula.edit; any other
--                        key: super admin (esb-sync's cursor uses the service role)
--   matches              super admin (esb-sync uses the service role)
-- The first migration's esb_admin_* write policies are dropped.
do $$
declare
  rec record;
  pol text;
begin
  for rec in
    select v.tbl, v.check_expr
    from (values
      ('player_config',       $e$(select private.has_permission('players.edit'))$e$),
      ('hidden_players',      $e$(select private.has_permission('players.visibility'))$e$),
      ('achievements',        $e$(select private.has_permission('achievements.edit'))$e$),
      ('player_achievements', $e$(select private.has_permission('badges.assign'))$e$),
      ('rating_groups',       $e$(select private.has_permission('groups.edit'))$e$),
      ('rating_adjustments',  $e$(case when reason = 'monthly_reset' then (select private.has_permission('reset.run')) else (select private.has_permission('adjustments.edit')) end)$e$),
      ('settings',            $e$(case when key in ('WinMin', 'WinMax', 'DrawMin', 'DrawMax') then (select private.has_permission('formula.edit')) else (select private.is_super()) end)$e$),
      ('matches',             $e$(select private.is_super())$e$)
    ) as v (tbl, check_expr)
  loop
    if to_regclass(format('public.%I', rec.tbl)) is null then
      raise warning 'public.% does not exist, skipped; run this migration again after creating it', rec.tbl;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', rec.tbl);

    execute format('drop policy if exists esb_public_read on public.%I', rec.tbl);
    execute format('create policy esb_public_read on public.%I as permissive for select to anon, authenticated using (true)', rec.tbl);

    foreach pol in array array[
      'esb_admin_insert', 'esb_admin_update', 'esb_admin_delete',
      'esb_admin_only_insert', 'esb_admin_only_update', 'esb_admin_only_delete'
    ] loop
      execute format('drop policy if exists %I on public.%I', pol, rec.tbl);
    end loop;

    -- Permissive: what a signed-in user with the permission may do.
    execute format('drop policy if exists esb_perm_insert on public.%I', rec.tbl);
    execute format('create policy esb_perm_insert on public.%I as permissive for insert to authenticated with check (%s)', rec.tbl, rec.check_expr);

    execute format('drop policy if exists esb_perm_update on public.%I', rec.tbl);
    execute format('create policy esb_perm_update on public.%I as permissive for update to authenticated using (%s) with check (%s)', rec.tbl, rec.check_expr, rec.check_expr);

    execute format('drop policy if exists esb_perm_delete on public.%I', rec.tbl);
    execute format('create policy esb_perm_delete on public.%I as permissive for delete to authenticated using (%s)', rec.tbl, rec.check_expr);

    -- Restrictive: must also pass, whatever other permissive policies exist.
    execute format('drop policy if exists esb_perm_only_insert on public.%I', rec.tbl);
    execute format('create policy esb_perm_only_insert on public.%I as restrictive for insert to public with check (%s)', rec.tbl, rec.check_expr);

    execute format('drop policy if exists esb_perm_only_update on public.%I', rec.tbl);
    execute format('create policy esb_perm_only_update on public.%I as restrictive for update to public using (%s) with check (%s)', rec.tbl, rec.check_expr, rec.check_expr);

    execute format('drop policy if exists esb_perm_only_delete on public.%I', rec.tbl);
    execute format('create policy esb_perm_only_delete on public.%I as restrictive for delete to public using (%s)', rec.tbl, rec.check_expr);
  end loop;
end
$$;

-- ── Policies: admin_log ─────────────────────────────────────────────────────
-- Read: log.read. Add: any admin. Delete: log.clear (Postgres deletes only rows the
-- caller can read, so clearing also needs log.read). Update: nobody.
-- The API may insert every column except id and created_at, which keep their
-- defaults: an admin cannot backdate an entry, date it in the future to stay on top of
-- the Log tab, or take ids the sequence hands out later (so later entries would fail).
do $$
declare
  pol  text;
  cols text;
begin
  if to_regclass('public.admin_log') is null then
    raise warning 'public.admin_log does not exist, skipped; run this migration again after creating it';
    return;
  end if;

  alter table public.admin_log enable row level security;

  -- Revoking the table privilege also drops earlier column grants, so this reruns cleanly.
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
    into cols
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'admin_log'
    and c.column_name not in ('id', 'created_at');
  revoke insert on table public.admin_log from anon, authenticated;
  if cols is not null then
    execute format('grant insert (%s) on table public.admin_log to authenticated', cols);
  end if;

  foreach pol in array array[
    'esb_admin_read', 'esb_admin_insert', 'esb_admin_delete',
    'esb_admin_only_select', 'esb_admin_only_insert', 'esb_admin_only_update', 'esb_admin_only_delete'
  ] loop
    execute format('drop policy if exists %I on public.admin_log', pol);
  end loop;

  drop policy if exists esb_perm_select on public.admin_log;
  create policy esb_perm_select on public.admin_log
    as permissive for select to authenticated
    using ((select private.has_permission('log.read')));

  drop policy if exists esb_perm_insert on public.admin_log;
  create policy esb_perm_insert on public.admin_log
    as permissive for insert to authenticated
    with check ((select private.is_staff()));

  drop policy if exists esb_perm_delete on public.admin_log;
  create policy esb_perm_delete on public.admin_log
    as permissive for delete to authenticated
    using ((select private.has_permission('log.clear')));

  drop policy if exists esb_perm_only_select on public.admin_log;
  create policy esb_perm_only_select on public.admin_log
    as restrictive for select to public
    using ((select private.has_permission('log.read')));

  drop policy if exists esb_perm_only_insert on public.admin_log;
  create policy esb_perm_only_insert on public.admin_log
    as restrictive for insert to public
    with check ((select private.is_staff()));

  drop policy if exists esb_perm_only_update on public.admin_log;
  create policy esb_perm_only_update on public.admin_log
    as restrictive for update to public
    using (false)
    with check (false);

  drop policy if exists esb_perm_only_delete on public.admin_log;
  create policy esb_perm_only_delete on public.admin_log
    as restrictive for delete to public
    using ((select private.has_permission('log.clear')));

  drop trigger if exists esb_admin_log_email on public.admin_log;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'admin_log' and column_name = 'email'
  ) then
    create trigger esb_admin_log_email
      before insert on public.admin_log
      for each row execute function private.admin_log_set_email();
  else
    raise warning 'public.admin_log has no email column: entries are not stamped with the signed-in email';
  end if;
end
$$;

-- ── Policies: storage ───────────────────────────────────────────────────────
-- player-avatars needs avatars.upload, achievements needs achievements.edit.
-- SELECT is included because uploads with x-upsert: true read the existing object.
-- Public URLs (/storage/v1/object/public/...) need no policy; other buckets are
-- untouched.
do $$
declare
  pol text;
  -- The caller may write this object (permissive policies).
  allowed constant text := $e$((bucket_id = 'player-avatars' and (select private.has_permission('avatars.upload'))) or (bucket_id = 'achievements' and (select private.has_permission('achievements.edit'))))$e$;
  -- The object is in another bucket, or the caller may write it (restrictive policies).
  guarded constant text := format('(bucket_id not in (%L, %L) or %s)', 'player-avatars', 'achievements', allowed);
begin
  foreach pol in array array[
    'esb_admin_read', 'esb_admin_insert', 'esb_admin_update', 'esb_admin_delete',
    'esb_admin_only_insert', 'esb_admin_only_update', 'esb_admin_only_delete'
  ] loop
    execute format('drop policy if exists %I on storage.objects', pol);
  end loop;

  drop policy if exists esb_perm_select on storage.objects;
  execute format('create policy esb_perm_select on storage.objects as permissive for select to authenticated using %s', allowed);

  drop policy if exists esb_perm_insert on storage.objects;
  execute format('create policy esb_perm_insert on storage.objects as permissive for insert to authenticated with check %s', allowed);

  drop policy if exists esb_perm_update on storage.objects;
  execute format('create policy esb_perm_update on storage.objects as permissive for update to authenticated using %s with check %s', allowed, allowed);

  drop policy if exists esb_perm_delete on storage.objects;
  execute format('create policy esb_perm_delete on storage.objects as permissive for delete to authenticated using %s', allowed);

  drop policy if exists esb_perm_only_insert on storage.objects;
  execute format('create policy esb_perm_only_insert on storage.objects as restrictive for insert to public with check %s', guarded);

  drop policy if exists esb_perm_only_update on storage.objects;
  execute format('create policy esb_perm_only_update on storage.objects as restrictive for update to public using %s with check %s', guarded, guarded);

  drop policy if exists esb_perm_only_delete on storage.objects;
  execute format('create policy esb_perm_only_delete on storage.objects as restrictive for delete to public using %s', guarded);
end
$$;

-- Make PostgREST see my_access() right away.
notify pgrst, 'reload schema';

commit;
