/* ============================================================
 * ESportsBattle Rank — Google Sheets Match Source
 * Index doc maps year → output doc.
 * Output doc has tabs: Jan26, Feb26, ..., Dec26
 * ============================================================ */
"use strict";

const SHEETS_INDEX_ID = "1L-yxNa_4JgH3bebdzPjq91DJgA5tT-WYzTvMsvoC_ow";

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];

/* ---- CSV parser ---- */
function parseCsvLine(line) {
  const cells = [];
  let inQ = false, cell = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === "," && !inQ) { cells.push(cell); cell = ""; }
    else { cell += c; }
  }
  cells.push(cell);
  return cells;
}

/* ---- Parse index sheet: col B = year, col C = URL ---- */
function parseIndexSheet(csv) {
  const result = [];
  for (const line of csv.split("\n")) {
    const cells = parseCsvLine(line);
    const year  = parseInt(cells[1]);
    const url   = (cells[2] || "").trim();
    if (!year || !url) continue;
    const sheetId = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    if (sheetId) result.push({ year, sheetId });
  }
  return result;
}

/* ---- Parse one month tab CSV into match objects ---- */
// Tab format: row 1 = header, rows 2+ = data
// Columns A-J: Date, Tournament, Time, Team1, Team2, Player1, Player2, Score1, (empty), Score2
function parseMonthCsv(text) {
  const matches = [];
  const lines   = text.split("\n");

  // Row 0 is header — skip it
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cells = parseCsvLine(line);
    if (cells.length < 10) continue;

    // A (0): date DD.MM.YYYY
    const dateRaw = cells[0].trim();
    if (!/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(dateRaw)) continue;
    const [dd, mm, yyyy] = dateRaw.split(".");
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
  return matches;
}

/* ---- Main: fetch all matches from all years/months ---- */
async function fetchMatchesFromSheets() {
  // 1. Read index
  const indexUrl = `https://docs.google.com/spreadsheets/d/${SHEETS_INDEX_ID}/gviz/tq?tqx=out:csv`;
  let indexCsv;
  try {
    indexCsv = await fetch(indexUrl).then(r => r.text());
  } catch (e) {
    console.error("Sheets: failed to load index", e);
    return [];
  }

  const yearEntries = parseIndexSheet(indexCsv);
  if (!yearEntries.length) {
    console.warn("Sheets: no year entries in index");
    return [];
  }

  // 2. Follow the central document's links and read only the linked month tabs.
  const allMatches = [];

  for (const { year, sheetId } of yearEntries) {
    const yy = String(year).slice(2); // "2026" → "26"

    // Try all month tabs in parallel
    const monthResults = await Promise.all(MONTH_ABBR.map(abbr => {
      const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(abbr + yy)}`;
      return fetch(url).then(r => r.text()).then(csv => parseMonthCsv(csv)).catch(() => []);
    }));

    const monthMatches = monthResults.flat();

    allMatches.push(...monthMatches);
  }

  // 3. Order dates chronologically, preserving sheet row order within a day.
  // The supplied Apps Script processes matches by their source row, not time.
  allMatches.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.rowIndex - b.rowIndex;
  });

  console.log(`Sheets: loaded ${allMatches.length} matches`);
  return allMatches;
}
