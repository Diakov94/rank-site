/* ============================================================
 * ESportsBattle Rank — Rating Engine
 * Fetches data from Supabase, calculates ratings.
 * ============================================================ */
"use strict";

const ENGINE_SUPABASE = Object.freeze({
  URL: "https://vgmwxtpsbwzeqwtpxamo.supabase.co",
  KEY: "sb_publishable_RjvZCtsriMO6nGDASJkcbg_estuVZyq",
});

/* ================== SUPABASE HELPERS ================== */
async function sbFetch(path) {
  const res = await fetch(`${ENGINE_SUPABASE.URL}/rest/v1/${path}`, {
    headers: {
      apikey: ENGINE_SUPABASE.KEY,
      Authorization: `Bearer ${ENGINE_SUPABASE.KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${path}`);
  return res.json();
}

/* Fetch all rows with pagination (Supabase default limit = 1000) */
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
    sbFetchAll("player_config", "*"),
    sbFetchAll("rating_adjustments", "*", "applied_date.asc,id.asc"),
    sbFetchAll("settings", "*"),
    sbFetchAll("rating_groups", "name,min_rating,color,coef", "min_rating.desc"),
  ]);

  const settingsMap = {};
  settings.forEach((s) => (settingsMap[s.key] = s.value));

  return { matches, players, adjustments, settingsMap, groups };
}

/* ================== RATING ENGINE ================== */
function groupCoef(rating, groups) {
  for (const g of groups) {
    if (rating >= g.min_rating) return g.coef;
  }
  return groups[groups.length - 1].coef;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/*
 * computeRatings()
 * Returns:
 *   players: { nickname: { rating, group, rank } }
 *   history: { nickname: [ { date, rating } ] }  — one snapshot per match day
 */
function computeRatings(matches, players, adjustments, settingsMap, groups) {
  const numberSetting = (key, fallback) => {
    const value = Number(String(settingsMap[key] ?? fallback).replace(",", "."));
    return Number.isFinite(value) ? value : fallback;
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

  /* Build initial ratings map */
  const current = {};
  players.forEach((p) => {
    const rating = Number(p.initial_rating);
    if (p.initial_rating !== null && p.initial_rating !== "" && Number.isFinite(rating)) {
      current[p.nickname] = rating;
    }
  });

  /* Build adjustments index: date -> [ {nickname, new_rating} ] */
  const adjByDate = {};
  adjustments.forEach((a) => {
    if (!adjByDate[a.applied_date]) adjByDate[a.applied_date] = [];
    adjByDate[a.applied_date].push(a);
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

  /* History snapshots: nickname -> [ {date, rating, reset?} ] */
  const history = {};
  players.forEach((p) => (history[p.nickname] = []));

  /* Track last date to emit snapshots per day */
  let lastDate = null;
  const resetDates = new Set(); // dates where monthly_reset was applied

  /* resetValues stores the rating each player was reset TO at start of day */
  const resetValues = {};

  function snapshotAll(date) {
    const isReset = resetDates.has(date);
    Object.keys(current).forEach((nick) => {
      if (!history[nick]) history[nick] = [];
      const entry = { date, rating: round2(current[nick]) };
      if (isReset) {
        entry.reset = true;
        if (resetValues[nick] != null) entry.resetFrom = round2(resetValues[nick]);
      }
      history[nick].push(entry);
    });
    if (isReset) Object.keys(resetValues).forEach((k) => delete resetValues[k]);
  }

  /* Process matches in order */
  for (const m of matches) {
    const dateStr = m.date; // YYYY-MM-DD

    /* New day — apply adjustments for this date, then snapshot previous day */
    if (dateStr !== lastDate) {
      if (lastDate !== null) snapshotAll(lastDate);

      /* Apply adjustments that take effect on this date */
      const dayAdj = adjByDate[dateStr] || [];
      dayAdj.forEach((a) => {
        current[a.nickname] = a.new_rating;
        if (!history[a.nickname]) history[a.nickname] = [];
        resetValues[a.nickname] = a.new_rating;
      });
      if (dayAdj.some((a) => a.reason === "monthly_reset")) {
        resetDates.add(dateStr);
      }

      lastDate = dateStr;
    }

    /* Only players with an explicitly configured starting rating participate. */
    if (!(m.player1 in current) || !(m.player2 in current)) continue;

    /* Skip if either player is suspended */
    if (isSuspended(m.player1, dateStr) || isSuspended(m.player2, dateStr))
      continue;

    const s1 = m.score1;
    const s2 = m.score2;
    const p1 = m.player1;
    const p2 = m.player2;

    const c1 = groupCoef(current[p1], groups);
    const c2 = groupCoef(current[p2], groups);
    if (s1 > s2) {
      /* P1 wins */
      const coef = groupCoef(current[p1], groups);
      const delta = basePoints(WIN_MIN, WIN_MAX, m, "W") * coef;
      current[p1] += delta;
      current[p2] -= delta;
    } else if (s2 > s1) {
      /* P2 wins */
      const coef = groupCoef(current[p2], groups);
      const delta = basePoints(WIN_MIN, WIN_MAX, m, "W") * coef;
      current[p2] += delta;
      current[p1] -= delta;
    } else {
      /* Draw */
      const c1 = groupCoef(current[p1], groups);
      const c2 = groupCoef(current[p2], groups);
      const points = basePoints(DRAW_MIN, DRAW_MAX, m, "D");
      if (c1 === c2) {
        current[p1] += points;
        current[p2] += points;
      } else {
        const weakerCoef = Math.max(c1, c2);
        const weaker  = c1 > c2 ? p1 : p2;
        const stronger = c1 > c2 ? p2 : p1;
        current[weaker]   += points * weakerCoef;
        current[stronger] += points / weakerCoef;
      }
    }
  }

  /* Snapshot last day */
  if (lastDate) snapshotAll(lastDate);

  /* Build final sorted leaderboard */
  const sorted = Object.entries(current)
    .sort(([nameA, ratingA], [nameB, ratingB]) => {
      const delta = round2(ratingB) - round2(ratingA);
      return delta || nameA.localeCompare(nameB, "ru");
    })
    .map(([nickname, rating], i) => ({
      rank: i + 1,
      nickname,
      rating: round2(rating),
      group: getRatingGroup(rating, groups),
    }));

  return { leaderboard: sorted, history, current };
}

function getRatingGroup(rating, groups) {
  for (const g of groups) {
    if (rating >= g.min_rating) return g;
  }
  return groups[groups.length - 1];
}

/* ================== MAIN EXPORT ================== */
async function buildRatings() {
  const { matches, players, adjustments, settingsMap, groups } =
    await loadEngineData();
  return computeRatings(matches, players, adjustments, settingsMap, groups);
}
