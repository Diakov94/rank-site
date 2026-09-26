"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSite } = require("./helpers/load.js");

const site = loadSite({ console: { log() {}, warn() {}, error() {} } });
const { monthDelta, shiftIsoDate, localIsoDate, safeUrl, safeColor, escapeHtml, groupForRating } = site;

const end = (date, rating) => ({ date, rating, games: 1 });
const start = (date, rating) => ({ date, rating, start: true, reset: true });

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
