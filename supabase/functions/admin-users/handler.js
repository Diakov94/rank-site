/* admin-users: the logic of the admin-users Edge Function. index.ts wires it to Deno.serve
 * and supabase-js; tests/admin-users.test.js runs it in Node with fake dependencies. Plain
 * JavaScript ES module with no imports: everything it talks to is injected.
 *
 * Request: POST, JSON body, header `Authorization: Bearer <user access token>` (plus the
 * `apikey` header the Supabase gateway wants). Every action needs the caller's
 * users.manage permission.
 *   {action: "list"}
 *     -> 200 {users: [{id, email, created_at, last_sign_in_at, role_id}]} (every Auth
 *        user, by email; role_id is null for a user without a role)
 *   {action: "create", email, password, role_id}
 *     -> 200 {user: {id, email, role_id}}. Creates a confirmed user, then assigns the
 *        role as the caller, so the user_roles policies check it again. When that
 *        assignment fails, the new user is deleted and the assignment's error returned.
 *   {action: "delete", user_id} -> 200 {ok: true}
 *     Removes the target's role as the caller (policies and the last-super-admin trigger
 *     apply), then deletes the Auth user.
 *   {action: "set_password", user_id, password} -> 200 {ok: true}
 * Rules (the database enforces the role writes again):
 *   - the caller may grant a role when they are super, or the role is not super and they
 *     hold every permission of it (private.can_grant_role);
 *   - create needs a role the caller may grant;
 *   - delete and set_password never target the caller, and a target that has a role
 *     needs a role the caller may grant;
 *   - passwords have at least MIN_PASSWORD_LENGTH characters.
 * Errors: {error: "..."} with 400 bad input, 401 missing or invalid token, 403 missing
 * permission, 404 unknown user, 405 method, 409 email taken or last super admin, 500
 * anything else. Checked in that order: method, token, users.manage, body, action rules.
 * Every response carries the CORS headers; OPTIONS answers the preflight.
 *
 * Dependencies (all async; a failure throws an Error that may carry .status, the
 * upstream HTTP status, and .code, the upstream error code from Auth, PostgREST or
 * Postgres):
 *   verifyToken(token)               -> {id} of the token's Auth user, or null when the
 *                                       token is invalid or expired
 *   getAccess(token)                 -> the caller's my_access():
 *                                       {role: {id, name, is_super} | null, permissions: [key]}
 *   getRole(roleId)                  -> {id, is_super, permissions: [key]}, or null
 *   userRoles()                      -> Map(user_id -> role_id) of every user_roles row
 *   roleOf(userId)                   -> role_id of that user's user_roles row, or null
 *   listUsers()                      -> [{id, email, created_at, last_sign_in_at}]
 *   getUser(userId)                  -> {id, email}, or null when there is no such user
 *   createUser({email, password})    -> {id, email} of a new, confirmed user
 *   deleteUser(userId)
 *   setPassword(userId, password)
 *   assignRole(token, userId, roleId)   inserts the user_roles row as the caller
 *   removeRole(token, userId)        -> number of user_roles rows deleted as the caller
 *   logError(error)                  optional, for 500s (default console.error)
 */

const MIN_PASSWORD_LENGTH = 8;

const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

const NO_USERS_MANAGE = "You do not have permission to manage users";
const CANNOT_GRANT = "You cannot grant this role";
const CANNOT_MANAGE_TARGET = "You cannot manage a user with this role";
const LAST_SUPER = "Cannot remove the last super admin";
const USER_NOT_FOUND = "User not found";
const INVALID_TOKEN = "Invalid or expired access token";

/* An error whose status and message go to the client as they are. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  });
}

function messageOf(e) {
  if (e instanceof Error) return e.message;
  if (e && typeof e.message === "string") return e.message;
  return String(e);
}

/* The token of an `Authorization: Bearer <token>` header, or null. */
function bearerToken(req) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") || "");
  return match ? match[1] : null;
}

/* The caller's my_access() answer as checks. No role means no permission at all. */
function accessOf(raw) {
  const role = raw && typeof raw.role === "object" && raw.role !== null ? raw.role : null;
  const isSuper = role !== null && role.is_super === true;
  const held = new Set(raw && Array.isArray(raw.permissions) ? raw.permissions : []);
  return {
    isStaff: role !== null,
    isSuper,
    has: (key) => role !== null && (isSuper || held.has(key)),
  };
}

/* private.can_grant_role: a super admin grants any role; anyone else only a role that is
 * not super and whose every permission they hold. An unknown role cannot be granted. */
function canGrant(access, role) {
  if (!access.isStaff || !role) return false;
  if (access.isSuper) return true;
  return role.is_super !== true &&
    Array.isArray(role.permissions) &&
    role.permissions.every((key) => access.has(key));
}

async function readBody(req) {
  let body;
  try {
    body = JSON.parse(await req.text());
  } catch {
    throw new HttpError(400, "The body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "The body must be a JSON object");
  }
  return body;
}

function parseEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) {
    throw new HttpError(400, "Enter a valid email address");
  }
  return email;
}

function parsePassword(value) {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return value;
}

function parseRoleId(value) {
  const id = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "role_id must be a positive integer");
  return id;
}

/* A user id in the lower-case form Auth uses, so it compares equal to the caller's id. */
function parseUserId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, "user_id must be a user id (UUID)");
  return value.toLowerCase();
}

/* A failed user_roles write as the caller, as the error to return. `forbidden` is the 403
 * message for a write the policies refused. Anything unrecognised stays a 500. */
function roleWriteError(e, forbidden) {
  if (e && e.code === "PT409") return new HttpError(409, LAST_SUPER); // the last-super-admin trigger
  const code = e && e.code;
  const status = e && e.status;
  if (status === 401) return new HttpError(401, INVALID_TOKEN);
  if (code === "42501" || status === 403) return new HttpError(403, forbidden);
  if (code === "23503") return new HttpError(400, "Unknown role");
  if (code === "23505") return new HttpError(409, "The user already has a role");
  return e;
}

/* A failed Auth admin call (create user, set password), as the error to return. */
function authError(e) {
  const code = e && e.code;
  const status = e && e.status;
  if (code === "email_exists" || code === "user_already_exists" ||
      (status === 422 && /already (been )?registered|already exists/i.test(messageOf(e)))) {
    return new HttpError(409, "A user with this email already exists");
  }
  if (status === 404 || code === "user_not_found") return new HttpError(404, USER_NOT_FOUND);
  if (status === 400 || status === 422) return new HttpError(400, messageOf(e)); // e.g. a weak password
  return e;
}

function byEmail(a, b) {
  const x = String(a.email ?? "").toLowerCase();
  const y = String(b.email ?? "").toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createHandler(deps) {
  const logError = deps.logError || ((e) => console.error(e));

  /* The caller: {token, id, access}. Throws 401, 403 or a wrapped 500. */
  async function authorize(req) {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, "Missing access token");

    let user;
    try {
      user = await deps.verifyToken(token);
    } catch (e) {
      logError(e);
      throw new HttpError(500, "Could not verify the access token");
    }
    if (!user || typeof user.id !== "string" || !user.id) throw new HttpError(401, INVALID_TOKEN);

    let access;
    try {
      access = accessOf(await deps.getAccess(token));
    } catch (e) {
      if (e && e.status === 401) throw new HttpError(401, INVALID_TOKEN);
      logError(e);
      throw new HttpError(500, "Could not check your permissions");
    }
    if (!access.has("users.manage")) throw new HttpError(403, NO_USERS_MANAGE);
    return { token, id: user.id.toLowerCase(), access };
  }

  /* The user a delete or set_password acts on: {id, roleId}. Refuses the caller
   * themselves, an unknown user and a user whose role the caller may not grant. The role
   * is read for this one user: set_password has no database check behind it, so a row
   * missing from a truncated full listing must never pass as "no role". */
  async function targetOf(caller, userId, selfMessage) {
    const user = await deps.getUser(userId);
    if (!user) throw new HttpError(404, USER_NOT_FOUND);
    const id = String(user.id).toLowerCase();
    if (id === caller.id) throw new HttpError(403, selfMessage);

    const roleId = (await deps.roleOf(id)) ?? null;
    if (roleId !== null && !canGrant(caller.access, await deps.getRole(roleId))) {
      throw new HttpError(403, CANNOT_MANAGE_TARGET);
    }
    return { id, roleId };
  }

  async function listUsers() {
    const [users, roles] = await Promise.all([deps.listUsers(), deps.userRoles()]);
    return {
      users: users
        .map((u) => ({
          id: u.id,
          email: u.email ?? null,
          created_at: u.created_at ?? null,
          last_sign_in_at: u.last_sign_in_at ?? null,
          role_id: roles.get(u.id) ?? null,
        }))
        .sort(byEmail),
    };
  }

  async function createUser(caller, body) {
    const email = parseEmail(body.email);
    const password = parsePassword(body.password);
    const roleId = parseRoleId(body.role_id);
    const role = await deps.getRole(roleId);
    if (!role) throw new HttpError(400, "Unknown role");
    if (!canGrant(caller.access, role)) throw new HttpError(403, CANNOT_GRANT);

    let user;
    try {
      user = await deps.createUser({ email, password });
    } catch (e) {
      throw authError(e);
    }
    if (!user || typeof user.id !== "string" || !user.id) throw new Error("Auth returned no user id for the new user");

    try {
      await deps.assignRole(caller.token, user.id, roleId);
    } catch (e) {
      try {
        await deps.deleteUser(user.id);
      } catch (rollbackError) {
        logError(e);
        logError(rollbackError);
        throw new HttpError(500,
          `The role could not be assigned (${messageOf(e)}), and the new user ${user.email ?? email} ` +
          `could not be deleted (${messageOf(rollbackError)}). Delete that user by hand.`);
      }
      throw roleWriteError(e, CANNOT_GRANT);
    }
    return { user: { id: user.id, email: user.email ?? email, role_id: roleId } };
  }

  async function deleteUser(caller, body) {
    const target = await targetOf(caller, parseUserId(body.user_id), "You cannot delete your own account");

    if (target.roleId !== null) {
      let removed;
      try {
        removed = await deps.removeRole(caller.token, target.id);
      } catch (e) {
        throw roleWriteError(e, CANNOT_MANAGE_TARGET);
      }
      if (!removed) throw new HttpError(403, CANNOT_MANAGE_TARGET); // the policies hid the row
    }

    try {
      await deps.deleteUser(target.id);
    } catch (e) {
      if (e && (e.status === 404 || e.code === "user_not_found")) throw new HttpError(404, USER_NOT_FOUND);
      if (target.roleId === null) throw e;
      throw new Error(`The user's role was removed, but the user could not be deleted: ${messageOf(e)}`, { cause: e });
    }
    return { ok: true };
  }

  async function setPassword(caller, body) {
    const userId = parseUserId(body.user_id);
    const password = parsePassword(body.password);
    const target = await targetOf(caller, userId, "You cannot set your own password here");
    try {
      await deps.setPassword(target.id, password);
    } catch (e) {
      throw authError(e);
    }
    return { ok: true };
  }

  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    if (req.method !== "POST") return json(405, { error: "Method not allowed" }, { Allow: "POST, OPTIONS" });

    try {
      const caller = await authorize(req);
      const body = await readBody(req);
      switch (body.action) {
        case "list": return json(200, await listUsers());
        case "create": return json(200, await createUser(caller, body));
        case "delete": return json(200, await deleteUser(caller, body));
        case "set_password": return json(200, await setPassword(caller, body));
        default: throw new HttpError(400, "Unknown action");
      }
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      logError(e);
      return json(500, { error: messageOf(e) || "Internal error" });
    }
  };
}
