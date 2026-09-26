"use strict";
/* Tests for the esb-sync Edge Function's logic (supabase/functions/esb-sync/sync.js), run
 * against a fake ESportsBattle API and a fake matches table. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ROOT } = require("./helpers/load.js");

const SYNC_PATH = path.join(ROOT, "supabase", "functions", "esb-sync", "sync.js");

/* Loaded as a data: URL for the reason given in admin-users.test.js. */
const syncModule = import(
  "data:text/javascript;charset=utf-8," +
  encodeURIComponent(`${fs.readFileSync(SYNC_PATH, "utf8")}\n//# sourceURL=${pathToFileURL(SYNC_PATH).href}\n`)
);

const SB = { code: "ECF-location-1" };

/* A finished Stamford Bridge tournament on `day` with these matches (ids or match objects). */
function tournament(id, day, matches) {
  return {
    id,
    day,
    matches: matches.map((m) => (typeof m === "object" ? m : match(m, day))),
  };
}

function match(id, day) {
  return {
    id,
    date: `${day}T10:00:00Z`,
    participant1: { nickname: `p${id}a`, score: 1, team: { token: "A" } },
    participant2: { nickname: `p${id}b`, score: 0, team: { token: "B" } },
  };
}

/**
 * The fake world: `tournaments` (see tournament()), a matches table keyed by external_id,
 * a cursor, and a clock. Options:
 *   now            the clock at the start, as an ISO string
 *   cursor         the stored cursor (undefined: no row)
 *   stored         external ids already in the table
 *   refuse(row)    an error object for a row the database refuses because of its data
 *   insertError    an error object every insert returns (the network, a permission...)
 *   failList(id)   true when that tournament's match list request fails
 *   tickPerInsert  ms the clock moves on each insert call
 */
async function setup(tournaments, options = {}) {
  const { createSync } = await syncModule;
  let clock = Date.parse(options.now ?? "2026-03-05T12:00:00Z");
  const table = new Map((options.stored ?? []).map((id) => [id, { external_id: id }]));
  const calls = { setCursor: [], insert: 0, logged: [] };
  let cursor = options.cursor;

  function insertOne(row) {
    const refused = options.refuse?.(row);
    if (refused) return refused;
    if (table.has(row.external_id)) {
      return { code: "23505", message: "duplicate key value violates unique constraint", details: `Key (external_id)=(${row.external_id}) already exists.` };
    }
    table.set(row.external_id, row);
    return null;
  }

  const sync = createSync({
    now: () => clock,
    logError: (text) => calls.logged.push(text),
    async fetchJson(url) {
      const list = url.match(/\/tournaments\/(\d+)\/matches$/);
      if (list) {
        const t = tournaments.find((x) => x.id === Number(list[1]));
        if (options.failList?.(t.id)) throw new Error("HTTP 502");
        return t.matches;
      }
      const day = decodeURIComponent(url.match(/dateFrom=([^&]+)/)[1]).slice(0, 10).replaceAll("/", "-");
      return {
        totalPages: 1,
        tournaments: tournaments
          .filter((t) => t.day === day)
          .map((t) => ({ id: t.id, token: `T${t.id}`, location: SB, status_id: 4 })),
      };
    },
    async existingIds(ids) {
      return { data: ids.filter((id) => table.has(id)).map((id) => ({ external_id: id })), error: null };
    },
    async insertMatches(rows) {
      calls.insert++;
      clock += options.tickPerInsert ?? 0;
      if (options.insertError) return { error: options.insertError };
      if (!Array.isArray(rows)) return { error: insertOne(rows) };
      const refused = rows.map((row) => options.refuse?.(row)).find(Boolean); // a batch is all or nothing
      if (refused) return { error: refused };
      for (const row of rows) insertOne(row);
      return { error: null };
    },
    async getCursor() { return cursor; },
    async setCursor(date) { calls.setCursor.push(date); cursor = date; },
  });
  return { run: (body) => sync.run(body ?? null), table, calls, cursor: () => cursor };
}

const BAD_TYPE = { code: "22P02", message: 'invalid input syntax for type integer: "x"' };

test("a match the database refuses is skipped and the day is still synced (no stall)", async () => {
  const world = await setup([tournament(1, "2026-03-01", [11, 12, 13]), tournament(2, "2026-03-03", [21])], {
    cursor: "2026-03-01",
    refuse: (row) => (row.external_id === 12 ? BAD_TYPE : null),
  });
  const { status, body } = await world.run();
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.inserted, 3);
  assert.deepEqual([...world.table.keys()].sort(), [11, 13, 21]);
  assert.equal(body.processedUpTo, "2026-03-05");
  assert.equal(body.remaining, false);
  assert.deepEqual(body.errors, ['day 2026-03-01 match 12: refused by the database (invalid input syntax for type integer: "x"), skipped']);
  assert.equal(world.cursor(), "2026-03-04", "caught up: back to yesterday, not stuck on 2026-03-01");
});

test("an insert failure outside class 22/23 fails the day, and auto mode retries it next run", async () => {
  const world = await setup([tournament(1, "2026-03-02", [11])], {
    cursor: "2026-03-01",
    insertError: { code: "42501", message: "permission denied for table matches" },
  });
  const { body } = await world.run();
  assert.equal(body.processedUpTo, "2026-03-01");
  assert.equal(body.nextDateFrom, "2026-03-02");
  assert.equal(body.inserted, 0);
  assert.deepEqual(body.errors, ["day 2026-03-02: insert of 1 matches failed: permission denied for table matches"]);
  assert.equal(world.cursor(), "2026-03-02");

  const network = await setup([tournament(1, "2026-03-02", [11])], { cursor: "2026-03-02", insertError: { code: "", message: "fetch failed" } });
  assert.equal((await network.run()).body.nextDateFrom, "2026-03-02");
});

test("one-by-one inserts: a duplicate from an overlapping run is quiet, another unique violation is reported", async () => {
  const world = await setup([tournament(1, "2026-03-05", [11, 12, 13, 14])], {
    cursor: "2026-03-05",
    refuse: (row) => {
      if (row.external_id === 11) return BAD_TYPE;
      if (row.external_id === 12) return { code: "23505", message: "duplicate key", details: "Key (external_id)=(12) already exists." };
      if (row.external_id === 13) return { code: "23505", message: "duplicate key", details: "Key (player1, date)=(x, y) already exists." };
      return null;
    },
  });
  const { body } = await world.run();
  assert.equal(body.inserted, 1);
  assert.deepEqual(body.errors.map((e) => e.replace(/ \(.*\)/, "")), [
    "day 2026-03-05 match 11: refused by the database, skipped",
    "day 2026-03-05 match 13: refused by the database, skipped",
  ]);
  assert.equal(body.processedUpTo, "2026-03-05");
});

test("one-by-one inserts stop at the 130 s deadline and the day is retried; earlier inserts count", async () => {
  const world = await setup([tournament(1, "2026-03-05", [11, 12, 13, 14, 15])], {
    cursor: "2026-03-05",
    refuse: (row) => (row.external_id === 11 ? BAD_TYPE : null),
    tickPerInsert: 40_000,
  });
  const { body } = await world.run();
  // Every insert takes 40 s: the refused batch at 0 s, then 11 (refused) at 40 s, 12 at 80 s
  // and 13 at 120 s; 14 would start at 160 s, past the deadline.
  assert.equal(body.inserted, 2);
  assert.deepEqual([...world.table.keys()], [12, 13]);
  assert.equal(body.nextDateFrom, "2026-03-05");
  assert.equal(body.processedUpTo, null);
  assert.match(body.errors.at(-1), /^day 2026-03-05: out of time after 2 one-by-one inserts/);
  assert.equal(world.cursor(), "2026-03-05");
});

test("no new day starts after 100 s", async () => {
  const world = await setup([tournament(1, "2026-03-04", [11])], {
    cursor: "2026-03-04",
    tickPerInsert: 101_000,
  });
  const { body } = await world.run();
  assert.equal(body.processedUpTo, "2026-03-04");
  assert.equal(body.nextDateFrom, "2026-03-05");
  assert.equal(body.remaining, true);
  assert.equal(body.ok, true);
});

test("match ids: digit strings become numbers; other ids are skipped with an error", async () => {
  const world = await setup([tournament(1, "2026-03-05", ["0123", 1.5, 2 ** 53, "abc", null, 7, { ...match(8, "x"), date: "soon" }])], {
    cursor: "2026-03-05",
  });
  const { body } = await world.run();
  assert.deepEqual([...world.table.keys()].sort((a, b) => a - b), [7, 123]);
  assert.deepEqual(body.errors, [
    "tournament 1: match with unusable id 1.5, skipped",
    `tournament 1: match with unusable id ${2 ** 53}, skipped`,
    'tournament 1: match with unusable id "abc", skipped',
    "tournament 1: match without id, skipped",
    'match 8: unexpected date "soon", skipped',
  ]);
  assert.equal(body.processedUpTo, "2026-03-05", "skipped matches do not fail the day");
});

test("matches already in the table are not inserted again", async () => {
  const world = await setup([tournament(1, "2026-03-05", [11, 12])], { cursor: "2026-03-05", stored: [11] });
  const { body } = await world.run();
  assert.equal(body.inserted, 1);
  assert.equal(body.ok, true);
  assert.equal(world.calls.insert, 1);
});

test("a failed match list fails the day, but the other tournaments' matches are saved", async () => {
  const world = await setup([tournament(1, "2026-03-05", [11]), tournament(2, "2026-03-05", [21])], {
    cursor: "2026-03-05",
    failList: (id) => id === 2,
  });
  const { body } = await world.run();
  assert.equal(body.inserted, 1);
  assert.deepEqual([...world.table.keys()], [11]);
  assert.equal(body.nextDateFrom, "2026-03-05");
  assert.deepEqual(body.errors, ["day 2026-03-05 tournament 2: HTTP 502"]);
});

test("auto mode: starts at 2026-01-01 without a cursor, runs at most 14 days, and moves the cursor", async () => {
  const world = await setup([], { now: "2026-02-01T08:00:00Z" });
  const { body } = await world.run();
  assert.equal(body.mode, "auto");
  assert.equal(body.processedFrom, "2026-01-01");
  assert.equal(body.processedUpTo, "2026-01-14");
  assert.equal(body.nextDateFrom, "2026-01-15");
  assert.deepEqual(world.calls.setCursor, ["2026-01-15"]);
});

test("auto mode: a cursor that is not a date on or before today answers 500 and is left alone", async () => {
  for (const cursor of ["junk", "2026-03-06", 20260301]) {
    const world = await setup([], { cursor });
    const { status, body } = await world.run();
    assert.equal(status, 500, String(cursor));
    assert.match(body.error, /^settings\.esb_sync_cursor is /);
    assert.deepEqual(world.calls.setCursor, []);
  }
});

test("manual mode syncs the range without touching the cursor; bad input answers 400", async () => {
  const world = await setup([tournament(1, "2026-02-10", [11])], { cursor: "2026-03-01" });
  const ok = await world.run({ dateFrom: "2026-02-10", dateTo: "2026-02-11" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, "manual");
  assert.equal(ok.body.inserted, 1);
  assert.equal(ok.body.nextDateFrom, null);
  assert.deepEqual(world.calls.setCursor, []);

  const bad = [
    [{ dateFrom: "2026-02-30" }, "dateFrom must be a real date in YYYY-MM-DD format"],
    [{ dateFrom: "2026-02-10", dateTo: "10.02.2026" }, "dateTo must be a real date in YYYY-MM-DD format"],
    [{ dateFrom: "2026-02-12", dateTo: "2026-02-11" }, "dateFrom 2026-02-12 is after dateTo 2026-02-11"],
    [{ dateFrom: "2026-03-06" }, "dateFrom 2026-03-06 is after dateTo 2026-03-05 (today)"],
    [{ dateTo: "2026-02-11" }, "dateTo requires dateFrom"],
  ];
  for (const [input, error] of bad) {
    const res = await world.run(input);
    assert.equal(res.status, 400, JSON.stringify(input));
    assert.equal(res.body.error, error);
  }
});

test("more than 10 errors: the response keeps the first 10 and the logs get all of them", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
  const world = await setup([tournament(1, "2026-03-05", ids)], { cursor: "2026-03-05", refuse: () => BAD_TYPE });
  const { body } = await world.run();
  assert.equal(body.errorCount, 12);
  assert.equal(body.errors.length, 10);
  assert.equal(world.calls.logged.length, 1);
  assert.equal(JSON.parse(world.calls.logged[0]).errors.length, 12);
});
