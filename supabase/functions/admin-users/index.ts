/* admin-users: lets an admin with the users.manage permission list, create and delete
 * admin panel users and set their passwords. The admin panel calls it with
 * POST {SUPABASE_URL}/functions/v1/admin-users and the signed-in user's access token.
 * The actions, the permission rules and the error codes are in handler.js; this file
 * only wires the handler to Deno.serve and supabase-js:
 *   - a service-role client for the Auth admin API and for reading roles, role_permissions
 *     and user_roles (it bypasses RLS);
 *   - a caller client per request (anon key plus the caller's Authorization header) for
 *     my_access() and for the user_roles writes, so RLS and the last-super-admin trigger
 *     check those as the caller.
 * Env (set by Supabase): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
 * Deploy: supabase functions deploy admin-users --no-verify-jwt (see DEPLOY.md, step 3).
 * The flag turns off only the gateway's own JWT check, which rejects valid sign-ins on
 * projects with Supabase's new API keys, as this one has. The function still checks every
 * caller's token itself: verifyToken below (auth.getUser), then my_access() as the caller.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHandler } from "./handler.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const USERS_PER_PAGE = 1000; // Auth admin listUsers page size
const MAX_USER_PAGES = 50; // list at most 50 000 users
const ROWS_PER_PAGE = 1000; // user_roles rows per request (Supabase's default PostgREST max-rows)

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: NO_SESSION });

/** A client that talks to PostgREST as the user whose access token this is. */
function asCaller(token: string) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: NO_SESSION,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

type UpstreamError = { message?: string; status?: number; code?: string } | null | undefined;

/** An Auth or PostgREST error as a thrown Error carrying .status and .code (see handler.js). */
function upstream(error: UpstreamError, status?: number): Error {
  const e = new Error(error?.message || "Request failed") as Error & { status?: number; code?: string };
  e.status = error?.status ?? status;
  e.code = error?.code;
  return e;
}

type ListedUser = { id: string; email: string | null; created_at: string; last_sign_in_at: string | null };
type RoleRow = { id: number; is_super: boolean; role_permissions: { permission_key: string }[] | null };
type UserRoleRow = { user_id: string; role_id: number };

const handler = createHandler({
  async verifyToken(token: string) {
    const { data, error } = await admin.auth.getUser(token);
    if (error) {
      // 4xx: a malformed, expired or revoked token, or one whose user is gone.
      if (error.status !== undefined && [400, 401, 403, 404].includes(error.status)) return null;
      throw upstream(error);
    }
    return data.user ? { id: data.user.id } : null;
  },

  async getAccess(token: string) {
    const { data, error, status } = await asCaller(token).rpc("my_access");
    if (error) throw upstream(error, status);
    return data;
  },

  async getRole(roleId: number) {
    const { data, error, status } = await admin
      .from("roles")
      .select("id, is_super, role_permissions(permission_key)")
      .eq("id", roleId)
      .maybeSingle();
    if (error) throw upstream(error, status);
    const row = data as unknown as RoleRow | null;
    if (!row) return null;
    return {
      id: row.id,
      is_super: row.is_super === true,
      permissions: (row.role_permissions ?? []).map((rp) => rp.permission_key),
    };
  },

  async userRoles() {
    // Paged: PostgREST cuts a response at max-rows without saying so.
    const roles = new Map<string, number>();
    for (let from = 0; ; from += ROWS_PER_PAGE) {
      const { data, error, status } = await admin
        .from("user_roles")
        .select("user_id, role_id")
        .order("user_id")
        .range(from, from + ROWS_PER_PAGE - 1);
      if (error) throw upstream(error, status);
      const rows = (data ?? []) as unknown as UserRoleRow[];
      for (const r of rows) roles.set(r.user_id, r.role_id);
      if (rows.length < ROWS_PER_PAGE) return roles;
    }
  },

  async roleOf(userId: string) {
    const { data, error, status } = await admin
      .from("user_roles")
      .select("user_id, role_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw upstream(error, status);
    const row = data as unknown as UserRoleRow | null;
    return row ? row.role_id : null;
  },

  async listUsers() {
    const users: ListedUser[] = [];
    for (let page = 1; page <= MAX_USER_PAGES; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
      if (error) throw upstream(error);
      for (const u of data.users) {
        users.push({
          id: u.id,
          email: u.email ?? null,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
        });
      }
      if (data.users.length < USERS_PER_PAGE) break;
    }
    return users;
  },

  async getUser(userId: string) {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) {
      if (error.status === 404) return null;
      throw upstream(error);
    }
    return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
  },

  async createUser({ email, password }: { email: string; password: string }) {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw upstream(error);
    return { id: data.user.id, email: data.user.email ?? email };
  },

  async deleteUser(userId: string) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw upstream(error);
  },

  async setPassword(userId: string, password: string) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) throw upstream(error);
  },

  async assignRole(token: string, userId: string, roleId: number) {
    const { error, status } = await asCaller(token)
      .from("user_roles")
      .insert({ user_id: userId, role_id: roleId });
    if (error) throw upstream(error, status);
  },

  async removeRole(token: string, userId: string) {
    const { data, error, status } = await asCaller(token)
      .from("user_roles")
      .delete()
      .eq("user_id", userId)
      .select("user_id");
    if (error) throw upstream(error, status);
    return ((data ?? []) as unknown[]).length;
  },
});

Deno.serve(handler);
