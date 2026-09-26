/* ============================================================
 * ESportsBattle Rank — Google Sheets Match Source
 * Index doc maps year → output doc.
 * Output doc has tabs: Jan26, Feb26, ..., Dec26
 * ============================================================ */
"use strict";

const SHEETS_INDEX_ID = "1L-yxNa_4JgH3bebdzPjq91DJgA5tT-WYzTvMsvoC_ow";

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];

/* ---- CSV parser (RFC 4180) ----
 * Whole text -> records (arrays of cells). Handles "" inside quoted cells, commas and
 * line breaks inside quotes, and LF or CRLF record ends. One record = one worksheet row. */
function parseCsv(text) {
  const records = [];
  let record = [], cell = "", inQ = false, open = false; // open: current record has content
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    open = true;
    if (inQ) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else inQ = false;
    }
    else if (c === '"') { inQ = true; }
    else if (c === ",") { record.push(cell); cell = ""; }
    else if (c === "\n" || (c === "\r" && text[i + 1] === "\n")) {
      if (c === "\r") i++;
      record.push(cell); records.push(record);
      record = []; cell = ""; open = false;
    }
    else { cell += c; }
  }
  if (open) { record.push(cell); records.push(record); }
  return records;
}

/* ---- Parse index sheet: col B = year, col C = URL ----
 * One entry per (year, sheet id): a doc listed twice for a year would load its tabs twice
 * and count every match twice. A doc listed under two years is kept for both, because each
 * year reads its own tabs (Jan26… vs Jan27…). */
function parseIndexSheet(csv) {
  const result = [];
  const seen = new Set();
  for (const cells of parseCsv(csv)) {
    const year  = parseInt(cells[1]);
    const url   = (cells[2] || "").trim();
    if (!year || !url) continue;
    const sheetId = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    const key = `${year}|${sheetId}`;
    if (!sheetId || seen.has(key)) continue;
    seen.add(key);
    result.push({ year, sheetId });
  }
  return result;
}

/* ---- Parse one month tab CSV into match objects ---- */
// Tab format: row 1 = header, rows 2+ = data
// Columns A-J: Date, Tournament, Time, Team1, Team2, Player1, Player2, Score1, (empty), Score2
function parseMonthCsv(text, tabName = "month tab") {
  const matches = [];
  const rows    = parseCsv(text);
  let badDates  = 0;

  // Row 0 is header — skip it
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length < 10) continue;

    // A (0): date DD.MM.YYYY, and it must exist in the calendar
    const dateRaw = cells[0].trim();
    if (!/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(dateRaw)) continue;
    const [dd, mm, yyyy] = dateRaw.split(".");
    const day = Number(dd), month = Number(mm), year = Number(yyyy);
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (!monthDays || day < 1 || day > monthDays) { badDates++; continue; }
    const date = `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;

    // F (5): Player1, G (6): Player2
    const player1 = cells[5].trim();
    const player2 = cells[6].trim();
    if (!player1 || !player2) continue;

    // H (7): Score1, J (9): Score2
    const s1raw  = cells[7].trim();
    const s2raw  = cells[9].trim();
    const score1 = Number(s1raw);
    const score2 = Number(s2raw);
    if (!s1raw || !s2raw || !Number.isFinite(score1) || !Number.isFinite(score2)) continue;

    // Keep the source row position: the rating calculation uses source row order both
    // to apply same-day matches and as part of the deterministic points hash.
    const rowIndex = i + 1; // 1-based worksheet row (header is row 1)
    const signature = `${date}|#${rowIndex}|${player1}|${player2}|${score1}|${score2}`;
    matches.push({ date, player1, player2, score1, score2, rowIndex, signature });
  }
  if (badDates) console.warn(`Sheets: ${tabName}: skipped ${badDates} row(s) with an invalid date`);
  return matches;
}

/* ---- Fetch one gviz CSV; network errors and non-OK responses throw ----
 * A tab that does not exist comes back as 200 with an empty body (no matches). */
async function fetchSheetText(url, what) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Sheets: failed to load ${what}: ${e?.message ?? e}`, { cause: e });
  }
  if (!res.ok) throw new Error(`Sheets: failed to load ${what}: HTTP ${res.status}`);
  return res.text();
}

/* ---- Main: fetch all matches from all years/months ---- */
async function fetchMatchesFromSheets() {
  // 1. Read index
  const indexUrl = `https://docs.google.com/spreadsheets/d/${SHEETS_INDEX_ID}/gviz/tq?tqx=out:csv`;
  const indexCsv = await fetchSheetText(indexUrl, "index");

  const yearEntries = parseIndexSheet(indexCsv);
  if (!yearEntries.length) {
    console.warn("Sheets: no year entries in index");
    return [];
  }

  // 2. Follow the central document's links and read the month tabs of every year in parallel.
  const tabs = yearEntries.flatMap(({ year, sheetId }) => {
    const yy = String(year).slice(2); // "2026" → "26"
    return MONTH_ABBR.map((abbr) => ({ sheetId, tabName: abbr + yy }));
  });
  const monthResults = await Promise.all(tabs.map(({ sheetId, tabName }) => {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
    return fetchSheetText(url, `tab ${tabName}`).then((csv) => parseMonthCsv(csv, tabName));
  }));

  const allMatches = monthResults.flat();

  // 3. Order dates chronologically, preserving sheet row order within a day.
  // The supplied Apps Script processes matches by their source row, not time.
  allMatches.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.rowIndex - b.rowIndex;
  });

  console.log(`Sheets: loaded ${allMatches.length} matches`);
  return allMatches;
}
