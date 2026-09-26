/* ============================================================
 * ESportsBattle Rank — Rating Engine
 * Fetches data from Supabase, calculates ratings.
 * Uses SUPABASE, sbHeaders, safeColor, numberOrNaN, groupForRating, compareRanking,
 * workDayOf, workDayOffset and adjustmentMoment from common.js.
 * ============================================================ */
"use strict";

/* ================== SUPABASE HELPERS ================== */
async function sbFetch(path) {
  const res = await fetch(`${SUPABASE.URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${path}`);
  return res.json();
}

/* Fetch all rows with pagination (Supabase default limit = 1000).
 * `order` must be deterministic (end with a unique column) so pages never overlap.
 * `fetchPage(path)` defaults to the public read; the admin panel passes its own. */
async function sbFetchAll(table, select = "*", order = "", fetchPage = sbFetch) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const orderParam = order ? `&order=${order}` : "";
    const data = await fetchPage(
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
 * rating_groups rows -> [{ id, name, min, color, coef }] sorted by min descending. Rows
 * without a finite min_rating are dropped; a missing or non-positive coef counts as 1. */
function normalizeGroups(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((g) => g && typeof g === "object")
    .map((g) => {
      const coef = numberOrNaN(g.coef);
      return {
        id: g.id ?? null,
        name: String(g.name ?? ""),
        min: numberOrNaN(g.min_rating),
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
 * Days are work days (07:30 -> 07:30 Kyiv, see common.js): the sorted union of match dates
 * and adjustment dates. Every adjustment sets an absolute rating. For each day:
 *   1. start-of-day adjustments (adjustmentMoment(a) is null: a monthly_reset, a row
 *      without created_at, or one saved on another work day than its applied_date) apply
 *      in the given order, last one wins per player;
 *   2. the day's matches play in source-row order. A moment adjustment (saved during its own
 *      work day) applies right before the first match whose time is at or after the moment
 *      it was saved, or after the day's last match if there is none; a match without a time
 *      never triggers one. Several apply in (moment, given) order;
 *   3. every rated player is snapshotted.
 * Returns:
 *   leaderboard: [ { rank, nickname, rating, group } ]
 *   history: { nickname: entries[] } (null-prototype object; every player_config nickname)
 *     Per processed day, in this order:
 *     start of day: { date, rating, start: true, reset }, only on days the player's rating
 *                   was set by a start-of-day adjustment (rating = value after them;
 *                   reset = one of them was a monthly_reset)
 *     adjusted:     { date, rating, adjusted: true, from, time }, one per moment adjustment
 *                   of the player (rating = value set, from = rating just before it or
 *                   null, time = "HH:MM" Kyiv)
 *     end of day:   { date, rating, games }, always last
 *   groups: normalized rating groups (see normalizeGroups)
 * options.applyUntil ("YYYY-MM-DD"): adjustments dated after it are not applied yet, so a
 * reset saved ahead of time waits for its month. Omit it to apply every adjustment.
 */
function computeRatings(matches, players, adjustments, settingsMap, groups, options = {}) {
  const applyUntil = options.applyUntil ?? null;
  const ratingGroups = normalizeGroups(groups);
  if (!ratingGroups.length) throw new Error("No rating groups configured");

  const numberSetting = (key, fallback) => {
    const value = numberOrNaN(String(settingsMap[key] ?? "").trim().replace(",", "."));
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const WIN_MIN = numberSetting("WinMin", 3);
  const WIN_MAX = numberSetting("WinMax", 3);
  const DRAW_MIN = numberSetting("DrawMin", 1);
  const DRAW_MAX = numberSetting("DrawMax", 1);

  function basePoints(min, max, match, salt) {
    // Mirrors hash32_ and basePoints_ in the supplied Apps Script.
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    if (lo === hi) return lo; // a fixed value needs no hash
    const signature = match.signature ?? `${match.date}|#${match.rowIndex ?? 0}|${match.player1}|${match.player2}|${match.score1 ?? ""}|${match.score2 ?? ""}`;
    let hash = 2166136261;
    const input = `${signature}|${salt}`;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash |= 0;
    return lo + (Math.abs(hash) % (Math.round(hi - lo) + 1)); // max − min is a whole number
  }

  /* Only player_config nicknames take part. Rated players (current) start from an explicit
   * initial rating, or join when an adjustment sets their rating. */
  const current = new Map();
  const history = Object.create(null); // its keys are the configured nicknames
  players.forEach((p) => {
    history[p.nickname] = [];
    const rating = numberOrNaN(p.initial_rating);
    if (Number.isFinite(rating)) current.set(p.nickname, rating);
  });
  const coefFor = (nickname) => groupForRating(current.get(nickname), ratingGroups).coef;

  /* Adjustments index: date -> { starts, moments }. starts: [ { nickname, rating, reset } ]
   * in fetched order; moments: [ { nickname, rating, offset, time } ] by (offset, fetched order). */
  const adjByDate = new Map();
  adjustments.forEach((a) => {
    const rating = numberOrNaN(a.new_rating);
    if (!(a.nickname in history)) return;
    if (typeof a.applied_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.applied_date)) return;
    if (applyUntil && a.applied_date > applyUntil) return;
    if (!Number.isFinite(rating)) return;
    if (!adjByDate.has(a.applied_date)) adjByDate.set(a.applied_date, { starts: [], moments: [] });
    const day = adjByDate.get(a.applied_date);
    const moment = adjustmentMoment(a);
    if (moment) day.moments.push({ nickname: a.nickname, rating, offset: moment.offset, time: moment.time });
    else day.starts.push({ nickname: a.nickname, rating, reset: a.reason === "monthly_reset" });
  });
  adjByDate.forEach((day) => day.moments.sort((x, y) => x.offset - y.offset)); // stable

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
    const dayAdj = adjByDate.get(date) ?? { starts: [], moments: [] };

    /* 1. Adjustments that take effect at the start of this work day */
    const starts = new Map(); // nickname -> { rating, reset } after the day's start adjustments
    for (const a of dayAdj.starts) {
      current.set(a.nickname, a.rating);
      starts.set(a.nickname, { rating: a.rating, reset: a.reset || Boolean(starts.get(a.nickname)?.reset) });
    }

    /* Moment adjustments, applied during the day: nickname -> adjusted entries */
    const adjusted = new Map();
    let nextMoment = 0;
    const applyMomentsUntil = (offset) => {
      while (nextMoment < dayAdj.moments.length && dayAdj.moments[nextMoment].offset <= offset) {
        const a = dayAdj.moments[nextMoment++];
        const from = current.has(a.nickname) ? round2(current.get(a.nickname)) : null;
        current.set(a.nickname, a.rating);
        if (!adjusted.has(a.nickname)) adjusted.set(a.nickname, []);
        adjusted.get(a.nickname).push({ date, rating: round2(a.rating), adjusted: true, from, time: a.time });
      }
    };

    /* 2. The day's matches, in source-row order */
    const games = new Map(); // nickname -> matches counted today
    for (const m of matchesByDate.get(date) ?? []) {
      /* Moment adjustments saved at or before this match's time (an untimed match never triggers one) */
      if (nextMoment < dayAdj.moments.length) {
        const offset = workDayOffset(m.time);
        if (offset !== null) applyMomentsUntil(offset);
      }

      /* Only rated players participate. */
      if (!current.has(m.player1) || !current.has(m.player2)) continue;

      /* Skip if either player is suspended */
      if (isSuspended(m.player1, date) || isSuspended(m.player2, date)) continue;

      playMatch(m);
      games.set(m.player1, (games.get(m.player1) ?? 0) + 1);
      games.set(m.player2, (games.get(m.player2) ?? 0) + 1);
    }
    applyMomentsUntil(Infinity); // saved after the day's last match

    /* 3. Snapshot every rated player: start, adjusted..., end */
    current.forEach((rating, nick) => {
      const series = history[nick];
      const start = starts.get(nick);
      if (start) series.push({ date, rating: round2(start.rating), start: true, reset: start.reset });
      for (const entry of adjusted.get(nick) ?? []) series.push(entry);
      series.push({ date, rating: round2(rating), games: games.get(nick) ?? 0 });
    });
  }

  /* Build final sorted leaderboard */
  /* The group comes from the unrounded rating, the order from the rounded one. */
  const leaderboard = [...current]
    .map(([nick, raw]) => ({ nick, rating: round2(raw), raw }))
    .sort(compareRanking)
    .map(({ nick, rating, raw }, i) => ({
      rank: i + 1,
      nickname: nick,
      rating,
      group: groupForRating(raw, ratingGroups),
    }));

  return { leaderboard, history, groups: ratingGroups };
}

/* ================== MAIN EXPORT ================== */
async function buildRatings() {
  const { matches, players, adjustments, settingsMap, groups } =
    await loadEngineData();
  /* Apply adjustments up to the current work day (or the last match day, if the sheet is
   * ahead of the clock). */
  const lastMatchDate = matches.length ? matches[matches.length - 1].date : "";
  const workDay = workDayOf();
  const applyUntil = lastMatchDate > workDay ? lastMatchDate : workDay;
  return computeRatings(matches, players, adjustments, settingsMap, groups, { applyUntil });
}
