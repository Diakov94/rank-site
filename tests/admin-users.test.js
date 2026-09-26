"use strict";
/* Tests for the admin-users Edge Function's logic (supabase/functions/admin-users/handler.js),
 * run against a fake backend that records every dependency call. The fake does not apply
 * RLS, so these tests show that the handler itself enforces each rule. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ROOT } = require("./helpers/load.js");

const HANDLER_PATH = path.join(ROOT, "supabase", "functions", "admin-users", "handler.js");

/* handler.js is an ES module, but package.json has no "type", so importing it by path makes
 * Node re-parse it as ESM with a warning (and fails before Node 20.19). A data: URL is always
 * ESM; the sourceURL comment keeps the file name in stack traces. handler.js has no imports. */
const handlerModule = import(
  "data:text/javascript;charset=utf-8," +
  encodeURIComponent(`${fs.readFileSync(HANDLER_PATH, "utf8")}\n//# sourceURL=${pathToFileURL(HANDLER_PATH).href}\n`)
);

const FUNCTION_URL = "https://project.supabase.co/functions/v1/admin-users";

const ALL_PERMISSIONS = [
  "players.edit", "players.visibility", "avatars.upload", "achievements.edit", "badges.assign",
  "groups.edit", "reset.run", "adjustments.edit", "formula.edit", "log.read", "log.clear",
  "users.manage",
];

const ROLE = { super: 1, manager: 2, editor: 3, auditor: 4, empty: 5 };

const uuid = (n) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`; // letters, so case matters
const ID = {
  super1: uuid(1),
  super2: uuid(2),
  manager: uuid(3),
  manager2: uuid(4),
  editor: uuid(5),
  auditor: uuid(6),
  nobody: uuid(7),
};
const TOKEN = Object.fromEntries(Object.keys(ID).map((key) => [key, `token-${key}`]));

const WRITES = ["createUser", "deleteUser", "setPassword", "assignRole", "removeRole"];

function upstreamError(message, fields) {
  return Object.assign(new Error(message), fields);
}

/* A backend with five roles and seven users. deps records every call in `calls`;
 * override(name, fn) replaces one dependency (the call is still recorded). */
function fakeBackend() {
  const roles = new Map([
    [ROLE.super, { id: ROLE.super, name: "Super admin", is_super: true, permissions: [] }],
    [ROLE.manager, { id: ROLE.manager, name: "Manager", is_super: false,
      permissions: ["users.manage", "players.edit", "players.visibility", "log.read"] }],
    [ROLE.editor, { id: ROLE.editor, name: "Editor", is_super: false, permissions: ["players.edit", "players.visibility"] }],
    [ROLE.auditor, { id: ROLE.auditor, name: "Auditor", is_super: false, permissions: ["log.read", "log.clear"] }],
    [ROLE.empty, { id: ROLE.empty, name: "Empty", is_super: false, permissions: [] }],
  ]);
  const users = new Map();
  const userRoles = new Map();
  const tokens = new Map();
  const add = (key, email, roleId, n) => {
    users.set(ID[key], {
      id: ID[key], email, password: `old-password-${key}`,
      created_at: `2026-09-0${n}T10:00:00Z`, last_sign_in_at: n % 2 ? `2026-09-2${n}T08:00:00Z` : null,
    });
    if (roleId !== null) userRoles.set(ID[key], roleId);
    tokens.set(TOKEN[key], ID[key]);
  };
  add("super1", "root@example.com", ROLE.super, 1);
  add("super2", "second-root@example.com", ROLE.super, 2);
  add("manager", "manager@example.com", ROLE.manager, 3);
  add("manager2", "Another.Manager@example.com", ROLE.manager, 4);
  add("editor", "editor@example.com", ROLE.editor, 5);
  add("auditor", "auditor@example.com", ROLE.auditor, 6);
  add("nobody", "signup@example.com", null, 7);

  let nextUser = 100;
  const impl = {
    async verifyToken(token) {
      const id = tokens.get(token);
      return id && users.has(id) ? { id } : null;
    },
    async getAccess(token) {
      const role = roles.get(userRoles.get(tokens.get(token)));
      if (!role) return { role: null, permissions: [] };
      return {
        role: { id: role.id, name: role.name, is_super: role.is_super },
        permissions: role.is_super ? [...ALL_PERMISSIONS] : [...role.permissions],
      };
    },
    async getRole(roleId) {
      const role = roles.get(roleId);
      return role ? { id: role.id, is_super: role.is_super, permissions: [...role.permissions] } : null;
    },
    async userRoles() {
      return new Map(userRoles);
    },
    async roleOf(userId) {
      return userRoles.get(userId) ?? null;
    },
    async listUsers() {
      return [...users.values()].map(({ id, email, created_at, last_sign_in_at }) => ({ id, email, created_at, last_sign_in_at }));
    },
    async getUser(id) {
      const user = users.get(id);
      return user ? { id: user.id, email: user.email } : null;
    },
    async createUser({ email, password }) {
      if ([...users.values()].some((u) => u.email === email)) {
        throw upstreamError("A user with this email address has already been registered", { status: 422, code: "email_exists" });
      }
      const id = uuid(nextUser++);
      users.set(id, { id, email, password, created_at: "2026-09-26T12:00:00Z", last_sign_in_at: null });
      return { id, email };
    },
    async deleteUser(id) {
      if (!users.delete(id)) throw upstreamError("User not found", { status: 404, code: "user_not_found" });
      userRoles.delete(id); // on delete cascade
    },
    async setPassword(id, password) {
      const user = users.get(id);
      if (!user) throw upstreamError("User not found", { status: 404, code: "user_not_found" });
      user.password = password;
    },
    async assignRole(_token, userId, roleId) {
      userRoles.set(userId, roleId);
    },
    async removeRole(_token, userId) {
      return userRoles.delete(userId) ? 1 : 0;
    },
  };

  const calls = [];
  const logged = [];
  const overrides = {};
  const deps = { logError: (e) => logged.push(e) };
  for (const name of Object.keys(impl)) {
    deps[name] = async (...args) => {
      calls.push({ name, args });
      return (overrides[name] || impl[name])(...args);
    };
  }
  return {
    deps, users, userRoles, calls, logged,
    override(name, fn) { overrides[name] = fn; },
    callsOf: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    names: () => calls.map((c) => c.name),
    writes: () => calls.filter((c) => WRITES.includes(c.name)).map((c) => c.name),
  };
}

async function setup() {
  const { createHandler } = await handlerModule;
  const backend = fakeBackend();
  return { backend, handle: createHandler(backend.deps) };
}

/* Sends one request. Options: method (POST), as (a key of TOKEN), authorization (the raw
 * header), body (sent as JSON), raw (the raw body). Every response must carry CORS headers. */
async function send(handle, { method = "POST", as, authorization, body, raw } = {}) {
  const headers = { apikey: "anon-key" };
  if (authorization !== undefined) headers.Authorization = authorization;
  else if (as) headers.Authorization = `Bearer ${TOKEN[as]}`;
  let payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  if (method === "GET" || method === "HEAD") payload = undefined;

  const res = await handle(new Request(FUNCTION_URL, { method, headers, body: payload }));
  assert.equal(res.headers.get("access-control-allow-origin"), "*", "CORS origin header");
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (method !== "OPTIONS") {
    assert.match(res.headers.get("content-type") || "", /^application\/json/);
    if (res.status !== 200) assert.ok(typeof json.error === "string" && json.error, `error message for ${res.status}`);
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

/* ================== CORS and methods ================== */
test("OPTIONS answers the CORS preflight without checking anything", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, { method: "OPTIONS" });
  assert.equal(res.status, 200);
  const methods = res.headers.get("access-control-allow-methods");
  assert.match(methods, /\bPOST\b/);
  assert.match(methods, /\bOPTIONS\b/);
  const allowed = res.headers.get("access-control-allow-headers").split(",").map((h) => h.trim().toLowerCase());
  for (const header of ["authorization", "apikey", "content-type", "x-client-info"]) assert.ok(allowed.includes(header), header);
  assert.deepEqual(backend.calls, []);
});

test("methods other than POST and OPTIONS get 405", async () => {
  const { backend, handle } = await setup();
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
    const res = await send(handle, { method, as: "super1", body: { action: "list" } });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
  }
  assert.deepEqual(backend.calls, []);
});

/* ================== Caller checks ================== */
test("a request without a bearer token gets 401", async () => {
  const { backend, handle } = await setup();
  for (const authorization of [undefined, "", "Basic dXNlcjpwYXNz", "Bearer", "Bearer   ", `Token ${TOKEN.super1}`]) {
    const res = await send(handle, { authorization, body: { action: "list" } });
    assert.equal(res.status, 401, String(authorization));
  }
  assert.deepEqual(backend.calls, []);
});

test("an invalid or expired token gets 401", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, { authorization: "Bearer not-a-real-token", body: { action: "list" } });
  assert.equal(res.status, 401);
  assert.deepEqual(backend.names(), ["verifyToken"]);

  backend.override("getAccess", async () => { throw upstreamError("JWT expired", { status: 401, code: "PGRST301" }); });
  const expired = await send(handle, { as: "super1", body: { action: "list" } });
  assert.equal(expired.status, 401);
  assert.equal(backend.callsOf("listUsers").length, 0);
});

test("a bearer token is read case-insensitively and passed on as it is", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, { authorization: `bearer ${TOKEN.super1}`, body: { action: "list" } });
  assert.equal(res.status, 200);
  assert.deepEqual(backend.callsOf("verifyToken"), [[TOKEN.super1]]);
  assert.deepEqual(backend.callsOf("getAccess"), [[TOKEN.super1]]);
});

test("a failing token or permission check is a 500, never a pass", async () => {
  const { backend, handle } = await setup();
  backend.override("verifyToken", async () => { throw new Error("auth server unreachable"); });
  const unverified = await send(handle, { as: "super1", body: { action: "list" } });
  assert.equal(unverified.status, 500);
  assert.equal(unverified.body.error, "Could not verify the access token");

  const other = await setup();
  other.backend.override("getAccess", async () => {
    throw upstreamError("Could not find the function public.my_access", { status: 404, code: "PGRST202" });
  });
  const unchecked = await send(other.handle, { as: "super1", body: { action: "list" } });
  assert.equal(unchecked.status, 500);
  assert.equal(unchecked.body.error, "Could not check your permissions");
  assert.equal(other.backend.callsOf("listUsers").length, 0);
  assert.equal(backend.logged.length + other.backend.logged.length, 2);
});

test("every action needs users.manage", async () => {
  const bodies = [
    { action: "list" },
    { action: "create", email: "new@example.com", password: "long-enough", role_id: ROLE.empty },
    { action: "delete", user_id: ID.nobody },
    { action: "set_password", user_id: ID.nobody, password: "long-enough" },
  ];
  for (const as of ["nobody", "editor", "auditor"]) {
    const { backend, handle } = await setup();
    for (const body of bodies) {
      const res = await send(handle, { as, body });
      assert.equal(res.status, 403, `${as} ${body.action}`);
      assert.equal(res.body.error, "You do not have permission to manage users");
    }
    assert.deepEqual([...new Set(backend.names())], ["verifyToken", "getAccess"]);
  }
});

test("permissions without a role count for nothing", async () => {
  const { backend, handle } = await setup();
  backend.override("getAccess", async () => ({ role: null, permissions: [...ALL_PERMISSIONS] }));
  const res = await send(handle, { as: "nobody", body: { action: "list" } });
  assert.equal(res.status, 403);
});

/* ================== Body ================== */
test("a body that is not a JSON object gets 400", async () => {
  const { backend, handle } = await setup();
  for (const raw of ["", "not json", "{", "[]", "null", "\"list\"", "42"]) {
    const res = await send(handle, { as: "super1", raw });
    assert.equal(res.status, 400, JSON.stringify(raw));
  }
  assert.deepEqual(backend.writes(), []);
});

test("an unknown action gets 400", async () => {
  const { backend, handle } = await setup();
  for (const action of [undefined, "", "drop", "LIST", "constructor", "__proto__", "toString", ["list"], 1]) {
    const res = await send(handle, { as: "super1", body: { action } });
    assert.equal(res.status, 400, String(action));
    assert.equal(res.body.error, "Unknown action");
  }
  assert.deepEqual(backend.writes(), []);
});

/* ================== list ================== */
test("list returns every Auth user with their role, by email", async () => {
  for (const as of ["super1", "manager"]) {
    const { backend, handle } = await setup();
    const res = await send(handle, { as, body: { action: "list" } });
    assert.equal(res.status, 200);
    const expected = [...backend.users.values()]
      .map((u) => ({
        id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
        role_id: backend.userRoles.get(u.id) ?? null,
      }))
      .sort((a, b) => (a.email.toLowerCase() < b.email.toLowerCase() ? -1 : 1));
    assert.deepEqual(res.body, { users: expected });
    assert.equal(res.body.users[0].email, "Another.Manager@example.com");
    assert.equal(res.body.users.find((u) => u.id === ID.nobody).role_id, null);
    assert.deepEqual(backend.writes(), []);
  }
});

/* ================== create ================== */
test("create makes a confirmed user and assigns the role with the caller's token", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, {
    as: "manager",
    body: { action: "create", email: "  new.editor@example.com ", password: "12345678", role_id: ROLE.editor },
  });
  assert.equal(res.status, 200);
  const { id } = res.body.user;
  assert.deepEqual(res.body, { user: { id, email: "new.editor@example.com", role_id: ROLE.editor } });
  assert.deepEqual(backend.callsOf("createUser"), [[{ email: "new.editor@example.com", password: "12345678" }]]);
  assert.deepEqual(backend.callsOf("assignRole"), [[TOKEN.manager, id, ROLE.editor]]);
  assert.deepEqual(backend.writes(), ["createUser", "assignRole"]);
  assert.equal(backend.users.get(id).password, "12345678");
  assert.equal(backend.userRoles.get(id), ROLE.editor);
});

test("create accepts role_id as a numeric string", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, {
    as: "super1", body: { action: "create", email: "x@example.com", password: "long-enough", role_id: "3" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role_id, 3);
  assert.equal(backend.callsOf("assignRole")[0][2], 3);
});

test("a super admin can create a user with any role, the super role included", async () => {
  const { backend, handle } = await setup();
  for (const [i, roleId] of Object.values(ROLE).entries()) {
    const res = await send(handle, {
      as: "super1", body: { action: "create", email: `user${i}@example.com`, password: "long-enough", role_id: roleId },
    });
    assert.equal(res.status, 200, `role ${roleId}`);
    assert.equal(backend.userRoles.get(res.body.user.id), roleId);
  }
});

test("create validates its input before creating anything", async () => {
  const { backend, handle } = await setup();
  const valid = { action: "create", email: "new@example.com", password: "long-enough", role_id: ROLE.editor };
  const cases = [
    { email: undefined }, { email: 42 }, { email: "" }, { email: "   " }, { email: "no-at-sign" },
    { email: "a@b" }, { email: "a b@example.com" }, { email: "@example.com" },
    { email: `${"a".repeat(250)}@example.com` },
    { password: undefined }, { password: "1234567" }, { password: 12345678 }, { password: "" },
    { role_id: undefined }, { role_id: null }, { role_id: 0 }, { role_id: -1 }, { role_id: 1.5 },
    { role_id: "x" }, { role_id: "3a" }, { role_id: "" }, { role_id: true }, { role_id: 2 ** 60 },
  ];
  for (const change of cases) {
    const res = await send(handle, { as: "super1", body: { ...valid, ...change } });
    assert.equal(res.status, 400, JSON.stringify(change));
  }
  assert.deepEqual(backend.writes(), []);
});

test("create refuses a role that does not exist", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, {
    as: "super1", body: { action: "create", email: "new@example.com", password: "long-enough", role_id: 99 },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Unknown role");
  assert.deepEqual(backend.writes(), []);
});

test("create refuses a role the caller cannot grant", async () => {
  const { backend, handle } = await setup();
  // The manager is not super, and lacks log.clear, which the auditor role has.
  for (const roleId of [ROLE.super, ROLE.auditor]) {
    const res = await send(handle, {
      as: "manager", body: { action: "create", email: "new@example.com", password: "long-enough", role_id: roleId },
    });
    assert.equal(res.status, 403, `role ${roleId}`);
    assert.equal(res.body.error, "You cannot grant this role");
  }
  assert.deepEqual(backend.writes(), []);

  // Roles whose permissions the manager all holds: its own and the empty one.
  for (const [i, roleId] of [ROLE.manager, ROLE.empty].entries()) {
    const res = await send(handle, {
      as: "manager", body: { action: "create", email: `ok${i}@example.com`, password: "long-enough", role_id: roleId },
    });
    assert.equal(res.status, 200, `role ${roleId}`);
  }
});

test("create answers 409 when the email is taken", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, {
    as: "super1", body: { action: "create", email: "editor@example.com", password: "long-enough", role_id: ROLE.editor },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "A user with this email already exists");
  assert.deepEqual(backend.writes(), ["createUser"]);

  // An older Auth server says it without an error code.
  backend.override("createUser", async () => { throw upstreamError("User already registered", { status: 422 }); });
  const legacy = await send(handle, {
    as: "super1", body: { action: "create", email: "other@example.com", password: "long-enough", role_id: ROLE.editor },
  });
  assert.equal(legacy.status, 409);
  assert.equal(backend.callsOf("assignRole").length, 0);
});

test("create passes Auth's refusal of the input on as 400", async () => {
  const { backend, handle } = await setup();
  backend.override("createUser", async () => {
    throw upstreamError("Password should contain at least one digit", { status: 422, code: "weak_password" });
  });
  const res = await send(handle, {
    as: "super1", body: { action: "create", email: "new@example.com", password: "long-enough", role_id: ROLE.editor },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Password should contain at least one digit");
  assert.equal(backend.callsOf("assignRole").length, 0);
});

test("create is a 500 when Auth returns no user", async () => {
  const { backend, handle } = await setup();
  backend.override("createUser", async () => ({}));
  const res = await send(handle, {
    as: "super1", body: { action: "create", email: "new@example.com", password: "long-enough", role_id: ROLE.editor },
  });
  assert.equal(res.status, 500);
  assert.equal(backend.callsOf("assignRole").length, 0);
});

test("a refused role assignment deletes the user just created", async () => {
  const cases = [
    [upstreamError('new row violates row-level security policy for table "user_roles"', { status: 403, code: "42501" }), 403, "You cannot grant this role"],
    [upstreamError("insert or update on table \"user_roles\" violates foreign key constraint", { status: 409, code: "23503" }), 400, "Unknown role"],
    [upstreamError("JWT expired", { status: 401, code: "PGRST301" }), 401, "Invalid or expired access token"],
    [upstreamError("connection reset", { status: 503 }), 500, "connection reset"],
  ];
  for (const [error, status, message] of cases) {
    const { backend, handle } = await setup();
    const before = new Map(backend.userRoles);
    backend.override("assignRole", async () => { throw error; });
    const res = await send(handle, {
      as: "manager", body: { action: "create", email: "new@example.com", password: "long-enough", role_id: ROLE.editor },
    });
    assert.equal(res.status, status, error.message);
    assert.equal(res.body.error, message);
    const [[createdId]] = backend.callsOf("deleteUser");
    assert.deepEqual(backend.writes(), ["createUser", "assignRole", "deleteUser"]);
    assert.equal(backend.users.has(createdId), false);
    assert.equal([...backend.users.values()].some((u) => u.email === "new@example.com"), false);
    assert.deepEqual(backend.userRoles, before);
    assert.equal(backend.logged.length, status === 500 ? 1 : 0);
  }
});

test("a failed rollback is a 500 that names the user left behind", async () => {
  const { backend, handle } = await setup();
  backend.override("assignRole", async () => { throw upstreamError("permission denied", { status: 403, code: "42501" }); });
  backend.override("deleteUser", async () => { throw upstreamError("Database error deleting user", { status: 500 }); });
  const res = await send(handle, {
    as: "manager", body: { action: "create", email: "orphan@example.com", password: "long-enough", role_id: ROLE.editor },
  });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /orphan@example\.com/);
  assert.match(res.body.error, /permission denied/);
  assert.match(res.body.error, /Database error deleting user/);
  assert.match(res.body.error, /Delete that user by hand/);
  assert.equal(backend.logged.length, 2);
});

/* ================== delete ================== */
test("delete removes the role as the caller, then deletes the user", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.editor } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(backend.writes(), ["removeRole", "deleteUser"]);
  assert.deepEqual(backend.callsOf("removeRole"), [[TOKEN.super1, ID.editor]]);
  assert.deepEqual(backend.callsOf("deleteUser"), [[ID.editor]]);
  assert.equal(backend.users.has(ID.editor), false);
});

test("delete accepts an upper-case user id", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.editor.toUpperCase() } });
  assert.equal(res.status, 200);
  assert.deepEqual(backend.callsOf("deleteUser"), [[ID.editor]]);
});

test("delete of a user without a role skips the role removal", async () => {
  const { backend, handle } = await setup();
  const res = await send(handle, { as: "manager", body: { action: "delete", user_id: ID.nobody } });
  assert.equal(res.status, 200);
  assert.deepEqual(backend.writes(), ["deleteUser"]);
  assert.equal(backend.users.has(ID.nobody), false);
});

test("a user can delete users whose role's permissions they all hold", async () => {
  const { backend, handle } = await setup();
  for (const userId of [ID.manager2, ID.editor]) {
    const res = await send(handle, { as: "manager", body: { action: "delete", user_id: userId } });
    assert.equal(res.status, 200, userId);
    assert.equal(backend.users.has(userId), false);
  }
  const res = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.super2 } });
  assert.equal(res.status, 200);
});

test("delete refuses a target whose role the caller cannot grant", async () => {
  const { backend, handle } = await setup();
  for (const userId of [ID.super1, ID.super2, ID.auditor]) {
    const res = await send(handle, { as: "manager", body: { action: "delete", user_id: userId } });
    assert.equal(res.status, 403, userId);
    assert.equal(res.body.error, "You cannot manage a user with this role");
    assert.ok(backend.users.has(userId));
  }
  assert.deepEqual(backend.writes(), []);
});

test("nobody can delete their own account", async () => {
  const { backend, handle } = await setup();
  for (const [as, userId] of [["super1", ID.super1], ["manager", ID.manager], ["manager", ID.manager.toUpperCase()]]) {
    const res = await send(handle, { as, body: { action: "delete", user_id: userId } });
    assert.equal(res.status, 403, `${as} ${userId}`);
    assert.equal(res.body.error, "You cannot delete your own account");
  }
  // Also when Auth resolves another spelling of the id to the caller.
  backend.override("getUser", async () => ({ id: ID.super1, email: "root@example.com" }));
  const res = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.editor } });
  assert.equal(res.status, 403);
  assert.deepEqual(backend.writes(), []);
  assert.ok(backend.users.has(ID.super1));
});

test("the target's role is read for that user, so a short full listing cannot hide it", async () => {
  const { backend, handle } = await setup();
  backend.override("userRoles", async () => new Map()); // e.g. a listing cut at max-rows
  for (const userId of [ID.super1, ID.auditor]) {
    const del = await send(handle, { as: "manager", body: { action: "delete", user_id: userId } });
    assert.equal(del.status, 403, `delete ${userId}`);
    const pw = await send(handle, { as: "manager", body: { action: "set_password", user_id: userId, password: "long-enough" } });
    assert.equal(pw.status, 403, `set_password ${userId}`);
  }
  assert.deepEqual(backend.callsOf("roleOf"), [[ID.super1], [ID.super1], [ID.auditor], [ID.auditor]]);
  assert.deepEqual(backend.writes(), []);

  backend.override("roleOf", async () => { throw new Error("user_roles unreachable"); });
  const failed = await send(handle, { as: "manager", body: { action: "set_password", user_id: ID.editor, password: "long-enough" } });
  assert.equal(failed.status, 500);
  assert.deepEqual(backend.writes(), []);
  assert.equal(backend.users.get(ID.editor).password, "old-password-editor");
});

test("delete validates user_id and answers 404 for an unknown user", async () => {
  const { backend, handle } = await setup();
  for (const user_id of [undefined, null, 42, "", "not-a-uuid", `${ID.editor}0`, ID.editor.replace(/.$/, "g")]) {
    const res = await send(handle, { as: "super1", body: { action: "delete", user_id } });
    assert.equal(res.status, 400, String(user_id));
  }
  const res = await send(handle, { as: "super1", body: { action: "delete", user_id: uuid(999) } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "User not found");
  assert.deepEqual(backend.writes(), []);
});

test("delete answers 409 when the database refuses to remove the last super admin", async () => {
  const { backend, handle } = await setup();
  backend.override("removeRole", async () => {
    throw upstreamError("Cannot remove the last super admin", { status: 400, code: "P0001" });
  });
  const res = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.super2 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "Cannot remove the last super admin");
  assert.deepEqual(backend.writes(), ["removeRole"]);
  assert.ok(backend.users.has(ID.super2));
});

test("delete stops when the policies refuse the role removal", async () => {
  const { backend, handle } = await setup();
  backend.override("removeRole", async () => 0); // RLS hid the row
  const hidden = await send(handle, { as: "manager", body: { action: "delete", user_id: ID.editor } });
  assert.equal(hidden.status, 403);

  backend.override("removeRole", async () => { throw upstreamError("permission denied for table user_roles", { status: 403, code: "42501" }); });
  const denied = await send(handle, { as: "manager", body: { action: "delete", user_id: ID.editor } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "You cannot manage a user with this role");
  assert.equal(backend.callsOf("deleteUser").length, 0);
  assert.ok(backend.users.has(ID.editor));
});

test("delete reports an Auth failure after the role was removed", async () => {
  const { backend, handle } = await setup();
  backend.override("deleteUser", async () => { throw upstreamError("Database error deleting user", { status: 500 }); });
  const res = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.editor } });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /role was removed/);
  assert.match(res.body.error, /Database error deleting user/);
  assert.equal(backend.logged.length, 1);

  backend.override("deleteUser", async () => { throw upstreamError("User not found", { status: 404, code: "user_not_found" }); });
  const gone = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.auditor } });
  assert.equal(gone.status, 404);

  backend.override("deleteUser", async () => { throw upstreamError("Database error deleting user", { status: 500 }); });
  const noRole = await send(handle, { as: "super1", body: { action: "delete", user_id: ID.nobody } });
  assert.equal(noRole.status, 500);
  assert.equal(noRole.body.error, "Database error deleting user");
});

/* ================== set_password ================== */
test("set_password sets a new password", async () => {
  const { backend, handle } = await setup();
  for (const userId of [ID.editor, ID.nobody]) {
    const res = await send(handle, { as: "manager", body: { action: "set_password", user_id: userId, password: "new-secret" } });
    assert.equal(res.status, 200, userId);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(backend.users.get(userId).password, "new-secret");
  }
  assert.deepEqual(backend.callsOf("setPassword"), [[ID.editor, "new-secret"], [ID.nobody, "new-secret"]]);
  assert.deepEqual(backend.writes(), ["setPassword", "setPassword"]);
});

test("set_password validates its input", async () => {
  const { backend, handle } = await setup();
  const cases = [
    { user_id: ID.editor, password: "1234567" },
    { user_id: ID.editor, password: undefined },
    { user_id: ID.editor, password: 123456789 },
    { user_id: "nope", password: "long-enough" },
    { password: "long-enough" },
  ];
  for (const body of cases) {
    const res = await send(handle, { as: "super1", body: { action: "set_password", ...body } });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(backend.writes(), []);
});

test("set_password refuses the caller, higher roles and unknown users", async () => {
  const { backend, handle } = await setup();
  const self = await send(handle, { as: "manager", body: { action: "set_password", user_id: ID.manager, password: "long-enough" } });
  assert.equal(self.status, 403);
  assert.equal(self.body.error, "You cannot set your own password here");
  for (const userId of [ID.super1, ID.auditor]) {
    const res = await send(handle, { as: "manager", body: { action: "set_password", user_id: userId, password: "long-enough" } });
    assert.equal(res.status, 403, userId);
    assert.equal(res.body.error, "You cannot manage a user with this role");
  }
  const unknown = await send(handle, { as: "super1", body: { action: "set_password", user_id: uuid(999), password: "long-enough" } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(backend.writes(), []);
  assert.equal(backend.users.get(ID.super1).password, "old-password-super1");
});

test("set_password passes Auth's refusal on", async () => {
  const { backend, handle } = await setup();
  backend.override("setPassword", async () => {
    throw upstreamError("Password is known to be weak and easy to guess", { status: 422, code: "weak_password" });
  });
  const weak = await send(handle, { as: "super1", body: { action: "set_password", user_id: ID.editor, password: "password" } });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, "Password is known to be weak and easy to guess");

  backend.override("setPassword", async () => { throw upstreamError("User not found", { status: 404, code: "user_not_found" }); });
  const gone = await send(handle, { as: "super1", body: { action: "set_password", user_id: ID.editor, password: "long-enough" } });
  assert.equal(gone.status, 404);
});

/* ================== Unexpected failures ================== */
test("an unexpected failure is a logged 500 with CORS headers", async () => {
  const { backend, handle } = await setup();
  const boom = new Error("boom");
  backend.override("listUsers", async () => { throw boom; });
  const res = await send(handle, { as: "super1", body: { action: "list" } });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "boom" });
  assert.deepEqual(backend.logged, [boom]);
});
