/* ============================================================
 * ESportsBattle Rank — Rating Engine
 * Fetches data from Supabase, calculates ratings.
 * Uses SUPABASE, sbHeaders, safeColor, groupForRating and localIsoDate from common.js.
 * ============================================================ */
"use strict";

/* ================== SUPABASE HELPERS ================== */
async function sbFetch(path) {
  const res = await fetch(`${SUPABASE.URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${path}`);
  return res.json();
}

/* Fetch all rows with pagination (Supabase default limit = 1000).
 * `order` must be deterministic (end with a unique column) so pages never overlap. */
async function sbFetchAll(table, select = "*", order = "") {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const orderParam = order ? `&order=${order}` : "";
    const data = await sbFetch(
      `${table}?select=${select}${orderParam}&limit=${pageSize}&offset=${offset}`
    );
    rows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

/* ================== LOAD DATA ================== */
async function loadEngineData() {
  const [matches, players, adjustments, settings, groups] = await Promise.all([
    fetchMatchesFromSheets(),
    sbFetchAll("player_config", "*", "nickname.asc"),
    sbFetchAll("rating_adjustments", "*", "applied_date.asc,id.asc"),
    sbFetchAll("settings", "*", "key.asc"),
    sbFetchAll("rating_groups", "id,name,min_rating,color,coef", "min_rating.desc,id.asc"),
  ]);

  const settingsMap = {};
  settings.forEach((s) => (settingsMap[s.key] = s.value));

  return { matches, players, adjustments, settingsMap, groups };
}

/* ================== RATING GROUPS ==================
 * rating_groups rows (min_rating) or already normalized groups (min) ->
 * [{ id, name, min, color, coef }] sorted by min descending. Rows without a finite
 * minimum are dropped; a missing or non-positive coef counts as 1. Idempotent. */
function normalizeGroups(rows) {
  const toNumber = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  return (Array.isArray(rows) ? rows : [])
    .filter((g) => g && typeof g === "object")
    .map((g) => {
      const coef = toNumber(g.coef);
      return {
        id: g.id ?? null,
        name: String(g.name ?? ""),
        min: toNumber(g.min_rating ?? g.min),
        color: safeColor(g.color),
        coef: Number.isFinite(coef) && coef > 0 ? coef : 1,
      };
    })
    .filter((g) => Number.isFinite(g.min))
    .sort((a, b) => b.min - a.min);
}

/* ================== RATING ENGINE ================== */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/*
 * computeRatings()
 * Days are the sorted union of match dates and adjustment dates. For each day: apply that
 * day's adjustments (in the given order, last one wins per player), play that day's matches
 * in source-row order, then snapshot every rated player.
 * Returns:
 *   leaderboard: [ { rank, nickname, rating, group } ]
 *   history: { nickname: entries[] } (null-prototype object; every player_config nickname)
 *     end of day:   { date, rating, games }
 *     start of day: { date, rating, start: true, reset }, right before the end entry, only
 *                   on days the player's rating was set by an adjustment (rating = value
 *                   after the adjustments; reset = one of them was a monthly_reset)
 *   groups: normalized rating groups (see normalizeGroups)
 * options.applyUntil ("YYYY-MM-DD"): adjustments dated after it are not applied yet, so a
 * reset saved ahead of time waits for its month. Omit it to apply every adjustment.
 */
function computeRatings(matches, players, adjustments, settingsMap, groups, options = {}) {
  const applyUntil = options.applyUntil ?? null;
  const ratingGroups = normalizeGroups(groups);
  if (!ratingGroups.length) throw new Error("No rating groups configured");

  const numberSetting = (key, fallback) => {
    const value = Number(String(settingsMap[key] ?? fallback).replace(",", "."));
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const WIN_MIN = numberSetting("WinMin", 3);
  const WIN_MAX = numberSetting("WinMax", 3);
  const DRAW_MIN = numberSetting("DrawMin", 1);
  const DRAW_MAX = numberSetting("DrawMax", 1);

  function basePoints(min, max, match, salt) {
    // Mirrors hash32_ and basePoints_ in the supplied Apps Script.
    const signature = match.signature ?? `${match.date}|#${match.rowIndex ?? 0}|${match.player1}|${match.player2}|${match.score1 ?? ""}|${match.score2 ?? ""}`;
    let hash = 2166136261;
    const input = `${signature}|${salt}`;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash |= 0;
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    if (lo === hi) return lo;
    return lo + (Math.abs(hash) % (hi - lo + 1));
  }

  /* Only player_config nicknames take part. Rated players (current) start from an explicit
   * initial rating, or join when an adjustment sets their rating. */
  const configured = new Set();
  const current = new Map();
  const history = Object.create(null);
  players.forEach((p) => {
    configured.add(p.nickname);
    history[p.nickname] = [];
    const rating = Number(p.initial_rating);
    if (p.initial_rating !== null && p.initial_rating !== "" && Number.isFinite(rating)) {
      current.set(p.nickname, rating);
    }
  });
  const coefFor = (nickname) => groupForRating(current.get(nickname), ratingGroups).coef;

  /* Adjustments index: date -> [ { nickname, rating, reset } ] in fetched order */
  const adjByDate = new Map();
  adjustments.forEach((a) => {
    const rating = Number(a.new_rating);
    if (!configured.has(a.nickname)) return;
    if (typeof a.applied_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.applied_date)) return;
    if (applyUntil && a.applied_date > applyUntil) return;
    if (a.new_rating === null || a.new_rating === "" || !Number.isFinite(rating)) return;
    if (!adjByDate.has(a.applied_date)) adjByDate.set(a.applied_date, []);
    adjByDate.get(a.applied_date).push({ nickname: a.nickname, rating, reset: a.reason === "monthly_reset" });
  });

  /* Matches index: date -> matches in source-row order */
  const matchesByDate = new Map();
  matches.forEach((m) => {
    if (!matchesByDate.has(m.date)) matchesByDate.set(m.date, []);
    matchesByDate.get(m.date).push(m);
  });

  /* Build suspension set for quick lookup */
  const suspended = players.filter((p) => p.suspended_from).map((p) => ({
    nickname: p.nickname,
    from: p.suspended_from,
    to: p.suspended_to,
  }));

  function isSuspended(nickname, dateStr) {
    return suspended.some(
      (s) =>
        s.nickname === nickname &&
        dateStr >= s.from &&
        (!s.to || dateStr <= s.to)
    );
  }

  function playMatch(m) {
    const s1 = m.score1;
    const s2 = m.score2;
    const p1 = m.player1;
    const p2 = m.player2;

    if (s1 > s2) {
      /* P1 wins */
      const delta = basePoints(WIN_MIN, WIN_MAX, m, "W") * coefFor(p1);
      current.set(p1, current.get(p1) + delta);
      current.set(p2, current.get(p2) - delta);
    } else if (s2 > s1) {
      /* P2 wins */
      const delta = basePoints(WIN_MIN, WIN_MAX, m, "W") * coefFor(p2);
      current.set(p2, current.get(p2) + delta);
      current.set(p1, current.get(p1) - delta);
    } else {
      /* Draw */
      const c1 = coefFor(p1);
      const c2 = coefFor(p2);
      const points = basePoints(DRAW_MIN, DRAW_MAX, m, "D");
      if (c1 === c2) {
        current.set(p1, current.get(p1) + points);
        current.set(p2, current.get(p2) + points);
      } else {
        const weakerCoef = Math.max(c1, c2);
        const weaker  = c1 > c2 ? p1 : p2;
        const stronger = c1 > c2 ? p2 : p1;
        current.set(weaker, current.get(weaker) + points * weakerCoef);
        current.set(stronger, current.get(stronger) + points / weakerCoef);
      }
    }
  }

  const days = [...new Set([...matchesByDate.keys(), ...adjByDate.keys()])].sort();

  for (const date of days) {
    /* 1. Adjustments that take effect on this date (start of day) */
    const starts = new Map(); // nickname -> { rating, reset } after the day's adjustments
    for (const a of adjByDate.get(date) ?? []) {
      current.set(a.nickname, a.rating);
      starts.set(a.nickname, { rating: a.rating, reset: a.reset || Boolean(starts.get(a.nickname)?.reset) });
    }

    /* 2. The day's matches, in source-row order */
    const games = new Map(); // nickname -> matches counted today
    for (const m of matchesByDate.get(date) ?? []) {
      /* Only rated players participate. */
      if (!current.has(m.player1) || !current.has(m.player2)) continue;

      /* Skip if either player is suspended */
      if (isSuspended(m.player1, date) || isSuspended(m.player2, date)) continue;

      playMatch(m);
      games.set(m.player1, (games.get(m.player1) ?? 0) + 1);
      games.set(m.player2, (games.get(m.player2) ?? 0) + 1);
    }

    /* 3. Snapshot every rated player */
    current.forEach((rating, nick) => {
      const series = history[nick] ?? (history[nick] = []);
      const start = starts.get(nick);
      if (start) series.push({ date, rating: round2(start.rating), start: true, reset: start.reset });
      series.push({ date, rating: round2(rating), games: games.get(nick) ?? 0 });
    });
  }

  /* Build final sorted leaderboard */
  const leaderboard = [...current]
    .sort(([nameA, ratingA], [nameB, ratingB]) => {
      const delta = round2(ratingB) - round2(ratingA);
      return delta || nameA.localeCompare(nameB, "ru");
    })
    .map(([nickname, rating], i) => ({
      rank: i + 1,
      nickname,
      rating: round2(rating),
      group: groupForRating(rating, ratingGroups),
    }));

  return { leaderboard, history, groups: ratingGroups };
}

/* ================== MAIN EXPORT ================== */
async function buildRatings() {
  const { matches, players, adjustments, settingsMap, groups } =
    await loadEngineData();
  /* Apply adjustments up to today (or the last match day, if the sheet is ahead of the clock). */
  const lastMatchDate = matches.length ? matches[matches.length - 1].date : "";
  const today = localIsoDate();
  const applyUntil = lastMatchDate > today ? lastMatchDate : today;
  return computeRatings(matches, players, adjustments, settingsMap, groups, { applyUntil });
}
