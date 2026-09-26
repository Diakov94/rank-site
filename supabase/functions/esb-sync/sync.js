/* esb-sync's logic: which days a run covers, reading the ESportsBattle API, inserting the new
 * matches and moving the cursor. index.ts wires it to Deno.serve, fetch and supabase-js; the
 * modes, the caller check and the responses are described there. This file has no imports,
 * so tests/esb-sync.test.js runs it in Node against a fake API and database.
 *
 * Dependencies (all async except now and logError):
 *   fetchJson(url)          -> parsed JSON of a GET to the ESB API; throws on a non-OK status,
 *                              a timeout or a network error
 *   existingIds(ids)        -> { data: [{ external_id }], error } of the matches rows whose
 *                              external_id is in ids
 *   insertMatches(rows)     -> { error } of an insert into matches (one row or an array);
 *                              error is PostgREST's { code, message, details } or null
 *   getCursor()             -> the stored cursor value, or undefined when there is no cursor
 *                              row yet; throws when the read fails
 *   setCursor(date)         saves the cursor; throws when the write fails
 *   now()                   -> milliseconds since the epoch (default Date.now)
 *   logError(text)          optional (default console.error)
 */

const ESB_API = "https://football.esportsbattle.com/api";
const SB_LOCATION_CODE = "ECF-location-1"; // Stamford Bridge
const MAX_DAYS_PER_RUN = 14; // days processed per invocation
export const CURSOR_KEY = "esb_sync_cursor"; // settings table key
const FIRST_DAY = "2026-01-01"; // where the first ever auto run starts
const MATCH_LIST_CONCURRENCY = 4; // ESB match-list requests in flight per day
const IDS_PER_DUPLICATE_CHECK = 200; // external ids per .in() query (keeps the URL short)
const TIME_BUDGET_MS = 100_000; // no new day is started after this (the platform limit is 150 s)
const INSERT_DEADLINE_MS = 130_000; // one-by-one inserts stop here, leaving time to save the cursor
const ERRORS_IN_RESPONSE = 10; // the logs get the whole list

/** "YYYY-MM-DD" → Date (UTC midnight) */
function parseDate(s) {
  return new Date(s + "T00:00:00Z");
}

/** Date → "YYYY-MM-DD" */
function fmtIso(d) {
  return d.toISOString().slice(0, 10);
}

/** True for a real calendar date written as "YYYY-MM-DD" (rejects 2026-02-30). */
function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = parseDate(value);
  return !Number.isNaN(d.getTime()) && fmtIso(d) === value;
}

function addDays(iso, days) {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtIso(d);
}

function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}

/** Like Promise.allSettled(items.map(fn)), with at most `limit` calls of fn running at once. */
async function allSettledLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Adds the tournament's matches to `rows` (String(external_id) → row), skipping ids that
 * are already in `seen` or `rows`. Matches with an unusable id or date are skipped with an
 * entry in `errors`. When it throws, it adds none of the tournament's matches.
 */
function collectMatchRows(tournament, matches, seen, rows, errors) {
  if (!Array.isArray(matches)) {
    // A well-formed answer that is not a list is reported but not retried, so one odd
    // tournament cannot hold the cursor back for ever.
    errors.push(`tournament ${tournament.id}: match list is not an array, skipped`);
    return;
  }

  const tournamentName =
    tournament.token_international || tournament.token || `Tournament ${tournament.id}`;

  const tournamentRows = new Map(); // added to `rows` at the end
  for (const m of matches) {
    const id = m?.id;
    if (id == null || id === "") {
      errors.push(`tournament ${tournament.id}: match without id, skipped`);
      continue;
    }
    // external_id is a bigint column: any other id would fail the day's duplicate check, and
    // one beyond 2^53 would not come back from the table as the same number.
    const externalId = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
    if (!Number.isSafeInteger(externalId)) {
      errors.push(`tournament ${tournament.id}: match with unusable id ${JSON.stringify(id)}, skipped`);
      continue;
    }
    const key = String(externalId);
    if (seen.has(key) || rows.has(key) || tournamentRows.has(key)) continue;

    const playedAt = typeof m.date === "string" ? m.date : "";
    const [datePart, timeRaw] = playedAt.split("T");
    const timePart = timeRaw?.replace("Z", "") ?? null;
    if (!isIsoDate(datePart)) {
      errors.push(`match ${key}: unexpected date ${JSON.stringify(m.date ?? null)}, skipped`);
      continue;
    }

    tournamentRows.set(key, {
      external_id: externalId,
      date: datePart,
      time: timePart,
      tournament: tournamentName,
      team1: m.participant1?.team?.token_international || m.participant1?.team?.token || null,
      team2: m.participant2?.team?.token_international || m.participant2?.team?.token || null,
      player1: m.participant1?.nickname || null,
      player2: m.participant2?.nickname || null,
      score1: m.participant1?.score ?? null,
      score2: m.participant2?.score ?? null,
      source: "api",
    });
  }
  for (const [key, row] of tournamentRows) rows.set(key, row);
}

/** True when Postgres refused a row because of its data (SQLSTATE class 22 or 23), not the network or database. */
function isRowRejection(error) {
  return /^2[23]/.test(error?.code ?? "");
}

export function createSync(deps) {
  const now = deps.now ?? Date.now;
  const logError = deps.logError ?? console.error;

  /** Fetch all finished SB tournaments for one calendar day; throws when any page fails. */
  async function fetchSbTournamentsForDay(day) {
    const base = day.replaceAll("-", "/"); // ESB dates are "YYYY/MM/DD"
    const results = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const url = `${ESB_API}/tournaments?page=${page}&dateFrom=${encodeURIComponent(base + " 00:00")}&dateTo=${encodeURIComponent(base + " 23:59")}`;
      try {
        const data = await deps.fetchJson(url);
        totalPages = data?.totalPages ?? 1;
        for (const t of (data?.tournaments ?? [])) {
          if (t.location?.code === SB_LOCATION_CODE && t.status_id === 4) {
            results.push(t);
          }
        }
      } catch (e) {
        throw new Error(`tournaments page ${page}: ${errorText(e)}`);
      }
      page++;
    }
    return results;
  }

  /**
   * Inserts the rows whose external_id is not in the table yet, in one batch. When Postgres
   * refuses the batch because of a row's data, the rows go in one at a time, and the refused
   * ones are skipped and reported in `errors`, so one bad match cannot hold the day back.
   * `failed` means the day must be retried: a duplicate check or an insert failed for another
   * reason, or the one-by-one inserts ran past `deadline`. Rows inserted before that stay in
   * the table and are counted in `inserted`.
   */
  async function insertNewRows(day, rows, seen, errors, deadline) {
    const ids = [...rows.values()].map((r) => r.external_id);
    for (let i = 0; i < ids.length; i += IDS_PER_DUPLICATE_CHECK) {
      const { data: existing, error: selectError } = await deps.existingIds(ids.slice(i, i + IDS_PER_DUPLICATE_CHECK));
      if (selectError) {
        errors.push(`day ${day}: duplicate check failed: ${selectError.message}`);
        return { inserted: 0, failed: true };
      }
      for (const row of existing ?? []) {
        const key = String(row.external_id);
        rows.delete(key);
        seen.add(key);
      }
    }
    if (rows.size === 0) return { inserted: 0, failed: false };

    const { error: batchError } = await deps.insertMatches([...rows.values()]);
    if (!batchError) {
      for (const key of rows.keys()) seen.add(key);
      return { inserted: rows.size, failed: false };
    }
    if (!isRowRejection(batchError)) {
      errors.push(`day ${day}: insert of ${rows.size} matches failed: ${batchError.message}`);
      return { inserted: 0, failed: true };
    }

    let inserted = 0;
    for (const [key, row] of rows) {
      if (now() > deadline) {
        errors.push(`day ${day}: out of time after ${inserted} one-by-one inserts; the rest is retried next run`);
        return { inserted, failed: true };
      }
      const { error } = await deps.insertMatches(row);
      if (error && !isRowRejection(error)) {
        errors.push(`day ${day}: insert of match ${key} failed: ${error.message}`);
        return { inserted, failed: true };
      }
      seen.add(key);
      // A duplicate external_id means an overlapping run stored the match after the duplicate check.
      const alreadyStored = error?.code === "23505" && /\(external_id\)/.test(error.details ?? "");
      if (!error) inserted++;
      else if (!alreadyStored) errors.push(`day ${day} match ${key}: refused by the database (${error.message}), skipped`);
    }
    return { inserted, failed: false };
  }

  /**
   * Syncs one day: fetches its tournaments' match lists (a few at a time), then inserts the
   * day's new matches (see insertNewRows). `failed` means the day must be retried: nothing
   * after it counts as done. A failed match-list fetch fails the day; the matches of the
   * tournaments whose lists did load are still inserted.
   */
  async function syncDay(day, seen, errors, deadline) {
    let tournaments;
    try {
      tournaments = await fetchSbTournamentsForDay(day);
    } catch (e) {
      errors.push(`day ${day}: ${errorText(e)}`);
      return { found: 0, inserted: 0, failed: true };
    }

    const matchLists = await allSettledLimited(
      tournaments,
      MATCH_LIST_CONCURRENCY,
      (tournament) => deps.fetchJson(`${ESB_API}/tournaments/${tournament.id}/matches`)
    );
    let failed = false;
    const rows = new Map(); // String(external_id) → row
    for (const [i, tournament] of tournaments.entries()) {
      const list = matchLists[i];
      try {
        if (list.status === "rejected") throw list.reason;
        collectMatchRows(tournament, list.value, seen, rows, errors);
      } catch (e) {
        errors.push(`day ${day} tournament ${tournament.id}: ${errorText(e)}`);
        failed = true;
      }
    }

    const result = await insertNewRows(day, rows, seen, errors, deadline);
    return { found: tournaments.length, inserted: result.inserted, failed: failed || result.failed };
  }

  /** One run for a request body (an object, or null for GET or no body): { status, body }. */
  async function run(requestBody) {
    const startedAt = now();

    try {
      // ── Determine date range ────────────────────────────────────────────────
      const body = requestBody && typeof requestBody === "object" ? requestBody : null;
      const rawFrom = body?.dateFrom ?? null;
      const rawTo = body?.dateTo ?? null;
      const todayIso = fmtIso(new Date(startedAt));
      const manualMode = rawFrom !== null;
      let fromIso;
      let toIso;

      if (manualMode) {
        if (!isIsoDate(rawFrom)) {
          return { status: 400, body: { ok: false, error: "dateFrom must be a real date in YYYY-MM-DD format" } };
        }
        if (rawTo !== null && !isIsoDate(rawTo)) {
          return { status: 400, body: { ok: false, error: "dateTo must be a real date in YYYY-MM-DD format" } };
        }
        fromIso = rawFrom;
        toIso = typeof rawTo === "string" ? rawTo : todayIso;
        if (fromIso > toIso) {
          return {
            status: 400,
            body: { ok: false, error: `dateFrom ${fromIso} is after dateTo ${toIso}${rawTo === null ? " (today)" : ""}` },
          };
        }
      } else {
        if (rawTo !== null) {
          return { status: 400, body: { ok: false, error: "dateTo requires dateFrom" } };
        }
        const cursor = await deps.getCursor();
        if (cursor === undefined) {
          fromIso = FIRST_DAY;
        } else if (isIsoDate(cursor) && cursor <= todayIso) {
          fromIso = cursor;
        } else {
          return {
            status: 500,
            body: {
              ok: false,
              error: `settings.${CURSOR_KEY} is ${JSON.stringify(cursor)}; it must be a YYYY-MM-DD date ` +
                `on or before today (${todayIso}). Fix or delete that row.`,
            },
          };
        }
        toIso = todayIso;
      }

      // ── Build list of days (capped at MAX_DAYS_PER_RUN) ────────────────────
      const days = [];
      for (let day = fromIso; day <= toIso && days.length < MAX_DAYS_PER_RUN; day = addDays(day, 1)) {
        days.push(day);
      }

      // ── Sync each day; stop at the first failed day or when out of time ────
      let sbTournamentsFound = 0;
      let inserted = 0;
      const errors = [];
      const seen = new Set(); // external ids already in the table, or inserted or refused in this run
      let processedUpTo = null; // last day fully synced
      let nextDateFrom = null; // first day of the range not synced by this run

      for (const day of days) {
        if (now() - startedAt > TIME_BUDGET_MS) {
          nextDateFrom = day;
          break;
        }
        const result = await syncDay(day, seen, errors, startedAt + INSERT_DEADLINE_MS);
        sbTournamentsFound += result.found;
        inserted += result.inserted;
        if (result.failed) {
          nextDateFrom = day;
          break;
        }
        processedUpTo = day;
      }
      if (nextDateFrom === null && processedUpTo !== null && processedUpTo < toIso) {
        nextDateFrom = addDays(processedUpTo, 1); // stopped by MAX_DAYS_PER_RUN
      }
      const remaining = nextDateFrom !== null; // more days to sync after this run

      // ── Update cursor (auto mode only) ──────────────────────────────────────
      if (!manualMode) {
        const nextCursor = nextDateFrom ?? addDays(fmtIso(new Date(now())), -1);
        try {
          await deps.setCursor(nextCursor);
        } catch (e) {
          errors.push(`cursor: could not save ${nextCursor}: ${errorText(e)}`);
        }
      }

      if (errors.length > ERRORS_IN_RESPONSE) logError(JSON.stringify({ errors }));
      return {
        status: 200,
        body: {
          ok: errors.length === 0,
          mode: manualMode ? "manual" : "auto",
          processedFrom: fromIso,
          processedUpTo,
          remaining,
          nextDateFrom,
          sbTournamentsFound,
          inserted,
          errorCount: errors.length,
          errors: errors.slice(0, ERRORS_IN_RESPONSE),
        },
      };
    } catch (err) {
      return { status: 500, body: { ok: false, error: String(err) } };
    }
  }

  return { run };
}
