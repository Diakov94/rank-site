/* esb-sync: copies finished Stamford Bridge matches from the ESportsBattle API into
 * the `matches` table. It uses the service role, so it bypasses RLS.
 *
 * Modes:
 *   Auto (GET, or POST without dateFrom): resumes from the `esb_sync_cursor` row in
 *   `settings` (FIRST_DAY when the row does not exist) up to today, at most
 *   MAX_DAYS_PER_RUN days, and moves the cursor to the first day it did not finish.
 *   Once caught up, the cursor goes back to yesterday so every run re-checks two days.
 *   Manual (POST {"dateFrom": "YYYY-MM-DD", "dateTo"?: "YYYY-MM-DD"}): syncs that range
 *   (dateTo defaults to today) and never touches the cursor. Continue a long range
 *   with the returned nextDateFrom.
 *
 * Caller check: when the SYNC_SECRET env var is set, every request except the CORS
 * preflight must send the header `x-sync-secret: <SYNC_SECRET>` (401 otherwise).
 * When it is unset, anyone who can reach the function may run it.
 *
 * Response: 200 with {ok, ..., errorCount, errors} for every run that completed; ok is
 * false when anything failed. 400 = bad input, 401 = wrong secret, 405 = method other
 * than GET/POST/OPTIONS, 500 = cursor problem or unexpected error.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ESB_API = "https://football.esportsbattle.com/api";
const SB_LOCATION_CODE = "ECF-location-1"; // Stamford Bridge
const MAX_DAYS_PER_RUN = 14; // days processed per invocation
const CURSOR_KEY = "esb_sync_cursor"; // settings table key
const FIRST_DAY = "2026-01-01"; // where the first ever auto run starts
const FETCH_TIMEOUT_MS = 15_000; // per ESB request
const MATCH_LIST_CONCURRENCY = 4; // ESB match-list requests in flight per day
const IDS_PER_DUPLICATE_CHECK = 200; // external ids per .in() query (keeps the URL short)
const TIME_BUDGET_MS = 100_000; // no new day is started after this (the platform limit is 150 s)
const SYNC_SECRET = Deno.env.get("SYNC_SECRET") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

/** "YYYY-MM-DD" → Date (UTC midnight) */
function parseDate(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

/** Date → "YYYY-MM-DD" */
function fmtIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** True for a real calendar date written as "YYYY-MM-DD" (rejects 2026-02-30). */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = parseDate(value);
  return !Number.isNaN(d.getTime()) && fmtIso(d) === value;
}

function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtIso(d);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Like Promise.allSettled(items.map(fn)), with at most `limit` calls of fn running at once. */
async function allSettledLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
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

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Constant-time comparison of the x-sync-secret header with SYNC_SECRET. */
function secretMatches(given: string | null): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(given ?? "");
  const b = enc.encode(SYNC_SECRET);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= b[i] ^ (a[i] ?? 0);
  return diff === 0;
}

/** The stored cursor value, or undefined when there is no cursor row yet. Throws when the read fails. */
async function getCursor(): Promise<unknown> {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", CURSOR_KEY)
    .maybeSingle();
  if (error) throw new Error(`Could not read settings.${CURSOR_KEY}: ${error.message}`);
  return data === null ? undefined : data.value;
}

async function setCursor(date: string): Promise<void> {
  const { error } = await supabase
    .from("settings")
    .upsert({ key: CURSOR_KEY, value: date }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

/** GET an ESB API URL as JSON; throws on a non-OK status, a timeout or a network error. */
async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

/** Fetch all finished SB tournaments for one calendar day; throws when any page fails. */
async function fetchSbTournamentsForDay(day: string): Promise<any[]> {
  const base = day.replaceAll("-", "/"); // ESB dates are "YYYY/MM/DD"
  const results: any[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${ESB_API}/tournaments?page=${page}&dateFrom=${encodeURIComponent(base + " 00:00")}&dateTo=${encodeURIComponent(base + " 23:59")}`;
    try {
      const data = await fetchJson(url);
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
 * Adds the tournament's matches to `rows` (String(external_id) → row), skipping ids that
 * are already in `seen` or `rows`. Matches with an unusable id or date are skipped with an
 * entry in `errors`. When it throws, it adds none of the tournament's matches.
 */
function collectMatchRows(
  tournament: any,
  matches: unknown,
  seen: Set<string>,
  rows: Map<string, Record<string, unknown>>,
  errors: string[]
): void {
  if (!Array.isArray(matches)) {
    // A well-formed answer that is not a list is reported but not retried, so one odd
    // tournament cannot hold the cursor back for ever.
    errors.push(`tournament ${tournament.id}: match list is not an array, skipped`);
    return;
  }

  const tournamentName =
    tournament.token_international || tournament.token || `Tournament ${tournament.id}`;

  const tournamentRows = new Map<string, Record<string, unknown>>(); // added to `rows` at the end
  for (const m of matches) {
    const id = m?.id;
    if (id == null || id === "") {
      errors.push(`tournament ${tournament.id}: match without id, skipped`);
      continue;
    }
    const key = String(id);
    if (seen.has(key) || rows.has(key) || tournamentRows.has(key)) continue;

    const playedAt: string = typeof m.date === "string" ? m.date : "";
    const [datePart, timeRaw] = playedAt.split("T");
    const timePart = timeRaw?.replace("Z", "") ?? null;
    if (!isIsoDate(datePart)) {
      errors.push(`match ${key}: unexpected date ${JSON.stringify(m.date ?? null)}, skipped`);
      continue;
    }

    tournamentRows.set(key, {
      external_id: id,
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

/**
 * Inserts the rows whose external_id is not in the table yet, in one batch, and returns
 * the number inserted. Throws when a duplicate check or the insert fails.
 */
async function insertNewRows(rows: Map<string, Record<string, unknown>>, seen: Set<string>): Promise<number> {
  const ids = [...rows.values()].map((r) => r.external_id);
  for (let i = 0; i < ids.length; i += IDS_PER_DUPLICATE_CHECK) {
    const { data: existing, error: selectError } = await supabase
      .from("matches")
      .select("external_id")
      .in("external_id", ids.slice(i, i + IDS_PER_DUPLICATE_CHECK));
    if (selectError) throw new Error(`duplicate check failed: ${selectError.message}`);
    for (const row of existing ?? []) {
      const key = String(row.external_id);
      rows.delete(key);
      seen.add(key);
    }
  }
  if (rows.size === 0) return 0;

  const { error: insertError } = await supabase.from("matches").insert([...rows.values()]);
  if (insertError) throw new Error(`insert of ${rows.size} matches failed: ${insertError.message}`);
  for (const key of rows.keys()) seen.add(key);
  return rows.size;
}

/**
 * Syncs one day: fetches its tournaments' match lists (a few at a time), then inserts the
 * day's new matches in one batch. `failed` means the day must be retried: nothing after it
 * counts as done. A failed match-list fetch, duplicate check or insert fails the day; the
 * matches of the tournaments whose lists did load are still inserted.
 */
async function syncDay(
  day: string,
  seen: Set<string>,
  errors: string[]
): Promise<{ found: number; inserted: number; failed: boolean }> {
  let tournaments: any[];
  try {
    tournaments = await fetchSbTournamentsForDay(day);
  } catch (e) {
    errors.push(`day ${day}: ${errorText(e)}`);
    return { found: 0, inserted: 0, failed: true };
  }

  const matchLists = await allSettledLimited(
    tournaments,
    MATCH_LIST_CONCURRENCY,
    (tournament) => fetchJson(`${ESB_API}/tournaments/${tournament.id}/matches`)
  );
  let failed = false;
  const rows = new Map<string, Record<string, unknown>>(); // String(external_id) → row
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

  let inserted = 0;
  try {
    inserted = await insertNewRows(rows, seen);
  } catch (e) {
    errors.push(`day ${day}: ${errorText(e)}`);
    failed = true;
  }
  return { found: tournaments.length, inserted, failed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, POST, OPTIONS" });
  }
  if (SYNC_SECRET && !secretMatches(req.headers.get("x-sync-secret"))) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const startedAt = Date.now();

  try {
    // ── Determine date range ──────────────────────────────────────────────────
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object") body = parsed;
    } catch { /* body is optional */ }

    const rawFrom = body?.dateFrom ?? null;
    const rawTo = body?.dateTo ?? null;
    const todayIso = fmtIso(new Date());
    const manualMode = rawFrom !== null;
    let fromIso: string;
    let toIso: string;

    if (manualMode) {
      if (!isIsoDate(rawFrom)) {
        return jsonResponse({ ok: false, error: "dateFrom must be a real date in YYYY-MM-DD format" }, 400);
      }
      if (rawTo !== null && !isIsoDate(rawTo)) {
        return jsonResponse({ ok: false, error: "dateTo must be a real date in YYYY-MM-DD format" }, 400);
      }
      fromIso = rawFrom;
      toIso = typeof rawTo === "string" ? rawTo : todayIso;
      if (fromIso > toIso) {
        return jsonResponse(
          { ok: false, error: `dateFrom ${fromIso} is after dateTo ${toIso}${rawTo === null ? " (today)" : ""}` },
          400
        );
      }
    } else {
      if (rawTo !== null) {
        return jsonResponse({ ok: false, error: "dateTo requires dateFrom" }, 400);
      }
      const cursor = await getCursor();
      if (cursor === undefined) {
        fromIso = FIRST_DAY;
      } else if (isIsoDate(cursor) && cursor <= todayIso) {
        fromIso = cursor;
      } else {
        return jsonResponse({
          ok: false,
          error: `settings.${CURSOR_KEY} is ${JSON.stringify(cursor)}; it must be a YYYY-MM-DD date ` +
            `on or before today (${todayIso}). Fix or delete that row.`,
        }, 500);
      }
      toIso = todayIso;
    }

    // ── Build list of days (capped at MAX_DAYS_PER_RUN) ──────────────────────
    const days: string[] = [];
    for (let day = fromIso; day <= toIso && days.length < MAX_DAYS_PER_RUN; day = addDays(day, 1)) {
      days.push(day);
    }

    // ── Sync each day; stop at the first failed day or when out of time ──────
    let sbTournamentsFound = 0;
    let inserted = 0;
    const errors: string[] = [];
    const seen = new Set<string>(); // external ids already in the table or inserted by this run
    let processedUpTo: string | null = null; // last day fully synced
    let nextDateFrom: string | null = null; // first day of the range not synced by this run

    for (const day of days) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        nextDateFrom = day;
        break;
      }
      const result = await syncDay(day, seen, errors);
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

    // ── Update cursor (auto mode only) ────────────────────────────────────────
    if (!manualMode) {
      const nextCursor = nextDateFrom ?? addDays(fmtIso(new Date()), -1);
      try {
        await setCursor(nextCursor);
      } catch (e) {
        errors.push(`cursor: could not save ${nextCursor}: ${errorText(e)}`);
      }
    }

    return jsonResponse({
      ok: errors.length === 0,
      mode: manualMode ? "manual" : "auto",
      processedFrom: fromIso,
      processedUpTo,
      remaining,
      nextDateFrom,
      sbTournamentsFound,
      inserted,
      errorCount: errors.length,
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
});
