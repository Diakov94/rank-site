/* esb-sync: copies finished Stamford Bridge matches from the ESportsBattle API into
 * the `matches` table. It uses the service role, so it bypasses RLS. The logic is in
 * sync.js (tested by tests/esb-sync.test.js); this file wires it to Deno.serve, fetch
 * and supabase-js, and checks the method and the caller.
 *
 * Modes:
 *   Auto (GET, or POST without dateFrom): resumes from the `esb_sync_cursor` row in
 *   `settings` (2026-01-01 when the row does not exist) up to today, at most 14 days,
 *   and moves the cursor to the first day it did not finish. Once caught up, the
 *   cursor goes back to yesterday so every run re-checks two days.
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
import { createSync, CURSOR_KEY } from "./sync.js";

const FETCH_TIMEOUT_MS = 15_000; // per ESB request
const SYNC_SECRET = Deno.env.get("SYNC_SECRET") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/* The service key: the new secret key when Supabase provides it (JSON, key name -> key,
 * "default" first, in SUPABASE_SECRET_KEYS), else the legacy SUPABASE_SERVICE_ROLE_KEY, which
 * stops working once the legacy keys are disabled. */
function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const key = keys.default ?? Object.values(keys)[0];
    if (typeof key === "string" && key) return key;
  } catch {
    // not JSON: use the legacy key
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey());

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  // Callers often discard the response, so failed runs and server errors also go to the logs.
  if ((status === 200 || status >= 500) && (body as { ok?: boolean }).ok === false) console.error(text);
  return new Response(text, {
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

const sync = createSync({
  /** GET an ESB API URL as JSON; throws on a non-OK status, a timeout or a network error. */
  async fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  },
  existingIds: (ids: unknown[]) => supabase.from("matches").select("external_id").in("external_id", ids),
  insertMatches: (rows: Record<string, unknown> | Record<string, unknown>[]) => supabase.from("matches").insert(rows),
  /** The stored cursor value, or undefined when there is no cursor row yet. Throws when the read fails. */
  async getCursor(): Promise<unknown> {
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", CURSOR_KEY)
      .maybeSingle();
    if (error) throw new Error(`Could not read settings.${CURSOR_KEY}: ${error.message}`);
    return data === null ? undefined : data.value;
  },
  async setCursor(date: string): Promise<void> {
    const { error } = await supabase
      .from("settings")
      .upsert({ key: CURSOR_KEY, value: date }, { onConflict: "key" });
    if (error) throw new Error(error.message);
  },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, POST, OPTIONS" });
  }
  if (SYNC_SECRET && !secretMatches(req.headers.get("x-sync-secret"))) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch { /* body is optional */ }
  const result = await sync.run(body);
  return jsonResponse(result.body, result.status);
});
