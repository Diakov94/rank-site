"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSite, plain, silentConsole } = require("./helpers/load.js");

const site = loadSite({ console: silentConsole });
const { computeRatings, normalizeGroups, groupForRating, monthDelta } = site;

/* Pro: coef 1 from 1100, Mid: coef 1.5 from 1000, Rookie: coef 2 below. */
const GROUPS = [
  { id: 1, name: "Pro", min_rating: 1100, color: "#111111", coef: 1 },
  { id: 2, name: "Mid", min_rating: 1000, color: "#222222", coef: 1.5 },
  { id: 3, name: "Rookie", min_rating: 0, color: "#333333", coef: 2 },
];
const FLAT = [{ id: 1, name: "All", min_rating: 0, color: "#444444", coef: 1 }];

let nextRow = 2;
function match(date, player1, player2, score1, score2, rowIndex = nextRow++) {
  return { date, player1, player2, score1, score2, rowIndex,
    signature: `${date}|#${rowIndex}|${player1}|${player2}|${score1}|${score2}` };
}
function roster(ratings) {
  return Object.entries(ratings).map(([nickname, initial_rating]) => ({ nickname, initial_rating }));
}
function adj(applied_date, nickname, new_rating, reason = null, id = undefined) {
  return { id, nickname, new_rating, applied_date, reason };
}
function run({ matches = [], players = [], adjustments = [], settings = {}, groups = GROUPS }) {
  return computeRatings(matches, players, adjustments, settings, groups);
}
function ratingsOf(result) {
  return Object.fromEntries(result.leaderboard.map((r) => [r.nickname, r.rating]));
}
const seriesOf = (result, nick) => plain(result.history[nick]);
const end = (date, rating, games) => ({ date, rating, games });
const start = (date, rating, reset) => ({ date, rating, start: true, reset });

/* ================== E1: days = union of match and adjustment dates ================== */
test("an adjustment on a day without matches takes effect (monthly reset on the 1st)", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-01-30", "A", "B", 2, 0), match("2026-02-02", "A", "B", 1, 0)],
    adjustments: [adj("2026-02-01", "A", 1000, "monthly_reset", 1), adj("2026-02-01", "B", 1000, "monthly_reset", 2)],
  });
  assert.deepEqual(ratingsOf(r), { A: 1004.5, B: 995.5 });
  assert.deepEqual(seriesOf(r, "A"), [
    end("2026-01-30", 1004.5, 1),
    start("2026-02-01", 1000, true),
    end("2026-02-01", 1000, 0),
    end("2026-02-02", 1004.5, 1),
  ]);
});

test("adjustments before the first match and after the last match take effect", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-01-10", "A", "B", 1, 0)],
    adjustments: [adj("2026-01-01", "A", 500), adj("2026-03-01", "B", 1500, "penalty")],
  });
  // A plays the match at 500 (Rookie, coef 2).
  assert.deepEqual(ratingsOf(r), { B: 1500, A: 506 });
  assert.deepEqual(seriesOf(r, "A"), [
    start("2026-01-01", 500, false),
    end("2026-01-01", 500, 0),
    end("2026-01-10", 506, 1),
    end("2026-03-01", 506, 0),
  ]);
  assert.deepEqual(seriesOf(r, "B"), [
    end("2026-01-01", 1000, 0),
    end("2026-01-10", 994, 1),
    start("2026-03-01", 1500, false),
    end("2026-03-01", 1500, 0),
  ]);
});

test("options.applyUntil holds back adjustments dated after it (a reset saved ahead of time)", () => {
  const data = {
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-09-20", "A", "B", 1, 0)],
    adjustments: [adj("2026-10-01", "A", 900, "monthly_reset", 1), adj("2026-09-25", "B", 1200, "penalty", 2)],
  };
  const held = computeRatings(data.matches, data.players, data.adjustments, {}, GROUPS, { applyUntil: "2026-09-26" });
  assert.deepEqual(ratingsOf(held), { B: 1200, A: 1004.5 });
  assert.equal(seriesOf(held, "A").at(-1).date, "2026-09-25");
  const all = computeRatings(data.matches, data.players, data.adjustments, {}, GROUPS);
  assert.deepEqual(ratingsOf(all), { B: 1200, A: 900 });
});

test("same-day adjustments apply in order before that day's matches; the last one wins", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-01-05", "A", "B", 3, 0)],
    adjustments: [
      adj("2026-01-05", "A", 900, "monthly_reset", 1),
      adj("2026-01-05", "A", 1200, "correction", 2),
    ],
  });
  // A plays at 1200 (Pro, coef 1); reset is true because one of the day's rows was a reset.
  assert.deepEqual(seriesOf(r, "A"), [start("2026-01-05", 1200, true), end("2026-01-05", 1203, 1)]);
  assert.deepEqual(seriesOf(r, "B"), [end("2026-01-05", 997, 1)]);
});

test("days are processed in date order whatever the input order of adjustments", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-02-01", "A", "B", 1, 0)],
    adjustments: [adj("2026-03-01", "A", 1100), adj("2026-01-01", "A", 900)],
  });
  const a = seriesOf(r, "A");
  assert.deepEqual(a.map((e) => e.date), ["2026-01-01", "2026-01-01", "2026-02-01", "2026-03-01", "2026-03-01"]);
  assert.equal(a[2].rating, 906); // played at 900 (coef 2)
  assert.equal(ratingsOf(r).A, 1100);
});

test("same-day matches are processed in the given source-row order", () => {
  const players = roster({ A: 1098, B: 1000, C: 1000 });
  // 1098 is Mid (coef 1.5): +4.5 lifts A into Pro, so the second win is worth 3.
  const first = run({ players, matches: [match("2026-01-05", "A", "B", 1, 0, 2), match("2026-01-05", "A", "C", 1, 0, 3)] });
  assert.equal(ratingsOf(first).A, 1105.5);
  assert.deepEqual([ratingsOf(first).B, ratingsOf(first).C], [995.5, 997]);
});

/* ================== E2: only player_config nicknames ================== */
test("adjustments for nicknames not in player_config are ignored", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-01-10", "A", "B", 1, 0), match("2026-02-01", "Ghost", "A", 5, 0)],
    adjustments: [adj("2026-02-01", "Ghost", 99999, "monthly_reset"), adj("2026-02-15", "Ghost", 5)],
  });
  assert.deepEqual(plain(r.leaderboard).map((x) => x.nickname), ["A", "B"]);
  assert.deepEqual(Object.keys(r.history).sort(), ["A", "B"]);
  // The Ghost-only date is not a processed day; the Ghost match did not count.
  assert.deepEqual(seriesOf(r, "A").map((e) => e.date), ["2026-01-10", "2026-02-01"]);
  assert.equal(seriesOf(r, "A")[1].games, 0);
});

test("a deleted player's old monthly_reset rows do not bring them back", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-05-01", "Deleted", "A", 3, 0), match("2026-05-01", "A", "B", 1, 0)],
    adjustments: ["A", "B", "Deleted"].map((n, i) => adj("2026-05-01", n, 1000, "monthly_reset", i + 1)),
  });
  assert.deepEqual(plain(r.leaderboard).map((x) => [x.rank, x.nickname, x.rating]), [[1, "A", 1004.5], [2, "B", 995.5]]);
  assert.equal(r.history.Deleted, undefined);
});

test("a configured player without initial_rating joins when an adjustment sets their rating", () => {
  const r = run({
    players: [...roster({ A: 1000 }), { nickname: "N", initial_rating: null }, { nickname: "U", initial_rating: null }],
    matches: [match("2026-01-05", "A", "N", 1, 0), match("2026-01-12", "N", "A", 1, 0)],
    adjustments: [adj("2026-01-10", "N", 1000)],
  });
  assert.deepEqual(ratingsOf(r), { N: 1004.5, A: 995.5 });
  assert.deepEqual(seriesOf(r, "N"), [start("2026-01-10", 1000, false), end("2026-01-10", 1000, 0), end("2026-01-12", 1004.5, 1)]);
  assert.deepEqual(seriesOf(r, "A"), [end("2026-01-05", 1000, 0), end("2026-01-10", 1000, 0), end("2026-01-12", 995.5, 1)]);
  // Every configured nickname has a series, even one that is never rated.
  assert.deepEqual(seriesOf(r, "U"), []);
});

test("adjustments without a usable rating or date are ignored; numeric strings are accepted", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: [match("2026-01-10", "A", "B", 1, 0)],
    adjustments: [
      adj("2026-01-05", "A", null), adj("2026-01-06", "A", ""), adj("2026-01-07", "A", "abc"),
      adj("2026-01-08", "A", Infinity), adj("05.01.2026", "A", 1), adj(null, "A", 1), adj("2026-1-9", "A", 1),
      adj("2026-01-20", "B", "1200.5"),
    ],
  });
  assert.deepEqual(ratingsOf(r), { B: 1200.5, A: 1004.5 });
  assert.deepEqual(seriesOf(r, "A").map((e) => e.date), ["2026-01-10", "2026-01-20"]);
  assert.deepEqual(seriesOf(r, "B").slice(-2), [start("2026-01-20", 1200.5, false), end("2026-01-20", 1200.5, 0)]);
});

test("computeRatings does not modify its inputs", () => {
  const groups = [...GROUPS].reverse().map((g) => ({ ...g }));
  const players = roster({ A: 1000, B: 1000 });
  const matches = [match("2026-01-10", "A", "B", 1, 0)];
  const adjustments = [adj("2026-01-01", "A", 1100, "monthly_reset", 1)];
  const before = JSON.stringify({ groups, players, matches, adjustments });
  run({ groups, players, matches, adjustments });
  assert.equal(JSON.stringify({ groups, players, matches, adjustments }), before);
});

/* ================== E3: history entry contract ================== */
test("history entries follow the start/end contract", () => {
  const r = run({
    players: roster({ A: 1000, B: 1000, C: 1000 }),
    matches: [
      match("2026-01-30", "A", "B", 1, 0), match("2026-02-01", "B", "C", 0, 0),
      match("2026-02-03", "X", "Y", 1, 0), match("2026-02-04", "C", "A", 2, 1),
    ],
    adjustments: [
      adj("2026-02-01", "A", 1000, "monthly_reset", 1), adj("2026-02-01", "B", 1000, "monthly_reset", 2),
      adj("2026-02-02", "C", 1050, "bonus", 3),
    ],
  });
  const days = ["2026-01-30", "2026-02-01", "2026-02-02", "2026-02-03", "2026-02-04"];
  for (const nick of ["A", "B", "C"]) {
    const s = seriesOf(r, nick);
    // one end entry per processed day, in date order
    assert.deepEqual(s.filter((e) => !e.start).map((e) => e.date), days, nick);
    assert.deepEqual(s.map((e) => e.date), [...s.map((e) => e.date)].sort(), nick);
    assert.ok(!s.at(-1).start, `${nick}: last entry is an end entry`);
    s.forEach((e, i) => {
      if (e.start) {
        assert.deepEqual(Object.keys(e), ["date", "rating", "start", "reset"]);
        assert.equal(typeof e.reset, "boolean");
        assert.equal(s[i + 1].date, e.date, "start entry is followed by that day's end entry");
        assert.ok(!s[i + 1].start);
      } else {
        assert.deepEqual(Object.keys(e), ["date", "rating", "games"]);
      }
    });
  }
  assert.deepEqual(seriesOf(r, "C").filter((e) => e.start), [start("2026-02-02", 1050, false)]);
  assert.deepEqual(seriesOf(r, "A").filter((e) => e.start), [start("2026-02-01", 1000, true)]);
  // A player left out of a reset gets no start entry and no reset flag that day.
  assert.deepEqual(seriesOf(r, "C").filter((e) => e.date === "2026-02-01"), [end("2026-02-01", 1001, 1)]);
});

test("games counts only the matches that counted; every rated player is snapshotted every day", () => {
  const r = run({
    players: [...roster({ A: 1000, B: 1000, C: 1000 }),
      { nickname: "S", initial_rating: 1000, suspended_from: "2026-01-01", suspended_to: null }],
    matches: [
      match("2026-01-05", "A", "B", 1, 0), match("2026-01-05", "A", "S", 1, 0),
      match("2026-01-05", "A", "X", 1, 0), match("2026-01-05", "B", "C", 1, 1),
      match("2026-01-07", "X", "Y", 1, 0),
    ],
  });
  const gamesOn = (date) => Object.fromEntries(["A", "B", "C", "S"].map((n) => [n, seriesOf(r, n).find((e) => e.date === date).games]));
  assert.deepEqual(gamesOn("2026-01-05"), { A: 1, B: 2, C: 1, S: 0 });
  assert.deepEqual(gamesOn("2026-01-07"), { A: 0, B: 0, C: 0, S: 0 });
});

test("history ratings are rounded to 2 decimals; reset bookkeeping fields are gone", () => {
  // Draw between Pro (coef 1) and Mid (coef 1.5): Pro gains 1 / 1.5.
  const r = run({ players: roster({ P: 1100, M: 1000 }), matches: [match("2026-01-05", "P", "M", 1, 1)] });
  assert.deepEqual(seriesOf(r, "P"), [end("2026-01-05", 1100.67, 1)]);
  assert.deepEqual(seriesOf(r, "M"), [end("2026-01-05", 1001.5, 1)]);
  assert.equal(r.leaderboard[0].rating, 1100.67);
  const all = Object.values(plain(r.history)).flat();
  assert.ok(all.every((e) => !("resetFrom" in e) && !("resetValues" in e)));
});

test("start entries give monthDelta the rating right after the monthly reset", () => {
  const players = roster({ A: 1000, B: 1000 });
  const matches = [match("2026-02-27", "A", "B", 1, 0)];
  for (let i = 0; i < 5; i++) matches.push(match("2026-03-01", "A", "B", 1, 0));
  matches.push(match("2026-03-03", "A", "B", 1, 0));
  const r = run({
    players, matches, groups: FLAT,
    adjustments: [adj("2026-03-01", "A", 1000, "monthly_reset", 1), adj("2026-03-01", "B", 1000, "monthly_reset", 2)],
  });
  const a = r.history.A;
  assert.equal(a.at(-1).rating, 1018);
  assert.equal(monthDelta(a, 7), 18); // includes the whole first day of the month
  assert.equal(monthDelta(a, 1), 3);
});

/* ================== E4: rating groups ================== */
test("normalizeGroups validates, normalizes and sorts groups", () => {
  const rows = [
    { id: 3, name: "Low", min_rating: 0, color: "red", coef: 2.5 },
    { id: 1, name: "Top", min_rating: "1100", color: "#ABCDEF", coef: "1" },
    { id: 2, name: "Mid", min: 1000, color: "#123", coef: 0 },
    { id: 7, name: "Neg", min_rating: 500, color: " #abcd ", coef: -1 },
    { id: 8, name: "NoCoef", min_rating: 250, coef: null },
    { id: 4, name: "Null", min_rating: null, coef: 2 },
    { id: 5, name: "Blank", min_rating: "", coef: 2 },
    { id: 6, name: "Text", min_rating: "abc", coef: 2 },
    null,
    "junk",
  ];
  const expected = [
    { id: 1, name: "Top", min: 1100, color: "#ABCDEF", coef: 1 },
    { id: 2, name: "Mid", min: 1000, color: "#123", coef: 1 },
    { id: 7, name: "Neg", min: 500, color: "#abcd", coef: 1 },
    { id: 8, name: "NoCoef", min: 250, color: "#8a94a6", coef: 1 },
    { id: 3, name: "Low", min: 0, color: "#8a94a6", coef: 2.5 },
  ];
  const groups = normalizeGroups(rows);
  assert.deepEqual(plain(groups), expected);
  assert.deepEqual(plain(normalizeGroups(groups)), expected, "idempotent");
  assert.deepEqual(plain(normalizeGroups(undefined)), []);
  assert.deepEqual(plain(normalizeGroups([{ name: "x", min: 5 }])), [{ id: null, name: "x", min: 5, color: "#8a94a6", coef: 1 }]);
});

test("normalizeGroups keeps the input order for equal minimums", () => {
  const groups = normalizeGroups([{ id: 1, name: "a", min: 0 }, { id: 2, name: "b", min: 10 }, { id: 3, name: "c", min: 0 }]);
  assert.deepEqual(plain(groups).map((g) => g.id), [2, 1, 3]);
});

test("computeRatings throws a clear error when no valid rating groups remain", () => {
  for (const groups of [[], undefined, [{ name: "x", min_rating: null, coef: 1 }]]) {
    assert.throws(() => computeRatings([], roster({ A: 1000 }), [], {}, groups), { message: "No rating groups configured" });
  }
});

test("computeRatings returns leaderboard, history and normalized groups", () => {
  const r = run({ players: roster({ A: 1150, B: 1000, C: 900 }), groups: [...GROUPS].reverse() });
  assert.deepEqual(Object.keys(r).sort(), ["groups", "history", "leaderboard"]);
  assert.deepEqual(plain(r.groups), plain(normalizeGroups(GROUPS)));
  assert.deepEqual(plain(r.leaderboard).map((x) => [x.rank, x.nickname, x.rating, x.group.name]),
    [[1, "A", 1150, "Pro"], [2, "B", 1000, "Mid"], [3, "C", 900, "Rookie"]]);
  for (const row of r.leaderboard) {
    assert.equal(row.group, groupForRating(row.rating, r.groups));
    assert.ok(r.groups.includes(row.group));
  }
});

test("the match coefficient comes from the normalized groups (a null coef counts as 1)", () => {
  const groups = [{ id: 1, name: "Pro", min_rating: 1100, coef: 1 }, { id: 2, name: "Base", min_rating: 0, coef: null }];
  const r = run({ groups, players: roster({ A: 1000, B: 1000 }), matches: [match("2026-01-05", "A", "B", 1, 0)] });
  assert.deepEqual(ratingsOf(r), { A: 1003, B: 997 });
});

/* ================== E5: prototype-safe nicknames ================== */
test("sheet nicknames that match Object.prototype keys do not crash or score", () => {
  const nasty = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];
  const r = run({
    players: roster({ A: 1000, B: 1000 }),
    matches: nasty.map((n) => match("2026-01-05", n, "A", 3, 0)),
    adjustments: nasty.map((n) => adj("2026-01-05", n, 5000)),
  });
  assert.deepEqual(ratingsOf(r), { A: 1000, B: 1000 });
  assert.equal(Object.getPrototypeOf(r.history), null);
  assert.deepEqual(Object.keys(r.history).sort(), ["A", "B"]);
});

test("configured players named like Object.prototype keys are rated normally", () => {
  const r = run({
    players: roster({ ["__proto__"]: 1000, constructor: 1000 }),
    matches: [match("2026-01-05", "__proto__", "constructor", 1, 0)],
  });
  assert.deepEqual(plain(r.leaderboard).map((x) => [x.nickname, x.rating]), [["__proto__", 1004.5], ["constructor", 995.5]]);
  assert.deepEqual(Object.keys(r.history).sort(), ["__proto__", "constructor"]);
  assert.ok(Array.isArray(r.history.__proto__));
  assert.deepEqual(plain(r.history.constructor), [end("2026-01-05", 995.5, 1)]);
});

/* ================== E6: settings ================== */
test("settings fall back to their defaults when non-finite or negative", () => {
  const players = roster({ A: 1000, B: 1000 });
  const matches = [match("2026-01-05", "A", "B", 1, 0), match("2026-01-06", "A", "B", 2, 2)];
  const bad = run({ groups: FLAT, players, matches, settings: { WinMin: "-5", WinMax: "abc", DrawMin: "Infinity", DrawMax: "-1" } });
  assert.deepEqual(ratingsOf(bad), { A: 1004, B: 998 }); // win 3, draw 1
  const zero = run({ groups: FLAT, players, matches, settings: { DrawMin: "0", DrawMax: 0 } });
  assert.deepEqual(ratingsOf(zero), { A: 1003, B: 997 });
  const comma = run({ groups: FLAT, players, matches, settings: { WinMin: "2,5", WinMax: "2,5" } });
  assert.deepEqual(ratingsOf(comma), { A: 1003.5, B: 998.5 });
  const blank = run({ groups: FLAT, players, matches, settings: { WinMin: "", WinMax: "  ", DrawMin: null } });
  assert.deepEqual(ratingsOf(blank), { A: 1004, B: 998 }); // blank means missing: defaults
});

test("a whole points range that is inexact in floating point awards min + a whole number", () => {
  const players = roster({ A: 1000, B: 1000 });
  const awarded = new Set();
  for (let i = 0; i < 60; i++) {
    const r = run({ groups: FLAT, players, matches: [match("2026-01-05", "A", "B", 1, 0, i + 2)], settings: { WinMin: "1.3", WinMax: "3.3" } });
    awarded.add(Math.round((ratingsOf(r).A - 1000) * 100) / 100);
  }
  assert.ok([...awarded].every((v) => [1.3, 2.3, 3.3].includes(v)), [...awarded].join(","));
  assert.ok(awarded.size > 1);
});

/* ================== Existing rating semantics ================== */
test("a win is worth base points times the winner's group coefficient", () => {
  const r = run({
    players: roster({ R: 900, P: 1150 }),
    matches: [match("2026-01-05", "R", "P", 2, 1), match("2026-01-06", "R", "P", 0, 1)],
  });
  const [rs, ps] = [seriesOf(r, "R"), seriesOf(r, "P")];
  assert.deepEqual([rs[0].rating, ps[0].rating], [906, 1144]); // Rookie winner: 3 * 2
  assert.deepEqual([rs[1].rating, ps[1].rating], [903, 1147]); // Pro winner: 3 * 1
});

test("a draw between equal coefficients gives both players the draw points", () => {
  const r = run({ players: roster({ A: 1000, B: 1050 }), matches: [match("2026-01-05", "A", "B", 1, 1)] });
  assert.deepEqual(ratingsOf(r), { B: 1051, A: 1001 });
});

test("a draw between unequal coefficients: weaker gets points*coef, stronger points/coef", () => {
  for (const [p1, p2] of [["P", "R"], ["R", "P"]]) {
    const r = run({ players: roster({ P: 1150, R: 900 }), matches: [match("2026-01-05", p1, p2, 0, 0)] });
    assert.deepEqual(ratingsOf(r), { P: 1150.5, R: 902 });
  }
});

test("suspensions are inclusive on both ends and may be open-ended", () => {
  const players = [
    ...roster({ A: 1000 }),
    { nickname: "S", initial_rating: 1000, suspended_from: "2026-01-10", suspended_to: "2026-01-12" },
    { nickname: "T", initial_rating: 1000, suspended_from: "2026-01-10", suspended_to: null },
  ];
  const days = ["2026-01-09", "2026-01-10", "2026-01-12", "2026-01-13", "2026-02-20"];
  const matches = days.flatMap((d) => [match(d, "S", "A", 1, 0), match(d, "T", "A", 1, 0)]);
  const r = run({ players, matches, groups: FLAT });
  const games = (nick) => seriesOf(r, nick).map((e) => e.games);
  assert.deepEqual(games("S"), [1, 0, 0, 1, 1]);
  assert.deepEqual(games("T"), [1, 0, 0, 0, 0]);
  assert.deepEqual(ratingsOf(r), { S: 1009, T: 1003, A: 988 });
});

test("players without an initial rating are skipped", () => {
  const r = run({
    players: [...roster({ A: 1000 }), { nickname: "N", initial_rating: null }, { nickname: "E", initial_rating: "" },
      { nickname: "W", initial_rating: "abc" }, { nickname: "M" }],
    matches: ["N", "E", "W", "M"].map((n) => match("2026-01-05", n, "A", 1, 0)),
  });
  assert.deepEqual(ratingsOf(r), { A: 1000 });
  assert.deepEqual(seriesOf(r, "A"), [end("2026-01-05", 1000, 0)]);
});

test("basePoints stays within [min, max] for integer ranges and is deterministic", () => {
  const players = roster({ A: 1000, B: 1000 });
  const deltas = (settings, withSignature = true) => Array.from({ length: 200 }, (_, i) => {
    const m = match("2026-01-05", "A", "B", 1, 0, i + 2);
    if (!withSignature) delete m.signature;
    return ratingsOf(run({ groups: FLAT, players, matches: [m], settings })).A - 1000;
  });
  const values = deltas({ WinMin: 1, WinMax: 10 });
  assert.ok(values.every((v) => Number.isInteger(v) && v >= 1 && v <= 10), String(values));
  assert.ok(new Set(values).size >= 5, "the hash spreads over the range");
  assert.deepEqual(deltas({ WinMin: 1, WinMax: 10 }), values, "same input, same points");
  assert.deepEqual(deltas({ WinMin: 10, WinMax: 1 }), values, "min and max may be swapped");
  // Without a signature, basePoints builds the same one from the match fields.
  assert.deepEqual(deltas({ WinMin: 1, WinMax: 10 }, false), values);
});

test("ratings match the original engine for a fixed data set (Apps Script parity)", () => {
  const m = (date, p1, p2, s1, s2, row) => match(date, p1, p2, s1, s2, row);
  const matches = [
    m("2026-01-05", "A", "B", 3, 1, 2), m("2026-01-05", "C", "D", 2, 2, 3), m("2026-01-05", "B", "C", 0, 1, 4), m("2026-01-05", "D", "A", 4, 0, 5),
    m("2026-01-06", "A", "C", 1, 1, 2), m("2026-01-06", "B", "D", 2, 3, 3), m("2026-01-06", "C", "A", 5, 2, 4), m("2026-01-06", "D", "B", 1, 1, 5),
    m("2026-01-09", "A", "D", 2, 0, 2), m("2026-01-09", "B", "C", 3, 3, 3), m("2026-01-09", "C", "D", 0, 2, 4), m("2026-01-09", "A", "B", 1, 0, 5),
  ];
  const r = run({
    players: roster({ A: 1000, B: 1090, C: 900, D: 1150 }), matches,
    settings: { WinMin: "1", WinMax: "10", DrawMin: "0", DrawMax: "3" },
  });
  // Values produced by the engine before this refactor.
  assert.deepEqual(plain(r.leaderboard).map((x) => [x.nickname, x.rating, x.group.name]),
    [["D", 1163, "Pro"], ["B", 1063.5, "Mid"], ["A", 1000.5, "Mid"], ["C", 920, "Rookie"]]);
  assert.deepEqual(seriesOf(r, "A").map((e) => e.rating), [999.5, 980.5, 1000.5]);
});

test("leaderboard ties (after rounding) are sorted by name and ranked 1..n", () => {
  const r = run({ players: roster({ Cid: 1000.004, Bob: 1000.001, abe: 1000, Top: 1200 }) });
  assert.deepEqual(plain(r.leaderboard).map((x) => [x.rank, x.nickname, x.rating]),
    [[1, "Top", 1200], [2, "abe", 1000], [3, "Bob", 1000], [4, "Cid", 1000]]);
});

/* ================== E7: Supabase loading ================== */
function supabaseFetch(tables, { failTable } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, headers: init?.headers });
    const u = new URL(url);
    if (u.hostname === "docs.google.com") return { ok: true, status: 200, text: async () => '"","Year","Link"' };
    const table = u.pathname.replace("/rest/v1/", "");
    if (table === failTable) return { ok: false, status: 503, json: async () => ({}) };
    const offset = Number(u.searchParams.get("offset"));
    const limit = Number(u.searchParams.get("limit"));
    const rows = (tables[table] ?? []).slice(offset, offset + limit);
    return { ok: true, status: 200, json: async () => rows };
  };
  return { fetch, requests };
}

test("loadEngineData requests every table in a deterministic order and pages past 1000 rows", async () => {
  const many = Array.from({ length: 1005 }, (_, i) => ({ nickname: `P${String(i).padStart(4, "0")}`, initial_rating: 1000 }));
  const stub = supabaseFetch({
    player_config: many,
    settings: [{ key: "WinMin", value: "2" }],
    rating_groups: GROUPS,
  });
  const s = loadSite({ console: silentConsole, fetch: stub.fetch });
  const data = await s.loadEngineData();
  assert.equal(data.players.length, 1005);
  assert.deepEqual(plain(data.settingsMap), { WinMin: "2" });
  const paths = stub.requests.map((r) => r.url).filter((u) => u.includes("/rest/v1/"))
    .map((u) => u.slice(u.indexOf("/rest/v1/") + 9)).sort();
  assert.deepEqual(paths, [
    "player_config?select=*&order=nickname.asc&limit=1000&offset=0",
    "player_config?select=*&order=nickname.asc&limit=1000&offset=1000",
    "rating_adjustments?select=*&order=applied_date.asc,id.asc&limit=1000&offset=0",
    "rating_groups?select=id,name,min_rating,color,coef&order=min_rating.desc,id.asc&limit=1000&offset=0",
    "settings?select=*&order=key.asc&limit=1000&offset=0",
  ]);
  const { URL: base, KEY } = s.SUPABASE;
  for (const r of stub.requests.filter((x) => x.url.includes("/rest/v1/"))) {
    assert.ok(r.url.startsWith(`${base}/rest/v1/`));
    assert.deepEqual(plain(r.headers), { apikey: KEY, Authorization: `Bearer ${KEY}` });
  }
});

test("buildRatings returns leaderboard, history and groups; a failed table rejects", async () => {
  const tables = { player_config: roster({ A: 1000 }), rating_groups: GROUPS };
  const s = loadSite({ console: silentConsole, fetch: supabaseFetch(tables).fetch });
  const result = await s.buildRatings();
  assert.deepEqual(plain(result.leaderboard).map((x) => [x.nickname, x.rating, x.group.name]), [["A", 1000, "Mid"]]);
  assert.deepEqual(Object.keys(result).sort(), ["groups", "history", "leaderboard"]);
  const broken = loadSite({ console: silentConsole, fetch: supabaseFetch(tables, { failTable: "settings" }).fetch });
  await assert.rejects(broken.buildRatings(), /Supabase error: 503 settings\?/);
});

test("buildRatings rejects when the Google Sheets index cannot be loaded", async () => {
  const tables = { player_config: roster({ A: 1000 }), rating_groups: GROUPS };
  const { fetch } = supabaseFetch(tables);
  const sheetsDown = async (url, init) => (new URL(url).hostname === "docs.google.com"
    ? { ok: false, status: 500, text: async () => "" }
    : fetch(url, init));
  const s = loadSite({ console: silentConsole, fetch: sheetsDown });
  await assert.rejects(s.buildRatings(), /Sheets: failed to load index: HTTP 500/);
});

test("buildRatings applies adjustments up to max(today, last match date) and holds back later ones", async () => {
  const tables = {
    player_config: roster({ A: 1000, B: 1000 }),
    rating_groups: GROUPS,
    rating_adjustments: [
      adj("2099-06-01", "A", 900, "penalty", 1), // after today, before the sheet's last match: applies
      adj("2099-07-01", "B", 1500, "monthly_reset", 2), // after both: held back
    ],
  };
  const { fetch } = supabaseFetch(tables);
  const csv = '"Date","T","Time","T1","T2","P1","P2","S1","","S2"\n"15.06.2099","T","7:30:00","X","Y","A","B","1","","0"';
  const withSheet = async (url, init) => {
    const u = new URL(url);
    if (u.hostname !== "docs.google.com") return fetch(url, init);
    if (u.pathname.includes("DOC99")) return { ok: true, status: 200, text: async () => (u.searchParams.get("sheet") === "Jun99" ? csv : "") };
    return { ok: true, status: 200, text: async () => '"","2099","https://docs.google.com/spreadsheets/d/DOC99/edit"' };
  };
  const s = loadSite({ console: silentConsole, fetch: withSheet });
  const result = await s.buildRatings();
  // A is set to 900 (Rookie, coef 2) and wins 3 x 2 = 6; B's July reset has not happened yet.
  assert.deepEqual(ratingsOf(result), { B: 994, A: 906 });
});
