-- ============================================================================
-- ESportsBattle Rank: everyone can read, only admins can write
--
-- What it does
--   * Creates public.admin_users, the list of Supabase Auth users who are admins,
--     and public.is_admin(), which says whether the caller is one of them.
--   * Site tables (player_config, rating_adjustments, settings, rating_groups,
--     hidden_players, achievements, player_achievements, matches): RLS on, anyone
--     can SELECT, and INSERT/UPDATE/DELETE need a signed-in admin.
--   * admin_log: only admins can read, add or delete entries.
--   * Storage buckets player-avatars and achievements: only admins can upload,
--     replace or delete objects. Public URLs (/storage/v1/object/public/...) keep
--     working without a policy because both buckets are public.
--   Writes are also blocked by RESTRICTIVE policies, so an older permissive
--   "allow all" policy can no longer let the publishable (anon) key write. This
--   migration does not drop policies it did not create; you may remove old ones by
--   hand once everything works.
--   The esb-sync edge function uses the service role, which bypasses RLS.
--
-- How to apply
--   Paste this file into the Supabase SQL editor and run it, or run
--   `supabase db push` from the repository root. It is idempotent: running it again
--   recreates the same policies. A table in public that does not exist yet is
--   skipped with a warning; run the file again after creating it.
--
-- Rollout: this migration alone is not a deployable state. The current admin panel
--   needs 20260927000000_roles.sql (public.my_access()) and cannot sign in without it.
--   Follow DEPLOY.md: apply both migrations, make yourself super admin, then publish
--   the site. The old front end's admin panel writes with the publishable key, so its
--   writes stop working as soon as this migration runs; the public page keeps working
--   throughout.
--
-- How to add an admin: once the roles migration has run, add admins to
--   public.user_roles as shown in that file's header or DEPLOY.md, step 2. The roles
--   migration reads admin_users only once, while user_roles is empty.
--
-- Disabling public sign-ups (Authentication > Sign In / Providers > Allow new users to
-- sign up) is recommended but not required: every write checks admin_users (after the
-- roles migration, the permissions of the caller's role), so a self-registered user
-- cannot write anything.
-- ============================================================================

begin;

-- ── Admin list ──────────────────────────────────────────────────────────────
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- RLS on with no policies: the API roles can neither read nor change this table.
-- Manage it from the SQL editor or with the service role, which bypass RLS.
alter table public.admin_users enable row level security;

-- SECURITY DEFINER so it can read admin_users, which the caller cannot.
-- 20260927000000_roles.sql redefines it as "the caller has a role"; the current admin
-- panel calls public.my_access() instead.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- ── Site tables: anyone reads, admins write ─────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'player_config', 'rating_adjustments', 'settings', 'rating_groups',
    'hidden_players', 'achievements', 'player_achievements', 'matches'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      raise warning 'public.% does not exist, skipped; run this migration again after creating it', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- Permissive: what each role may do.
    execute format('drop policy if exists esb_public_read on public.%I', t);
    execute format('create policy esb_public_read on public.%I as permissive for select to anon, authenticated using (true)', t);

    execute format('drop policy if exists esb_admin_insert on public.%I', t);
    execute format('create policy esb_admin_insert on public.%I as permissive for insert to authenticated with check ((select public.is_admin()))', t);

    execute format('drop policy if exists esb_admin_update on public.%I', t);
    execute format('create policy esb_admin_update on public.%I as permissive for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);

    execute format('drop policy if exists esb_admin_delete on public.%I', t);
    execute format('create policy esb_admin_delete on public.%I as permissive for delete to authenticated using ((select public.is_admin()))', t);

    -- Restrictive: must also pass, whatever other permissive policies exist.
    execute format('drop policy if exists esb_admin_only_insert on public.%I', t);
    execute format('create policy esb_admin_only_insert on public.%I as restrictive for insert to public with check ((select public.is_admin()))', t);

    execute format('drop policy if exists esb_admin_only_update on public.%I', t);
    execute format('create policy esb_admin_only_update on public.%I as restrictive for update to public using ((select public.is_admin())) with check ((select public.is_admin()))', t);

    execute format('drop policy if exists esb_admin_only_delete on public.%I', t);
    execute format('create policy esb_admin_only_delete on public.%I as restrictive for delete to public using ((select public.is_admin()))', t);
  end loop;
end
$$;

-- ── admin_log: admins only ──────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.admin_log') is null then
    raise warning 'public.admin_log does not exist, skipped; run this migration again after creating it';
    return;
  end if;

  alter table public.admin_log enable row level security;

  drop policy if exists esb_admin_read on public.admin_log;
  create policy esb_admin_read on public.admin_log
    as permissive for select to authenticated
    using ((select public.is_admin()));

  drop policy if exists esb_admin_insert on public.admin_log;
  create policy esb_admin_insert on public.admin_log
    as permissive for insert to authenticated
    with check ((select public.is_admin()));

  drop policy if exists esb_admin_delete on public.admin_log;
  create policy esb_admin_delete on public.admin_log
    as permissive for delete to authenticated
    using ((select public.is_admin()));

  drop policy if exists esb_admin_only_select on public.admin_log;
  create policy esb_admin_only_select on public.admin_log
    as restrictive for select to public
    using ((select public.is_admin()));

  drop policy if exists esb_admin_only_insert on public.admin_log;
  create policy esb_admin_only_insert on public.admin_log
    as restrictive for insert to public
    with check ((select public.is_admin()));

  drop policy if exists esb_admin_only_update on public.admin_log;
  create policy esb_admin_only_update on public.admin_log
    as restrictive for update to public
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

  drop policy if exists esb_admin_only_delete on public.admin_log;
  create policy esb_admin_only_delete on public.admin_log
    as restrictive for delete to public
    using ((select public.is_admin()));
end
$$;

-- ── Storage: admins upload, replace and delete in the two site buckets ──────
-- RLS is already enabled on storage.objects by Supabase; other buckets are untouched.

-- Uploads with x-upsert: true also need SELECT on the existing object.
drop policy if exists esb_admin_read on storage.objects;
create policy esb_admin_read on storage.objects
  as permissive for select to authenticated
  using (bucket_id in ('player-avatars', 'achievements') and (select public.is_admin()));

drop policy if exists esb_admin_insert on storage.objects;
create policy esb_admin_insert on storage.objects
  as permissive for insert to authenticated
  with check (bucket_id in ('player-avatars', 'achievements') and (select public.is_admin()));

drop policy if exists esb_admin_update on storage.objects;
create policy esb_admin_update on storage.objects
  as permissive for update to authenticated
  using (bucket_id in ('player-avatars', 'achievements') and (select public.is_admin()))
  with check (bucket_id in ('player-avatars', 'achievements') and (select public.is_admin()));

drop policy if exists esb_admin_delete on storage.objects;
create policy esb_admin_delete on storage.objects
  as permissive for delete to authenticated
  using (bucket_id in ('player-avatars', 'achievements') and (select public.is_admin()));

drop policy if exists esb_admin_only_insert on storage.objects;
create policy esb_admin_only_insert on storage.objects
  as restrictive for insert to public
  with check (bucket_id not in ('player-avatars', 'achievements') or (select public.is_admin()));

drop policy if exists esb_admin_only_update on storage.objects;
create policy esb_admin_only_update on storage.objects
  as restrictive for update to public
  using (bucket_id not in ('player-avatars', 'achievements') or (select public.is_admin()))
  with check (bucket_id not in ('player-avatars', 'achievements') or (select public.is_admin()));

drop policy if exists esb_admin_only_delete on storage.objects;
create policy esb_admin_only_delete on storage.objects
  as restrictive for delete to public
  using (bucket_id not in ('player-avatars', 'achievements') or (select public.is_admin()));

commit;
