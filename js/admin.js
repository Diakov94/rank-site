/* ============================================================
 * ESportsBattle Admin Panel — Supabase edition
 * Uses SUPABASE, ADMIN_SESSION_KEY, sbHeaders and the helpers in common.js,
 * and buildRatings / normalizeGroups from engine.js.
 * ============================================================ */
"use strict";

/* ===== State ===== */
const st = {
  players: [],
  hiddenNicks: new Set(),
  searchQuery: "",
  achievements: [],
  playerAchievements: {},
  openPickerNick: null,
  currentTab: "players",
  session: null,       // { access_token, refresh_token, expires_at, email, user_id }
  groups: [],          // normalized rating groups from the engine, sorted by min desc
  loadErrors: {},      // read failures of loadAdminData, by source
  avatarVersions: {},  // nick -> version, set after an avatar upload in this session
  resetSaving: false,
  access: null,        // what the account may do, from fetchAccess(); null outside the panel
  users: [],           // Users tab: [{ id, email, created_at, last_sign_in_at, role_id }]
  userRoleData: null,  // Users tab: loadRoleData() result, null while it loads
  roleData: null,      // Roles tab: loadRoleData() result
  roleUserCounts: null, // Roles tab: Map role id -> number of users, null until the tab loads
  creatingUser: false,
};

/* ===== DOM refs ===== */
const loginSection  = document.getElementById("loginSection");
const panelSection  = document.getElementById("panelSection");
const emailInput    = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const loginBtn      = document.getElementById("loginBtn");
const loginError    = document.getElementById("loginError");
const logoutBtn     = document.getElementById("logoutBtn");
const playerList    = document.getElementById("playerList");
const totalVisible  = document.getElementById("totalVisible");
const totalHidden   = document.getElementById("totalHidden");
const adminSearch   = document.getElementById("adminSearch");

/* ===== Session (Supabase Auth) =====
 * The session lives in localStorage[ADMIN_SESSION_KEY]. Every admin request sends its
 * access token; the database policies decide what the account may do. */
var SESSION_EXPIRED_MSG = "Session expired. Log in again.";
var OTHER_ACCOUNT_MSG = "You signed in as another account in another tab. Log in again.";
var refreshInFlight = null;

/* `fallback` ({ email, user_id }) fills what the auth response leaves out. */
function sessionFromAuth(data, fallback) {
  var now = Math.floor(Date.now() / 1000);
  var expiresAt = Number(data.expires_at);
  if (!Number.isFinite(expiresAt)) expiresAt = now + (Number(data.expires_in) || 3600);
  fallback = fallback || {};
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    email: (data.user && data.user.email) || fallback.email || "",
    user_id: (data.user && data.user.id) || fallback.user_id || "",
  };
}

function readStoredSession() {
  try {
    var s = JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY) || "null");
    return s && s.access_token && s.refresh_token && s.user_id ? s : null;
  } catch (e) {
    return null;
  }
}

function storeSession(s) {
  st.session = s;
  try { localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(s)); }
  catch (e) { console.warn("Could not store the admin session:", e); }
}

function clearSession() {
  st.session = null;
  try { localStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) { /* storage unavailable */ }
}

/* The logged-in admin's email, or null without a session. */
function adminEmail() {
  return (st.session && st.session.email) || null;
}

/* Whether `a` and `b` ({ user_id }, such as two sessions) belong to the same user. */
function sameSessionUser(a, b) {
  return !!a.user_id && a.user_id === b.user_id;
}

/* A valid access token, refreshed first when it expires within a minute. */
async function getAccessToken() {
  if (!st.session) throw new Error("Not logged in.");
  var stored = readStoredSession();
  if (stored && !sameSessionUser(stored, st.session)) {
    /* Another tab signed in as someone else, so this tab's session is gone. Only this tab
     * forgets it: the stored session is the other tab's. */
    st.session = null;
    showLoginScreen(OTHER_ACCOUNT_MSG);
    throw new Error(OTHER_ACCOUNT_MSG);
  }
  /* Another tab may already have refreshed (and so rotated) the session. */
  if (stored && Number(stored.expires_at) > Number(st.session.expires_at)) st.session = stored;
  if (!(Number(st.session.expires_at) - 60 > Math.floor(Date.now() / 1000))) return refreshSession();
  return st.session.access_token;
}

/* POST /auth/v1/token for `grantType`; data is the parsed JSON body, or null. */
async function requestAuthToken(grantType, payload) {
  var res = await fetch(SUPABASE.URL + "/auth/v1/token?grant_type=" + grantType, {
    method: "POST",
    headers: { apikey: SUPABASE.KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  var data = await res.json().catch(function() { return null; });
  return { res: res, data: data };
}

/* Single flight: concurrent callers share one refresh request. When the auth server rejects
 * the refresh token, the session ends and the login screen comes back. */
function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = (async function() {
      var current = st.session;
      if (!current) throw new Error("Not logged in.");
      var auth = await requestAuthToken("refresh_token", { refresh_token: current.refresh_token });
      var res = auth.res, data = auth.data;
      /* Signed out, logged in again or adopted from another tab meanwhile: keep that state
       * instead of ending or overwriting it with the result for the old session. */
      if (st.session !== current) {
        if (!st.session) throw new Error("Not logged in.");
        return st.session.access_token;
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        sessionExpired();
        throw new Error(SESSION_EXPIRED_MSG);
      }
      if (!res.ok || !data || !data.access_token) throw new Error("Session refresh failed: HTTP " + res.status);
      storeSession(sessionFromAuth(data, current));
      return st.session.access_token;
    })().finally(function() { refreshInFlight = null; });
  }
  return refreshInFlight;
}

function sessionExpired() {
  clearSession();
  showLoginScreen(SESSION_EXPIRED_MSG);
}

/* Leaves the panel for the login screen, which shows `message`. */
function showLoginScreen(message) {
  st.access = null;
  clearTypedPasswords();
  closeAchievementPicker();
  toggleLoadingOverlay("adminLoadingOverlay", false);
  panelSection.style.display = "none";
  loginSection.style.display = "";
  showLoginError(message);
}

/* ===== Supabase requests =====
 * The one helper for every admin REST, Storage and Edge Function call, reads and writes.
 * `path` starts with /rest/v1/, /storage/v1/ or /functions/v1/. opts: method, body (sent as
 * JSON), raw + contentType (a file upload), prefer (Prefer header), headers, mustMatch (for
 * deletes and updates that must hit a row: sends Prefer: return=representation and throws
 * "Not found or not permitted", with .notMatched, when no row comes back). A 401 refreshes
 * the token once and retries.
 * Throws an Error with .status, .body (the parsed JSON error body, or null) and .code (its
 * PostgREST code, if any) on a non-2xx response; returns parsed JSON, or null for an empty
 * body. */
var ADMIN_PATH_PREFIX = /^\/(rest|storage|functions)\/v1\//;

async function adminRequest(path, opts) {
  if (!ADMIN_PATH_PREFIX.test(path)) throw new Error("adminRequest: unsupported path " + path);
  opts = opts || {};
  var extra = Object.assign({}, opts.headers);
  var body;
  if (opts.raw !== undefined) {
    body = opts.raw;
    extra["Content-Type"] = opts.contentType || "application/octet-stream";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    extra["Content-Type"] = "application/json";
  }
  if (opts.mustMatch) extra.Prefer = "return=representation";
  else if (opts.prefer) extra.Prefer = opts.prefer;

  function send(token) {
    return fetch(SUPABASE.URL + path, { method: opts.method || "GET", headers: sbHeaders(token, extra), body: body });
  }

  var res = await send(await getAccessToken());
  if (res.status === 401) {
    res = await send(await refreshSession());
    /* A fresh token that an Edge Function still refuses was rejected by the function
     * gateway's own JWT check, not because the session ended: report it, stay signed in. */
    if (res.status === 401 && path.indexOf("/functions/v1/") === 0) {
      var gatewayText = await res.text();
      throw Object.assign(new Error(
        "The server function rejected your sign-in (" + (gatewayText || "HTTP 401") + "). " +
        "Deploy it with --no-verify-jwt, see DEPLOY.md."
      ), { status: 401 });
    }
    if (res.status === 401) {
      sessionExpired();
      throw Object.assign(new Error(SESSION_EXPIRED_MSG), { status: 401 });
    }
  }
  var text = await res.text();
  var result = null;
  if (text) {
    try { result = JSON.parse(text); } catch (e) { result = text; }
  }
  if (!res.ok) {
    var errBody = result && typeof result === "object" ? result : null;
    throw Object.assign(new Error("HTTP " + res.status + (text ? ": " + text : "")), {
      status: res.status,
      body: errBody,
      code: errBody && typeof errBody.code === "string" ? errBody.code : undefined,
    });
  }
  if (opts.mustMatch && (!Array.isArray(result) || !result.length)) {
    throw Object.assign(new Error("Not found or not permitted"), { notMatched: true });
  }
  return result;
}

/* Every row of a table, read with the admin's token and paged like the public reads. */
function adminRows(table, select, order) {
  return sbFetchAll(table, select, order, function(path) { return adminRequest("/rest/v1/" + path); });
}

/* A .catch handler that rethrows the error with `prefix` before its message, keeping the
 * details refusalText() reads. */
function rethrowAs(prefix) {
  return function(e) {
    throw Object.assign(new Error(prefix + e.message), { status: e.status, body: e.body, code: e.code, notMatched: e.notMatched });
  };
}

/* ===== Request errors ===== */
function errorBody(err) {
  return err && err.body && typeof err.body === "object" ? err.body : {};
}

/* The server's own explanation: PostgREST's or Storage's message, else the admin-users
 * function's { error }. */
function serverMessage(err) {
  var body = errorBody(err);
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.error === "string" && body.error) return body.error;
  return "";
}

/* A refusal by the database policies or the admin-users function: HTTP 403, PostgREST's
 * insufficient_privilege (42501), or Storage's row-level security error (which some Storage
 * versions send with HTTP 400 and statusCode "403" in the body). */
function isPermissionError(err) {
  if (!err) return false;
  var body = errorBody(err);
  return err.status === 403 || body.code === "42501" || String(body.statusCode) === "403" ||
    /row-level security/i.test(serverMessage(err));
}

/* Clear text for the refusals a role runs into, or "" for any other failure: the last super
 * admin, a missing permission (`action` completes "You don't have permission to …"), or an
 * update or delete that reached no row the policies let through. */
function refusalText(err, action) {
  if (/last super admin/i.test(serverMessage(err))) return "Cannot remove the last super admin.";
  if (isPermissionError(err)) {
    /* The admin-users function explains its refusals in { error } ("You cannot grant this
     * role"); the database's own text, and one that only repeats "no permission", add nothing. */
    var body = errorBody(err);
    var detail = typeof body.error === "string" && !body.message && !/permission|row-level security/i.test(body.error) ? body.error.trim() : "";
    return "You don't have permission to " + action + "." + (detail ? " " + detail + (/[.!?]$/.test(detail) ? "" : ".") : "");
  }
  if (err && err.notMatched) return "Nothing was changed: it no longer exists, or you don't have permission to " + action + ".";
  return "";
}

/* Readable text for a failed request of the Users and Roles tabs. `conflict` is the text for
 * HTTP 409 (a duplicate, or a row still in use) when it is not about the last super admin. */
function errorText(err, action, conflict) {
  return refusalText(err, action) ||
    (conflict && err && err.status === 409 ? conflict : "") ||
    serverMessage(err) || (err && err.message) || String(err);
}

/* ===== Auth ===== */
var loginPending = false;
var panelEntered = false; // the panel was opened on this page (set by enterPanel)

async function tryLogin() {
  if (loginPending) return;
  loginError.textContent = "";

  var email    = emailInput ? emailInput.value.trim() : "";
  var password = passwordInput.value;

  if (!email || !password) {
    showLoginError("Enter email and password.");
    return;
  }

  loginPending = true;
  st.access = null;
  loginBtn.disabled = true;
  loginBtn.textContent = "Checking…";
  var reloading = false;
  try {
    var auth = await requestAuthToken("password", { email: email, password: password });
    var res = auth.res, data = auth.data;
    if (!res.ok || !data || !data.access_token) {
      showLoginError("Invalid email or password.");
      return;
    }
    storeSession(sessionFromAuth(data, { email: email }));
    if (!(await verifyAccess(function() { return false; }))) return;
    passwordInput.value = "";
    /* After a session ended in an open panel, the page still holds the previous account's
     * data (users, roles, log). Start from a clean page instead: it resumes the session just
     * stored and checks its access again. Without storage the session would not survive the
     * reload, so the panel opens in place as on a first login. */
    var stored = readStoredSession();
    if (panelEntered && stored && st.session && stored.access_token === st.session.access_token) {
      reloading = true;
      await writeLog("Logged in", adminEmail()); // before the reload cancels the request
      location.reload();
      return;
    }
    writeLog("Logged in", adminEmail());
    enterPanel();
  } catch (e) {
    console.error("Login error:", e);
    showLoginError("Connection error. Try again.");
  } finally {
    if (!reloading) { // otherwise the form stays busy until the page reloads
      loginPending = false;
      loginBtn.disabled = false;
      loginBtn.textContent = "Log in";
    }
  }
}

/* ===== Access: roles and permissions =====
 * After login the panel asks the database what the account may do (public.my_access()) and
 * shows only the tabs and controls its role allows. The database enforces every write on its
 * own; hiding a control only keeps the panel honest about what will work. */
var ACCESS_CHECK_FAILED_MSG = "Could not verify admin access. Try again.";

/* Every tab in display order: the permission it needs (none: open to every role), superOnly
 * for the super admin's Roles tab, and what opening it loads. */
var TABS = {
  players: {},
  achievements: {},
  dashboard: { load: renderDashboard },
  log: { perm: "log.read", load: loadLog },
  groups: { perm: "groups.edit", load: loadGroupsTab },
  reset: { perm: "reset.run", load: loadResetTab },
  adjustments: { perm: "adjustments.edit", load: loadAdjustmentsTab },
  formula: { perm: "formula.edit", load: loadFormulaSettings },
  users: { perm: "users.manage", load: loadUsersTab },
  roles: { superOnly: true, load: loadRolesTab }, // creating and editing roles
};
var TAB_IDS = Object.keys(TABS);

/* What the signed-in account may do: { role, permissions }. role is { id, name, is_super }
 * or null (no access); permissions is a Set of the keys my_access() returned (can() does not
 * read it for a super role, which holds every permission). Throws when access cannot be
 * verified, including before the roles migration is applied; callers sign out. */
async function fetchAccess() {
  return parseAccess(await adminRequest("/rest/v1/rpc/my_access", { method: "POST", body: {} }));
}

/* my_access() -> { role: { id, name, is_super } | null, permissions: [keys] }. Anything else
 * throws, so a malformed answer never opens the panel. */
function parseAccess(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Unexpected my_access response");
  var role = data.role;
  if (role === null || role === undefined) return { role: null, permissions: new Set() };
  if (typeof role !== "object" || Array.isArray(role)) throw new Error("Unexpected my_access response");
  var keys = (Array.isArray(data.permissions) ? data.permissions : [])
    .filter(function(k) { return typeof k === "string"; });
  return {
    role: { id: toRoleId(role.id), name: String(role.name ?? "") || "Unnamed role", is_super: role.is_super === true },
    permissions: new Set(keys),
  };
}

var NO_ROLE_MSG = "This account has no role in the admin panel.";

/* Whether the signed-in account holds permission `key` (a super admin holds every one). */
function can(key) {
  var a = st.access;
  return !!(a && a.role && (a.role.is_super || a.permissions.has(key)));
}

function isSuperAdmin() {
  return !!(st.access && st.access.role && st.access.role.is_super);
}

function tabAllowed(tab) {
  if (TAB_IDS.indexOf(tab) === -1 || !st.access || !st.access.role) return false;
  if (TABS[tab].superOnly) return isSuperAdmin();
  return !TABS[tab].perm || can(TABS[tab].perm);
}

/* A role id as a number, or null. */
function toRoleId(value) {
  if (value === null || value === undefined || value === "") return null;
  var n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function setHidden(id, hidden) {
  var el = document.getElementById(id);
  if (el) el.hidden = hidden;
}

/* Shows the account and its role in the header, and only the tabs and static controls the
 * role allows. Rows (players, achievements) check can() when they are drawn. */
function applyAccess() {
  var a = st.access;
  var identity = document.getElementById("adminIdentity");
  if (identity) {
    var email = adminEmail() || "";
    var roleName = a && a.role ? a.role.name : "";
    var emailEl = document.createElement("span");
    emailEl.className = "admin-identity-email";
    emailEl.textContent = email;
    var roleEl = document.createElement("span");
    roleEl.className = "admin-identity-role";
    roleEl.textContent = roleName;
    var sep = document.createElement("span");
    sep.className = "admin-identity-sep";
    sep.textContent = "·";
    identity.replaceChildren(emailEl, sep, roleEl);
    identity.title = email + " · " + roleName;
    identity.hidden = !(a && a.role);
  }

  var visibleTabs = 0;
  TAB_IDS.forEach(function(key) {
    var allowed = tabAllowed(key);
    setHidden(tabDomId("tab", key), !allowed);
    if (allowed) visibleTabs++;
  });
  /* More tabs than the original eight: a little less padding, so they fit on a desktop row. */
  var tabRow = document.querySelector(".admin-tabs");
  if (tabRow) tabRow.classList.toggle("admin-tabs--compact", visibleTabs > 8);

  setHidden("addPlayerForm", !can("players.edit"));
  setHidden("addAchBtn", !can("achievements.edit"));
  if (!can("achievements.edit")) {
    var achForm = document.getElementById("addAchForm");
    if (achForm) achForm.classList.remove("open");
  }
  setHidden("clearLogBtn", !can("log.clear"));
  if (!can("badges.assign")) closeAchievementPicker();

  if (!tabAllowed(st.currentTab)) switchTab("players");
}

/* Forget the session here and, best effort, on the server. */
async function endSession() {
  var token = st.session && st.session.access_token;
  clearSession();
  if (!token) return;
  try {
    await fetch(SUPABASE.URL + "/auth/v1/logout?scope=local", { method: "POST", headers: sbHeaders(token) });
  } catch (e) {
    console.warn("Logout request failed:", e);
  }
}

/* #loginError is an alert region, and describes both fields, so the message is read out even
 * though focus moves to the password. */
function showLoginError(msg) {
  loginError.textContent = msg;
  passwordInput.value = "";
  passwordInput.focus();
}
async function logout() {
  if (logoutBtn) logoutBtn.disabled = true;
  await writeLog("Logged out", adminEmail());
  await endSession();
  location.reload();
}

/* ===== Panel ===== */
/* Opens the panel for the account in st.access (set by the caller after fetchAccess). */
function enterPanel() {
  panelEntered = true;
  applyAccess();
  loginSection.style.display = "none";
  panelSection.style.display = "block";
  panelSection.inert = true; // behind the loading overlay until loadAdminData is done
  switchTab(st.currentTab); // after a new login, reload the open tab for this account
  setTimeout(function() { toggleLoadingOverlay("adminLoadingOverlay", true); }, 0);
  loadAdminData();
}

/* A stored session opens the panel again once its access is verified, as at login. */
async function resumeSession() {
  /* A login submitted meanwhile takes over: it checks access and opens the panel itself. */
  function superseded() { return loginPending || panelSection.style.display !== "none"; }
  try {
    await getAccessToken();
  } catch (err) {
    console.error("Session check failed:", err);
    if (st.session && panelSection.style.display === "none") showLoginError("Connection error. Try again.");
    return;
  }
  if (superseded()) return;
  if (await verifyAccess(superseded)) enterPanel();
}

/* Asks what the signed-in account may do and keeps it in st.access. When the check fails or
 * the account has no role, it ends the session, says why and returns null; a network error
 * or a server outage keeps the session (the panel stays closed), so trying again can work.
 * Once stale() reports that another login took over, it returns null and does nothing more. */
async function verifyAccess(stale) {
  var access;
  try {
    access = await fetchAccess();
  } catch (err) {
    if (stale() || !st.session) return null; // !st.session: a rejected token already said so
    console.error("Access check failed:", err);
    if (err instanceof TypeError || err.status >= 500) {
      showLoginError("Connection error. Try again.");
      return null;
    }
    await endSession();
    showLoginError(ACCESS_CHECK_FAILED_MSG);
    return null;
  }
  if (stale()) return null;
  if (!access.role) {
    await endSession();
    showLoginError(NO_ROLE_MSG);
    return null;
  }
  st.access = access;
  return access;
}

async function loadAdminData() {
  playerList.innerHTML = '<p class="loading-msg">Loading player data...</p>';
  st.loadErrors = {};
  renderLoadErrors();

  /* Records a failed read under `key` and reports whether it failed. */
  function failed(result, key, message) {
    if (result.status === "fulfilled") return false;
    console.error(message, result.reason);
    st.loadErrors[key] = message + " " + ((result.reason && result.reason.message) || result.reason);
    return true;
  }
  /* The rows of a read, or [] when it failed (recorded as above). */
  function rowsOrEmpty(result, key, message) {
    if (failed(result, key, message)) return [];
    return Array.isArray(result.value) ? result.value : [];
  }

  try {
    /* Load players from player_config + current ratings from engine, with the rest alongside */
    var [configRes, ratingsResult, hiddenRes, achRes, playerAchRes] = await Promise.allSettled([
      adminRows("player_config", "nickname,initial_rating", "nickname.asc"),
      typeof buildRatings === "function"
        ? buildRatings()
        : Promise.reject(new Error("Rating engine is unavailable")),
      adminRows("hidden_players", "nick", "nick.asc"),
      adminRows("achievements", "id,name,icon_url,url", "id.asc"),
      adminRows("player_achievements", "nick,achievement_id", "nick.asc,achievement_id.asc"),
    ]);

    var configPlayers = rowsOrEmpty(configRes, "config", "Could not load players:");
    var ratingsData = failed(ratingsResult, "engine", "Rating calculation failed (ratings, changes and activity are unavailable):")
      ? null : ratingsResult.value;

    st.hiddenNicks = new Set(rowsOrEmpty(hiddenRes, "hidden", "Could not load hidden players (visibility switches may be wrong):")
      .map(function(r) { return r.nick; }));
    st.achievements = rowsOrEmpty(achRes, "achievements", "Could not load achievements:");
    st.playerAchievements = {};
    rowsOrEmpty(playerAchRes, "playerAchievements", "Could not load badge assignments:").forEach(function(r) {
      if (!st.playerAchievements[r.nick]) st.playerAchievements[r.nick] = new Set();
      st.playerAchievements[r.nick].add(r.achievement_id);
    });

    /* Build rating lookup from engine */
    var ratingByNick = {};
    if (ratingsData) {
      ratingsData.leaderboard.forEach(function(p) {
        ratingByNick[p.nickname] = p.rating;
      });
    }
    st.groups = ratingsData ? ratingsData.groups : [];

    /* series: the engine's history entries; ends: only the end-of-day entries (one per day,
     * without the start-of-day and mid-day adjustment entries) */
    st.players = configPlayers.map(function(p) {
      var series = (ratingsData && ratingsData.history[p.nickname]) || [];
      return {
        nick: p.nickname,
        rating: ratingByNick[p.nickname] ?? null,
        series: series,
        ends: endEntries(series),
      };
    });
    sortPlayers();

    renderLoadErrors();
    renderAchievementsTab();
    renderList();
    /* The failed reads show in their tabs; screen readers hear them once, here. */
    var failures = Object.values(st.loadErrors);
    if (failures.length) announce(failures.join(" "));
  } catch (err) {
    showLoadError(playerList, "Failed to load data: " + err.message);
  } finally {
    toggleLoadingOverlay("adminLoadingOverlay", false);
    panelSection.inert = false;
    /* Focus was on the login form, now hidden: the panel starts at its title. */
    restoreFocus(document.querySelector(".admin-title"), loginSection);
  }
}

function sortPlayers() {
  st.players.sort(compareRanking);
}

/* Load failures that affect the Players tab without emptying it. */
function renderLoadErrors() {
  var box = document.getElementById("playerLoadError");
  if (!box) return;
  var messages = ["engine", "hidden", "playerAchievements"]
    .map(function(key) { return st.loadErrors[key]; })
    .filter(Boolean);
  box.innerHTML = messages.map(errorHtml).join("");
  box.style.display = messages.length ? "" : "none";
}

function errorHtml(message) {
  return '<p class="load-error">' + escapeHtml(message) + '</p>';
}

/* Shows a failed load in `container` and reads it out (re-renders use errorHtml alone). */
function showLoadError(container, message) {
  container.innerHTML = errorHtml(message);
  announce(message);
}

/* Reads `text` out to screen readers through the #adminStatus region. It is emptied first
 * and filled a moment later, so the same text twice is read twice. */
var announceTimer = 0;
function announce(text) {
  var region = document.getElementById("adminStatus");
  if (!region) return;
  clearTimeout(announceTimer);
  region.textContent = "";
  announceTimer = setTimeout(function() { region.textContent = text; }, 50);
}

/* Focuses `el` when focus was lost (the focused control was removed or hidden, so focus fell
 * back to the page) or is still inside `scope`; never away from a control the user moved to. */
function restoreFocus(el, scope) {
  var active = document.activeElement;
  if (el && (!active || active === document.body || (scope && scope.contains(active)))) el.focus();
}

/* After an item of `list` was deleted: focuses the first control of the item now at `index`
 * (the next one, or the new last one), else `fallback`. */
function focusAfterDelete(list, index, fallback) {
  var item = list.children[Math.min(index, list.children.length - 1)];
  restoreFocus((item && item.querySelector("button, input, select, [tabindex]")) || fallback);
}

/* A finite number as text, or "" — keeps database values out of markup. */
function numOrEmpty(value) {
  var n = numberOrNaN(value);
  return Number.isFinite(n) ? String(n) : "";
}

/* ===== Tab switching ===== */
/* "tab" + "users" -> "tabUsers"; "section" + "users" -> "sectionUsers". */
function tabDomId(prefix, tab) {
  return prefix + tab.charAt(0).toUpperCase() + tab.slice(1);
}

/* A tab the role does not allow opens the Players tab instead. */
function switchTab(tab) {
  if (!tabAllowed(tab)) tab = "players";
  st.currentTab = tab;
  TAB_IDS.forEach(function(key) {
    var btn = document.getElementById(tabDomId("tab", key));
    var sec = document.getElementById(tabDomId("section", key));
    if (btn) {
      btn.classList.toggle("tab-active", key === tab);
      /* The open tab, for screen readers (the class only shows it) */
      if (key === tab) btn.setAttribute("aria-current", "true");
      else btn.removeAttribute("aria-current");
    }
    if (sec) sec.style.display = key === tab ? "block" : "none";
  });
  /* On a narrow touch screen the tab row scrolls sideways (with a mouse it wraps instead, see
   * admin.css): bring the chosen tab fully into view. Only the row scrolls, never the page;
   * where every tab fits (desktop, or a wrapped row) nothing moves. */
  var activeTab = document.getElementById(tabDomId("tab", tab));
  var tabRow = activeTab && activeTab.parentElement;
  if (tabRow && tabRow.scrollWidth > tabRow.clientWidth) {
    var tabBox = activeTab.getBoundingClientRect(), rowBox = tabRow.getBoundingClientRect();
    if (tabBox.left < rowBox.left) tabRow.scrollLeft -= rowBox.left - tabBox.left;
    else if (tabBox.right > rowBox.right) tabRow.scrollLeft += tabBox.right - rowBox.right;
  }
  var load = TABS[tab].load;
  if (load) {
    /* "Loading…" is only shown; say it too. The dashboard draws at once. */
    if (load !== renderDashboard && activeTab) announce("Loading " + activeTab.textContent.replace(/^\S+\s+/, "") + "…");
    load();
  }
}

/* ===== Rating formula settings ===== */
var FORMULA_FIELDS = {
  WinMin: "formulaWinMin", WinMax: "formulaWinMax",
  DrawMin: "formulaDrawMin", DrawMax: "formulaDrawMax",
};
async function loadFormulaSettings() {
  /* Save stays off until the stored values are on screen, so a failed load cannot
   * overwrite them with the form's defaults. */
  var btn = document.getElementById("saveFormulaBtn");
  if (btn) btn.disabled = true;
  var msg = document.getElementById("formulaMsg");
  if (msg) msg.textContent = ""; // an empty status region takes no room (admin.css)
  try {
    var rows = await adminRequest("/rest/v1/settings?select=key,value");
    var values = {};
    (Array.isArray(rows) ? rows : []).forEach(function(r) { values[r.key] = r.value; });
    var defaults = { WinMin: 3, WinMax: 3, DrawMin: 1, DrawMax: 1 };
    Object.keys(FORMULA_FIELDS).forEach(function(key) {
      var input = document.getElementById(FORMULA_FIELDS[key]);
      if (input) input.value = values[key] ?? defaults[key];
    });
    if (btn) btn.disabled = false;
  } catch (err) {
    showFormulaMessage("Could not load settings: " + err.message + " Saving is disabled until they load.", true);
  }
}
async function saveFormulaSettings() {
  var btn = document.getElementById("saveFormulaBtn");
  var records = [];
  var numbers = {};
  for (var key of Object.keys(FORMULA_FIELDS)) {
    var input = document.getElementById(FORMULA_FIELDS[key]);
    var value = input ? input.value.trim() : "";
    var num = Number(value);
    if (!value || !Number.isFinite(num) || num < 0) { showFormulaMessage("Enter a number of 0 or more in every field.", true); return; }
    numbers[key] = num;
    records.push({ key: key, value: value });
  }
  /* The engine awards min + k points for a whole number k (up to max), so the range must be whole. */
  var ranges = [["Win", numbers.WinMin, numbers.WinMax], ["Draw", numbers.DrawMin, numbers.DrawMax]];
  for (var i = 0; i < ranges.length; i++) {
    var label = ranges[i][0], lo = ranges[i][1], hi = ranges[i][2];
    if (lo > hi) { showFormulaMessage(label + " min must not be greater than " + label.toLowerCase() + " max.", true); return; }
    if (Math.abs((hi - lo) - Math.round(hi - lo)) > 1e-9) {
      showFormulaMessage(label + ": max − min must be a whole number. Each match awards min + 0, 1, 2 … points up to max, so 2.5–4.5 works but 2.5–3 does not.", true);
      return;
    }
  }
  btn.disabled = true;
  try {
    await adminRequest("/rest/v1/settings?on_conflict=key", {
      method: "POST",
      body: records,
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    writeLog("Rating formula updated", records.map(function(r) { return r.key + "=" + r.value; }).join(", "));
    showFormulaMessage("✓ Saved. Reload the site to apply.", false);
  } catch (err) {
    showFormulaMessage(refusalText(err, "edit the rating formula") || "Save failed: " + err.message, true);
  } finally { btn.disabled = false; }
}
function showFormulaMessage(message, error) {
  var el = document.getElementById("formulaMsg");
  if (!el) return;
  el.textContent = message;
  el.style.color = error ? "#ff7676" : "var(--accent)";
}

/* ===== Monthly Reset ===== */

function loadResetTab() {
  var now = new Date();
  var currentYear = now.getFullYear();

  // Populate year dropdown (current year ± 2)
  var yearSel = document.getElementById("resetYear");
  if (yearSel && !yearSel.options.length) {
    for (var y = currentYear - 1; y <= currentYear + 2; y++) {
      var opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y;
      if (y === currentYear) opt.selected = true;
      yearSel.appendChild(opt);
    }
  }

  // Default to the current month and year.
  var monthSel = document.getElementById("resetMonth");
  if (monthSel) {
    monthSel.value = String(now.getMonth() + 1).padStart(2, "0");
  }
  if (yearSel) yearSel.value = String(currentYear);

  // Load players for the selected month when selectors change
  if (yearSel) yearSel.onchange = loadResetPlayers;
  if (monthSel) monthSel.onchange = loadResetPlayers;

  loadResetPlayers();
}

function getResetDate() {
  var year  = (document.getElementById("resetYear")  || {}).value;
  var month = (document.getElementById("resetMonth") || {}).value;
  if (!year || !month) return null;
  return year + "-" + month + "-01";
}

/* Save works only for a list that finished loading, and saves to the date it was loaded for
 * (resetList's data-reset-date). */
function updateResetSaveBtn() {
  var btn = document.getElementById("applyResetBtn");
  var container = document.getElementById("resetList");
  if (btn) btn.disabled = st.resetSaving || !(container && container.dataset.resetDate);
}

var resetLoadSeq = 0;

async function loadResetPlayers() {
  var container = document.getElementById("resetList");
  if (!container) return;

  var seq = ++resetLoadSeq;
  delete container.dataset.resetDate;
  updateResetSaveBtn();

  var dateVal = getResetDate();
  if (!dateVal) {
    container.innerHTML = '<p class="loading-msg">Select a year and month above.</p>';
    return;
  }

  // Update label
  var label = document.getElementById("resetDateLabel");
  var monthNames = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];
  var parts = dateVal.split("-");
  if (label) label.textContent = "Applied on: " + dateVal + "  (" + monthNames[parseInt(parts[1])-1] + " " + parts[0] + ")";

  container.innerHTML = '<p class="loading-msg">Loading…</p>';

  try {
    // Fetch players and any existing resets for this date in parallel
    var [playersRes, existingRes] = await Promise.allSettled([
      adminRows("player_config", "nickname,initial_rating", "nickname.asc"),
      adminRequest("/rest/v1/rating_adjustments?applied_date=eq." + dateVal + "&reason=eq.monthly_reset&select=id,nickname,new_rating&order=id.asc"),
    ]);
    if (seq !== resetLoadSeq) return; // a newer load replaced this one

    if (playersRes.status === "rejected") {
      showLoadError(container, "Could not load players: " + playersRes.reason.message);
      return;
    }
    if (existingRes.status === "rejected") {
      showLoadError(container, "Could not load the saved reset for " + dateVal + ": " + existingRes.reason.message +
        ". Saving is disabled so the saved values are not overwritten.");
      return;
    }

    var players  = playersRes.value;
    var existing = existingRes.value;

    if (!Array.isArray(players) || !players.length) {
      container.innerHTML = '<p class="loading-msg">No players found.</p>';
      return;
    }

    // Build existing ratings map: nickname → new_rating (the highest id wins, as in the engine)
    var existingMap = {};
    if (Array.isArray(existing)) {
      existing.forEach(function(e) { existingMap[e.nickname] = e.new_rating; });
    }

    container.innerHTML = "";
    container.className = "player-list";

    // Group header info
    var hasExisting = Object.keys(existingMap).length > 0;
    if (hasExisting) {
      var info = document.createElement("p");
      info.style.cssText = "font-size:12px;opacity:0.55;margin:0 0 12px;";
      info.textContent = "✓ Loaded existing reset (" + Object.keys(existingMap).length + " players saved). Edit and save to update.";
      container.appendChild(info);
    }

    var frag = document.createDocumentFragment();
    players.forEach(function(p) {
      var savedRating = existingMap[p.nickname];
      var displayRating = savedRating != null ? savedRating : p.initial_rating;

      var row = document.createElement("div");
      row.className = "player-row";
      row.dataset.nick = p.nickname;
      row.innerHTML =
        '<div class="player-row-info">' +
          '<img class="player-row-avatar" alt="' + escapeHtml(p.nickname) + '" />' +
          '<div>' +
            '<div class="player-row-nick">' + escapeHtml(p.nickname) + '</div>' +
            '<div class="player-row-rating" style="font-size:11px;opacity:0.5;">base: ' + escapeHtml(numOrEmpty(p.initial_rating) || "—") + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="row-actions" style="gap:8px;">' +
          (savedRating != null ? '<span style="font-size:11px;color:var(--accent);opacity:0.8;">saved</span>' : '') +
          '<span aria-hidden="true" style="font-size:12px;opacity:0.5;white-space:nowrap;">Start rating</span>' +
          '<input type="number" class="reset-rating-input group-min-input" value="' + numOrEmpty(displayRating) + '" min="0" step="0.5" style="width:90px;text-align:right;" ' +
            'aria-label="Start rating for ' + escapeHtml(p.nickname) + '" />' +
        '</div>';

      setAvatar(row.querySelector(".player-row-avatar"), p.nickname, 64, avatarSrc(p.nickname));
      frag.appendChild(row);
    });
    container.appendChild(frag);
    container.dataset.resetDate = dateVal;
    updateResetSaveBtn();
  } catch (e) {
    showLoadError(container, "Error: " + e.message);
  }
}

document.addEventListener("DOMContentLoaded", function() {
  var applyBtn = document.getElementById("applyResetBtn");
  if (applyBtn) applyBtn.addEventListener("click", saveMonthlyReset);
});

/* Insert the new rows first and only then delete the old ones, so a failed insert loses
 * nothing. Same-day rows are applied in id order, so the new rows win even if the cleanup fails. */
async function saveMonthlyReset() {
  var container = document.getElementById("resetList");
  var dateVal = container && container.dataset.resetDate;
  if (!dateVal) { alert("Wait until the player list for the selected month has loaded."); return; }

  var rows = container.querySelectorAll("[data-nick]");
  if (!rows.length) { alert("No players loaded."); return; }

  var records = [];
  rows.forEach(function(row) {
    var nick = row.dataset.nick;
    var rating = parseFloat(row.querySelector(".reset-rating-input").value);
    if (nick && isFinite(rating)) {
      records.push({ nickname: nick, new_rating: rating, applied_date: dateVal, reason: "monthly_reset" });
    }
  });
  if (!records.length) { alert("Enter at least one starting rating before saving."); return; }

  var btn = document.getElementById("applyResetBtn");
  st.resetSaving = true;
  updateResetSaveBtn();
  btn.textContent = "Saving…";

  try {
    var inserted = await adminRequest("/rest/v1/rating_adjustments", {
      method: "POST",
      body: records,
      prefer: "return=representation",
    }).catch(function(e) {
      throw new Error((refusalText(e, "save monthly resets") || e.message) + "\nNothing was deleted; the previously saved reset is unchanged.");
    });
    var newIds = (Array.isArray(inserted) ? inserted : [])
      .map(function(r) { return Number(r.id); })
      .filter(function(id) { return Number.isInteger(id); });
    if (newIds.length !== records.length) {
      throw new Error("The server did not confirm the new rows, so the old ones were kept. Reload the tab and check the saved values.");
    }
    writeLog("Monthly reset saved", dateVal + " — " + records.length + " players");

    /* Only rows saved before this insert: if another save of the same month overlaps, the
     * later one's rows stay, so the month never ends up without a reset. */
    try {
      await adminRequest(
        "/rest/v1/rating_adjustments?applied_date=eq." + dateVal + "&reason=eq.monthly_reset&id=lt." + Math.min.apply(null, newIds),
        { method: "DELETE" }
      );
    } catch (e) {
      alert("The new reset for " + dateVal + " was saved, but the previous rows could not be removed: " + (refusalText(e, "save monthly resets") || e.message) +
        "\nThe new values still apply (same-day rows are applied in id order). Save again to clean up.");
    }

    var msg = document.getElementById("resetMsg");
    if (msg) { msg.textContent = "✓ Saved!"; setTimeout(function() { msg.textContent = ""; }, 2500); }

    // Reload to show "saved" badges
    await loadResetPlayers();
  } catch (e) {
    alert("Error: " + e.message);
  } finally {
    st.resetSaving = false;
    btn.textContent = "💾 Save Reset";
    updateResetSaveBtn();
  }
}

/* ===== Rating Adjustments ===== */
/* Player options come from st.players, so added and deleted players show up on the next open. */
function fillAdjNickSelect() {
  var select = document.getElementById("adjNick");
  if (!select) return;
  var selected = select.value;
  var nicks = st.players.map(function(p) { return p.nick; }).sort(function(a, b) { return a.localeCompare(b); });
  select.replaceChildren();
  nicks.forEach(function(nick) { select.appendChild(makeOption(nick, nick, false)); });
  if (nicks.indexOf(selected) !== -1) select.value = selected;
}

var ADJ_LIST_LIMIT = 200;

/* Default date = the current work day (07:30–07:30 Kyiv), so a new adjustment applies from now.
 * A default the admin has not changed moves on with the work day, when the tab loads and when
 * Add is clicked, so a page left open past 07:30 does not backdate the next adjustment to
 * yesterday's start. A date the admin picked stays. */
function refreshAdjDateDefault() {
  var adjDate = document.getElementById("adjDate");
  if (adjDate && (!adjDate.value || adjDate.value === adjDate.dataset.defaultDate)) {
    adjDate.value = adjDate.dataset.defaultDate = workDayOf();
  }
}

async function loadAdjustmentsTab() {
  var container = document.getElementById("adjList");
  if (!container) return;
  container.innerHTML = '<p class="loading-msg">Loading…</p>';

  // Populate player select
  fillAdjNickSelect();

  refreshAdjDateDefault();

  // Load existing manual adjustments (monthly resets live in the Monthly Reset tab)
  try {
    var rows = await adminRequest(
      "/rest/v1/rating_adjustments?select=*&or=(reason.is.null,reason.neq.monthly_reset)&order=applied_date.desc,id.desc&limit=" + ADJ_LIST_LIMIT
    );
    renderAdjustmentsList(Array.isArray(rows) ? rows : []);
  } catch (e) {
    showLoadError(container, "Could not load adjustments: " + e.message);
  }
}

/* When an adjustment takes effect within its work day (Kyiv time): the moment it was saved,
 * or the start of the day for a row dated another day or saved before created_at existed. */
function adjustmentEffectText(row) {
  var moment = adjustmentMoment(row);
  return moment ? moment.time : "07:30 (start of day)";
}

function renderAdjustmentsList(rows) {
  var container = document.getElementById("adjList");
  if (!container) return;
  if (!rows.length) { container.innerHTML = '<p class="loading-msg">No adjustments yet.</p>'; return; }
  container.innerHTML =
    (rows.length >= ADJ_LIST_LIMIT ? '<p class="dash-h3" style="margin-top:0;">Showing the latest ' + ADJ_LIST_LIMIT + ' manual adjustments.</p>' : '') +
    '<div class="adj-table-wrap">' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
    '<thead><tr style="opacity:0.5;text-align:left;">' +
    '<th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Player</th>' +
    '<th style="padding:6px 8px;">New Rating</th><th style="padding:6px 8px;">Takes effect</th>' +
    '<th style="padding:6px 8px;">Reason</th>' +
    '<th style="padding:6px 8px;"></th></tr></thead>' +
    '<tbody>' +
    rows.map(function(r) {
      return '<tr style="border-top:1px solid rgba(255,255,255,0.06);">' +
        '<td style="padding:6px 8px;">' + escapeHtml(r.applied_date) + '</td>' +
        '<td style="padding:6px 8px;font-weight:600;">' + escapeHtml(r.nickname) + '</td>' +
        '<td style="padding:6px 8px;color:var(--accent);">' + escapeHtml(numOrEmpty(r.new_rating)) + '</td>' +
        '<td style="padding:6px 8px;font-variant-numeric:tabular-nums;">' + escapeHtml(adjustmentEffectText(r)) + '</td>' +
        '<td style="padding:6px 8px;opacity:0.6;">' + escapeHtml(r.reason || "—") + '</td>' +
        '<td style="padding:6px 8px;">' +
          '<button class="btn adj-del-btn" data-id="' + escapeHtml(r.id) + '" type="button" title="Delete adjustment" ' +
          'aria-label="Delete adjustment for ' + escapeHtml(r.nickname) + ' on ' + escapeHtml(r.applied_date) + '" ' +
          'style="font-size:11px;color:#ff7676;padding:3px 8px;">✕</button>' +
        '</td></tr>';
    }).join("") +
    '</tbody></table></div>';

  container.querySelectorAll(".adj-del-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      if (confirm("Delete this adjustment?")) deleteAdjustment(parseInt(btn.dataset.id));
    });
  });
}

async function deleteAdjustment(id) {
  try {
    await adminRequest("/rest/v1/rating_adjustments?id=eq." + id, { method: "DELETE", mustMatch: true });
    writeLog("Adjustment deleted", String(id));
    loadAdjustmentsTab();
  } catch (e) { alert(refusalText(e, "delete rating adjustments") || "Error: " + e.message); }
}

document.addEventListener("DOMContentLoaded", function() {
  var addBtn = document.getElementById("addAdjBtn");
  if (addBtn) addBtn.addEventListener("click", async function() {
    var nick   = (document.getElementById("adjNick") || {}).value;
    var rating = parseFloat((document.getElementById("adjRating") || {}).value);
    refreshAdjDateDefault();
    var date   = (document.getElementById("adjDate") || {}).value;
    var reason = ((document.getElementById("adjReason") || {}).value || "").trim();

    if (!nick || !isFinite(rating) || !date) { alert("Fill in player, rating and date."); return; }
    addBtn.disabled = true; addBtn.textContent = "Saving…";

    try {
      await adminRequest("/rest/v1/rating_adjustments", {
        method: "POST",
        body: { nickname: nick, new_rating: rating, applied_date: date, reason: reason || null },
      });
      writeLog("Adjustment added", nick + " → " + rating + " on " + date);
      document.getElementById("adjRating").value = "";
      document.getElementById("adjReason").value = "";
      loadAdjustmentsTab();
    } catch (e) {
      alert(refusalText(e, "add rating adjustments") || "Error: " + e.message);
    } finally {
      addBtn.disabled = false; addBtn.textContent = "+ Add";
    }
  });
});

/* ===== Groups tab ===== */
async function loadGroupsTab() {
  var container = document.getElementById("groupList");
  if (!container) return;
  container.innerHTML = '<p class="loading-msg">Loading…</p>';
  try {
    var rows = await adminRequest("/rest/v1/rating_groups?select=id,name,min_rating,color,coef&order=min_rating.desc");
    renderGroupsTab(normalizeGroups(rows));
  } catch (e) {
    showLoadError(container, "Could not load groups: " + e.message);
  }
}

/* ===== Render groups tab ===== */
function renderGroupsTab(groups) {
  var container = document.getElementById("groupList");
  if (!container) return;
  container.innerHTML = "";

  if (!groups.length) {
    container.innerHTML = '<p class="loading-msg">No groups found. Run the SQL setup in Supabase first.</p>';
    return;
  }

  var entries = []; // { group, row } in display order
  var frag = document.createDocumentFragment();
  groups.forEach(function(g) {
    var row = document.createElement("div");
    row.className = "group-row";
    /* Every row has the same fields: their names say which group they belong to. */
    row.innerHTML =
      '<label class="group-color-wrap" title="Click to change colour">' +
        '<span class="group-color-swatch" style="background:' + escapeHtml(g.color) + ';"></span>' +
        '<input class="group-color-input" type="color" value="' + escapeHtml(g.color) + '" aria-label="Colour of ' + escapeHtml(g.name) + '" />' +
      '</label>' +
      '<input class="group-name-input" type="text" value="' + escapeHtml(g.name) + '" placeholder="Group name" aria-label="Name of group ' + escapeHtml(g.name) + '" />' +
      '<label class="group-min-label" for="grpMin' + escapeHtml(g.id) + '">Min rating:</label>' +
      '<input id="grpMin' + escapeHtml(g.id) + '" class="group-min-input" type="number" value="' + escapeHtml(g.min) + '" min="0" step="1" />' +
      '<label class="group-min-label" for="grpCoef' + escapeHtml(g.id) + '">Coef:</label>' +
      '<input id="grpCoef' + escapeHtml(g.id) + '" class="group-min-input group-coef-input" type="number" value="' + escapeHtml(g.coef) + '" step="0.01" />' +
      '<button class="btn group-save-btn" type="button" aria-label="Save ' + escapeHtml(g.name) + '" style="font-size:13px;background:var(--accent);color:#0b0f14;font-weight:700;flex-shrink:0;">Save</button>';

    // Live-update swatch as colour changes
    row.querySelector(".group-color-input").addEventListener("input", function(e) {
      row.querySelector(".group-color-swatch").style.background = safeColor(e.target.value);
    });

    row.querySelector(".group-save-btn").addEventListener("click", function() {
      var name     = row.querySelector(".group-name-input").value.trim();
      var color    = row.querySelector(".group-color-input").value;
      var min      = parseInt(row.querySelector(".group-min-input").value, 10);
      var coef     = parseFloat(row.querySelector(".group-coef-input").value);
      if (!name) { alert("Name cannot be empty."); return; }
      if (isNaN(min) || min < 0) { alert("Min rating must be a non-negative number."); return; }
      if (!isFinite(coef) || coef <= 0) { alert("Coefficient must be greater than zero."); return; }
      saveGroup(g, name, min, color, coef, row, entries);
    });

    entries.push({ group: g, row: row });
    frag.appendChild(row);
  });
  container.appendChild(frag);
}

/* ===== Save group =====
 * Updates only the saved row (other rows keep their unsaved edits), moves rows when the
 * order changed, and refreshes st.groups for the dashboard and CSV. */
async function saveGroup(groupObj, name, minRating, color, coef, rowEl, entries) {
  var saveBtn = rowEl.querySelector(".group-save-btn");
  saveBtn.disabled = true; saveBtn.textContent = "Saving…";
  try {
    var rows = await adminRequest("/rest/v1/rating_groups?id=eq." + encodeURIComponent(groupObj.id), {
      method: "PATCH",
      body: { name: name, min_rating: minRating, color: color, coef: coef },
      mustMatch: true,
    });
    Object.assign(groupObj, normalizeGroups(rows)[0]);

    rowEl.querySelector(".group-name-input").value = groupObj.name;
    rowEl.querySelector(".group-min-input").value = groupObj.min;
    rowEl.querySelector(".group-coef-input").value = groupObj.coef;
    rowEl.querySelector(".group-color-input").value = groupObj.color;
    rowEl.querySelector(".group-color-swatch").style.background = groupObj.color;
    /* The field names carry the group's name, which may have changed */
    rowEl.querySelector(".group-color-input").setAttribute("aria-label", "Colour of " + groupObj.name);
    rowEl.querySelector(".group-name-input").setAttribute("aria-label", "Name of group " + groupObj.name);
    saveBtn.setAttribute("aria-label", "Save " + groupObj.name);

    entries.sort(function(a, b) { return b.group.min - a.group.min; });
    var container = rowEl.parentNode;
    if (container && entries.some(function(e, i) { return container.children[i] !== e.row; })) {
      entries.forEach(function(e) { container.appendChild(e.row); });
    }
    st.groups = entries.map(function(e) { return e.group; });

    writeLog("Group updated", groupObj.name + " — min:" + groupObj.min + " color:" + groupObj.color);
    saveBtn.textContent = "✓ Saved";
    announce(groupObj.name + " saved."); // the button text alone is not read out
    setTimeout(function() {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }, 1400);
  } catch (err) {
    alert(refusalText(err, "edit rating groups") || "Error: " + err.message);
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

/* ===== Render achievements tab ===== */
function renderAchievementsTab() {
  var container = document.getElementById("achCardList");
  if (!container) return;
  container.innerHTML = st.loadErrors.achievements ? errorHtml(st.loadErrors.achievements) : "";

  if (!st.achievements.length) {
    if (!st.loadErrors.achievements) {
      container.innerHTML = '<p class="loading-msg">' + (can("achievements.edit") ? "No achievements yet. Create one below." : "No achievements yet.") + '</p>';
    }
    return;
  }

  st.achievements.forEach(function(ach) {
    container.appendChild(makeAchCard(ach));
  });
}

function makeAchCard(ach) {
  var href = safeUrl(ach.url);
  var card = document.createElement("div");
  card.className = "ach-card";
  card.dataset.achId = ach.id;
  card.innerHTML =
    '<div class="ach-card-view">' +
      '<img class="ach-card-icon" src="' + escapeHtml(safeUrl(ach.icon_url)) + '" alt="" />' +
      '<div class="ach-card-info">' +
        '<div class="ach-card-name">' + escapeHtml(ach.name) + '</div>' +
        '<div class="ach-card-url">' +
          (href ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(ach.url) + '</a>'
            : ach.url ? '<span style="opacity:0.68;">' + escapeHtml(ach.url) + ' (not an http(s) link)</span>'
            : '<span style="opacity:0.68;">No link</span>') +
        '</div>' +
      '</div>' +
      '<div class="ach-card-actions">' +
        '<button class="btn ach-edit-btn" type="button" style="font-size:12px;">✏ Edit</button>' +
        '<button class="btn ach-del-btn" type="button" style="font-size:12px;color:#ff7676;">✕ Delete</button>' +
      '</div>' +
    '</div>' +
    '<div class="ach-card-edit" style="display:none;">' +
      '<div class="ach-edit-row">' +
        '<label class="ach-edit-label" for="achEditName' + escapeHtml(ach.id) + '">Name</label>' +
        '<input id="achEditName' + escapeHtml(ach.id) + '" class="ach-edit-name ach-edit-input" type="text" value="' + escapeHtml(ach.name) + '" />' +
      '</div>' +
      '<div class="ach-edit-row">' +
        '<label class="ach-edit-label" for="achEditUrl' + escapeHtml(ach.id) + '">Link (URL)</label>' +
        '<input id="achEditUrl' + escapeHtml(ach.id) + '" class="ach-edit-url ach-edit-input" type="url" placeholder="https://..." value="' + escapeHtml(ach.url || "") + '" />' +
      '</div>' +
      '<div class="ach-edit-row">' +
        '<label class="ach-edit-label">Icon</label>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          /* Visually hidden, not display:none, so the keyboard can reach it */
          '<label class="upload-btn" title="Choose new icon"><span aria-hidden="true">🖼</span>' +
            '<input class="ach-edit-file sr-only" type="file" accept="image/*" aria-label="New icon for ' + escapeHtml(ach.name) + '" /></label>' +
          '<span class="ach-edit-filename" style="font-size:12px;opacity:0.55;">Keep current</span>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:4px;">' +
        '<button class="btn ach-save-edit-btn" type="button" style="font-size:13px;background:var(--accent);color:#0b0f14;font-weight:700;">Save</button>' +
        '<button class="btn ach-cancel-edit-btn" type="button" style="font-size:13px;">Cancel</button>' +
      '</div>' +
    '</div>';

  /* Without achievements.edit the card is read-only. */
  if (!can("achievements.edit")) {
    card.querySelector(".ach-card-actions").remove();
    card.querySelector(".ach-card-edit").remove();
    return card;
  }

  /* Edit toggle. Each hides the button just pressed, so focus moves to the part now shown. */
  card.querySelector(".ach-edit-btn").addEventListener("click", function() {
    card.querySelector(".ach-card-view").style.display = "none";
    card.querySelector(".ach-card-edit").style.display = "flex";
    card.querySelector(".ach-edit-name").focus();
  });
  card.querySelector(".ach-cancel-edit-btn").addEventListener("click", function() {
    card.querySelector(".ach-card-view").style.display = "flex";
    card.querySelector(".ach-card-edit").style.display = "none";
    card.querySelector(".ach-edit-file").value = "";
    card.querySelector(".ach-edit-filename").textContent = "Keep current";
    card.querySelector(".ach-edit-btn").focus();
  });

  /* File picker label */
  card.querySelector(".ach-edit-file").addEventListener("change", function(e) {
    card.querySelector(".ach-edit-filename").textContent = e.target.files[0] ? e.target.files[0].name : "Keep current";
  });

  /* Save edit */
  card.querySelector(".ach-save-edit-btn").addEventListener("click", function() {
    var name = card.querySelector(".ach-edit-name").value.trim();
    var url  = card.querySelector(".ach-edit-url").value.trim();
    var file = card.querySelector(".ach-edit-file").files[0] || null;
    if (!name) { alert("Name cannot be empty."); return; }
    if (url && !safeUrl(url)) { alert("The link must be an http:// or https:// URL."); return; }
    saveAchievementEdit(ach.id, name, url, file, card);
  });

  /* Delete */
  card.querySelector(".ach-del-btn").addEventListener("click", function() {
    if (confirm('Delete achievement "' + ach.name + '"?')) deleteAchievement(ach.id, card);
  });

  return card;
}

/* Uploads `file` to Storage as bucket/key, replacing an existing object. */
async function uploadToBucket(bucket, key, file) {
  return adminRequest("/storage/v1/object/" + bucket + "/" + key, {
    method: "POST",
    raw: file,
    contentType: file.type || "image/png",
    headers: { "x-upsert": "true" },
  });
}

/* Uploads an achievement icon and returns its public URL. */
async function uploadAchievementIcon(name, file) {
  var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  var filename = slug + "_" + Date.now() + ".png";
  await uploadToBucket(SUPABASE.ACH_BUCKET, filename, file).catch(rethrowAs("Icon upload failed: "));
  return storagePublicUrl(SUPABASE.ACH_BUCKET, filename);
}

/* ===== Create achievement ===== */
async function createAchievement(name, url, file) {
  var saveBtn = document.getElementById("achSaveBtn");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

  try {
    var iconUrl = await uploadAchievementIcon(name, file);

    var inserted = await adminRequest("/rest/v1/achievements", {
      method: "POST",
      body: { name: name, icon_url: iconUrl, url: url || null },
      prefer: "return=representation",
    }).catch(rethrowAs("DB insert failed: "));
    var newAch = Array.isArray(inserted) ? inserted[0] : inserted;
    st.achievements.push(newAch);
    writeLog("Achievement created", name);

    /* Reset form */
    document.getElementById("achNameInput").value = "";
    document.getElementById("achUrlInput").value = "";
    document.getElementById("achIconInput").value = "";
    document.getElementById("achIconName").textContent = "No file";
    var addAchForm = document.getElementById("addAchForm");
    addAchForm.classList.remove("open");
    var addAchBtn = document.getElementById("addAchBtn");
    addAchBtn.setAttribute("aria-expanded", "false");
    restoreFocus(addAchBtn, addAchForm); // the form closed around the Save button

    renderAchievementsTab();
  } catch (err) {
    alert(refusalText(err, "create achievements") || "Error: " + err.message);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
  }
}

/* ===== Edit achievement ===== */
async function saveAchievementEdit(id, name, url, file, cardEl) {
  var saveBtn = cardEl.querySelector(".ach-save-edit-btn");
  saveBtn.disabled = true; saveBtn.textContent = "Saving…";

  try {
    var updateData = { name: name, url: url || null };

    /* Upload new icon if provided */
    if (file) updateData.icon_url = await uploadAchievementIcon(name, file);

    var updated = await adminRequest("/rest/v1/achievements?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      body: updateData,
      mustMatch: true,
    }).catch(rethrowAs("Update failed: "));

    /* Update state */
    var idx = st.achievements.findIndex(function(a) { return a.id === id; });
    if (idx !== -1) Object.assign(st.achievements[idx], updateData, updated[0]);
    writeLog("Achievement edited", name);

    renderAchievementsTab();
    /* The card was drawn again: focus goes back to its Edit button. */
    restoreFocus(document.querySelector('#achCardList [data-ach-id="' + CSS.escape(String(id)) + '"] .ach-edit-btn'));
  } catch (err) {
    alert(refusalText(err, "edit achievements") || "Error: " + err.message);
    saveBtn.disabled = false; saveBtn.textContent = "Save";
  }
}

/* ===== Delete achievement ===== */
async function deleteAchievement(id, cardEl) {
  if (cardEl) cardEl.style.opacity = "0.4";
  try {
    await adminRequest("/rest/v1/achievements?id=eq." + encodeURIComponent(id), { method: "DELETE", mustMatch: true });
    var delName = (st.achievements.find(function(a){return a.id===id;})||{}).name || String(id);
    writeLog("Achievement deleted", delName);
    var list = document.getElementById("achCardList");
    var index = cardEl ? Array.prototype.indexOf.call(list.children, cardEl) : 0;
    st.achievements = st.achievements.filter(function(a) { return a.id !== id; });
    Object.keys(st.playerAchievements).forEach(function(nick) {
      st.playerAchievements[nick].delete(id);
    });
    renderAchievementsTab();
    focusAfterDelete(list, index, document.querySelector("#sectionAchievements h2"));
    renderList();
  } catch (err) {
    if (cardEl) cardEl.style.opacity = "1";
    alert(refusalText(err, "delete achievements") || "Delete failed: " + err.message);
  }
}

/* ===== Achievement picker (per player) ===== */
function openAchievementPicker(nick, btnEl) {
  closeAchievementPicker();
  if (!can("badges.assign")) return;
  if (!st.achievements.length) {
    alert(st.loadErrors.achievements || "No achievements yet. Create one in the Achievements tab.");
    return;
  }
  st.openPickerNick = nick;
  var picker = document.createElement("div");
  picker.className = "ach-picker";
  picker.id = "achPicker";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Achievements of " + nick);
  var assigned = st.playerAchievements[nick] || new Set();
  st.achievements.forEach(function(ach) {
    var isChecked = assigned.has(ach.id);
    var item = document.createElement("label");
    item.className = "ach-picker-item";
    item.innerHTML =
      '<input type="checkbox" ' + (isChecked ? "checked" : "") + ' data-ach-id="' + escapeHtml(ach.id) + '" />' +
      '<img src="' + escapeHtml(safeUrl(ach.icon_url)) + '" alt="" />' +
      '<span>' + escapeHtml(ach.name) + '</span>';
    item.querySelector("input").addEventListener("change", function(e) {
      togglePlayerAchievement(nick, ach.id, e.target.checked, e.target);
    });
    picker.appendChild(item);
  });
  var rect = btnEl.getBoundingClientRect();
  picker.style.position = "fixed";
  picker.style.top = (rect.bottom + 6) + "px";
  picker.style.right = (window.innerWidth - rect.right) + "px";
  /* Right after the player's row, so its checkboxes come next in the Tab and reading order.
   * It is position:fixed, so the list's layout does not change. */
  btnEl.closest(".player-row").after(picker);
  btnEl.setAttribute("aria-expanded", "true");
  keepPickerOnScreen(picker, rect);
  picker.querySelector("input").focus({ preventScroll: true });
  /* Escape closes it (back to the button), and so does moving focus out of it. */
  picker.addEventListener("keydown", function(e) {
    if (e.key === "Escape") { closeAchievementPicker(); btnEl.focus(); }
  });
  picker.addEventListener("focusout", function(e) {
    if (e.relatedTarget && !picker.contains(e.relatedTarget) && e.relatedTarget !== btnEl) closeAchievementPicker();
  });
  setTimeout(function() {
    document.addEventListener("click", onPickerOutsideClick, true);
  }, 0);
}

/* The picker opens right-aligned under its button. Where that leaves the screen (on a phone
 * the button sits at the left of its row; a row near the bottom has no room below), it moves
 * back inside, 8px from the edges, or opens above the button when there is more room there.
 * Where it is fully on screen, nothing changes. */
function keepPickerOnScreen(picker, btnRect) {
  var edge = 8, gap = 6;
  var viewW = document.documentElement.clientWidth;
  var viewH = window.innerHeight;
  if (!viewW || !viewH) return; // no layout to fit into
  var box = picker.getBoundingClientRect();

  if (box.left < 0 || box.right > viewW) {
    /* Measure the width it takes with the whole screen available, then fix that width and
     * align its right edge with the button as far as the screen allows. */
    picker.style.right = "auto";
    picker.style.left = edge + "px";
    picker.style.maxWidth = (viewW - 2 * edge) + "px";
    var width = picker.getBoundingClientRect().width;
    picker.style.width = width + "px";
    picker.style.left = Math.max(edge, Math.min(btnRect.right - width, viewW - edge - width)) + "px";
    box = picker.getBoundingClientRect(); // its height can differ at the new width
  }

  if (box.bottom > viewH) {
    var below = viewH - btnRect.bottom - gap - edge;
    var above = btnRect.top - gap - edge;
    if (above > below) {
      var height = Math.min(box.height, above);
      picker.style.maxHeight = height + "px";
      picker.style.top = (btnRect.top - gap - height) + "px";
    } else {
      picker.style.maxHeight = Math.max(below, 0) + "px";
    }
  }
}

function onPickerOutsideClick(e) {
  var picker = document.getElementById("achPicker");
  if (!picker) { document.removeEventListener("click", onPickerOutsideClick, true); return; }
  if (!picker.contains(e.target)) {
    closeAchievementPicker();
    document.removeEventListener("click", onPickerOutsideClick, true);
  }
}
function closeAchievementPicker() {
  var picker = document.getElementById("achPicker");
  if (picker) picker.remove();
  var btn = st.openPickerNick !== null ? trophyBtnOf(st.openPickerNick) : null;
  if (btn) btn.setAttribute("aria-expanded", "false");
  st.openPickerNick = null;
}

async function togglePlayerAchievement(nick, achId, assign, checkboxEl) {
  if (!st.playerAchievements[nick]) st.playerAchievements[nick] = new Set();
  if (assign) { st.playerAchievements[nick].add(achId); }
  else        { st.playerAchievements[nick].delete(achId); }
  updateTrophyBtn(nick);
  try {
    if (assign) {
      await adminRequest("/rest/v1/player_achievements", {
        method: "POST",
        body: { nick: nick, achievement_id: achId },
        prefer: "resolution=merge-duplicates",
      });
    } else {
      await adminRequest(
        "/rest/v1/player_achievements?nick=eq." + encodeURIComponent(nick) + "&achievement_id=eq." + encodeURIComponent(achId),
        { method: "DELETE" }
      );
    }
    var achName = (st.achievements.find(function(a){return a.id===achId;})||{}).name || String(achId);
    writeLog(assign ? "Badge assigned" : "Badge removed", nick + " → " + achName);
  } catch (err) {
    console.error("Toggle achievement failed:", err);
    if (assign) { st.playerAchievements[nick].delete(achId); }
    else        { st.playerAchievements[nick].add(achId); }
    if (checkboxEl) checkboxEl.checked = !assign;
    updateTrophyBtn(nick);
    alert(refusalText(err, "assign achievements to players") || "Error: " + err.message);
  }
}

/* Shows the player's badge count on their trophy button. */
function paintTrophy(btn, nick) {
  var count = st.playerAchievements[nick] ? st.playerAchievements[nick].size : 0;
  btn.classList.toggle("has-ach", count > 0);
  btn.title = count > 0 ? "Achievements (" + count + ")" : "Add achievement";
  /* The title is only a description; the name says whose badges the button opens. */
  btn.setAttribute("aria-label", count > 0 ? "Achievements of " + nick + " (" + count + ")" : "Add achievement to " + nick);
}

/* The trophy button in `nick`'s row of the player list, or null. */
function trophyBtnOf(nick) {
  var row = playerList.querySelector('[data-nick="' + CSS.escape(nick) + '"]');
  return row && row.querySelector(".trophy-btn");
}

function updateTrophyBtn(nick) {
  var btn = trophyBtnOf(nick);
  if (btn) paintTrophy(btn, nick);
}

/* ===== Avatar URL =====
 * The plain public URL, so the browser cache works; after an upload in this session the nick
 * gets a version so the new picture shows at once. */
function avatarSrc(nick) {
  var version = st.avatarVersions[nick];
  return version ? avatarUrl(nick) + "?v=" + version : avatarUrl(nick);
}

/* ===== Render players ===== */
function renderList() {
  updateStats();
  if (st.loadErrors.config) {
    playerList.innerHTML = errorHtml(st.loadErrors.config);
    return;
  }
  var q = st.searchQuery.toLowerCase().trim();
  var visible = q
    ? st.players.filter(function(p) { return p.nick.toLowerCase().indexOf(q) !== -1; })
    : st.players;
  if (!visible.length) {
    playerList.innerHTML = '<p class="loading-msg">No players found.</p>';
    return;
  }
  var frag = document.createDocumentFragment();
  for (var i = 0; i < visible.length; i++) { frag.appendChild(makeRow(visible[i])); }
  playerList.replaceChildren(frag);
}

/* Row actions are drawn only for the permissions the role holds; without players.visibility
 * a hidden player shows a plain "Hidden" label instead of the switch. */
function makeRow(p) {
  var rating = p.rating != null ? Number(p.rating).toFixed(1) : "—";
  var visible = !st.hiddenNicks.has(p.nick);
  var canUpload = can("avatars.upload");
  var canBadges = can("badges.assign");
  var canVisibility = can("players.visibility");
  var canDelete = can("players.edit");

  var row = document.createElement("div");
  row.dataset.nick = p.nick;
  row.innerHTML =
    '<div class="player-row-info">' +
      '<img class="player-row-avatar" alt="' + escapeHtml(p.nick) + '" loading="lazy" />' +
      '<div>' +
        '<div class="player-row-nick">' + escapeHtml(p.nick) + '</div>' +
        '<div class="player-row-rating">Rating: ' + escapeHtml(rating) + '</div>' +
      '</div>' +
    '</div>' +
    /* The file input is visually hidden, not display:none, so the keyboard reaches it. The
     * switch is named "Show <nick> on site: Visible/Hidden": its label text alone is the state. */
    '<div class="row-actions">' +
      (canUpload
        ? '<label class="upload-btn" title="Upload photo"><span aria-hidden="true">📷</span>' +
            '<input class="avatar-file-input sr-only" type="file" accept="image/*" aria-label="Upload photo for ' + escapeHtml(p.nick) + '" /></label>'
        : '') +
      (canBadges ? '<button class="trophy-btn" type="button" aria-expanded="false"><span aria-hidden="true">🏆</span></button>' : '') +
      (canVisibility
        ? '<label class="toggle">' +
            '<span class="sr-only">Show ' + escapeHtml(p.nick) + ' on site: </span>' +
            '<input type="checkbox" role="switch" />' +
            '<span class="toggle-track"><span class="toggle-thumb"></span></span>' +
            '<span class="toggle-label"></span>' +
          '</label>'
        : visible ? '' : '<span class="row-status">Hidden</span>') +
      (canDelete
        ? '<button class="btn delete-player-btn" type="button" title="Delete player" aria-label="Delete player ' + escapeHtml(p.nick) + '" ' +
            'style="font-size:11px;color:#ff7676;padding:3px 8px;">✕</button>'
        : '') +
    '</div>';
  paintVisibility(row, visible);

  var img = row.querySelector(".player-row-avatar");
  setAvatar(img, p.nick, 64, avatarSrc(p.nick));
  var input = row.querySelector(".avatar-file-input");
  if (input) input.addEventListener("change", function(e) {
    var file = e.target.files[0];
    if (file) uploadAvatar(p.nick, file, img);
    input.value = "";
  });
  var toggleBox = row.querySelector(".toggle input");
  if (toggleBox) toggleBox.addEventListener("change", function(e) {
    onToggle(p.nick, e.target.checked, row);
  });
  var trophyBtn = row.querySelector(".trophy-btn");
  if (trophyBtn) {
    paintTrophy(trophyBtn, p.nick);
    trophyBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      openAchievementPicker(p.nick, this);
    });
  }
  var deleteBtn = row.querySelector(".delete-player-btn");
  if (deleteBtn) deleteBtn.addEventListener("click", function() {
    if (confirm('Delete player "' + p.nick + '"? This cannot be undone.')) {
      deletePlayer(p.nick, row);
    }
  });
  return row;
}

/* ===== Upload avatar ===== */
async function uploadAvatar(nick, file, imgEl) {
  imgEl.style.opacity = "0.4";
  try {
    await uploadToBucket(SUPABASE.AVATAR_BUCKET, avatarKey(nick), file).catch(rethrowAs("Upload failed: "));
    st.avatarVersions[nick] = Date.now();
    setAvatar(imgEl, nick, 64, avatarSrc(nick));
    writeLog("Avatar uploaded", nick);
  } catch (err) {
    console.error(err); alert(refusalText(err, "upload player photos") || "Upload error: " + err.message);
  } finally {
    imgEl.style.opacity = "1";
  }
}

/* ===== Toggle visibility ===== */
/* Shows `visible` on the row: switch, dimming, label, title. */
function paintVisibility(row, visible) {
  row.className = "player-row" + (visible ? "" : " player-row--hidden");
  var box = row.querySelector(".toggle input");
  var lbl = row.querySelector(".toggle-label");
  var tog = row.querySelector(".toggle");
  if (box) box.checked = visible;
  if (lbl) lbl.textContent = visible ? "Visible" : "Hidden";
  if (tog) tog.title = visible ? "Visible — click to hide" : "Hidden — click to show";
}

/* Shows `visible` on the row and in st.hiddenNicks. */
function applyVisibility(nick, visible, row) {
  if (visible) { st.hiddenNicks.delete(nick); } else { st.hiddenNicks.add(nick); }
  paintVisibility(row, visible);
  updateStats();
}

async function onToggle(nick, visible, row) {
  var box = row.querySelector(".toggle input");
  applyVisibility(nick, visible, row);
  if (box) box.disabled = true; // one request at a time per switch
  try {
    if (visible) {
      await adminRequest("/rest/v1/hidden_players?nick=eq." + encodeURIComponent(nick), { method: "DELETE" });
    } else {
      await adminRequest("/rest/v1/hidden_players", {
        method: "POST",
        body: { nick: nick },
        prefer: "resolution=merge-duplicates",
      });
    }
    writeLog(visible ? "Player shown" : "Player hidden", nick);
  } catch (err) {
    console.error("Supabase error:", err);
    applyVisibility(nick, !visible, row);
    alert(refusalText(err, "hide and show players") || "Could not " + (visible ? "show " : "hide ") + nick + ": " + err.message);
  } finally {
    if (box) box.disabled = false;
  }
}

/* Hidden players still in the list (hidden_players can keep rows for deleted players). */
function hiddenCount() {
  return st.players.filter(function(p) { return st.hiddenNicks.has(p.nick); }).length;
}

function updateStats() {
  var hidden = hiddenCount();
  var total  = st.players.length;
  if (totalVisible) totalVisible.textContent = total - hidden;
  if (totalHidden)  totalHidden.textContent  = hidden;
}

/* ===== Write log ===== */
/* Never throws: a failed log write only warns in the console. */
async function writeLog(action, details) {
  try {
    await adminRequest("/rest/v1/admin_log", {
      method: "POST",
      body: {
        action: action,
        details: details || null,
        email: adminEmail(),
      },
    });
  } catch (e) { console.warn("Log write failed:", e); }
}

/* ===== Load log ===== */
async function loadLog() {
  var logList = document.getElementById("logList");
  if (!logList) return;
  logList.innerHTML = '<p class="loading-msg">Loading…</p>';
  try {
    var rows = await adminRequest("/rest/v1/admin_log?select=*&order=created_at.desc&limit=200");
    if (!Array.isArray(rows) || !rows.length) {
      logList.innerHTML = '<p class="loading-msg">No log entries yet.</p>';
      return;
    }
    /* Focusable, so the keyboard can scroll it sideways where it overflows (under 1100px). */
    var html = '<div class="log-wrap" tabindex="0" role="region" aria-label="Activity log"><table class="log-table"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>';
    rows.forEach(function(r) {
      var timeStr = formatStamp(r.created_at, "—");
      html += '<tr>' +
        '<td class="log-time">' + escapeHtml(timeStr) + '</td>' +
        '<td class="log-details" style="color:var(--accent);font-size:12px;opacity:0.74;">' + escapeHtml(r.email || "—") + '</td>' +
        '<td class="log-action">' + escapeHtml(r.action) + '</td>' +
        '<td class="log-details">' + escapeHtml(r.details || "—") + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    logList.innerHTML = html;
  } catch (e) {
    showLoadError(logList, "Failed to load log: " + e.message);
  }
}

/* ===== Clear log ===== */
async function clearLog() {
  if (!confirm("Clear entire activity log? This cannot be undone.")) return;
  try {
    await adminRequest("/rest/v1/admin_log?id=gte.0", { method: "DELETE" });
  } catch (e) { alert(refusalText(e, "clear the activity log") || "Failed to clear log: " + e.message); return; }
  await writeLog("Log cleared");
  loadLog();
}

/* ===== CSV ===== */
/* A text cell that a spreadsheet would run as a formula (= + - @ tab CR) gets a leading
 * apostrophe; plain numbers such as -3.5 or +2.0 stay numbers. */
function csvCell(value) {
  var s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCsv(rows, filename) {
  var csv = rows.map(function(r) { return r.map(csvCell).join(","); }).join("\n");
  var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ===== Export CSV ===== */
function exportCSV() {
  var rows = [["Rank", "Nickname", "Rating", "Δ7d", "Δ1d", "Group", "Status"]];
  var visible = st.players.filter(function(p) { return !st.hiddenNicks.has(p.nick); });
  visible.forEach(function(p, i) {
    var d7 = monthDelta(p.series, 7);
    var d1 = monthDelta(p.series, 1);
    var grp = p.rating != null ? groupForRating(p.rating, st.groups) : null;
    rows.push([
      i + 1, p.nick,
      p.rating != null ? Number(p.rating).toFixed(1) : "—",
      d7 != null ? (d7 > 0 ? "+" : "") + d7.toFixed(1) : "—",
      d1 != null ? (d1 > 0 ? "+" : "") + d1.toFixed(1) : "—",
      grp ? grp.name : "—", "Visible",
    ]);
  });
  downloadCsv(rows, "esb_leaderboard_" + localIsoDate() + ".csv");
}

/* ===== Dashboard ===== */
function renderDashboard() {
  var sec = document.getElementById("sectionDashboard");
  if (!sec) return;

  var total   = st.players.length;
  var hidden  = hiddenCount();
  var visible = total - hidden;
  var achCount = st.achievements.length;
  var totalBadges = Object.values(st.playerAchievements).reduce(function(s, set) { return s + set.size; }, 0);
  var visiblePlayers = st.players.filter(function(p) { return !st.hiddenNicks.has(p.nick); });

  var ratings = visiblePlayers
    .filter(function(p) { return p.rating != null; })
    .map(function(p) { return p.rating; });
  var avgRating = ratings.length ? (ratings.reduce(function(s, r) { return s + r; }, 0) / ratings.length).toFixed(1) : "—";
  var maxRating = ratings.length ? Math.max.apply(null, ratings).toFixed(1) : "—";

  /* ---- Current month ---- */
  var latestDate = "";
  st.players.forEach(function(p) {
    if (p.series && p.series.length) {
      var d = p.series[p.series.length - 1].date;
      if (d > latestDate) latestDate = d;
    }
  });
  var monthPrefix = latestDate ? latestDate.slice(0, 7) : localIsoDate().slice(0, 7);
  var monthName   = latestDate
    ? new Date(latestDate + "T00:00:00").toLocaleString("en", { month: "long", year: "numeric" })
    : "—";

  /* ---- Movers ---- */
  var withDelta = visiblePlayers
    .map(function(p) { return { nick: p.nick, delta7: monthDelta(p.series, 7) }; });

  var gainers = withDelta.filter(function(p) { return p.delta7 != null && p.delta7 > 0; })
    .sort(function(a, b) { return b.delta7 - a.delta7; }).slice(0, 5);
  var losers  = withDelta.filter(function(p) { return p.delta7 != null && p.delta7 < 0; })
    .sort(function(a, b) { return a.delta7 - b.delta7; }).slice(0, 5);

  var groupDist = st.groups.map(function(g) {
    var cnt = visiblePlayers.filter(function(p) {
      return p.rating != null && groupForRating(p.rating, st.groups) === g;
    }).length;
    return { name: g.name, color: g.color, count: cnt };
  }).filter(function(g) { return g.count > 0; });

  function moverHtml(list, isGain) {
    if (!list.length) return '<p class="loading-msg" style="padding:6px 0;">No data</p>';
    return list.map(function(p, i) {
      var color = isGain ? "#52d18a" : "#ff7676";
      var sign  = isGain ? "+" : "";
      return '<div class="mover-row">' +
        '<span class="mover-rank">' + (i + 1) + '</span>' +
        '<span class="mover-nick">' + escapeHtml(p.nick) + '</span>' +
        '<span class="mover-delta" style="color:' + color + '">' + sign + p.delta7.toFixed(1) + '</span>' +
        '</div>';
    }).join("");
  }

  /* ---- Activity: all months ---- */
  var allMonthsSet = new Set();
  st.players.forEach(function(p) {
    (p.series || []).forEach(function(e) { allMonthsSet.add(e.date.slice(0, 7)); });
  });
  var sortedMonths = Array.from(allMonthsSet).sort().reverse();

  /* summary for current month; game days = dates on which any visible player played */
  var curPlayers    = calcMonthActivity(monthPrefix);
  var activeCnt     = curPlayers.filter(function(p) { return p.playedDays > 0; }).length;
  var inactiveCnt   = curPlayers.length - activeCnt;
  var gameDates     = new Set();
  curPlayers.forEach(function(p) {
    if (!st.hiddenNicks.has(p.nick)) p.playedDates.forEach(function(d) { gameDates.add(d); });
  });

  sec.innerHTML =
    (st.loadErrors.engine ? errorHtml(st.loadErrors.engine) : "") +
    '<div class="dash-grid">' +
      '<div class="dash-card"><div class="dash-card-val">' + visible + '</div><div class="dash-card-label">Visible players</div></div>' +
      '<div class="dash-card"><div class="dash-card-val" style="color:#ff7676">' + hidden + '</div><div class="dash-card-label">Hidden players</div></div>' +
      '<div class="dash-card"><div class="dash-card-val">' + avgRating + '</div><div class="dash-card-label">Avg rating</div></div>' +
      '<div class="dash-card"><div class="dash-card-val">' + maxRating + '</div><div class="dash-card-label">Top rating</div></div>' +
      '<div class="dash-card"><div class="dash-card-val">' + achCount + '</div><div class="dash-card-label">Achievements</div></div>' +
      '<div class="dash-card"><div class="dash-card-val">' + totalBadges + '</div><div class="dash-card-label">Badges assigned</div></div>' +
    '</div>' +

    '<h3 class="dash-h3">📈 Top gainers (7 days)</h3>' + moverHtml(gainers, true) +
    '<h3 class="dash-h3">📉 Top losers (7 days)</h3>'  + moverHtml(losers, false) +
    '<h3 class="dash-h3">🎮 Group distribution</h3>' +
    '<div>' +
    groupDist.map(function(g) {
      var pct = visible > 0 ? Math.round(g.count / visible * 100) : 0;
      return '<div class="group-bar-row">' +
        '<span class="group-bar-dot" style="background:' + escapeHtml(g.color) + '"></span>' +
        '<span class="group-bar-name">' + escapeHtml(g.name) + '</span>' +
        '<div class="group-bar-track"><div class="group-bar-fill" style="width:' + pct + '%;background:' + escapeHtml(g.color) + '"></div></div>' +
        '<span class="group-bar-count">' + g.count + '</span>' +
        '</div>';
    }).join("") +
    '</div>' +

    '<h3 class="dash-h3">📅 Activity by month</h3>' +
    '<div class="dash-grid" style="margin-bottom:14px;">' +
      '<div class="dash-card"><div class="dash-card-val" style="color:#52d18a">' + gameDates.size + '</div><div class="dash-card-label">Game days (' + escapeHtml(monthName.split(' ')[0]) + ')</div></div>' +
      '<div class="dash-card"><div class="dash-card-val" style="color:#52d18a">' + activeCnt + '</div><div class="dash-card-label">Players played</div></div>' +
      '<div class="dash-card"><div class="dash-card-val" style="color:#ff7676">' + inactiveCnt + '</div><div class="dash-card-label">No games</div></div>' +
    '</div>' +
    '<div id="activityYears">' + buildActivityHtml(sortedMonths) + '</div>';

  /* Toggle listeners — years and months */
  sec.querySelectorAll('.year-toggle, .month-toggle').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = document.getElementById(btn.dataset.target);
      var open = btn.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
      if (target) target.classList.toggle('open', open);
    });
  });

  /* CSV export per month */
  sec.querySelectorAll('.act-csv-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      exportActivityCSV(btn.dataset.prefix, btn.dataset.label);
    });
  });
}

function exportActivityCSV(prefix, label) {
  var players = calcMonthActivity(prefix);
  var rows = [['Nickname', 'Played days', 'Not played days', 'Total days']];
  players.forEach(function(p) {
    rows.push([p.nick, p.playedDays, p.zeroDays, p.playedDays + p.zeroDays]);
  });
  downloadCsv(rows, 'activity_' + label.replace(/\s+/g, '_').toLowerCase() + '.csv');
}

function buildActivityHtml(sortedMonths) {
  /* Group months by year */
  var byYear = {};
  sortedMonths.forEach(function(prefix) {
    var year = prefix.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(prefix);
  });
  var years = Object.keys(byYear).sort().reverse();

  return years.map(function(year, yi) {
    var isYearOpen = yi === 0;
    var monthsHtml = byYear[year].map(function(prefix, mi) {
      var d = new Date(prefix + '-01T00:00:00');
      var label = d.toLocaleString('en', { month: 'long' });
      var isMonthOpen = yi === 0 && mi === 0;
      var players = calcMonthActivity(prefix);
      return '<div class="month-section" style="margin-left:0;">' +
        '<div class="month-toggle-row">' +
          '<button class="month-toggle' + (isMonthOpen ? ' open' : '') + '" data-target="mgrid-' + escapeHtml(prefix) + '" ' +
            'aria-expanded="' + isMonthOpen + '" aria-controls="mgrid-' + escapeHtml(prefix) + '">' +
            escapeHtml(label) +
            '<span class="month-arrow" aria-hidden="true">▼</span>' +
          '</button>' +
          '<button class="act-csv-btn btn" data-prefix="' + escapeHtml(prefix) + '" data-label="' + escapeHtml(label + ' ' + year) + '" style="font-size:12px;padding:5px 10px;flex-shrink:0;">📥 CSV</button>' +
        '</div>' +
        '<div class="month-grid' + (isMonthOpen ? ' open' : '') + '" id="mgrid-' + escapeHtml(prefix) + '">' +
          monthGridHtml(players) +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="year-section">' +
      '<button class="year-toggle' + (isYearOpen ? ' open' : '') + '" data-target="ygrid-' + escapeHtml(year) + '" ' +
        'aria-expanded="' + isYearOpen + '" aria-controls="ygrid-' + escapeHtml(year) + '">' +
        '📆 ' + escapeHtml(year) +
        '<span class="month-arrow" aria-hidden="true">▼</span>' +
      '</button>' +
      '<div class="year-body' + (isYearOpen ? ' open' : '') + '" id="ygrid-' + escapeHtml(year) + '">' +
        monthsHtml +
      '</div>' +
    '</div>';
  }).join('');
}

/* Per-player activity in a month, from the engine's end-of-day entries (p.ends): played =
 * games > 0, not played = games === 0. */
function calcMonthActivity(prefix) {
  return st.players
    .map(function(p) {
      var playedDates = [];
      var zeroDays = 0;
      p.ends.forEach(function(e) {
        if (!e.date.startsWith(prefix)) return;
        var games = Number(e.games);
        if (games > 0) playedDates.push(e.date);
        else if (games === 0) zeroDays++;
      });
      return { nick: p.nick, playedDays: playedDates.length, zeroDays: zeroDays, playedDates: playedDates };
    })
    .sort(function(a, b) { return b.playedDays - a.playedDays || a.nick.localeCompare(b.nick); });
}

function monthGridHtml(players) {
  return players.map(function(p) {
    var active = p.playedDays > 0;
    var cls = active ? 'player-tile tile-active' : 'player-tile tile-inactive';
    var stats =
      '<div class="tile-stat tile-played">Played: ' + p.playedDays + '</div>' +
      '<div class="tile-stat tile-none">Not played: ' + p.zeroDays + '</div>';
    return '<div class="' + cls + '"><div class="tile-nick">' + escapeHtml(p.nick) + '</div>' + stats + '</div>';
  }).join('');
}

/* ===== Roles data (Users and Roles tabs) ===== */
/* The permissions, the roles and what each role holds, read with the admin's token (staff may
 * read all three). Returns { permissions: [{ key, label, description }], roles: [{ id, name,
 * description, is_super, permissions: Set }], byId: Map }. The super role holds every
 * permission without rows of its own. */
async function loadRoleData() {
  var results = await Promise.all([
    adminRows("permissions", "key,label,description,sort", "sort.asc,key.asc"),
    adminRows("roles", "id,name,description,is_super", "id.asc"),
    adminRows("role_permissions", "role_id,permission_key", "role_id.asc,permission_key.asc"),
  ]);
  var permissions = results[0]
    .filter(function(p) { return p && typeof p.key === "string"; })
    .map(function(p) { return { key: p.key, label: String(p.label || p.key), description: String(p.description || "") }; });
  var roles = results[1]
    .filter(function(r) { return r && toRoleId(r.id) !== null; })
    .map(function(r) {
      return {
        id: toRoleId(r.id),
        name: String(r.name ?? ""),
        description: String(r.description ?? ""),
        is_super: r.is_super === true,
        permissions: new Set(),
      };
    });
  var byId = new Map(roles.map(function(r) { return [r.id, r]; }));
  results[2].forEach(function(link) {
    var role = link && byId.get(toRoleId(link.role_id));
    if (role && typeof link.permission_key === "string") role.permissions.add(link.permission_key);
  });
  roles.forEach(function(role) {
    if (role.is_super) permissions.forEach(function(p) { role.permissions.add(p.key); });
  });
  roles.sort(compareRoles);
  return { permissions: permissions, roles: roles, byId: byId };
}

/* The super role first, then by name. */
function compareRoles(a, b) {
  return (b.is_super - a.is_super) || a.name.localeCompare(b.name) || a.id - b.id;
}

function roleById(id) {
  return (id !== null && st.userRoleData && st.userRoleData.byId.get(id)) || null;
}

/* Whether the signed-in account may give `role` to someone (as private.can_grant_role
 * decides): a super admin any role; anyone else a role that is not super and whose
 * permissions they all hold. */
function canGrantRole(role) {
  if (!role) return false;
  if (isSuperAdmin()) return true;
  if (role.is_super) return false;
  return Array.from(role.permissions).every(function(key) { return can(key); });
}

function grantableRoles() {
  return st.userRoleData ? st.userRoleData.roles.filter(canGrantRole) : [];
}

function isOwnRole(role) {
  return !!(role && st.access && st.access.role && st.access.role.id === role.id);
}

/* A date and time as in the activity log, or `empty` for a missing or invalid value. */
function formatStamp(value, empty) {
  if (!value) return empty;
  var d = new Date(value);
  if (Number.isNaN(d.getTime())) return empty;
  return d.toLocaleDateString("uk-UA") + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function makeOption(value, text, selected) {
  var opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  if (selected) opt.selected = true;
  return opt;
}

/* Shows `text` in a form's message span: red for an error, green otherwise (cleared after a
 * few seconds). The span is a status region that stays in the page; empty, it takes no room. */
function showFormMessage(id, text, isError) {
  var el = document.getElementById(id);
  if (!el) return;
  clearTimeout(el._hideTimer);
  el.textContent = text;
  el.style.color = isError ? "#ff7676" : "var(--accent)";
  if (!isError) el._hideTimer = setTimeout(function() { el.textContent = ""; }, 4000);
}

/* ===== Users tab =====
 * Accounts come from the admin-users Edge Function, which can read and change auth.users (the
 * page cannot). Roles are assigned in user_roles through the REST API with the admin's token,
 * so the database decides who may grant which role. */
var ADMIN_USERS_PATH = "/functions/v1/admin-users";
var MIN_PASSWORD_LENGTH = 8;
var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var usersLoadSeq = 0;

/* POST to the admin-users function. A 404 without the function's own { error } means the
 * function itself is missing. */
async function callAdminUsers(payload) {
  try {
    return await adminRequest(ADMIN_USERS_PATH, { method: "POST", body: payload });
  } catch (e) {
    if (e.status === 404 && typeof errorBody(e).error !== "string") {
      throw Object.assign(new Error("The admin-users Edge Function is not deployed (HTTP 404)."), { status: 404 });
    }
    throw e;
  }
}

function normalizeUsers(list) {
  return (Array.isArray(list) ? list : [])
    .filter(function(u) { return u && typeof u.id === "string" && u.id; })
    .map(function(u) {
      return {
        id: u.id,
        email: String(u.email || ""),
        created_at: u.created_at || null,
        last_sign_in_at: u.last_sign_in_at || null,
        role_id: toRoleId(u.role_id),
      };
    })
    .sort(function(a, b) { return a.email.localeCompare(b.email); });
}

/* Passwords typed into the Users tab (new user, Set password) do not stay in the page when it
 * goes back to the login screen, where another account may log in next. */
function clearTypedPasswords() {
  var fields = document.querySelectorAll("#newUserPassword, .user-pw-input");
  for (var i = 0; i < fields.length; i++) fields[i].value = "";
}

function isSelf(user) {
  return !!st.session && sameSessionUser({ user_id: user.id }, st.session);
}

function roleNameOf(roleId) {
  if (roleId === null) return "No role";
  var role = roleById(roleId);
  return role ? role.name : "Unknown role";
}

async function loadUsersTab() {
  var list = document.getElementById("userList");
  /* Only for the open tab: createUser reloads it after a request the admin may have left. */
  if (!list || st.currentTab !== "users") return;
  var seq = ++usersLoadSeq;
  list.innerHTML = '<p class="loading-msg">Loading…</p>';
  st.userRoleData = null;
  fillNewUserRoleSelect();
  try {
    var results = await Promise.all([loadRoleData(), callAdminUsers({ action: "list" })]);
    if (seq !== usersLoadSeq) return; // a newer load replaced this one
    st.userRoleData = results[0];
    st.users = normalizeUsers(results[1] && results[1].users);
    fillNewUserRoleSelect();
    renderUsers();
  } catch (e) {
    if (seq !== usersLoadSeq) return;
    console.error("Users load failed:", e);
    showLoadError(list, "Could not load users: " + errorText(e, "manage users"));
    fillNewUserRoleSelect("Not available");
  }
}

/* The create form offers only the roles the account can grant, with no role chosen up front,
 * so nobody is made a super admin by default. `unavailable` replaces "Loading…" while there
 * are no roles to offer because the tab failed to load. */
function fillNewUserRoleSelect(unavailable) {
  var select = document.getElementById("newUserRole");
  if (!select) return;
  var roles = grantableRoles();
  select.replaceChildren(makeOption("", st.userRoleData ? (roles.length ? "Choose a role…" : "No role you can assign") : unavailable || "Loading…", true));
  roles.forEach(function(role) { select.appendChild(makeOption(String(role.id), role.name, false)); });
  select.disabled = !roles.length;
  updateCreateUserBtn();
}

function updateCreateUserBtn() {
  var btn = document.getElementById("createUserBtn");
  if (btn) btn.disabled = st.creatingUser || !grantableRoles().length;
}

function renderUsers() {
  var list = document.getElementById("userList");
  if (!list) return;
  if (!st.users.length) {
    list.innerHTML = '<p class="loading-msg">No users yet.</p>';
    return;
  }
  var frag = document.createDocumentFragment();
  st.users.forEach(function(user) { frag.appendChild(makeUserRow(user)); });
  list.replaceChildren(frag);
}

/* One account. Its role, password and the account itself can be changed only by someone who
 * could grant its current role, and never by the account itself: such rows are read-only. */
function makeUserRow(user) {
  var self = isSelf(user);
  var role = roleById(user.role_id);
  var manageable = !self && (user.role_id === null || canGrantRole(role));
  var roleText = roleNameOf(user.role_id);

  var row = document.createElement("div");
  row.className = "user-row" + (self ? " user-row--self" : "");
  row.dataset.userId = user.id;
  row.innerHTML =
    '<div class="user-row-info">' +
      '<div class="user-row-email">' +
        '<span class="user-row-email-text" title="' + escapeHtml(user.email || user.id) + '">' + escapeHtml(user.email || user.id) + '</span>' +
        (self ? '<span class="admin-tag">You</span>' : '') +
      '</div>' +
      '<div class="user-row-meta">Created ' + escapeHtml(formatStamp(user.created_at, "—")) +
        ' · Last sign-in ' + escapeHtml(formatStamp(user.last_sign_in_at, "never")) + '</div>' +
    '</div>' +
    '<div class="user-row-actions">' +
      (manageable
        ? '<select class="admin-input admin-input--role user-role-select"></select>' +
          '<button class="btn btn-accent user-role-save" type="button" hidden>Save role</button>' +
          '<button class="btn user-pw-btn" type="button" aria-expanded="false" style="font-size:12px;">🔑 Set password</button>' +
          '<button class="btn user-del-btn" type="button" title="Delete user" aria-label="Delete user ' + escapeHtml(user.email || user.id) + '" ' +
            'style="font-size:11px;color:#ff7676;padding:3px 8px;">✕</button>'
        // tabindex=-1: script moves focus here after a redraw or a delete (no control in the row)
        : '<span class="user-role-static" tabindex="-1">' + escapeHtml(roleText) + '</span>') +
    '</div>' +
    (manageable
      ? '<div class="user-pw-form" hidden>' +
          '<input class="admin-input user-pw-input" type="password" autocomplete="new-password" placeholder="New password (at least ' + MIN_PASSWORD_LENGTH + ' characters)" />' +
          '<button class="btn btn-accent user-pw-save" type="button">Save password</button>' +
          '<button class="btn user-pw-cancel" type="button" style="font-size:13px;">Cancel</button>' +
          '<span class="form-msg user-pw-msg" role="status"></span>' +
        '</div>'
      : '');

  if (!manageable) {
    row.querySelector(".user-role-static").title = self
      ? "You cannot change your own role."
      : "This user's role has permissions you don't hold, so you cannot change this account.";
    return row;
  }

  var select = row.querySelector(".user-role-select");
  select.setAttribute("aria-label", "Role of " + (user.email || user.id));
  if (user.role_id === null) select.appendChild(makeOption("", "No role", true));
  grantableRoles().forEach(function(r) {
    select.appendChild(makeOption(String(r.id), r.name, r.id === user.role_id));
  });
  if (user.role_id !== null) select.appendChild(makeOption("", "No role (remove access)", false));
  /* A role picked with the mouse or a finger is saved at once. Arrow keys change a closed
   * select one role per press (Windows), which would grant every role on the way, so a role
   * picked from the keyboard waits for Enter or the Save role button. */
  var roleSave = row.querySelector(".user-role-save");
  var keyboardPick = false;
  select.addEventListener("pointerdown", function() { keyboardPick = false; });
  select.addEventListener("keydown", function(e) {
    if (e.key === "Enter") changeUserRole(user, row, select);
    else keyboardPick = true;
  });
  select.addEventListener("change", function() {
    roleSave.hidden = !keyboardPick || toRoleId(select.value) === user.role_id;
    if (!keyboardPick) changeUserRole(user, row, select);
  });
  roleSave.addEventListener("click", function() { changeUserRole(user, row, select); });

  var pwForm = row.querySelector(".user-pw-form");
  var pwInput = row.querySelector(".user-pw-input");
  var pwBtn = row.querySelector(".user-pw-btn");
  pwInput.setAttribute("aria-label", "New password for " + (user.email || user.id));
  pwBtn.addEventListener("click", function() {
    pwForm.hidden = !pwForm.hidden;
    pwBtn.setAttribute("aria-expanded", String(!pwForm.hidden));
    if (!pwForm.hidden) pwInput.focus();
  });
  row.querySelector(".user-pw-cancel").addEventListener("click", function() {
    pwInput.value = "";
    row.querySelector(".user-pw-msg").textContent = "";
    pwForm.hidden = true;
    pwBtn.setAttribute("aria-expanded", "false");
    pwBtn.focus(); // the form closed around this Cancel button
  });
  row.querySelector(".user-pw-save").addEventListener("click", function() { setUserPassword(user, row); });
  pwInput.addEventListener("keydown", function(e) { if (e.key === "Enter") setUserPassword(user, row); });
  row.querySelector(".user-del-btn").addEventListener("click", function() { deleteUser(user, row); });
  return row;
}

/* Gives the user another role (an upsert on user_roles.user_id), or none. */
async function changeUserRole(user, row, select) {
  var newId = toRoleId(select.value);
  var before = user.role_id;
  if (newId === before) return;
  var who = user.email || user.id;
  var roleSave = row.querySelector(".user-role-save");
  if (newId === null && !confirm('Remove the role of "' + who + '"? They will no longer be able to use the admin panel.')) {
    select.value = String(before);
    roleSave.hidden = true;
    return;
  }
  select.disabled = true;
  roleSave.disabled = true;
  try {
    if (newId === null) {
      await adminRequest("/rest/v1/user_roles?user_id=eq." + encodeURIComponent(user.id), { method: "DELETE", mustMatch: true });
    } else {
      await adminRequest("/rest/v1/user_roles?on_conflict=user_id", {
        method: "POST",
        body: { user_id: user.id, role_id: newId },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
    user.role_id = newId;
    writeLog("Role changed", who + ": " + roleNameOf(before) + " → " + roleNameOf(newId));
    var newRow = makeUserRow(user);
    row.replaceWith(newRow); // the "No role" options depend on the role
    restoreFocus(newRow.querySelector(".user-role-select, .user-role-static")); // the focused select went with the old row
  } catch (e) {
    select.value = before === null ? "" : String(before);
    select.disabled = false;
    roleSave.disabled = false;
    roleSave.hidden = true;
    alert(errorText(e, newId === null ? "remove this user's role" : "give this user that role"));
  }
}

async function setUserPassword(user, row) {
  var input = row.querySelector(".user-pw-input");
  var save = row.querySelector(".user-pw-save");
  var msg = row.querySelector(".user-pw-msg");
  var password = input.value;
  function show(text) { msg.textContent = text; msg.style.color = "#ff7676"; }
  if (save.disabled) return;
  if (password.length < MIN_PASSWORD_LENGTH) {
    show("Password must be at least " + MIN_PASSWORD_LENGTH + " characters.");
    input.focus();
    return;
  }
  msg.textContent = "";
  save.disabled = true;
  save.textContent = "Saving…";
  try {
    await callAdminUsers({ action: "set_password", user_id: user.id, password: password });
    input.value = "";
    writeLog("Password set", user.email || user.id);
    row.querySelector(".user-pw-form").hidden = true;
    var pwBtn = row.querySelector(".user-pw-btn");
    pwBtn.textContent = "✓ Password set";
    pwBtn.setAttribute("aria-expanded", "false");
    restoreFocus(pwBtn, row); // the form closed around the focused field or button
    announce("Password set for " + (user.email || user.id) + "."); // the button text alone is not read out
    setTimeout(function() { pwBtn.textContent = "🔑 Set password"; }, 2500);
  } catch (e) {
    show(errorText(e, "set this user's password"));
  } finally {
    save.disabled = false;
    save.textContent = "Save password";
  }
}

async function deleteUser(user, row) {
  var who = user.email || user.id;
  if (!confirm('Delete user "' + who + '"? They will no longer be able to log in. This cannot be undone.')) return;
  var btn = row.querySelector(".user-del-btn");
  btn.disabled = true;
  row.style.opacity = "0.4";
  try {
    await callAdminUsers({ action: "delete", user_id: user.id });
    writeLog("User deleted", who + " (" + roleNameOf(user.role_id) + ")");
    var list = document.getElementById("userList");
    var index = Array.prototype.indexOf.call(list.children, row);
    st.users = st.users.filter(function(u) { return u.id !== user.id; });
    renderUsers();
    focusAfterDelete(list, index, document.querySelector("#sectionUsers h2"));
  } catch (e) {
    row.style.opacity = "1";
    btn.disabled = false;
    alert(errorText(e, "delete this user"));
  }
}

async function createUser() {
  if (st.creatingUser) return;
  var emailEl = document.getElementById("newUserEmail");
  var passwordEl = document.getElementById("newUserPassword");
  var roleEl = document.getElementById("newUserRole");
  var btn = document.getElementById("createUserBtn");
  var email = emailEl.value.trim();
  var password = passwordEl.value;
  var role = roleById(toRoleId(roleEl.value));

  if (!EMAIL_PATTERN.test(email)) { showFormMessage("createUserMsg", "Enter a valid email address.", true); return; }
  if (password.length < MIN_PASSWORD_LENGTH) {
    showFormMessage("createUserMsg", "Password must be at least " + MIN_PASSWORD_LENGTH + " characters.", true);
    return;
  }
  if (!role || !canGrantRole(role)) { showFormMessage("createUserMsg", "Choose a role.", true); return; }

  st.creatingUser = true;
  updateCreateUserBtn();
  btn.textContent = "Creating…";
  var created = false;
  try {
    await callAdminUsers({ action: "create", email: email, password: password, role_id: role.id });
    created = true;
    writeLog("User created", email + " (" + role.name + ")");
    emailEl.value = "";
    passwordEl.value = "";
    roleEl.value = "";
    showFormMessage("createUserMsg", "✓ " + email + " created.", false);
  } catch (e) {
    showFormMessage("createUserMsg", errorText(e, "create users with that role", "A user with this email already exists."), true);
  } finally {
    st.creatingUser = false;
    btn.textContent = "+ Create user";
    updateCreateUserBtn();
  }
  if (created) loadUsersTab();
}

/* ===== Roles tab =====
 * Roles and their permissions are rows in roles and role_permissions, written through the
 * REST API. Only the super admin sees this tab, and the database lets only the super admin
 * write those rows, never for the super role itself. */
var rolesLoadSeq = 0;

async function loadRolesTab() {
  var list = document.getElementById("roleList");
  if (!list) return;
  var seq = ++rolesLoadSeq;
  list.innerHTML = '<p class="loading-msg">Loading…</p>';
  try {
    var results = await Promise.all([
      loadRoleData(),
      adminRows("user_roles", "user_id,role_id", "user_id.asc"),
    ]);
    if (seq !== rolesLoadSeq) return; // a newer load replaced this one
    st.roleData = results[0];
    st.roleUserCounts = new Map();
    results[1].forEach(function(r) {
      var id = toRoleId(r && r.role_id);
      if (id !== null) st.roleUserCounts.set(id, (st.roleUserCounts.get(id) || 0) + 1);
    });
    renderRoles();
  } catch (e) {
    if (seq !== rolesLoadSeq) return;
    console.error("Roles load failed:", e);
    showLoadError(list, "Could not load roles: " + errorText(e, "manage roles"));
  }
}

function renderRoles() {
  var list = document.getElementById("roleList");
  if (!list || !st.roleData) return;
  if (!st.roleData.roles.length) {
    list.innerHTML = '<p class="loading-msg">No roles yet.</p>';
    return;
  }
  var frag = document.createDocumentFragment();
  st.roleData.roles.forEach(function(role) { frag.appendChild(makeRoleCard(role)); });
  list.replaceChildren(frag);
}

/* One role: name, description, number of users, and a checkbox per permission. The viewer is
 * the super admin (the only one who sees this tab) and may switch every permission; the super
 * role itself is locked. */
function makeRoleCard(role) {
  var count = st.roleUserCounts ? (st.roleUserCounts.get(role.id) || 0) : null;
  var card = document.createElement("div");
  card.className = "role-card" + (role.is_super ? " role-card--super" : "");
  card.dataset.roleId = role.id;
  card.innerHTML =
    '<div class="role-card-head">' +
      '<div class="role-card-info">' +
        '<div class="role-card-name">' + escapeHtml(role.name) +
          (role.is_super ? '<span class="admin-tag admin-tag--gold">🔒 All permissions</span>' : '') +
          (isOwnRole(role) ? '<span class="admin-tag">Your role</span>' : '') +
        '</div>' +
        (role.description ? '<div class="role-card-desc">' + escapeHtml(role.description) + '</div>' : '') +
        (count !== null ? '<div class="role-card-meta">' + count + (count === 1 ? " user" : " users") + '</div>' : '') +
      '</div>' +
      (role.is_super ? '' :
        '<div class="role-card-actions">' +
          '<button class="btn role-edit-btn" type="button" aria-expanded="false" style="font-size:12px;">✏ Edit</button>' +
          '<button class="btn role-del-btn" type="button" style="font-size:12px;color:#ff7676;">✕ Delete</button>' +
        '</div>') +
    '</div>' +
    (role.is_super
      ? '<p class="role-locked">This role has every permission, including ones added later. It cannot be edited or deleted.</p>'
      : '<div class="role-card-edit" hidden>' +
          '<label class="admin-field"><span class="tg-label">Name</span>' +
            '<input class="admin-input admin-input--role-name role-edit-name" type="text" value="' + escapeHtml(role.name) + '" /></label>' +
          '<label class="admin-field admin-form-grow"><span class="tg-label">Description</span>' +
            '<input class="admin-input admin-input--full role-edit-desc" type="text" value="' + escapeHtml(role.description) + '" /></label>' +
          '<div class="role-card-edit-actions">' +
            '<button class="btn btn-accent role-save-btn" type="button">Save</button>' +
            '<button class="btn role-cancel-btn" type="button" style="font-size:13px;">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<div class="role-perms"></div>');
  if (role.is_super) return card;

  var perms = card.querySelector(".role-perms");
  /* Every card lists the same checkboxes: the group's name says which role they change. */
  perms.setAttribute("role", "group");
  perms.setAttribute("aria-label", "Permissions of " + role.name);
  st.roleData.permissions.forEach(function(perm) {
    var label = document.createElement("label");
    label.className = "role-perm";
    label.title = (perm.description ? perm.description + " " : "") + "(" + perm.key + ")";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = role.permissions.has(perm.key);
    var text = document.createElement("span");
    text.textContent = perm.label;
    label.append(box, text);
    /* The title is not read for the checkbox: screen readers get the description from a
     * hidden copy (hidden, so it is not also read as part of the name). */
    if (perm.description) {
      var desc = document.createElement("span");
      desc.id = "perm-" + role.id + "-" + perm.key.replace(/[^\w-]/g, "_");
      desc.hidden = true;
      desc.textContent = perm.description;
      label.append(desc);
      box.setAttribute("aria-describedby", desc.id);
    }
    box.addEventListener("change", function() { toggleRolePermission(role, perm, box); });
    perms.appendChild(label);
  });

  var edit = card.querySelector(".role-card-edit");
  var nameInput = card.querySelector(".role-edit-name");
  var descInput = card.querySelector(".role-edit-desc");
  var editBtn = card.querySelector(".role-edit-btn");
  editBtn.addEventListener("click", function() {
    edit.hidden = !edit.hidden;
    editBtn.setAttribute("aria-expanded", String(!edit.hidden));
    if (!edit.hidden) nameInput.focus();
  });
  card.querySelector(".role-cancel-btn").addEventListener("click", function() {
    nameInput.value = role.name;
    descInput.value = role.description;
    edit.hidden = true;
    editBtn.setAttribute("aria-expanded", "false");
    editBtn.focus(); // the form closed around this Cancel button
  });
  card.querySelector(".role-save-btn").addEventListener("click", function() { saveRole(role, card); });
  [nameInput, descInput].forEach(function(input) {
    input.addEventListener("keydown", function(e) { if (e.key === "Enter") saveRole(role, card); });
  });
  card.querySelector(".role-del-btn").addEventListener("click", function() { deleteRole(role, card); });
  return card;
}

/* Grants or removes one permission of a role (never the super role, which has no checkboxes). */
async function toggleRolePermission(role, perm, box) {
  var grant = box.checked;
  box.disabled = true;
  try {
    if (grant) {
      await adminRequest("/rest/v1/role_permissions", {
        method: "POST",
        body: { role_id: role.id, permission_key: perm.key },
        prefer: "resolution=ignore-duplicates,return=minimal",
      });
      role.permissions.add(perm.key);
    } else {
      await adminRequest(
        "/rest/v1/role_permissions?role_id=eq." + encodeURIComponent(role.id) + "&permission_key=eq." + encodeURIComponent(perm.key),
        { method: "DELETE", mustMatch: true }
      );
      role.permissions.delete(perm.key);
    }
    writeLog("Role updated", role.name + ": " + (grant ? "granted" : "removed") + ' "' + perm.label + '"');
  } catch (e) {
    box.checked = !grant;
    alert(errorText(e, grant ? "grant this permission" : "remove this permission"));
  } finally {
    box.disabled = false;
  }
}

async function saveRole(role, card) {
  var btn = card.querySelector(".role-save-btn");
  if (btn.disabled) return;
  var name = card.querySelector(".role-edit-name").value.trim();
  var description = card.querySelector(".role-edit-desc").value.trim();
  if (!name) { alert("Enter a role name."); return; }
  if (name === role.name && description === role.description) {
    card.querySelector(".role-card-edit").hidden = true;
    var editBtn = card.querySelector(".role-edit-btn");
    editBtn.setAttribute("aria-expanded", "false");
    editBtn.focus(); // the form closed around the focused field or button
    return;
  }
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    var rows = await adminRequest("/rest/v1/roles?id=eq." + encodeURIComponent(role.id), {
      method: "PATCH",
      body: { name: name, description: description },
      mustMatch: true,
    });
    var oldName = role.name, oldDescription = role.description;
    role.name = String(rows[0].name ?? name);
    role.description = String(rows[0].description ?? description);
    var changes = [];
    if (role.name !== oldName) changes.push('renamed from "' + oldName + '"');
    if (role.description !== oldDescription) changes.push("description changed");
    writeLog("Role updated", role.name + ": " + (changes.join(", ") || "saved"));
    st.roleData.roles.sort(compareRoles);
    renderRoles();
    /* The card was drawn again: focus goes back to its Edit button. */
    restoreFocus(document.querySelector('#roleList [data-role-id="' + CSS.escape(String(role.id)) + '"] .role-edit-btn'));
  } catch (e) {
    alert(errorText(e, "edit roles", "A role with this name already exists."));
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

async function deleteRole(role, card) {
  if (!confirm('Delete role "' + role.name + '"?')) return;
  card.style.opacity = "0.4";
  try {
    await adminRequest("/rest/v1/roles?id=eq." + encodeURIComponent(role.id), { method: "DELETE", mustMatch: true });
    writeLog("Role deleted", role.name);
    var list = document.getElementById("roleList");
    var index = Array.prototype.indexOf.call(list.children, card);
    /* By id: st.roleData may have been loaded again since this card was drawn. */
    st.roleData.roles = st.roleData.roles.filter(function(r) { return r.id !== role.id; });
    st.roleData.byId.delete(role.id);
    renderRoles();
    focusAfterDelete(list, index, document.querySelector("#sectionRoles h2"));
  } catch (e) {
    card.style.opacity = "1";
    alert(errorText(e, "delete roles", "Role is still assigned to users."));
  }
}

async function createRole() {
  var nameEl = document.getElementById("newRoleName");
  var descEl = document.getElementById("newRoleDesc");
  var btn = document.getElementById("createRoleBtn");
  if (btn.disabled) return;
  var name = nameEl.value.trim();
  var description = descEl.value.trim();
  if (!name) { showFormMessage("createRoleMsg", "Enter a role name.", true); return; }
  btn.disabled = true;
  btn.textContent = "Creating…";
  var created = false;
  try {
    await adminRequest("/rest/v1/roles", { method: "POST", body: { name: name, description: description } });
    created = true;
    writeLog("Role created", name);
    nameEl.value = "";
    descEl.value = "";
    showFormMessage("createRoleMsg", "✓ " + name + " created. Choose its permissions below.", false);
  } catch (e) {
    showFormMessage("createRoleMsg", errorText(e, "create roles", "A role with this name already exists."), true);
  } finally {
    btn.disabled = false;
    btn.textContent = "+ Create role";
  }
  if (created) loadRolesTab();
}

/* ===== Boot ===== */
loginBtn.addEventListener("click", tryLogin);
if (emailInput) emailInput.addEventListener("keydown", function(e) { if (e.key === "Enter") passwordInput.focus(); });
passwordInput.addEventListener("keydown", function(e) { if (e.key === "Enter") tryLogin(); });
if (logoutBtn) logoutBtn.addEventListener("click", logout);
if (adminSearch) adminSearch.addEventListener("input", debounce(function() {
  st.searchQuery = adminSearch.value; renderList();
}, 120));

document.addEventListener("DOMContentLoaded", function() {
  /* Tab buttons */
  TAB_IDS.forEach(function(key) {
    var btn = document.getElementById(tabDomId("tab", key));
    if (btn) btn.addEventListener("click", function() { switchTab(key); });
  });
  var saveFormulaBtn = document.getElementById("saveFormulaBtn");
  if (saveFormulaBtn) saveFormulaBtn.addEventListener("click", saveFormulaSettings);

  /* Users and Roles forms: the button, or Enter in a field, submits */
  [["createUserBtn", createUser, ["newUserEmail", "newUserPassword"]],
   ["createRoleBtn", createRole, ["newRoleName", "newRoleDesc"]]].forEach(function(form) {
    var btn = document.getElementById(form[0]);
    if (btn) btn.addEventListener("click", form[1]);
    form[2].forEach(function(id) {
      var input = document.getElementById(id);
      if (input) input.addEventListener("keydown", function(e) { if (e.key === "Enter") form[1](); });
    });
  });

  /* Add new player */
  var addPlayerBtn = document.getElementById("addPlayerBtn");
  if (addPlayerBtn) addPlayerBtn.addEventListener("click", addNewPlayer);

  /* Export CSV button */
  var exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportCSV);

  /* Clear log button */
  var clearLogBtnEl = document.getElementById("clearLogBtn");
  if (clearLogBtnEl) clearLogBtnEl.addEventListener("click", clearLog);

  /* New achievement form */
  var addAchBtn    = document.getElementById("addAchBtn");
  var addAchForm   = document.getElementById("addAchForm");
  var achSaveBtn   = document.getElementById("achSaveBtn");
  var achCancelBtn = document.getElementById("achCancelBtn");
  var achIconInput = document.getElementById("achIconInput");
  var achIconName  = document.getElementById("achIconName");

  if (addAchBtn) addAchBtn.addEventListener("click", function() {
    addAchBtn.setAttribute("aria-expanded", String(addAchForm.classList.toggle("open")));
  });
  if (achCancelBtn) achCancelBtn.addEventListener("click", function() {
    addAchForm.classList.remove("open");
    document.getElementById("achNameInput").value = "";
    document.getElementById("achUrlInput").value = "";
    achIconInput.value = ""; achIconName.textContent = "No file";
    addAchBtn.setAttribute("aria-expanded", "false");
    addAchBtn.focus(); // the form closed around this Cancel button
  });
  if (achIconInput) achIconInput.addEventListener("change", function() {
    achIconName.textContent = achIconInput.files[0] ? achIconInput.files[0].name : "No file";
  });
  if (achSaveBtn) achSaveBtn.addEventListener("click", function() {
    var name = document.getElementById("achNameInput").value.trim();
    var url  = document.getElementById("achUrlInput").value.trim();
    var file = achIconInput.files[0];
    if (!name) { alert("Enter achievement name."); return; }
    if (url && !safeUrl(url)) { alert("The link must be an http:// or https:// URL."); return; }
    if (!file) { alert("Choose an icon image."); return; }
    createAchievement(name, url, file);
  });
});

/* The old cookie gate is gone; remove its leftover cookies. */
["esb_admin", "esb_admin_email"].forEach(function(name) {
  document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

st.session = readStoredSession();
if (st.session) {
  resumeSession();
} else {
  if (emailInput) emailInput.focus();
}

/* ===== Delete Player ===== */
async function deletePlayer(nick, rowEl) {
  if (rowEl) rowEl.style.opacity = "0.4";
  try {
    await adminRequest("/rest/v1/player_config?nickname=eq." + encodeURIComponent(nick), { method: "DELETE", mustMatch: true });
    writeLog("Player deleted", nick);
    st.players = st.players.filter(function(p) { return p.nick !== nick; });
    if (rowEl) {
      var index = Array.prototype.indexOf.call(playerList.children, rowEl);
      rowEl.remove();
      focusAfterDelete(playerList, index, adminSearch); // the tab has no heading
    }
    updateStats();
  } catch (e) {
    if (rowEl) rowEl.style.opacity = "1";
    alert(refusalText(e, "delete players") || "Error: " + e.message);
  }
}

/* ===== Add New Player ===== */
async function addNewPlayer() {
  var nickInput   = document.getElementById("newPlayerNick");
  var ratingInput = document.getElementById("newPlayerRating");
  var msg         = document.getElementById("addPlayerMsg");
  var btn         = document.getElementById("addPlayerBtn");

  var nick   = (nickInput ? nickInput.value.trim() : "");
  var rating = parseFloat(ratingInput ? ratingInput.value : "");

  if (!nick) { showAddMsg("Enter a nickname.", "error"); return; }
  if (!isFinite(rating) || rating < 0) { showAddMsg("Enter a valid starting rating.", "error"); return; }
  if (st.players.some(function(p) { return p.nick === nick; })) { showAddMsg(nick + " already exists.", "error"); return; }

  btn.disabled = true; btn.textContent = "Adding…";

  try {
    await adminRequest("/rest/v1/player_config", {
      method: "POST",
      body: { nickname: nick, initial_rating: rating, active: true },
    });

    writeLog("Player added", nick + " (rating: " + rating + ")");
    st.players.push({ nick: nick, rating: rating, series: [], ends: [] });
    sortPlayers();
    renderList();
    showAddMsg("✓ " + nick + " added!", "success");
    if (nickInput) nickInput.value = "";
    if (ratingInput) ratingInput.value = "";
  } catch (e) {
    showAddMsg(e.status === 409 ? nick + " already exists." : refusalText(e, "add players") || "Error: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "+ Add Player";
  }

  /* #addPlayerMsg is a status region; empty, it takes no room. An error stays until the next
   * try (there is time to read it), a success clears itself. */
  function showAddMsg(text, type) {
    if (!msg) return;
    clearTimeout(msg._hideTimer);
    msg.textContent = text;
    msg.style.color = type === "error" ? "#ff7676" : "var(--accent)";
    if (type !== "error") msg._hideTimer = setTimeout(function() { msg.textContent = ""; }, 3000);
  }
}
