import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ESB_API = "https://football.esportsbattle.com/api";
const SB_LOCATION_CODE = "ECF-location-1"; // Stamford Bridge
const MAX_DAYS_PER_RUN = 14; // days processed per invocation
const CURSOR_KEY = "esb_sync_cursor"; // settings table key

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

/** Date → "YYYY/MM/DD" for ESB API */
function fmtEsb(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

async function getCursor(): Promise<string | null> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", CURSOR_KEY)
    .single();
  return data?.value ?? null;
}

async function setCursor(date: string): Promise<void> {
  await supabase
    .from("settings")
    .upsert({ key: CURSOR_KEY, value: date });
}

/** Fetch all finished SB tournaments for one calendar day */
async function fetchSbTournamentsForDay(dayDate: Date): Promise<any[]> {
  const base = fmtEsb(dayDate);
  const results: any[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${ESB_API}/tournaments?page=${page}&dateFrom=${encodeURIComponent(base + " 00:00")}&dateTo=${encodeURIComponent(base + " 23:59")}`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      totalPages = data.totalPages ?? 1;
      for (const t of (data.tournaments ?? [])) {
        if (t.location?.code === SB_LOCATION_CODE && t.status_id === 4) {
          results.push(t);
        }
      }
    } catch { break; }
    page++;
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    // ── Determine date range ──────────────────────────────────────────────────
    // Manual override: POST body { dateFrom?: "YYYY-MM-DD", dateTo?: "YYYY-MM-DD" }
    // Auto mode (no body): reads cursor from settings; defaults to 2026-01-01 if
    // cursor is not set (= first ever run → will fill history from the start).
    let fromIso = "";
    let toIso   = "";
    let manualMode = false;

    try {
      const body = await req.json();
      if (body?.dateFrom) { fromIso = body.dateFrom; manualMode = true; }
      if (body?.dateTo)   { toIso   = body.dateTo; }
    } catch { /* body is optional */ }

    const todayIso = fmtIso(new Date());

    if (!manualMode) {
      // Auto mode: resume from stored cursor
      const cursor = await getCursor();
      fromIso = cursor ?? "2026-01-01"; // first run ever → start from Jan 1
      toIso   = todayIso;
    } else if (!toIso) {
      toIso = todayIso;
    }

    const fromDate = parseDate(fromIso);
    const toDate   = parseDate(toIso);

    // ── Build list of days (capped at MAX_DAYS_PER_RUN) ──────────────────────
    const days: Date[] = [];
    const cur = new Date(fromDate);
    while (cur <= toDate && days.length < MAX_DAYS_PER_RUN) {
      days.push(new Date(cur));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    const processedUpTo = fmtIso(days[days.length - 1]);
    const remaining = cur <= toDate; // more days after this batch
    const nextDateFrom = remaining ? fmtIso(cur) : null;

    // ── Load existing external IDs to skip duplicates ─────────────────────────
    const { data: existing } = await supabase
      .from("matches")
      .select("external_id")
      .not("external_id", "is", null);
    const existingIds = new Set<number>(
      (existing ?? []).map((m: { external_id: number }) => m.external_id)
    );

    // ── Sync each day ─────────────────────────────────────────────────────────
    let sbTournamentsFound = 0;
    let inserted = 0;
    const errors: string[] = [];

    for (const day of days) {
      const sbTournaments = await fetchSbTournamentsForDay(day);
      sbTournamentsFound += sbTournaments.length;

      for (const tournament of sbTournaments) {
        try {
          const res = await fetch(`${ESB_API}/tournaments/${tournament.id}/matches`);
          if (!res.ok) continue;
          const matches = await res.json();
          if (!Array.isArray(matches)) continue;

          const tournamentName =
            tournament.token_international || tournament.token || `Tournament ${tournament.id}`;

          for (const m of matches) {
            if (existingIds.has(m.id)) continue;

            const playedAt: string = m.date ?? "";
            const datePart = playedAt.split("T")[0] ?? null;
            const timePart = playedAt.split("T")[1]?.replace("Z", "") ?? null;

            const { error } = await supabase.from("matches").insert({
              external_id: m.id,
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

            if (!error) {
              inserted++;
              existingIds.add(m.id);
            } else {
              errors.push(`match ${m.id}: ${error.message}`);
            }
          }
        } catch (e) {
          errors.push(`tournament ${tournament.id}: ${String(e)}`);
        }
      }
    }

    // ── Update cursor (auto mode only) ────────────────────────────────────────
    if (!manualMode) {
      // In auto mode, advance cursor by one day past what we processed,
      // so next run picks up from the next unprocessed day.
      // But if we've caught up to today, reset cursor to yesterday
      // so routine runs always re-check the last 2 days.
      if (remaining) {
        await setCursor(nextDateFrom!);
      } else {
        const yesterday = new Date();
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        await setCursor(fmtIso(yesterday));
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode: manualMode ? "manual" : "auto",
        processedFrom: fromIso,
        processedUpTo,
        remaining,
        nextDateFrom,
        sbTournamentsFound,
        inserted,
        errors: errors.slice(0, 10),
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
