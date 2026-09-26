"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSite, plain, silentConsole } = require("./helpers/load.js");

const site = loadSite({ console: silentConsole });
const { monthDelta, shiftIsoDate, localIsoDate, safeUrl, safeColor, escapeHtml, groupForRating } = site;
const { kyivWallClock, workDayOffset, workDayOf, adjustmentMoment, endEntries } = site;

const end = (date, rating) => ({ date, rating, games: 1 });
const start = (date, rating) => ({ date, rating, start: true, reset: true });
const adjusted = (date, rating, from, time) => ({ date, rating, adjusted: true, from, time });

/* Runs fn with process.env.TZ set to tz (Node applies TZ changes immediately). */
function inTimeZone(tz, fn) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

/* ================== monthDelta ================== */
test("monthDelta needs two entries in the latest month", () => {
  assert.equal(monthDelta(undefined, 7), null);
  assert.equal(monthDelta([], 7), null);
  assert.equal(monthDelta([end("2026-09-05", 1000)], 7), null);
  assert.equal(monthDelta([end("2026-08-30", 1000), end("2026-09-02", 1010)], 7), null);
});

test("monthDelta without start entries uses the latest entry on or before the cut-off", () => {
  const s = [end("2026-08-28", 1030), end("2026-09-02", 1000), end("2026-09-05", 1010), end("2026-09-09", 1020)];
  assert.equal(monthDelta(s, 7), 20); // cut-off 09-02
  assert.equal(monthDelta(s, 1), 10); // cut-off 09-08 -> 09-05
  assert.equal(monthDelta(s, 5), 20); // cut-off 09-04 -> 09-02
});

test("monthDelta never reaches back before the start of the latest month", () => {
  const s = [end("2026-08-28", 1030), end("2026-09-02", 1000), end("2026-09-05", 1010), end("2026-09-09", 1020)];
  assert.equal(monthDelta(s, 30), 20); // cut-off in August -> first September entry
});

test("monthDelta with a start entry measures from the rating right after the reset", () => {
  const s = [end("2026-08-31", 1040), start("2026-09-01", 1000), end("2026-09-01", 1015), end("2026-09-03", 1018)];
  assert.equal(monthDelta(s, 7), 18); // cut-off in August -> the start entry
  assert.equal(monthDelta(s, 1), 3);  // cut-off 09-02 -> end of 09-01
});

test("monthDelta with the cut-off exactly on the 1st uses the 1st's last entry", () => {
  const withStart = [start("2026-09-01", 1000), end("2026-09-01", 1015), end("2026-09-03", 1018)];
  assert.equal(monthDelta(withStart, 2), 3);
  assert.equal(monthDelta(withStart, 3), 18);
  const plainEnds = [end("2026-09-01", 1003), end("2026-09-08", 1010)];
  assert.equal(monthDelta(plainEnds, 7), 7);
  assert.equal(monthDelta(plainEnds, 8), 7);
});

test("monthDelta never uses an adjusted (mid-day) entry as its base", () => {
  // No reset on the 1st: without the rule, the month's first entry would be the adjusted one.
  const s = [end("2026-08-31", 1040), adjusted("2026-09-02", 1200, 1041, "15:04"), end("2026-09-02", 1205), end("2026-09-05", 1210)];
  assert.equal(monthDelta(s, 30), 5); // base: end of 09-02
  assert.equal(monthDelta(s, 3), 5);  // cut-off 09-02 -> end of 09-02
  // A month whose only entries besides the last one are adjusted ones has no base.
  assert.equal(monthDelta([end("2026-08-31", 1040), adjusted("2026-09-02", 1200, 1040, "10:00"), end("2026-09-02", 1203)], 7), null);
});

test("endEntries drops start and adjusted entries", () => {
  const s = [end("2026-08-31", 1040), start("2026-09-01", 1000), adjusted("2026-09-01", 1100, 1003, "12:00"),
    end("2026-09-01", 1103), adjusted("2026-09-02", 900, 1103, "09:00"), end("2026-09-02", 906)];
  assert.deepEqual(plain(endEntries(s)), [end("2026-08-31", 1040), end("2026-09-01", 1103), end("2026-09-02", 906)]);
});

/* ================== work day (Kyiv) ================== */
const VIEWER_ZONES = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/Kyiv"];
const at = (iso) => new Date(iso);

test("kyivWallClock converts an instant to Kyiv time in summer (UTC+3) and winter (UTC+2)", () => {
  for (const tz of VIEWER_ZONES) {
    inTimeZone(tz, () => {
      assert.deepEqual(plain(kyivWallClock(at("2026-07-01T04:30:00Z"))), { date: "2026-07-01", time: "07:30:00" }, tz);
      assert.deepEqual(plain(kyivWallClock(at("2026-01-15T05:30:00Z"))), { date: "2026-01-15", time: "07:30:00" }, tz);
      assert.deepEqual(plain(kyivWallClock(at("2026-07-01T21:05:09Z"))), { date: "2026-07-02", time: "00:05:09" }, tz);
      assert.deepEqual(plain(kyivWallClock(at("2026-12-31T22:00:00Z"))), { date: "2027-01-01", time: "00:00:00" }, tz);
    });
  }
});

test("workDayOffset counts seconds from 07:30 and wraps past midnight", () => {
  assert.equal(workDayOffset("7:30"), 0);
  assert.equal(workDayOffset("07:30:00"), 0);
  assert.equal(workDayOffset("7:30:01"), 1);
  assert.equal(workDayOffset("13:45:00"), 6 * 3600 + 15 * 60);
  assert.equal(workDayOffset("23:59:59"), 16 * 3600 + 29 * 60 + 59);
  assert.equal(workDayOffset("00:00:00"), 16 * 3600 + 30 * 60);
  assert.equal(workDayOffset("1:15"), 17 * 3600 + 45 * 60);
  assert.equal(workDayOffset("7:29:59"), 86399); // the last second of the work day
  for (const bad of [null, undefined, "", "abc", "12", ":30"]) assert.equal(workDayOffset(bad), null, String(bad));
});

test("workDayOf: a Kyiv time before 07:30 belongs to the previous work day (summer and winter)", () => {
  for (const tz of VIEWER_ZONES) {
    inTimeZone(tz, () => {
      // Summer, UTC+3: 07:30 Kyiv = 04:30 UTC.
      assert.equal(workDayOf(at("2026-07-01T04:29:59Z")), "2026-06-30", tz); // 07:29:59
      assert.equal(workDayOf(at("2026-07-01T04:30:00Z")), "2026-07-01", tz); // 07:30:00
      assert.equal(workDayOf(at("2026-07-01T21:30:00Z")), "2026-07-01", tz); // 00:30 on the 2nd
      // Winter, UTC+2: 07:30 Kyiv = 05:30 UTC.
      assert.equal(workDayOf(at("2026-01-15T05:29:00Z")), "2026-01-14", tz); // 07:29
      assert.equal(workDayOf(at("2026-01-15T05:30:00Z")), "2026-01-15", tz); // 07:30
      assert.equal(workDayOf(at("2026-01-01T05:00:00Z")), "2025-12-31", tz); // 07:00 on New Year's Day
      // DST starts 2026-03-29 03:00 -> 04:00: 07:30 that morning is already UTC+3.
      assert.equal(workDayOf(at("2026-03-29T04:29:00Z")), "2026-03-28", tz);
      assert.equal(workDayOf(at("2026-03-29T04:30:00Z")), "2026-03-29", tz);
      // DST ends 2026-10-25 04:00 -> 03:00: 07:30 that morning is UTC+2 again.
      assert.equal(workDayOf(at("2026-10-25T05:29:00Z")), "2026-10-24", tz);
      assert.equal(workDayOf(at("2026-10-25T05:30:00Z")), "2026-10-25", tz);
    });
  }
});

test("workDayOf defaults to now", () => {
  const before = workDayOf(new Date());
  const now = workDayOf();
  const after = workDayOf(new Date());
  assert.ok(now === before || now === after);
  assert.match(now, /^\d{4}-\d{2}-\d{2}$/);
});

test("adjustmentMoment: a manual row saved on its own work day applies at the moment it was saved", () => {
  const row = (applied_date, created_at, reason = "manual") => ({ id: 1, nickname: "A", new_rating: 1000, applied_date, reason, created_at });
  for (const tz of VIEWER_ZONES) {
    inTimeZone(tz, () => {
      // Summer: 12:04:30 UTC = 15:04:30 Kyiv (the DB's timestamptz format, microseconds included).
      assert.deepEqual(plain(adjustmentMoment(row("2026-09-25", "2026-09-25T12:04:30.123456+00:00"))),
        { offset: 7 * 3600 + 34 * 60 + 30, time: "15:04" }, tz);
      // Winter: 12:04:30 UTC = 14:04:30 Kyiv.
      assert.deepEqual(plain(adjustmentMoment(row("2026-01-15", "2026-01-15T12:04:30+00:00"))),
        { offset: 6 * 3600 + 34 * 60 + 30, time: "14:04" }, tz);
      // 01:15 Kyiv on the 26th still belongs to the 25th's work day.
      assert.deepEqual(plain(adjustmentMoment(row("2026-09-25", "2026-09-25T22:15:00Z"))), { offset: 17 * 3600 + 45 * 60, time: "01:15" }, tz);
      // 07:29 vs 07:30 Kyiv (summer): the last minute of the 25th, then the start of the 26th.
      assert.deepEqual(plain(adjustmentMoment(row("2026-09-25", "2026-09-26T04:29:00Z"))), { offset: 86340, time: "07:29" }, tz);
      assert.equal(adjustmentMoment(row("2026-09-26", "2026-09-26T04:29:00Z")), null, tz);
      assert.deepEqual(plain(adjustmentMoment(row("2026-09-26", "2026-09-26T04:30:00Z"))), { offset: 0, time: "07:30" }, tz);
      // Winter: 07:30 Kyiv = 05:30 UTC.
      assert.equal(adjustmentMoment(row("2026-01-15", "2026-01-15T05:29:59Z")), null, tz);
      assert.deepEqual(plain(adjustmentMoment(row("2026-01-15", "2026-01-15T05:30:00Z"))), { offset: 0, time: "07:30" }, tz);
      assert.deepEqual(plain(adjustmentMoment(row("2026-01-14", "2026-01-15T05:29:59Z"))), { offset: 86399, time: "07:29" }, tz);
    });
  }
});

test("adjustmentMoment: monthly resets, backdated, future-dated and undated rows apply at the start of the day", () => {
  const row = (applied_date, created_at, reason) => ({ id: 1, nickname: "A", new_rating: 1000, applied_date, reason, created_at });
  assert.equal(adjustmentMoment(row("2026-09-01", "2026-09-01T09:00:00Z", "monthly_reset")), null);
  assert.equal(adjustmentMoment(row("2026-09-20", "2026-09-25T12:00:00Z", "manual")), null); // backdated
  assert.equal(adjustmentMoment(row("2026-09-27", "2026-09-25T12:00:00Z", null)), null); // saved ahead
  assert.equal(adjustmentMoment(row("2026-09-25", null, "manual")), null);
  assert.equal(adjustmentMoment(row("2026-09-25", undefined, "manual")), null);
  assert.equal(adjustmentMoment(row("2026-09-25", "not a date", "manual")), null);
  assert.equal(adjustmentMoment(null), null);
  // A free-text or null reason on the same work day is a moment adjustment.
  assert.equal(adjustmentMoment(row("2026-09-25", "2026-09-25T12:00:00Z", null)).time, "15:00");
});

/* ================== dates ================== */
test("shiftIsoDate crosses month and year ends and leap days", () => {
  assert.equal(shiftIsoDate("2026-01-31", 1), "2026-02-01");
  assert.equal(shiftIsoDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftIsoDate("2028-03-01", -1), "2028-02-29");
  assert.equal(shiftIsoDate("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftIsoDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftIsoDate("2026-09-08", -7), "2026-09-01");
  assert.equal(shiftIsoDate("2026-09-08", 0), "2026-09-08");
});

test("shiftIsoDate is not affected by time zones or DST changes", () => {
  for (const tz of ["America/Los_Angeles", "Europe/Berlin", "Pacific/Kiritimati", "UTC"]) {
    inTimeZone(tz, () => {
      assert.equal(shiftIsoDate("2026-03-08", 1), "2026-03-09", tz); // US DST start
      assert.equal(shiftIsoDate("2026-03-29", 1), "2026-03-30", tz); // EU DST start
      assert.equal(shiftIsoDate("2026-04-01", -7), "2026-03-25", tz);
      assert.equal(shiftIsoDate("2026-10-25", 1), "2026-10-26", tz); // EU DST end
      assert.equal(shiftIsoDate("2026-11-01", 1), "2026-11-02", tz); // US DST end
    });
  }
});

test("localIsoDate formats the viewer's local calendar day", () => {
  const instant = new Date("2026-03-01T05:00:00Z");
  assert.equal(inTimeZone("America/Los_Angeles", () => localIsoDate(instant)), "2026-02-28");
  assert.equal(inTimeZone("Europe/Berlin", () => localIsoDate(instant)), "2026-03-01");
});

/* ================== safe output ================== */
test("safeUrl keeps absolute http(s) URLs only", () => {
  assert.equal(safeUrl("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(safeUrl("http://example.com"), "http://example.com/");
  assert.equal(safeUrl("  https://example.com/x  "), "https://example.com/x");
  assert.equal(safeUrl("https://example.com/<b>"), "https://example.com/%3Cb%3E");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com/",
    "/relative/path", "example.com", "", null, undefined, 42]) {
    assert.equal(safeUrl(bad), "", String(bad));
  }
});

test("safeColor keeps hex colours and falls back otherwise", () => {
  assert.equal(safeColor("#abc"), "#abc");
  assert.equal(safeColor("#A1B2C3"), "#A1B2C3");
  assert.equal(safeColor("#a1b2c3d4"), "#a1b2c3d4");
  assert.equal(safeColor("  #123  "), "#123");
  for (const bad of ["red", "#12", "#123456789", "#ggg", "#abc;background:url(x)", "abc", "", null, undefined]) {
    assert.equal(safeColor(bad), "#8a94a6", String(bad));
  }
  assert.equal(safeColor("nope", "#000"), "#000");
});

test("escapeHtml escapes the five HTML special characters", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml("plain"), "plain");
});

/* ================== groupForRating ================== */
test("groupForRating picks the first group whose minimum the rating reaches", () => {
  const groups = [{ name: "Pro", min: 1100 }, { name: "Mid", min: 1000 }, { name: "Low", min: 500 }];
  const name = (r) => groupForRating(r, groups).name;
  assert.equal(name(1100), "Pro");
  assert.equal(name(1250.5), "Pro");
  assert.equal(name(1099.99), "Mid");
  assert.equal(name(1000), "Mid");
  assert.equal(name("1100"), "Pro");
  assert.equal(name(499), "Low"); // below every minimum -> lowest group
  for (const bad of [NaN, undefined, "abc", Infinity]) assert.equal(name(bad), "Low", String(bad));
  assert.equal(groupForRating(1000, groups), groups[1]);
});
