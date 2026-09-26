/* ============================================================
 * ESportsBattle Rank — public leaderboard
 * Single-file vanilla JS app. No build step, no dependencies.
 * ============================================================ */
"use strict";

/* Uses SUPABASE, ADMIN_SESSION_KEY and the helpers from common.js, and buildRatings /
 * sbFetchAll from engine.js. */

/* ================== CONFIG ================== */
const CONFIG = Object.freeze({
  CHART_ANIM_MS: 600,
  REFRESH_MS: 10 * 60 * 1000, // auto-refresh interval, and how old data may get before a refresh on tab return
});

/* ================== DOM REFS ================== */
const $ = (id) => document.getElementById(id);

const els = {
  tbody:         document.querySelector("#leaderboard tbody"),
  search:        $("search"),
  refresh:       $("refresh"),

  profileTitle:  $("profileTitle"),
  currentRating: $("currentRating"),

  history:       $("history"),
  chart:         $("chart"),
  chartTip:      $("chartTip"),
  dateFrom:      $("dateFrom"),
  dateTo:        $("dateTo"),

  playerPhoto:        $("playerPhoto"),
  photoNick:          $("photoNick"),
  groupDot:           $("groupDot"),
  groupName:          $("groupName"),
  playerAchievements: $("playerAchievements"),

  weekBanner:  $("weekBanner"),
  weekAvatar:  $("weekAvatar"),
  weekNick:    $("weekNick"),
  weekDelta:   $("weekDelta"),
  weekRating:  $("weekRating"),

  miniCard:    $("miniCard"),
  miniAvatar:  $("miniAvatar"),
  miniNick:    $("miniNick"),
  miniRating:  $("miniRating"),
  miniDot:     $("miniDot"),
  miniGroup:   $("miniGroup"),

  compareModal:    $("compareModal"),
  compareGrid:     $("compareGrid"),
  compareClose:    $("compareClose"),

  adminLink:   $("adminLink"),
  loadNotice:  $("loadNotice"),
};

/* ================== STATE ================== */
const state = {
  players: [],            // [{ nick, series, ends }] — ends = the series without start-of-day entries
  hiddenNicks: new Set(),
  groups: [],             // normalized rating groups from buildRatings()
  selected: null,
  deepLinkNick: null,     // ?player= as it was when the page opened
  dateFrom: "",
  dateTo:   "",
  rangeIsDefault: true,   // false once the viewer picks dates; the default follows new data
  dataSpan: { first: "", last: "" },
  globalRows: [],
  globalRankByNick: new Map(),
  rankCache: new Map(),   // date -> Map(nick -> rank among visible players)
  achievements: [],       // [{ id, name, icon_url, url }]
  achIdsByNick: new Map(), // nick -> Set of achievement ids (as strings)
  weekNick: null,
  loading: false,
  loadedAt: 0,            // Date.now() of the last successful load
  chartRAF: 0,
  chartAnimating: false,
  chartSeries: [],
  chartDims: null,
  chartHoverIdx: null,
  compareNick: null,
  compareOpener: null,
};

/* Leaderboard order: rating desc, then nick as nick.localeCompare(other, "ru") would order it. */
const compareNicks = new Intl.Collator("ru").compare;
const hoverQuery = window.matchMedia("(hover: hover)");

/* ================== INIT ================== */
init();

async function init() {
  state.deepLinkNick = new URLSearchParams(window.location.search).get("player");
  showAdminLink();

  els.refresh?.addEventListener("click", () => loadData());
  els.search?.addEventListener("input", debounce(onSearch, 120));

  const onRangeChange = () => {
    let from = els.dateFrom?.value || "";
    let to   = els.dateTo?.value   || "";
    if (!from && !to) {
      state.rangeIsDefault = true;
      applyDefaultRange();
    } else {
      state.rangeIsDefault = false;
      if (from && to && from > to) {
        [from, to] = [to, from];
        els.dateFrom.value = from;
        els.dateTo.value   = to;
      }
      state.dateFrom = from;
      state.dateTo   = to;
    }
    renderProfile();
  };
  els.dateFrom?.addEventListener("change", onRangeChange);
  els.dateTo?.addEventListener("change",   onRangeChange);

  // Resize → redraw chart without re-animating
  window.addEventListener("resize", debounce(() => {
    if (!state.chartSeries?.length) return;
    state.chartDims = computeChartDims(state.chartSeries);
    drawChartFrame(state.chartSeries, state.chartDims, {
      progress: 1,
      hoverIdx: state.chartHoverIdx ?? undefined,
    });
  }, 150));

  setupChartHover();

  els.weekBanner?.addEventListener("click", onWeekBannerActivate);
  els.weekBanner?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onWeekBannerActivate();
  });

  els.compareClose?.addEventListener("click", closeCompareModal);
  els.compareModal?.querySelector(".compare-backdrop")?.addEventListener("click", closeCompareModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCompareModal(); });

  els.loadNotice?.addEventListener("click", () => showLoadNotice(false));

  initBackToTop();

  await loadData({ initial: true });

  // Auto-refresh every 10 minutes while the tab is visible — re-read from Google Sheets.
  // A tab that comes back after a longer absence refreshes right away.
  setInterval(() => {
    if (document.visibilityState === "visible") loadData();
  }, CONFIG.REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - state.loadedAt > CONFIG.REFRESH_MS) loadData();
  });
}

function showAdminLink() {
  if (!els.adminLink) return;
  try {
    if (localStorage.getItem(ADMIN_SESSION_KEY)) els.adminLink.style.display = "";
  } catch {
    // Storage blocked: keep the link hidden.
  }
}

/* ================== BACK TO TOP ================== */
function initBackToTop() {
  const btn = document.getElementById("backToTop");
  if (!btn) return;

  window.addEventListener("scroll", debounce(() => {
    btn.classList.toggle("visible", window.scrollY > 320);
  }, 80), { passive: true });

  btn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

/* ================== LOAD ================== */
/* The first load shows the full-screen overlay. Refreshes (the Refresh button, the timer)
 * keep the page usable: only the button shows "Loading…", the selected player and the
 * compare pick are kept, and a failed refresh leaves the current data on screen. */
async function loadData({ initial = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  setLoading(true, initial);
  try {
    const optional = (what) => (err) => { console.warn(`${what} load failed:`, err); return null; };
    const [engine, hiddenRows, achievements, playerAchievements] = await Promise.all([
      buildRatings(),
      sbFetchAll("hidden_players", "nick", "nick.asc"),
      sbFetchAll("achievements", "id,name,icon_url,url", "id.asc").catch(optional("Achievements")),
      sbFetchAll("player_achievements", "nick,achievement_id", "nick.asc,achievement_id.asc")
        .catch(optional("Player achievements")),
    ]);
    applyData(engine, hiddenRows, achievements, playerAchievements);
    showLoadNotice(false);
  } catch (err) {
    console.error("Data load failed:", err);
    if (state.loadedAt) {
      showLoadNotice(true);
    } else if (els.tbody) {
      els.tbody.innerHTML = `<tr><td colspan="3" style="opacity:.7;padding:14px;">Failed to load data. Try Refresh.</td></tr>`;
    }
  } finally {
    state.loading = false;
    setLoading(false, initial);
  }
}

function applyData({ leaderboard, history, groups }, hiddenRows, achievements, playerAchievements) {
  const firstData = !state.loadedAt;

  state.groups = groups;
  state.hiddenNicks = new Set(hiddenRows.map((r) => r.nick));
  state.players = leaderboard.map((p) => {
    const series = (history[p.nickname] ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    return { nick: p.nickname, series, ends: series.filter((e) => !e.start) };
  });

  // Achievements are optional: on failure keep what the previous load had.
  if (achievements && playerAchievements) {
    state.achievements = achievements;
    state.achIdsByNick = new Map();
    for (const { nick, achievement_id: id } of playerAchievements) {
      if (!state.achIdsByNick.has(nick)) state.achIdsByNick.set(nick, new Set());
      state.achIdsByNick.get(nick).add(String(id));
    }
  }

  buildGlobalRanking();
  updateDateRange();

  if (state.compareNick && !state.globalRankByNick.has(state.compareNick)) state.compareNick = null;
  renderTable();

  // Initial load: the ?player= deep link; refresh: the current selection. Both fall back to #1
  // when that player is not on the visible board. Neither writes the URL or scrolls.
  const wanted = firstData ? state.deepLinkNick : state.selected?.nick;
  const p = state.globalRows.find((x) => x.nick === wanted) ?? state.globalRows[0];
  if (p) selectPlayer(p, { animate: firstData });

  state.loadedAt = Date.now();
}

function setLoading(isLoading, initial) {
  if (initial) {
    const overlay = document.getElementById("loadingOverlay");
    if (overlay) overlay.classList.toggle("hidden", !isLoading);
    document.documentElement.style.overflow = isLoading ? "hidden" : "";
  }
  if (!els.refresh) return;
  els.refresh.disabled = isLoading;
  els.refresh.textContent = isLoading ? "Loading…" : "Refresh";
}

function showLoadNotice(show) {
  if (!els.loadNotice) return;
  els.loadNotice.hidden = !show;
  els.loadNotice.textContent = show ? "Couldn't refresh the data. Showing the last loaded results." : "";
}

/* ================== DATE RANGE ================== */
/* The inputs are limited to the data span. Until the viewer picks dates, the range is the
 * last 7 days of data and follows new data on every load. */
function updateDateRange() {
  let first = "", last = "";
  for (const p of state.players) {
    const a = p.series[0]?.date, b = p.series.at(-1)?.date;
    if (a && (!first || a < first)) first = a;
    if (b && b > last) last = b;
  }
  state.dataSpan = { first, last };
  for (const input of [els.dateFrom, els.dateTo]) {
    if (!input) continue;
    input.min = first;
    input.max = last;
  }
  if (state.rangeIsDefault) applyDefaultRange();
}

function applyDefaultRange() {
  const { last } = state.dataSpan;
  state.dateFrom = last ? shiftIsoDate(last, -6) : "";
  state.dateTo   = last;
  if (els.dateFrom) els.dateFrom.value = state.dateFrom;
  if (els.dateTo)   els.dateTo.value   = state.dateTo;
}

/* ================== RANKING ================== */
function compareRanking(a, b) {
  return (b.rating ?? -Infinity) - (a.rating ?? -Infinity) || compareNicks(a.nick, b.nick);
}

/* Runs once per data load; the table, search and history only read its results. */
function buildGlobalRanking() {
  state.globalRows = state.players
    .filter((p) => !state.hiddenNicks.has(p.nick))
    .map((p) => ({
      ...p,
      rating: p.series.at(-1)?.rating ?? null,
      delta1: monthDelta(p.series, 1),
      delta7: monthDelta(p.series, 7),
    }))
    .sort(compareRanking);

  state.globalRankByNick = new Map(
    state.globalRows.map((p, idx) => [p.nick, idx + 1])
  );
  state.rankCache = new Map();

  renderWeekBanner();
}

/* Rank of `nick` among the visible players on `date`, ordered like the leaderboard, using each
 * player's last end-of-day entry on or before that date. Computed once per date per load. */
function rankOnDate(date, nick) {
  let ranks = state.rankCache.get(date);
  if (!ranks) {
    const rows = [];
    for (const p of state.globalRows) {
      const entry = lastEntryOnOrBefore(p.ends, date);
      if (entry) rows.push({ nick: p.nick, rating: entry.rating });
    }
    rows.sort(compareRanking);
    ranks = new Map(rows.map((r, idx) => [r.nick, idx + 1]));
    state.rankCache.set(date, ranks);
  }
  return ranks.get(nick) ?? null;
}

/* Binary search in a date-sorted list with one entry per date. */
function lastEntryOnOrBefore(entries, date) {
  let lo = 0, hi = entries.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].date <= date) { found = entries[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}

/* ================== PLAYER OF THE WEEK ================== */
function renderWeekBanner() {
  if (!els.weekBanner) return;
  const candidates = state.globalRows.filter((p) => p.delta7 != null && p.delta7 > 0);
  if (!candidates.length) { els.weekBanner.style.display = "none"; state.weekNick = null; return; }

  const best = candidates.reduce((a, b) => (b.delta7 > a.delta7 ? b : a));
  state.weekNick = best.nick;

  if (els.weekAvatar.dataset.nick !== best.nick) {
    els.weekAvatar.dataset.nick = best.nick;
    setAvatar(els.weekAvatar, best.nick);
  }
  els.weekNick.textContent = best.nick;
  els.weekDelta.textContent = `${formatDelta(best.delta7)} pts this week`;
  els.weekRating.textContent = `Rating: ${fmt(best.rating)}`;

  els.weekBanner.style.display = "";
  els.weekBanner.style.cursor = "pointer";
}

function onWeekBannerActivate() {
  const p = state.globalRows.find((x) => x.nick === state.weekNick);
  if (p) selectPlayer(p, { user: true, scroll: true });
}

/* ================== TABLE ================== */
/* Filters the ranked rows by the search box and renders them; returns the rendered rows. */
function renderTable() {
  if (!els.tbody) return [];
  hideMiniCard();

  const q = (els.search?.value ?? "").toLowerCase().trim();
  const filtered = q
    ? state.globalRows.filter((p) => p.nick.toLowerCase().includes(q))
    : state.globalRows;

  // A refresh rebuilds the rows: keep keyboard focus on the same row or "vs" button.
  const focused = els.tbody.contains(document.activeElement) ? document.activeElement : null;
  const focusNick = focused?.dataset.nick;
  const focusCmp = Boolean(focused?.classList.contains("cmp-btn"));

  const frag = document.createDocumentFragment();

  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" style="opacity:.7;padding:14px;">No players found.</td>`;
    frag.appendChild(tr);
  } else {
    for (const p of filtered) {
      const tr = document.createElement("tr");
      const rank = state.globalRankByNick.get(p.nick) ?? null;
      tr.dataset.nick = p.nick;
      tr.tabIndex = 0;

      if (rank === 1) tr.classList.add("rank-1");
      else if (rank === 2) tr.classList.add("rank-2");
      else if (rank === 3) tr.classList.add("rank-3");

      if (state.selected?.nick === p.nick) tr.classList.add("active");

      const isCmpSelected = state.compareNick === p.nick;
      tr.innerHTML = `
        <td>${rank ?? "—"}</td>
        <td>${escapeHtml(p.nick)}<button class="cmp-btn${isCmpSelected ? " selected" : ""}" title="Compare with another player" data-nick="${escapeHtml(p.nick)}">vs</button></td>
        <td class="right">${fmt(p.rating)}</td>
      `;
      tr.querySelector(".cmp-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        onCompareClick(p.nick, e.currentTarget);
      });
      tr.addEventListener("click", () => selectPlayer(p, { user: true, scroll: true }));
      tr.addEventListener("keydown", (e) => {
        if (e.target !== tr || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        selectPlayer(p, { user: true, scroll: true });
      });
      tr.addEventListener("mouseenter", (e) => showMiniCard(p, e));
      tr.addEventListener("mousemove",  (e) => moveMiniCard(e));
      tr.addEventListener("mouseleave", hideMiniCard);
      frag.appendChild(tr);
    }
  }

  els.tbody.replaceChildren(frag);

  if (focusNick != null) {
    const tr = [...els.tbody.rows].find((r) => r.dataset.nick === focusNick);
    (focusCmp ? tr?.querySelector(".cmp-btn") : tr)?.focus({ preventScroll: true });
  }
  return filtered;
}

/* ================== SELECT PLAYER ================== */
/* user: the viewer picked the player (row, search, banner), so ?player= is updated.
 * scroll: on phones, also bring the profile into view (explicit row or banner picks only).
 * animate: false redraws the chart in place (refresh). */
function selectPlayer(p, { user = false, scroll = false, animate = true } = {}) {
  state.selected = p;
  if (user) updateURL(p.nick);

  for (const tr of els.tbody?.rows ?? []) tr.classList.toggle("active", tr.dataset.nick === p.nick);

  renderProfile(animate);
  if (scroll) scrollToProfile();
}

function renderProfile(animate = true) {
  const p = state.selected;
  if (!p) return;

  if (els.profileTitle) els.profileTitle.textContent = p.nick;

  const lastRating = p.series.at(-1)?.rating ?? null;
  if (els.currentRating) els.currentRating.textContent = fmt(lastRating);

  setPlayerPhoto(p.nick);
  setPlayerGroup(lastRating);
  renderAchievements(p.nick);

  renderHistory(p);
  drawChartAnimated(sliceByRange(p.ends, state.dateFrom, state.dateTo), animate);
}

/* Mobile: scroll to the profile section, below the sticky header (scroll-margin-top). */
function scrollToProfile() {
  if (window.innerWidth > 768) return;
  const profileCard = document.querySelector(".grid .card:nth-child(2)");
  if (!profileCard) return;
  const topbar = document.querySelector(".topbar");
  if (topbar) document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
  setTimeout(() => profileCard.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
}

/* ================== PHOTO + GROUP ================== */
function setPlayerPhoto(nick) {
  if (!els.playerPhoto) return;
  if (els.photoNick) els.photoNick.textContent = nick;
  if (els.playerPhoto.dataset.nick === nick) return; // same player (refresh): keep the loaded image
  els.playerPhoto.dataset.nick = nick;
  els.playerPhoto.alt = `Photo of ${nick}`;
  setAvatar(els.playerPhoto, nick, 512);
}

function setPlayerGroup(rating) {
  const g = groupForRating(rating, state.groups);
  if (els.groupName) els.groupName.textContent = g.name;
  if (els.groupDot) {
    els.groupDot.style.background = g.color;
    els.groupDot.style.boxShadow = `0 0 12px ${g.color}55`;
  }
}

/* ================== MINI CARD ================== */
function showMiniCard(p, e) {
  if (!els.miniCard) return;
  // Only for devices whose primary pointer can hover (not phones and tablets)
  if (!hoverQuery.matches) return;
  const g = groupForRating(p.rating, state.groups);

  setAvatar(els.miniAvatar, p.nick);
  els.miniNick.textContent    = p.nick;
  els.miniRating.textContent  = fmt(p.rating);
  els.miniDot.style.background   = g.color;
  els.miniDot.style.boxShadow    = `0 0 6px ${g.color}88`;
  els.miniGroup.textContent   = g.name;

  els.miniCard.style.display = "block";
  moveMiniCard(e);
}

function moveMiniCard(e) {
  if (!els.miniCard || els.miniCard.style.display === "none") return;
  const cw = els.miniCard.offsetWidth  || 200;
  const ch = els.miniCard.offsetHeight || 140;
  let x = e.clientX + 16;
  let y = e.clientY + 16;
  if (x + cw > window.innerWidth  - 8) x = e.clientX - cw - 16;
  if (y + ch > window.innerHeight - 8) y = e.clientY - ch - 16;
  els.miniCard.style.left = x + "px";
  els.miniCard.style.top  = y + "px";
}

function hideMiniCard() {
  if (els.miniCard) els.miniCard.style.display = "none";
}

/* ================== COMPARE ================== */
function onCompareClick(nick, button) {
  if (state.compareNick === nick) {
    state.compareNick = null;
  } else if (state.compareNick) {
    const n1 = state.compareNick;
    state.compareNick = null;
    markCompareButtons();
    openCompareModal(n1, nick, button);
    return;
  } else {
    state.compareNick = nick;
  }
  markCompareButtons();
}

/* Updates the "vs" buttons in place, so the button keeps keyboard focus. */
function markCompareButtons() {
  els.tbody?.querySelectorAll(".cmp-btn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.nick === state.compareNick);
  });
}

/* Games counted in the latest month of the series (end-of-day entries only). */
function gamesThisMonth(series) {
  const last = series.at(-1);
  if (!last) return null;
  const month = last.date.slice(0, 7);
  let games = 0;
  for (let i = series.length - 1; i >= 0 && series[i].date.slice(0, 7) === month; i--) {
    if (!series[i].start) games += Number(series[i].games) || 0;
  }
  return games;
}

function openCompareModal(nick1, nick2, opener) {
  if (!els.compareModal || !els.compareGrid) return;

  const pair = [nick1, nick2].map((nick) => state.globalRows.find((p) => p.nick === nick));
  if (!pair[0] || !pair[1]) return;
  hideMiniCard();

  const [r1, r2] = pair.map((p) => p.rating ?? -Infinity);
  const higherRating = r1 === r2 ? null : (r1 > r2 ? nick1 : nick2);

  els.compareGrid.innerHTML = pair.map((p) => {
    const g = groupForRating(p.rating, state.groups);
    const isRatingWinner = p.nick === higherRating;
    const rank = state.globalRankByNick.get(p.nick) ?? "—";

    return `
      <div class="compare-col${isRatingWinner ? " winner" : ""}">
        ${isRatingWinner ? '<div class="compare-winner-badge">Higher rating</div>' : '<div style="height:22px"></div>'}
        <img class="compare-col-avatar" alt="" />
        <div class="compare-col-nick">${escapeHtml(p.nick)}</div>
        <div class="compare-stat">
          <div class="compare-stat-label">Rating</div>
          <div class="compare-stat-val" style="color:var(--accent)">${fmt(p.rating)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Rank</div>
          <div class="compare-stat-val">#${rank}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Δ 7 days</div>
          <div class="compare-stat-val ${deltaClass(p.delta7)}">${formatDelta(p.delta7)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Δ 1 day</div>
          <div class="compare-stat-val ${deltaClass(p.delta1)}">${formatDelta(p.delta1)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Group</div>
          <div class="compare-stat-val" style="font-size:14px;color:${safeColor(g.color)}">${escapeHtml(g.name)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Games this month</div>
          <div class="compare-stat-val">${gamesThisMonth(p.series) ?? "—"}</div>
        </div>
      </div>`;
  }).join("");

  els.compareGrid.querySelectorAll(".compare-col-avatar").forEach((img, i) => setAvatar(img, pair[i].nick));

  state.compareOpener = opener ?? document.activeElement;
  els.compareModal.style.display = "flex";
  els.compareClose?.focus();
}

function closeCompareModal() {
  if (!els.compareModal || els.compareModal.style.display === "none") return;
  els.compareModal.style.display = "none";

  // Return focus to the "vs" button that opened the modal (found again if the table re-rendered).
  const opener = state.compareOpener;
  state.compareOpener = null;
  if (opener?.isConnected) { opener.focus(); return; }
  const nick = opener?.dataset?.nick;
  if (nick == null) return;
  for (const b of els.tbody?.querySelectorAll(".cmp-btn") ?? []) {
    if (b.dataset.nick === nick) { b.focus(); return; }
  }
}

/* ================== ACHIEVEMENTS ================== */
/* Renders from the data loaded with the ratings, so badges always match the selected player. */
function renderAchievements(nick) {
  if (!els.playerAchievements) return;
  els.playerAchievements.innerHTML = "";

  const ids = state.achIdsByNick.get(nick);
  if (!ids) return;

  for (const ach of state.achievements) {
    if (!ids.has(String(ach.id))) continue;
    const name = escapeHtml(ach.name);
    const icon = safeUrl(ach.icon_url);
    const href = safeUrl(ach.url);
    const inner =
      (icon ? `<img src="${escapeHtml(icon)}" alt="${name}" loading="lazy" />` : "") +
      `<span class="ach-badge-tip">${name}</span>`;

    let badge;
    if (href) {
      badge = document.createElement("a");
      badge.href = href;
      badge.target = "_blank";
      badge.rel = "noopener noreferrer";
      badge.className = "ach-badge ach-badge--link";
    } else {
      badge = document.createElement("div");
      badge.className = "ach-badge";
    }
    badge.innerHTML = inner;
    els.playerAchievements.appendChild(badge);
  }
}

/* ================== HISTORY ================== */
/* One row per day in the range, newest first. A day whose rating was set by an adjustment
 * shows start of day → end of day; other days show the previous day's end → end of day
 * (for the oldest row, the previous day may lie before the range). */
function renderHistory(p) {
  if (!els.history) return;
  els.history.innerHTML = "";

  const from = state.dateFrom, to = state.dateTo;
  const rows = [];
  let prevEnd = null, start = null;
  for (const entry of p.series) {
    if (entry.start) { start = entry; continue; }
    if ((!from || entry.date >= from) && (!to || entry.date <= to)) {
      rows.push({ end: entry, start: start?.date === entry.date ? start : null, prev: prevEnd });
    }
    prevEnd = entry;
    start = null;
  }
  if (!rows.length) return;

  const change = (a, b) =>
    `${fmt(a)}<span class="hist-arrow">→</span>${fmt(b)} <span class="${deltaClass(b - a)}">(${formatDelta(b - a)})</span>`;

  const frag = document.createDocumentFragment();
  for (let i = rows.length - 1; i >= 0; i--) {
    const { end, start: dayStart, prev } = rows[i];
    const rank = rankOnDate(end.date, p.nick);
    let tag = "", value;
    if (dayStart) {
      tag = dayStart.reset ? "🔄 reset" : "✎ adjusted";
      value = change(dayStart.rating, end.rating);
    } else if (prev) {
      value = change(prev.rating, end.rating);
    } else {
      value = fmt(end.rating);
    }

    const li = document.createElement("li");
    li.innerHTML = `
      <span>${escapeHtml(end.date)}</span>
      <span class="hist-rank">#${rank ?? "—"}</span>
      <span class="hist-reset-col">${tag}</span>
      <span>${value}</span>
    `;
    frag.appendChild(li);
  }

  els.history.appendChild(frag);
}

/* ================== CHART ================== */
function computeChartDims(series) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(1, els.chart.clientWidth);
  const H = Math.max(1, els.chart.clientHeight);

  if (els.chart.width !== Math.round(W * dpr) || els.chart.height !== Math.round(H * dpr)) {
    els.chart.width = Math.round(W * dpr);
    els.chart.height = Math.round(H * dpr);
  }

  const pad = { l: 48, r: 20, t: 20, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const values = series.map((s) => s.rating);
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  // Flat or single-point series: widen the domain so the line sits inside the plot
  if (max - min < 1) {
    const extra = 1 + (max - min + 2) * 0.08;
    min -= extra;
    max += extra;
  }
  const range = max - min;
  const n = series.length;

  const xAt = (i) => pad.l + (i / Math.max(1, n - 1)) * innerW;
  const yAt = (v) => pad.t + (1 - (v - min) / range) * innerH;

  return { W, H, dpr, pad, innerW, innerH, min, max, range, n, xAt, yAt };
}

function drawChartFrame(series, dims, opts = {}) {
  if (!els.chart) return;
  const { W, H, dpr, pad, innerH, max, range, n, xAt, yAt } = dims;
  const progress = opts.progress != null ? opts.progress : 1;
  const hoverIdx = opts.hoverIdx != null ? opts.hoverIdx : null;

  const ctx = els.chart.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!n) return;

  // Gridlines + Y-axis labels
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255,255,255,0.42)";
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const STEPS = 4;
  // Labels come from the same domain as yAt, with enough decimals that no two steps print alike
  const digits = Math.min(2, Math.max(0, Math.ceil(-Math.log10(range / STEPS))));
  for (let i = 0; i <= STEPS; i++) {
    const ratio = i / STEPS;
    const y = pad.t + ratio * innerH;
    const v = max - ratio * range;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(digits), pad.l - 6, y);
  }

  // Animated portion
  const maxIndex = Math.max(0, Math.floor((n - 1) * progress));
  const partial = (n - 1) * progress - maxIndex;
  const lastX = (maxIndex < n - 1 && partial > 0)
    ? xAt(maxIndex) + (xAt(maxIndex + 1) - xAt(maxIndex)) * partial
    : xAt(maxIndex);
  const lastY = (maxIndex < n - 1 && partial > 0)
    ? yAt(series[maxIndex].rating) + (yAt(series[maxIndex + 1].rating) - yAt(series[maxIndex].rating)) * partial
    : yAt(series[maxIndex].rating);

  // Build month segments (break chart at month boundaries)
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, "rgba(53,192,122,0.32)");
  grad.addColorStop(1, "rgba(53,192,122,0.00)");

  const segs = [];
  let segStart = 0;
  for (let i = 1; i <= maxIndex; i++) {
    if (series[i - 1].date.slice(0, 7) !== series[i].date.slice(0, 7)) { // "YYYY-MM" changed
      segs.push([segStart, i - 1]);
      segStart = i;
    }
  }
  segs.push([segStart, maxIndex]);

  // Filled area — one fill per month segment
  segs.forEach(([s, e], si) => {
    const isLast = si === segs.length - 1;
    const ex = (isLast && maxIndex < n - 1 && partial > 0) ? lastX : xAt(e);
    const ey = (isLast && maxIndex < n - 1 && partial > 0) ? lastY : yAt(series[e].rating);
    ctx.beginPath();
    ctx.moveTo(xAt(s), H - pad.b);
    for (let i = s; i <= e; i++) ctx.lineTo(xAt(i), yAt(series[i].rating));
    if (isLast && maxIndex < n - 1 && partial > 0) ctx.lineTo(lastX, lastY);
    ctx.lineTo(ex, H - pad.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  });

  // Line — one stroke per month segment
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  segs.forEach(([s, e], si) => {
    const isLast = si === segs.length - 1;
    ctx.beginPath();
    ctx.strokeStyle = "#35c07a";
    for (let i = s; i <= e; i++) {
      const x = xAt(i), y = yAt(series[i].rating);
      if (i === s) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (isLast && maxIndex < n - 1 && partial > 0) ctx.lineTo(lastX, lastY);
    ctx.stroke();
  });

  // Month boundary markers — gray band from final rank downward + label
  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  segs.slice(0, -1).forEach(([, e]) => {
    const x1 = xAt(e);
    const x2 = xAt(e + 1);
    const midX = (x1 + x2) / 2;
    const halfW = Math.max((x2 - x1) / 2, 8);
    const topY = yAt(series[e].rating); // top of band = Y level of last point of the month

    // Gray filled band — starts at final rank of the month, goes to bottom
    ctx.fillStyle = "rgba(180,180,200,0.13)";
    ctx.fillRect(midX - halfW, topY, halfW * 2, H - pad.b - topY);

    // Solid edges of the band
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(midX - halfW, topY);
    ctx.lineTo(midX - halfW, H - pad.b);
    ctx.moveTo(midX + halfW, topY);
    ctx.lineTo(midX + halfW, H - pad.b);
    ctx.stroke();

    // New month label — just above the top edge of the band
    const nextDate = series[e + 1].date; // "YYYY-MM-DD"
    const label = MONTH_NAMES[Number(nextDate.slice(5, 7)) - 1] + " " + nextDate.slice(0, 4);
    ctx.fillStyle = "rgba(255,255,255,0.50)";
    ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, midX, topY - 4);
  });

  // Data point dots (only after animation completes)
  if (progress >= 1) {
    for (let i = 0; i < n; i++) {
      const x = xAt(i), y = yAt(series[i].rating);
      ctx.fillStyle = "#35c07a";
      ctx.beginPath();
      ctx.arc(x, y, i === n - 1 ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (i === n - 1) {
        ctx.strokeStyle = "rgba(11,15,20,1)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  // Hover marker
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < n) {
    const hx = xAt(hoverIdx), hy = yAt(series[hoverIdx].rating);

    // Vertical guide line
    ctx.strokeStyle = "rgba(53,192,122,0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hx, pad.t);
    ctx.lineTo(hx, H - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);

    // Halo
    ctx.fillStyle = "rgba(53,192,122,0.25)";
    ctx.beginPath();
    ctx.arc(hx, hy, 11, 0, Math.PI * 2);
    ctx.fill();

    // Marker
    ctx.fillStyle = "#35c07a";
    ctx.beginPath();
    ctx.arc(hx, hy, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawChartAnimated(series, animate = true) {
  if (!els.chart) return;
  cancelAnimationFrame(state.chartRAF);
  hideChartTip();

  state.chartSeries = series;
  state.chartDims = computeChartDims(series);
  state.chartHoverIdx = null;

  if (!series.length || !animate) {
    drawChartFrame(series, state.chartDims, { progress: 1 });
    state.chartAnimating = false;
    return;
  }

  state.chartAnimating = true;
  const start = performance.now();

  const tick = (now) => {
    const t = Math.min(1, (now - start) / CONFIG.CHART_ANIM_MS);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    drawChartFrame(state.chartSeries, state.chartDims, { progress: eased });
    if (t < 1) {
      state.chartRAF = requestAnimationFrame(tick);
    } else {
      state.chartAnimating = false;
    }
  };
  state.chartRAF = requestAnimationFrame(tick);
}

/* ----- hover ----- */
function setupChartHover() {
  if (!els.chart) return;
  els.chart.addEventListener("mousemove", onChartMove);
  els.chart.addEventListener("mouseleave", onChartLeave);
  els.chart.addEventListener("touchstart", onChartTouch, { passive: true });
  els.chart.addEventListener("touchmove",  onChartTouch, { passive: true });
  els.chart.addEventListener("touchend",   onChartLeave);
}

function pickNearestIdx(clientX) {
  const series = state.chartSeries;
  const dims = state.chartDims;
  if (!series?.length || !dims) return null;

  const rect = els.chart.getBoundingClientRect();
  const x = clientX - rect.left;

  let nearest = 0;
  let minDist = Infinity;
  for (let i = 0; i < series.length; i++) {
    const d = Math.abs(dims.xAt(i) - x);
    if (d < minDist) { minDist = d; nearest = i; }
  }
  // Don't show if pointer is far outside the plot area
  return minDist > Math.max(40, dims.innerW / Math.max(1, series.length - 1)) ? null : nearest;
}

function onChartMove(e) {
  if (state.chartAnimating) return;
  const idx = pickNearestIdx(e.clientX);
  applyChartHover(idx);
}

function onChartTouch(e) {
  if (state.chartAnimating) return;
  const t = e.touches?.[0];
  if (!t) return;
  const idx = pickNearestIdx(t.clientX);
  applyChartHover(idx);
}

function onChartLeave() {
  applyChartHover(null);
}

function applyChartHover(idx) {
  const series = state.chartSeries;
  const dims = state.chartDims;
  if (!series?.length || !dims) return;

  if (idx === state.chartHoverIdx) return;
  state.chartHoverIdx = idx;

  drawChartFrame(series, dims, { progress: 1, hoverIdx: idx ?? undefined });

  if (idx == null) { hideChartTip(); return; }

  const point = series[idx];
  const px = dims.xAt(idx);
  const py = dims.yAt(point.rating);

  if (els.chartTip) {
    els.chartTip.innerHTML =
      `<strong>${fmt(point.rating)}</strong>` +
      `<span>${escapeHtml(point.date)}</span>`;
    // Position relative to .chartWrap (canvas has padding inside wrap = 8px)
    const offset = 8; // matches .chartWrap padding
    els.chartTip.style.left = (px + offset) + "px";
    els.chartTip.style.top  = (py + offset) + "px";
    els.chartTip.hidden = false;
  }
}

function hideChartTip() {
  if (els.chartTip) els.chartTip.hidden = true;
}

/* ================== HELPERS ================== */
function sliceByRange(series, from, to) {
  if (!series.length) return series;
  return series.filter((p) => {
    if (from && p.date < from) return false;
    if (to   && p.date > to)   return false;
    return true;
  });
}

function fmt(num) {
  if (num == null || Number.isNaN(num)) return "—";
  return String(Number(num));
}

/* Deltas: one decimal with a sign. The class uses the rounded value, so "0" is never red. */
function roundDelta(v) {
  return parseFloat(Number(v).toFixed(1));
}

function formatDelta(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const n = roundDelta(v);
  return n > 0 ? `+${n}` : String(n);
}

function deltaClass(v) {
  if (v == null || Number.isNaN(v)) return "";
  const n = roundDelta(v);
  if (n > 0) return "delta-pos";
  if (n < 0) return "delta-neg";
  return "delta-zero";
}

/* Filters the table. A non-empty query selects its first match (without scrolling) when that is
 * a different player; clearing the query keeps the current selection. */
function onSearch() {
  const rows = renderTable();
  if (!(els.search?.value ?? "").trim()) return;
  const first = rows[0];
  if (first && first.nick !== state.selected?.nick) selectPlayer(first, { user: true });
}

function updateURL(nick) {
  const url = new URL(window.location.href);
  url.searchParams.set("player", nick);
  history.replaceState(null, "", url.toString());
}
