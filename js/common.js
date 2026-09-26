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

/* ================== AVATARS ================== */
function avatarUrl(nick) {
  return `${SUPABASE.URL}/storage/v1/object/public/${SUPABASE.AVATAR_BUCKET}/${encodeURIComponent(nick)}.png`;
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

/* ================== RATING HELPERS ================== */
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
  const month = series.filter((p) => p.date >= monthStart);
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
