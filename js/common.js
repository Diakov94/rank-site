/* ============================================================
 * ESportsBattle Rank — shared config and helpers
 * Loaded first on both pages (index.html, admin.html) and by the tests.
 * Classic script: every top-level name here is a global.
 * ============================================================ */
"use strict";

/* The publishable key is designed to ship in client code. Row Level Security
 * decides what it can do; see supabase/migrations for the policies. */
const SUPABASE = Object.freeze({
  URL: "https://vgmwxtpsbwzeqwtpxamo.supabase.co",
  KEY: "sb_publishable_RjvZCtsriMO6nGDASJkcbg_estuVZyq",
  AVATAR_BUCKET: "player-avatars",
  ACH_BUCKET: "achievements",
});

/* localStorage key holding the admin's Supabase Auth session (written by admin.js). */
const ADMIN_SESSION_KEY = "esb_admin_session";

/* Headers for Supabase REST/Storage. `token` is a user access token for admin
 * requests; public reads authenticate with the publishable key alone. */
function sbHeaders(token, extra) {
  return { apikey: SUPABASE.KEY, Authorization: `Bearer ${token || SUPABASE.KEY}`, ...extra };
}

/* ================== STORAGE / AVATARS ================== */
function storagePublicUrl(bucket, key) {
  return `${SUPABASE.URL}/storage/v1/object/public/${bucket}/${key}`;
}

/* Object key of a player's avatar in the avatar bucket. */
function avatarKey(nick) {
  return `${encodeURIComponent(nick)}.png`;
}

function avatarUrl(nick) {
  return storagePublicUrl(SUPABASE.AVATAR_BUCKET, avatarKey(nick));
}

function initialsAvatarUrl(nick, size = 64) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(nick)}&background=0b1f17&color=35c07a&size=${size}&bold=true&format=png`;
}

/* Shows the uploaded avatar, falling back to generated initials when there is none. */
function setAvatar(img, nick, size = 64, src = avatarUrl(nick)) {
  img.onerror = () => { img.onerror = null; img.src = initialsAvatarUrl(nick, size); };
  img.src = src;
}

/* ================== SAFE OUTPUT ================== */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* Absolute http(s) URL or "" — keeps javascript: and data: links out of href/src. */
function safeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

/* Hex colour or the fallback — keeps database values out of CSS/HTML injection. */
function safeColor(value, fallback = "#8a94a6") {
  const color = String(value ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
}

/* Number(value), except that null, undefined and "" are NaN rather than 0. */
function numberOrNaN(value) {
  return value === null || value === undefined || value === "" ? NaN : Number(value);
}

/* Shows or hides a full-screen loading overlay and locks page scrolling meanwhile. */
function toggleLoadingOverlay(id, on) {
  document.getElementById(id)?.classList.toggle("hidden", !on);
  document.documentElement.style.overflow = on ? "hidden" : "";
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ================== DATES ==================
 * Rating dates are calendar days as "YYYY-MM-DD" strings. They compare correctly as
 * strings, and the arithmetic below runs in UTC so the viewer's time zone never shifts them. */
function localIsoDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftIsoDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ================== WORK DAY (Kyiv) ==================
 * The firm's work day runs from 07:30 to 07:30 the next morning, Kyiv time. The match
 * sheets already date every row by its work day: rows after midnight keep the previous
 * date, and within a date the rows run in time order from 07:30. */
const WORKDAY_START_SECONDS = (7 * 60 + 30) * 60;
/* Browsers with time-zone data from before 2022 only know the old name "Europe/Kiev"
 * (same zone); without the fallback they would throw here and stop the whole site. */
const KYIV_CLOCK = (() => {
  const options = {
    hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "Europe/Kyiv" });
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "Europe/Kiev" });
  }
})();
const WORK_TIMEZONE = KYIV_CLOCK.resolvedOptions().timeZone;

/* Kyiv wall clock of an instant: { date: "YYYY-MM-DD", time: "HH:MM:SS" }. */
function kyivWallClock(instant = new Date()) {
  const p = {};
  for (const part of KYIV_CLOCK.formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

/* Seconds since the start of the work day (07:30) for a "H:MM" or "H:MM:SS" time, or null. */
function workDayOffset(time) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time ?? "").trim());
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  return (seconds - WORKDAY_START_SECONDS + 86400) % 86400;
}

/* The work day an instant belongs to: a Kyiv time before 07:30 is still the previous day's. */
function workDayOf(instant = new Date()) {
  const { date, time } = kyivWallClock(instant);
  return workDayOffset(time) >= 86400 - WORKDAY_START_SECONDS ? shiftIsoDate(date, -1) : date;
}

/* When a rating_adjustments row takes effect within its work day (applied_date). A monthly
 * reset, or a row dated another work day than the one it was saved on (backdated), applies
 * at the start of that work day: null. Otherwise it applies at the moment it was saved
 * (created_at): { offset: seconds since 07:30, time: "HH:MM" Kyiv time }. */
function adjustmentMoment(a) {
  if (!a || a.reason === "monthly_reset" || !a.created_at) return null;
  const saved = new Date(a.created_at);
  if (Number.isNaN(saved.getTime()) || workDayOf(saved) !== a.applied_date) return null;
  const { time } = kyivWallClock(saved);
  return { offset: workDayOffset(time), time: time.slice(0, 5) };
}

/* ================== RATING HELPERS ================== */
/* Leaderboard order for { nick, rating } rows: rating descending, then nickname in
 * Russian collation. The engine and the public page's history ranks both use it. */
const compareNicks = new Intl.Collator("ru").compare;

function compareRanking(a, b) {
  return (b.rating ?? -Infinity) - (a.rating ?? -Infinity) || compareNicks(a.nick, b.nick);
}

/* A history series without its start-of-day and adjustment entries: one entry per day. */
function endEntries(series) {
  return series.filter((e) => !e.start && !e.adjusted);
}

/* Groups are sorted by `min` descending (see normalizeGroups in engine.js). */
function groupForRating(rating, groups) {
  const lowest = groups[groups.length - 1];
  const r = Number(rating);
  if (!Number.isFinite(r)) return lowest;
  return groups.find((g) => r >= g.min) ?? lowest;
}

/* Rating change over the last `days` days, never reaching back before the start of the
 * latest month, because ratings are reset then. The base is the latest entry on or before
 * the cut-off day; when the cut-off falls before the month, it is the month's first entry,
 * which is the start-of-day reset entry when the engine emitted one. */
function monthDelta(series, days) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  const monthStart = `${last.date.slice(0, 7)}-01`;
  const month = series.filter((p) => p.date >= monthStart && !p.adjusted); // a mid-day set is not a base
  if (month.length < 2) return null;

  const target = shiftIsoDate(last.date, -days);
  let base = month[0];
  if (target >= monthStart) {
    for (let i = 0; i < month.length - 1; i++) {
      if (month[i].date <= target) base = month[i];
    }
  }
  return base === last ? null : last.rating - base.rating;
}
