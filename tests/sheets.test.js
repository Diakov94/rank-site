"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSite, plain } = require("./helpers/load.js");

/* A console that records calls instead of printing them. */
function recorder() {
  const calls = { log: [], warn: [], error: [] };
  return { calls, console: {
    log: (...a) => calls.log.push(a.join(" ")),
    warn: (...a) => calls.warn.push(a.join(" ")),
    error: (...a) => calls.error.push(a.join(" ")),
  } };
}
function freshSite(fetch) {
  const rec = recorder();
  return { site: loadSite({ console: rec.console, fetch }), calls: rec.calls };
}

const { site } = freshSite();
const { parseCsv, parseIndexSheet } = site;

const HEADER = '"Date","Tournament","Time","Team1","Team2","Player1","Player2","Score1","","Score2"';
function row(date, p1, p2, s1, s2, tournament = "Cup") {
  return [date, tournament, "12:00", "T1", "T2", p1, p2, s1, "", s2]
    .map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
}
const csv = (...rows) => [HEADER, ...rows].join("\n");
const brief = (matches) => plain(matches).map((m) => [m.date, m.player1, m.player2, m.rowIndex]);

/* ================== parseCsv ================== */
test("parseCsv handles quotes, escaped quotes and commas inside quotes", () => {
  assert.deepEqual(plain(parseCsv('a,b\n"c,d","e ""q"""\n')), [["a", "b"], ["c,d", 'e "q"']]);
  assert.deepEqual(plain(parseCsv('"",x,""""')), [["", "x", '"']]);
});

test("parseCsv keeps line breaks inside quoted cells in one record", () => {
  assert.deepEqual(plain(parseCsv('"x\ny",z\nw,v')), [["x\ny", "z"], ["w", "v"]]);
  assert.deepEqual(plain(parseCsv('"a\r\nb",c\r\nd,e')), [["a\r\nb", "c"], ["d", "e"]]);
});

test("parseCsv accepts CRLF and LF record ends and ignores one trailing line break", () => {
  assert.deepEqual(plain(parseCsv("a,b\r\nc,d\r\n")), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(plain(parseCsv("a,b\nc,d")), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(plain(parseCsv("a,\n\nb")), [["a", ""], [""], ["b"]]);
  assert.deepEqual(plain(parseCsv('a\n""')), [["a"], [""]]);
  assert.deepEqual(plain(parseCsv("")), []);
});

test("parseCsv reads back any RFC 4180 serialization of random records", () => {
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
  const pieces = ["a", "b", ",", '"', '""', "\n", "\r\n", " ", "é"];
  for (let i = 0; i < 500; i++) {
    const records = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () =>
      Array.from({ length: 1 + Math.floor(rnd() * 5) }, () =>
        Array.from({ length: Math.floor(rnd() * 5) }, () => pieces[Math.floor(rnd() * pieces.length)]).join("")));
    const eol = rnd() < 0.5 ? "\n" : "\r\n";
    const text = records.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join(eol) + (rnd() < 0.5 ? eol : "");
    assert.deepEqual(plain(parseCsv(text)), records, JSON.stringify(text));
  }
});

/* ================== parseMonthCsv ================== */
test("parseMonthCsv skips the header and keeps worksheet row numbers and signatures", () => {
  const { site } = freshSite();
  const text = [row("01.01.2026", "H1", "H2", 1, 0), row("5.1.2026", "A", "B", 3, 1), row("06.01.2026", "C", "D", 2, 2)].join("\n");
  assert.deepEqual(plain(site.parseMonthCsv(text)), [
    { date: "2026-01-05", player1: "A", player2: "B", score1: 3, score2: 1, rowIndex: 2, signature: "2026-01-05|#2|A|B|3|1" },
    { date: "2026-01-06", player1: "C", player2: "D", score1: 2, score2: 2, rowIndex: 3, signature: "2026-01-06|#3|C|D|2|2" },
  ]);
});

test("parseMonthCsv: a quoted line break does not shift later row numbers", () => {
  const { site } = freshSite();
  const text = csv(row("05.01.2026", "A", "B", 1, 0), row("05.01.2026", "C", "D", 1, 0, "Cup\nFinal"), row("06.01.2026", "E", "F", 0, 1));
  assert.deepEqual(brief(site.parseMonthCsv(text)), [["2026-01-05", "A", "B", 2], ["2026-01-05", "C", "D", 3], ["2026-01-06", "E", "F", 4]]);
});

test("parseMonthCsv: CRLF input parses like LF input", () => {
  const { site } = freshSite();
  const rows = [row("05.01.2026", "A", "B", 1, 0), row("06.01.2026", "E", "F", 0, 1)];
  assert.deepEqual(plain(site.parseMonthCsv(csv(...rows).replace(/\n/g, "\r\n"))), plain(site.parseMonthCsv(csv(...rows))));
  assert.equal(site.parseMonthCsv(csv(...rows).replace(/\n/g, "\r\n")).length, 2);
});

test("parseMonthCsv unescapes quotes in nicknames", () => {
  const { site } = freshSite();
  const [m] = site.parseMonthCsv(csv(row("05.01.2026", 'The "Rock"', "B", 1, 0)));
  assert.equal(m.player1, 'The "Rock"');
  assert.equal(m.signature, '2026-01-05|#2|The "Rock"|B|1|0');
});

test("parseMonthCsv skips impossible dates, counts them and warns once per tab", () => {
  const { site, calls } = freshSite();
  const text = csv(
    row("31.02.2026", "A", "B", 1, 0), row("29.02.2025", "A", "B", 1, 0), row("29.02.2028", "A", "B", 1, 0),
    row("00.01.2026", "A", "B", 1, 0), row("15.13.2026", "A", "B", 1, 0), row("15.00.2026", "A", "B", 1, 0),
    row("31.04.2026", "A", "B", 1, 0), row("31.12.2026", "A", "B", 1, 0), row("29.02.2000", "A", "B", 1, 0),
    row("29.02.1900", "A", "B", 1, 0),
  );
  assert.deepEqual(plain(site.parseMonthCsv(text, "Feb26")).map((m) => [m.date, m.rowIndex]),
    [["2028-02-29", 4], ["2026-12-31", 9], ["2000-02-29", 10]]);
  assert.equal(calls.warn.length, 1);
  assert.match(calls.warn[0], /Feb26/);
  assert.match(calls.warn[0], /\b7\b/);
});

test("parseMonthCsv does not warn when every date is valid", () => {
  const { site, calls } = freshSite();
  site.parseMonthCsv(csv(row("05.01.2026", "A", "B", 1, 0), row("not a date", "A", "B", 1, 0)), "Jan26");
  assert.deepEqual(calls.warn, []);
});

test("parseMonthCsv skips short rows and rows without players or scores", () => {
  const { site } = freshSite();
  const text = csv(
    '"05.01.2026","Cup","12:00"',
    "",
    row("05.01.2026", "", "B", 1, 0),
    row("05.01.2026", "A", " ", 1, 0),
    row("05.01.2026", "A", "B", "", 0),
    row("05.01.2026", "A", "B", 1, "x"),
    row("05.01.2026", " A ", " B ", " 2 ", " 1 "),
  );
  assert.deepEqual(plain(site.parseMonthCsv(text)), [
    { date: "2026-01-05", player1: "A", player2: "B", score1: 2, score2: 1, rowIndex: 8, signature: "2026-01-05|#8|A|B|2|1" },
  ]);
  assert.deepEqual(plain(site.parseMonthCsv("")), []);
});

/* ================== parseIndexSheet ================== */
const docUrl = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;

test("parseIndexSheet reads year and doc id, skips the header and dedupes sheet ids per year", () => {
  const index = [
    '"","Year","Link"',
    `"","2026","${docUrl("DOC_26")}"`,
    `"","2026","${docUrl("DOC_26")}"`,
    `"","2027","${docUrl("DOC_27")}"`,
    `"","2027","https://docs.google.com/spreadsheets/d/DOC_27/gviz/tq"`,
    `"","2027","${docUrl("DOC_26")}"`,
    '"","2028","not a link"',
    '"","","https://docs.google.com/spreadsheets/d/NOYEAR/edit"',
  ].join("\n");
  // A doc listed under two years is kept for both: each year reads its own MonYY tabs.
  assert.deepEqual(plain(parseIndexSheet(index)),
    [{ year: 2026, sheetId: "DOC_26" }, { year: 2027, sheetId: "DOC_27" }, { year: 2027, sheetId: "DOC_26" }]);
});

/* ================== fetchMatchesFromSheets ================== */
const INDEX_ID = site.SHEETS_INDEX_ID;
const indexCsv = (...entries) => ['"","Year","Link"', ...entries.map(([year, id]) => `"","${year}","${docUrl(id)}"`)].join("\n");
const ok = (body) => ({ ok: true, status: 200, text: async () => body });
const fail = (status) => ({ ok: false, status, text: async () => "<html>error</html>" });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Stub for fetch: `index` answers the index doc, `tabs[sheetId][tabName]` a month tab
 * (missing tabs answer 200 with an empty body, as gviz does). Values may be responses,
 * Errors (the fetch rejects) or functions returning either. */
function sheetsFetch({ index, tabs = {} }) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const u = new URL(url);
    const id = u.pathname.split("/")[3];
    let answer = id === INDEX_ID ? index : tabs[id]?.[u.searchParams.get("sheet")] ?? ok("");
    if (typeof answer === "function") answer = await answer(url);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, requests };
}

test("fetchMatchesFromSheets throws when the index cannot be fetched", async () => {
  const { site } = freshSite(sheetsFetch({ index: new TypeError("Failed to fetch") }).fetch);
  await assert.rejects(site.fetchMatchesFromSheets(), /Sheets: failed to load index: Failed to fetch/);
});

test("fetchMatchesFromSheets throws when the index answers non-OK", async () => {
  const { site } = freshSite(sheetsFetch({ index: fail(500) }).fetch);
  await assert.rejects(site.fetchMatchesFromSheets(), /index: HTTP 500/);
});

test("fetchMatchesFromSheets throws when a month tab fails or answers non-OK", async () => {
  const index = ok(indexCsv([2026, "DOC_26"]));
  const broken = sheetsFetch({ index, tabs: { DOC_26: { Feb26: new TypeError("network down") } } });
  await assert.rejects(freshSite(broken.fetch).site.fetchMatchesFromSheets(), /tab Feb26: network down/);
  const limited = sheetsFetch({ index, tabs: { DOC_26: { Mar26: fail(429) } } });
  await assert.rejects(freshSite(limited.fetch).site.fetchMatchesFromSheets(), /tab Mar26: HTTP 429/);
});

test("fetchMatchesFromSheets treats empty tabs as months without matches", async () => {
  const stub = sheetsFetch({
    index: ok(indexCsv([2026, "DOC_26"])),
    tabs: { DOC_26: { Jan26: ok(csv(row("05.01.2026", "A", "B", 1, 0))) } },
  });
  const { site, calls } = freshSite(stub.fetch);
  assert.deepEqual(brief(await site.fetchMatchesFromSheets()), [["2026-01-05", "A", "B", 2]]);
  assert.deepEqual(calls.log, ["Sheets: loaded 1 matches"]);
});

test("fetchMatchesFromSheets requests MonYY tabs once per distinct sheet id and year", async () => {
  const stub = sheetsFetch({ index: ok(indexCsv([2026, "DOC_26"], [2026, "DOC_26"], [2027, "DOC_27"])) });
  await freshSite(stub.fetch).site.fetchMatchesFromSheets();
  const tabs = stub.requests.slice(1).map((url) => {
    const u = new URL(url);
    return `${u.pathname.split("/")[3]}:${u.searchParams.get("sheet")}`;
  });
  assert.deepEqual(tabs.sort(), [...MONTHS.map((m) => `DOC_26:${m}26`), ...MONTHS.map((m) => `DOC_27:${m}27`)].sort());
  assert.equal(stub.requests.length, 1 + 24);
  assert.match(stub.requests[0], new RegExp(`/spreadsheets/d/${INDEX_ID}/gviz/tq\\?tqx=out:csv$`));
});

test("fetchMatchesFromSheets: a doc listed twice counts its matches once; one doc may serve two years", async () => {
  const stub = sheetsFetch({
    index: ok(indexCsv([2026, "DOC"], [2026, "DOC"], [2027, "DOC"])),
    tabs: { DOC: {
      Dec26: ok(csv(row("30.12.2026", "A", "B", 1, 0))),
      Jan27: ok(csv(row("02.01.2027", "C", "D", 0, 1))),
    } },
  });
  assert.deepEqual(brief(await freshSite(stub.fetch).site.fetchMatchesFromSheets()),
    [["2026-12-30", "A", "B", 2], ["2027-01-02", "C", "D", 2]]);
  assert.equal(stub.requests.length, 1 + 24);
});

test("fetchMatchesFromSheets loads all years' tabs in parallel", async () => {
  let inFlight = 0, maxInFlight = 0;
  const slow = () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => setTimeout(() => { inFlight--; resolve(ok("")); }, 5));
  };
  const tabsFor = (yy) => Object.fromEntries(MONTHS.map((m) => [m + yy, slow]));
  const stub = sheetsFetch({
    index: ok(indexCsv([2025, "DOC_25"], [2026, "DOC_26"])),
    tabs: { DOC_25: tabsFor("25"), DOC_26: tabsFor("26") },
  });
  await freshSite(stub.fetch).site.fetchMatchesFromSheets();
  assert.equal(maxInFlight, 24);
});

test("fetchMatchesFromSheets sorts by date, then by worksheet row", async () => {
  const stub = sheetsFetch({
    index: ok(indexCsv([2026, "DOC_26"], [2027, "DOC_27"])),
    tabs: {
      DOC_26: {
        Jan26: ok(csv(row("10.01.2026", "A", "B", 1, 0), row("05.01.2026", "C", "D", 1, 0), row("05.01.2026", "E", "F", 1, 0))),
        Feb26: ok(csv(row("05.01.2026", "G", "H", 1, 0), row("01.02.2026", "I", "J", 1, 0))),
      },
      DOC_27: { Jan27: ok(csv(row("01.01.2027", "K", "L", 1, 0))) },
    },
  });
  assert.deepEqual(brief(await freshSite(stub.fetch).site.fetchMatchesFromSheets()), [
    ["2026-01-05", "G", "H", 2],
    ["2026-01-05", "C", "D", 3],
    ["2026-01-05", "E", "F", 4],
    ["2026-01-10", "A", "B", 2],
    ["2026-02-01", "I", "J", 3],
    ["2027-01-01", "K", "L", 2],
  ]);
});

test("fetchMatchesFromSheets returns no matches and warns when the index lists no years", async () => {
  const stub = sheetsFetch({ index: ok('"","Year","Link"') });
  const { site, calls } = freshSite(stub.fetch);
  assert.deepEqual(plain(await site.fetchMatchesFromSheets()), []);
  assert.deepEqual(calls.warn, ["Sheets: no year entries in index"]);
  assert.equal(stub.requests.length, 1);
});
