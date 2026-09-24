/* ============================================================
 * ESportsBattle Rank — public leaderboard
 * Single-file vanilla JS app. No build step, no dependencies.
 * ============================================================ */
"use strict";

/* ================== CONFIG ================== */
const CONFIG = Object.freeze({
  DATA_URL:
    "https://script.google.com/macros/s/AKfycbxkLrAorAf8PMAB3Wu9vBv7DIcjj9tj6W4KrnuEVYMvrV563bWQ0clgsultApJnEOy0/exec",
  RATING_DIGITS: 2,
  DELTA_DIGITS: 2,
  CHART_ANIM_MS: 600,
});

const SUPABASE = Object.freeze({
  URL: "https://vgmwxtpsbwzeqwtpxamo.supabase.co",
  KEY: "sb_publishable_RjvZCtsriMO6nGDASJkcbg_estuVZyq",
  BUCKET: "player-avatars",
});

/* Rating groups — loaded from Supabase, defaults used as fallback. */
let GROUPS = [
  { name: "Legend",       min: 1250, color: "#e53a2e" },
  { name: "Icon",         min: 1125, color: "#dab823" },
  { name: "Elite",        min: 1000, color: "#f0ff25" },
  { name: "Champion",     min:  875, color: "#20b839" },
  { name: "World Class",  min:  750, color: "#b8b8b8" },
  { name: "Professional", min:    0, color: "#7ec8ce" },
];

async function loadGroups() {
  try {
    const res = await fetch(
      `${SUPABASE.URL}/rest/v1/rating_groups?select=name,min_rating,color&order=min_rating.desc`,
      { headers: { apikey: SUPABASE.KEY, Authorization: `Bearer ${SUPABASE.KEY}` } }
    );
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) {
      GROUPS = rows.map((r) => ({ name: r.name, min: r.min_rating, color: r.color }));
    }
  } catch (e) {
    console.warn("Groups load failed, using defaults");
  }
}

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
};

/* ================== STATE ================== */
const state = {
  players: [],
  hiddenNicks: new Set(),
  selected: null,
  dateFrom: "",
  dateTo:   "",
  globalRows: [],
  globalRankByNick: new Map(),
  chartRAF: 0,
  chartAnimating: false,
  chartSeries: [],
  chartDims: null,
  chartHoverIdx: null,
  compareNick: null,
};

/* ================== INIT ================== */
init();

async function init() {
  els.refresh?.addEventListener("click", loadData);
  els.search?.addEventListener("input", debounce(onSearch, 120));

  const onRangeChange = () => {
    state.dateFrom = els.dateFrom?.value || "";
    state.dateTo   = els.dateTo?.value   || "";
    renderTable();
    if (state.selected) {
      const p = state.players.find((x) => x.nick === state.selected.nick);
      if (p) selectPlayer(p);
    }
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

  els.compareClose?.addEventListener("click", closeCompareModal);
  els.compareModal?.querySelector(".compare-backdrop")?.addEventListener("click", closeCompareModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCompareModal(); });

  initBackToTop();

  await loadGroups();
  await loadData();
  handleDeepLink();

  // Auto-refresh every 10 minutes — re-read from Google Sheets
  setInterval(() => loadData(), 10 * 60 * 1000);
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
async function loadData() {
  setLoading(true);
  try {
    const [engineResult, hiddenResult] = await Promise.allSettled([
      buildRatings(),
      fetch(
        `${SUPABASE.URL}/rest/v1/hidden_players?select=nick`,
        { headers: { apikey: SUPABASE.KEY, Authorization: `Bearer ${SUPABASE.KEY}` } }
      ).then((r) => r.json()),
    ]);

    if (engineResult.status === "rejected") throw engineResult.reason;

    const { leaderboard, history } = engineResult.value;
    const hiddenRows = hiddenResult.status === "fulfilled" && Array.isArray(hiddenResult.value)
      ? hiddenResult.value
      : [];
    state.hiddenNicks = new Set(hiddenRows.map((r) => r.nick));

    state.players = leaderboard.map((p) => ({
      nick: p.nickname,
      series: (history[p.nickname] ?? []).slice().sort((a, b) => a.date.localeCompare(b.date)),
    }));
    buildGlobalRanking();

    // Set default date range to last 7 days
    if (!state.dateFrom && !state.dateTo) {
      let lastDate = "";
      state.players.forEach((p) => {
        const d = p.series.at(-1)?.date ?? "";
        if (d > lastDate) lastDate = d;
      });
      if (lastDate) {
        const end = new Date(lastDate + "T00:00:00");
        const start = new Date(end);
        start.setDate(start.getDate() - 6);
        const startStr = start.toISOString().slice(0, 10);
        state.dateFrom = startStr;
        state.dateTo   = lastDate;
        if (els.dateFrom) els.dateFrom.value = startStr;
        if (els.dateTo)   els.dateTo.value   = lastDate;
      }
    }

    renderTable();
    autoSelectTop();

  } catch (err) {
    console.error("Data load failed:", err);
    if (els.tbody) {
      els.tbody.innerHTML = `<tr><td colspan="3" style="opacity:.7;padding:14px;">Failed to load data. Try Refresh.</td></tr>`;
    }
  } finally {
    setLoading(false);
  }
}

function setLoading(isLoading) {
  const overlay = document.getElementById("loadingOverlay");
  if (overlay) overlay.classList.toggle("hidden", !isLoading);
  document.body.style.overflow = isLoading ? "hidden" : "";
  if (!els.refresh) return;
  els.refresh.disabled = isLoading;
  els.refresh.textContent = isLoading ? "Loading…" : "Refresh";
}

/* ================== JSONP ================== */
function loadJSONP(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cbName = `__rank_cb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement("script");
    let timer = 0;

    const cleanup = () => {
      try { delete window[cbName]; } catch { window[cbName] = undefined; }
      script.remove();
      if (timer) clearTimeout(timer);
    };

    window[cbName] = (data) => { cleanup(); resolve(data); };
    script.src = `${url}?callback=${cbName}&t=${Date.now()}`;
    script.async = true;
    script.onerror = () => { cleanup(); reject(new Error("JSONP load failed")); };

    timer = setTimeout(() => { cleanup(); reject(new Error("JSONP timeout")); }, timeoutMs);
    document.body.appendChild(script);
  });
}

/* ================== GROUPS ================== */
function getGroupByRating(rating) {
  const r = Number(rating);
  if (!Number.isFinite(r)) return GROUPS.at(-1);
  if (r < 0) return GROUPS.at(-1);
  return GROUPS.find((g) => r >= g.min) ?? GROUPS.at(-1);
}

/* ================== RANKING ================== */
function buildGlobalRanking() {
  state.globalRows = state.players
    .filter((p) => !state.hiddenNicks.has(p.nick))
    .map((p) => ({
      ...p,
      rating: p.series.at(-1)?.rating ?? null,
      delta1: calcDelta(p.series, 1),
      delta7: calcMonthDelta(p.series, 7),
    }))
    .sort((a, b) => {
      const delta = (b.rating ?? -Infinity) - (a.rating ?? -Infinity);
      return delta || a.nick.localeCompare(b.nick, "ru");
    });

  state.globalRankByNick = new Map(
    state.globalRows.map((p, idx) => [p.nick, idx + 1])
  );

  renderWeekBanner();
}

/* ================== PLAYER OF THE WEEK ================== */
function renderWeekBanner() {
  if (!els.weekBanner) return;
  const candidates = state.globalRows.filter((p) => p.delta7 != null && p.delta7 > 0);
  if (!candidates.length) { els.weekBanner.style.display = "none"; return; }

  const best = candidates.reduce((a, b) => (b.delta7 > a.delta7 ? b : a));
  const supUrl = `${SUPABASE.URL}/storage/v1/object/public/${SUPABASE.BUCKET}/${encodeURIComponent(best.nick)}.png`;
  const uiUrl  = `https://ui-avatars.com/api/?name=${encodeURIComponent(best.nick)}&background=0b1f17&color=35c07a&size=64&bold=true&format=png`;

  els.weekAvatar.src = supUrl;
  els.weekAvatar.onerror = () => { els.weekAvatar.onerror = null; els.weekAvatar.src = uiUrl; };
  els.weekNick.textContent = best.nick;
  els.weekDelta.textContent = `+${fmt(best.delta7, CONFIG.DELTA_DIGITS)} pts this week`;
  els.weekRating.textContent = `Rating: ${fmt(best.rating, CONFIG.RATING_DIGITS)}`;

  els.weekBanner.style.display = "";
  els.weekBanner.style.cursor = "pointer";
  els.weekBanner.onclick = () => {
    const p = state.players.find((x) => x.nick === best.nick);
    if (p) selectPlayer(p);
  };
}

/* ================== TABLE ================== */
function renderTable() {
  if (!els.tbody) return;
  buildGlobalRanking();

  const q = (els.search?.value ?? "").toLowerCase().trim();
  const filtered = q
    ? state.globalRows.filter((p) => p.nick.toLowerCase().includes(q))
    : state.globalRows;

  const frag = document.createDocumentFragment();

  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" style="opacity:.7;padding:14px;">No players found.</td>`;
    frag.appendChild(tr);
  } else {
    for (const p of filtered) {
      const tr = document.createElement("tr");
      const rank = state.globalRankByNick.get(p.nick) ?? null;

      if (rank === 1) tr.classList.add("rank-1");
      else if (rank === 2) tr.classList.add("rank-2");
      else if (rank === 3) tr.classList.add("rank-3");

      if (state.selected?.nick === p.nick) tr.classList.add("active");

      const isCmpSelected = state.compareNick === p.nick;
      tr.innerHTML = `
        <td>${rank ?? "—"}</td>
        <td>${escapeHtml(p.nick)}<button class="cmp-btn${isCmpSelected ? " selected" : ""}" title="Compare with another player" data-nick="${escapeHtml(p.nick)}">vs</button></td>
        <td class="right">${fmt(p.rating, CONFIG.RATING_DIGITS)}</td>
      `;
      tr.querySelector(".cmp-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        onCompareClick(p.nick);
      });
      tr.addEventListener("click", () => selectPlayer(p));
      tr.addEventListener("mouseenter", (e) => showMiniCard(p, e));
      tr.addEventListener("mousemove",  (e) => moveMiniCard(e));
      tr.addEventListener("mouseleave", hideMiniCard);
      frag.appendChild(tr);
    }
  }

  els.tbody.replaceChildren(frag);
}

/* ================== SELECT PLAYER ================== */
function selectPlayer(p) {
  state.selected = p;
  updateURL(p.nick);

  // mark active row
  els.tbody?.querySelectorAll("tr.active").forEach((r) => r.classList.remove("active"));
  const rows = els.tbody?.querySelectorAll("tr") ?? [];
  for (const tr of rows) {
    const nickCell = tr.children[1];
    if (nickCell && nickCell.textContent === p.nick) {
      tr.classList.add("active");
      break;
    }
  }

  if (els.profileTitle) els.profileTitle.textContent = p.nick;

  const lastRating = p.series.at(-1)?.rating ?? null;
  if (els.currentRating) els.currentRating.textContent = fmt(lastRating, CONFIG.RATING_DIGITS);

  setPlayerPhoto(p.nick);
  setPlayerGroup(lastRating);
  loadAndRenderAchievements(p.nick);

  // Mobile: auto-scroll to profile section
  if (window.innerWidth <= 768) {
    const profileCard = document.querySelector(".grid .card:nth-child(2)");
    if (profileCard) {
      setTimeout(() => profileCard.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  }

  const seriesWindow = sliceByRange(p.series, state.dateFrom, state.dateTo);
  renderHistory(seriesWindow);
  drawChartAnimated(seriesWindow);
}

/* ================== PHOTO + GROUP ================== */
function setPlayerPhoto(nick) {
  if (!els.playerPhoto) return;
  const supUrl = `${SUPABASE.URL}/storage/v1/object/public/${SUPABASE.BUCKET}/${encodeURIComponent(nick)}.png`;
  const uiUrl  = `https://ui-avatars.com/api/?name=${encodeURIComponent(nick)}&background=0b1f17&color=35c07a&size=512&bold=true&format=png`;

  els.playerPhoto.alt = `Photo of ${nick}`;
  els.playerPhoto.src = supUrl;

  // Fallback: Supabase → ui-avatars (initials)
  els.playerPhoto.onerror = () => {
    els.playerPhoto.onerror = null;
    els.playerPhoto.src = uiUrl;
  };

  if (els.photoNick) els.photoNick.textContent = nick;
}

function setPlayerGroup(rating) {
  const g = getGroupByRating(rating);
  if (els.groupName) els.groupName.textContent = g.name;
  if (els.groupDot) {
    els.groupDot.style.background = g.color;
    els.groupDot.style.boxShadow = `0 0 12px ${g.color}55`;
  }
}

/* ================== MINI CARD ================== */
function showMiniCard(p, e) {
  if (!els.miniCard) return;
  // Don't show mini card on touch devices
  if ("ontouchstart" in window) return;
  const g = getGroupByRating(p.rating);
  const supUrl = `${SUPABASE.URL}/storage/v1/object/public/${SUPABASE.BUCKET}/${encodeURIComponent(p.nick)}.png`;
  const uiUrl  = `https://ui-avatars.com/api/?name=${encodeURIComponent(p.nick)}&background=0b1f17&color=35c07a&size=64&bold=true&format=png`;

  els.miniAvatar.src = supUrl;
  els.miniAvatar.onerror = () => { els.miniAvatar.onerror = null; els.miniAvatar.src = uiUrl; };
  els.miniNick.textContent    = p.nick;
  els.miniRating.textContent  = fmt(p.rating, CONFIG.RATING_DIGITS);
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
function onCompareClick(nick) {
  if (state.compareNick === nick) {
    state.compareNick = null;
    renderTable();
    return;
  }
  if (state.compareNick && state.compareNick !== nick) {
    const n1 = state.compareNick;
    state.compareNick = null;
    renderTable();
    openCompareModal(n1, nick);
    return;
  }
  state.compareNick = nick;
  renderTable();
}

function openCompareModal(nick1, nick2) {
  if (!els.compareModal || !els.compareGrid) return;

  const p1 = state.globalRows.find((p) => p.nick === nick1);
  const p2 = state.globalRows.find((p) => p.nick === nick2);
  if (!p1 || !p2) return;

  const higherRating = (p1.rating ?? 0) >= (p2.rating ?? 0) ? nick1 : nick2;
  const higherDelta  = (p1.delta7 ?? 0) >= (p2.delta7 ?? 0) ? nick1 : nick2;

  els.compareGrid.innerHTML = [p1, p2].map((p) => {
    const g = getGroupByRating(p.rating);
    const supUrl = `${SUPABASE.URL}/storage/v1/object/public/${SUPABASE.BUCKET}/${encodeURIComponent(p.nick)}.png`;
    const uiUrl  = `https://ui-avatars.com/api/?name=${encodeURIComponent(p.nick)}&background=0b1f17&color=35c07a&size=64&bold=true&format=png`;
    const isRatingWinner = p.nick === higherRating;
    const rank = state.globalRankByNick.get(p.nick) ?? "—";

    return `
      <div class="compare-col${isRatingWinner ? " winner" : ""}">
        ${isRatingWinner ? '<div class="compare-winner-badge">Higher rating</div>' : '<div style="height:22px"></div>'}
        <img class="compare-col-avatar" src="${escapeHtml(supUrl)}"
             onerror="this.onerror=null;this.src='${escapeHtml(uiUrl)}'" alt="" />
        <div class="compare-col-nick">${escapeHtml(p.nick)}</div>
        <div class="compare-stat">
          <div class="compare-stat-label">Rating</div>
          <div class="compare-stat-val" style="color:var(--accent)">${fmt(p.rating, CONFIG.RATING_DIGITS)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Rank</div>
          <div class="compare-stat-val">#${rank}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Δ 7 days</div>
          <div class="compare-stat-val ${deltaClass(p.delta7)}">${formatDelta(p.delta7, CONFIG.DELTA_DIGITS)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Δ 1 day</div>
          <div class="compare-stat-val ${deltaClass(p.delta1)}">${formatDelta(p.delta1, CONFIG.DELTA_DIGITS)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Group</div>
          <div class="compare-stat-val" style="font-size:14px;color:${g.color}">${escapeHtml(g.name)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Data points</div>
          <div class="compare-stat-val">${p.series.length}</div>
        </div>
      </div>`;
  }).join("");

  els.compareModal.style.display = "flex";
}

function closeCompareModal() {
  if (els.compareModal) els.compareModal.style.display = "none";
}

/* ================== ACHIEVEMENTS ================== */
async function loadAndRenderAchievements(nick) {
  if (!els.playerAchievements) return;
  els.playerAchievements.innerHTML = "";

  try {
    // Get achievement IDs for this player
    const paRes = await fetch(
      `${SUPABASE.URL}/rest/v1/player_achievements?nick=eq.${encodeURIComponent(nick)}&select=achievement_id`,
      { headers: { apikey: SUPABASE.KEY, Authorization: `Bearer ${SUPABASE.KEY}` } }
    );
    const paRows = await paRes.json();
    if (!Array.isArray(paRows) || !paRows.length) return;

    const ids = paRows.map((r) => r.achievement_id).join(",");

    // Get achievement details
    const achRes = await fetch(
      `${SUPABASE.URL}/rest/v1/achievements?id=in.(${ids})&select=id,name,icon_url,url`,
      { headers: { apikey: SUPABASE.KEY, Authorization: `Bearer ${SUPABASE.KEY}` } }
    );
    const achievements = await achRes.json();
    if (!Array.isArray(achievements) || !achievements.length) return;

    renderAchievements(achievements);
  } catch (e) {
    console.warn("Achievements load failed:", e);
  }
}

function renderAchievements(achievements) {
  if (!els.playerAchievements) return;
  els.playerAchievements.innerHTML = "";

  achievements.forEach((ach) => {
    const inner =
      `<img src="${ach.icon_url}" alt="${escapeHtml(ach.name)}" loading="lazy" />` +
      `<span class="ach-badge-tip">${escapeHtml(ach.name)}</span>`;

    let badge;
    if (ach.url) {
      badge = document.createElement("a");
      badge.href = ach.url;
      badge.target = "_blank";
      badge.rel = "noopener noreferrer";
      badge.className = "ach-badge ach-badge--link";
    } else {
      badge = document.createElement("div");
      badge.className = "ach-badge";
    }
    badge.innerHTML = inner;
    els.playerAchievements.appendChild(badge);
  });
}

/* ================== HISTORY ================== */
/* Returns rank (1-based) of the given rating among all players on a given date */
function getRankOnDate(date, rating) {
  let higher = 0;
  for (const player of state.players) {
    if (!player.series || !player.series.length) continue;
    // Find last series entry on or before this date
    let r = null;
    for (let i = player.series.length - 1; i >= 0; i--) {
      if (player.series[i].date <= date) { r = player.series[i].rating; break; }
    }
    if (r != null && r > rating + 0.001) higher++;
  }
  return higher + 1;
}

function renderHistory(series) {
  if (!els.history) return;
  els.history.innerHTML = "";
  if (!series.length) return;

  // Merge consecutive same-date pairs (start → end on the same day, e.g. 1st of month)
  const merged = [];
  let i = 0;
  while (i < series.length) {
    if (i + 1 < series.length && series[i].date === series[i + 1].date) {
      const isReset = series[i].reset || series[i + 1].reset;
      merged.push({ date: series[i].date, startRating: series[i].rating, endRating: series[i + 1].rating, reset: isReset, resetFrom: series[i].resetFrom ?? series[i + 1].resetFrom });
      i += 2;
    } else {
      merged.push({ date: series[i].date, rating: series[i].rating, reset: series[i].reset, resetFrom: series[i].resetFrom });
      i++;
    }
  }

  const frag = document.createDocumentFragment();
  const reversed = merged.slice().reverse();

  reversed.forEach((p, idx) => {
    const prevEntry = reversed[idx + 1];
    const prevRating = prevEntry != null ? (prevEntry.endRating ?? prevEntry.rating) : null;
    const endRating = p.endRating ?? p.rating;
    const rank = getRankOnDate(p.date, endRating);
    const rankHtml = `<span class="hist-rank">#${rank}</span>`;
    const li = document.createElement("li");
    const isReset = p.reset === true;

    if (isReset) {
      // Monthly reset — show reset value → end of day rating
      const resetFrom = p.resetFrom ?? p.startRating;
      const resetCol = `<span class="hist-reset-col">🔄 reset</span>`;
      const emptyCol = `<span class="hist-reset-col"></span>`;
      if (resetFrom != null && Math.abs(endRating - resetFrom) > 0.01) {
        const delta = endRating - resetFrom;
        const cls = deltaClass(delta);
        li.innerHTML = `
          <span>${escapeHtml(p.date)}</span>
          ${rankHtml}
          ${resetCol}
          <span>${fmt(resetFrom, CONFIG.RATING_DIGITS)}<span class="hist-arrow">→</span>${fmt(endRating, CONFIG.RATING_DIGITS)} <span class="${cls}">(${formatDelta(delta, CONFIG.DELTA_DIGITS)})</span></span>
        `;
      } else {
        li.innerHTML = `
          <span>${escapeHtml(p.date)}</span>
          ${rankHtml}
          ${resetCol}
          <span>${fmt(endRating, CONFIG.RATING_DIGITS)}</span>
        `;
      }
    } else if (p.startRating != null) {
      const delta = p.endRating - p.startRating;
      const cls = deltaClass(delta);
      li.innerHTML = `
        <span>${escapeHtml(p.date)}</span>
        ${rankHtml}
        <span class="hist-reset-col"></span>
        <span>${fmt(p.startRating, CONFIG.RATING_DIGITS)}<span class="hist-arrow">→</span>${fmt(p.endRating, CONFIG.RATING_DIGITS)} <span class="${cls}">(${formatDelta(delta, CONFIG.DELTA_DIGITS)})</span></span>
      `;
    } else if (prevRating != null) {
      const delta = p.rating - prevRating;
      const cls = deltaClass(delta);
      li.innerHTML = `
        <span>${escapeHtml(p.date)}</span>
        ${rankHtml}
        <span class="hist-reset-col"></span>
        <span>${fmt(prevRating, CONFIG.RATING_DIGITS)}<span class="hist-arrow">→</span>${fmt(p.rating, CONFIG.RATING_DIGITS)} <span class="${cls}">(${formatDelta(delta, CONFIG.DELTA_DIGITS)})</span></span>
      `;
    } else {
      li.innerHTML = `
        <span>${escapeHtml(p.date)}</span>
        ${rankHtml}
        <span class="hist-reset-col"></span>
        <span>${fmt(p.rating, CONFIG.RATING_DIGITS)}</span>
      `;
    }
    frag.appendChild(li);
  });

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
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = max - min || 1;
  const n = series.length;

  const xAt = (i) => pad.l + (i / Math.max(1, n - 1)) * innerW;
  const yAt = (v) => pad.t + (1 - (v - min) / range) * innerH;

  return { W, H, dpr, pad, innerW, innerH, min, max, range, n, xAt, yAt };
}

function drawChartFrame(series, dims, opts = {}) {
  if (!els.chart) return;
  const { W, H, dpr, pad, min, max, range, n, xAt, yAt } = dims;
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
  for (let i = 0; i <= STEPS; i++) {
    const ratio = i / STEPS;
    const y = pad.t + ratio * (H - pad.t - pad.b);
    const v = max - ratio * range;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(0), pad.l - 6, y);
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
    const a = new Date(series[i - 1].date), b = new Date(series[i].date);
    if (a.getMonth() !== b.getMonth() || a.getFullYear() !== b.getFullYear()) {
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
    const nextDate = new Date(series[e + 1].date);
    const label = MONTH_NAMES[nextDate.getMonth()] + " " + nextDate.getFullYear();
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

function drawChartAnimated(series) {
  if (!els.chart) return;
  cancelAnimationFrame(state.chartRAF);
  hideChartTip();

  state.chartSeries = series;
  state.chartDims = computeChartDims(series);
  state.chartHoverIdx = null;

  if (!series.length) {
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
      `<strong>${fmt(point.rating, CONFIG.RATING_DIGITS)}</strong>` +
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

/* Month-capped delta — stays within the current month (used for Player of the Week) */
function calcMonthDelta(series, days) {
  if (!series || series.length < 2) return null;
  const last = series.at(-1);
  const lastDate = new Date(last.date + "T00:00:00");
  const monthStart = new Date(lastDate.getFullYear(), lastDate.getMonth(), 1);
  const monthEntries = series.filter((p) => new Date(p.date + "T00:00:00") >= monthStart);
  if (monthEntries.length < 2) return null;

  const target = new Date(lastDate);
  target.setDate(target.getDate() - days);
  const effectiveFrom = target > monthStart ? target : monthStart;

  let base = monthEntries[0];
  if (effectiveFrom > monthStart) {
    for (let i = 0; i < monthEntries.length - 1; i++) {
      if (new Date(monthEntries[i].date + "T00:00:00") <= effectiveFrom) base = monthEntries[i];
    }
  }
  if (base === last) return null;
  return last.rating - base.rating;
}

function calcDelta(series, days) {
  if (!series || series.length < 2) return null;
  const last = series.at(-1);
  const lastDate = new Date(last.date + "T00:00:00");

  const target = new Date(lastDate);
  target.setDate(target.getDate() - days);

  // Find the last entry whose date is on or before the target date
  let base = null;
  for (let i = series.length - 2; i >= 0; i--) {
    if (new Date(series[i].date + "T00:00:00") <= target) {
      base = series[i];
      break;
    }
  }

  if (!base) return null;
  return last.rating - base.rating;
}

function fmt(num) {
  if (num == null || Number.isNaN(num)) return "—";
  return String(Number(num));
}

function formatDelta(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const n = parseFloat(Number(v).toFixed(1));
  return n > 0 ? `+${n}` : String(n);
}

function deltaClass(v) {
  if (v == null || Number.isNaN(v)) return "";
  if (v > 0) return "delta-pos";
  if (v < 0) return "delta-neg";
  return "delta-zero";
}

function onSearch() {
  renderTable();
  const first = els.tbody?.querySelector("tr");
  if (first && first.children.length > 1) first.click();
}

function autoSelectTop() {
  if (!state.globalRows.length) return;
  selectPlayer(state.globalRows[0]);
}

function updateURL(nick) {
  const url = new URL(window.location.href);
  url.searchParams.set("player", nick);
  history.replaceState(null, "", url.toString());
}

function handleDeepLink() {
  const nick = new URLSearchParams(window.location.search).get("player");
  if (!nick) return;
  const p = state.players.find((x) => x.nick === nick);
  if (p) selectPlayer(p);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
