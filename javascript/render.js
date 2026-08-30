// render.js — Per-player canvas drawing (board, piece, ghost, effects),
// player-column layout builder, and full-screen state overlays (menu, waiting, countdown, pause, end).

"use strict";

/* ============================================================
 * CANVAS SETUP
 * ============================================================ */
function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return ctx;
}

/* ============================================================
 * PLAYER COLUMNS — one column per player: header, board + mini panels, stats.
 * Called from confirmMenu() (and at boot) with the chosen player count.
 * ============================================================ */
const CELL_BY_COUNT = { 1: 30, 2: 27, 3: 24, 4: 21 };
const MINI_BY_COUNT = { 1: 19, 2: 17, 3: 15, 4: 13 };
const SLOT_H_BY_COUNT = { 1: 64, 2: 58, 3: 52, 4: 48 };
const MINI_W_BY_COUNT = { 1: 96, 2: 88, 3: 80, 4: 72 };

function buildColumns(n) {
  const wrap = document.getElementById("columns");
  wrap.innerHTML = "";
  const cell = CELL_BY_COUNT[n] || 21;
  const mini = MINI_BY_COUNT[n] || 13;
  const slotH = SLOT_H_BY_COUNT[n] || 48;
  const miniW = MINI_W_BY_COUNT[n] || 72;

  for (let i = 0; i < n; i++) {
    const pl = players[i];
    if (!pl) continue;
    pl.cell = cell; pl.miniCell = mini; pl.nextSlotH = slotH;
    const label = (online && pl.name) ? pl.name : ("P" + (i + 1));

    const col = document.createElement("div");
    col.className = "player-col";
    col.innerHTML = `
      <div class="col-header">
        <span class="p-label">${escapeHtml(label)}</span>
        <span class="pad-dot" id="padDot-${i}"></span>
        <span class="out-badge hidden" id="outBadge-${i}">OUT</span>
      </div>
      <div class="col-body">
        <canvas id="board-${i}"></canvas>
        <div class="side-mini">
          <div class="mini-card"><h3>Next</h3><canvas id="next-${i}"></canvas></div>
          <div class="mini-card"><h3>Hold</h3><canvas id="hold-${i}"></canvas></div>
        </div>
      </div>
      <div class="stats-strip">
        <div class="stat"><span class="label">Score</span><span class="value" id="score-${i}">0</span></div>
        <div class="stat-row">
          <div class="stat"><span class="label">Level</span><span class="value small" id="level-${i}">1</span></div>
          <div class="stat"><span class="label">Lines</span><span class="value small" id="lines-${i}">0</span></div>
        </div>
      </div>`;
    wrap.appendChild(col);

    pl.miniW = miniW;
    pl.ctx = setupCanvas(document.getElementById(`board-${i}`), COLS * cell, ROWS * cell);
    pl.nextCtx = setupCanvas(document.getElementById(`next-${i}`), miniW, slotH * 3);
    pl.holdCtx = setupCanvas(document.getElementById(`hold-${i}`), miniW, slotH);
    pl.elScore = document.getElementById(`score-${i}`);
    pl.elLevel = document.getElementById(`level-${i}`);
    pl.elLines = document.getElementById(`lines-${i}`);
    pl.elOutBadge = col.querySelector(`#outBadge-${i}`);
    pl.elPadDot = col.querySelector(`#padDot-${i}`);

    updateStats(pl);
    drawNext(pl);
    drawHold(pl);
  }
  lastDotSig = "";
  updatePadDots();
}

/* ============================================================
 * BLOCK / PIECE DRAWING (shared by board and mini panels)
 * ============================================================ */
function drawBoardBackground(ctx, cell) {
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if ((r + c) % 2 === 0) ctx.fillRect(c * cell, r * cell, cell, cell);
}

function drawBlock(ctx, x, y, size, color) {
  const g = ctx.createLinearGradient(x, y, x, y + size);
  g.addColorStop(0, lighten(color, 35));
  g.addColorStop(1, color);
  ctx.fillStyle = g;
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2);

  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);

  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x + 2, y + 2, size - 4, Math.max(2, size * 0.16));
}

function drawMiniPiece(ctx, type, cx, cy, miniCell) {
  const m = SHAPES[type];
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (let r = 0; r < m.length; r++)
    for (let c = 0; c < m[r].length; c++)
      if (m[r][c]) { minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c); }
  const w = (maxC - minC + 1) * miniCell;
  const h = (maxR - minR + 1) * miniCell;
  for (let r = 0; r < m.length; r++)
    for (let c = 0; c < m[r].length; c++)
      if (m[r][c]) drawBlock(ctx, cx - w / 2 + (c - minC) * miniCell, cy - h / 2 + (r - minR) * miniCell, miniCell, COLORS[type]);
}

/* ============================================================
 * PER-PLAYER RENDERING
 * ============================================================ */
function renderPlayer(pl) {
  const ctx = pl.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, COLS * pl.cell, ROWS * pl.cell);
  drawBoardBackground(ctx, pl.cell);

  let sx = 0, sy = 0;
  if (shake.t > 0 && shake.dur > 0) {
    const k = shake.mag * (1 - shake.t / shake.dur);
    sx = (Math.random() * 2 - 1) * k;
    sy = (Math.random() * 2 - 1) * k;
  }

  ctx.save();
  ctx.translate(sx, sy);

  const clearingRows = pl.clearing ? new Set(pl.clearing.rows) : null;
  for (let r = 0; r < ROWS; r++) {
    if (clearingRows && clearingRows.has(r)) continue; // cleared rows flash instead of drawing blocks
    for (let c = 0; c < COLS; c++) {
      const t = pl.board[r][c];
      if (t) drawBlock(ctx, c * pl.cell, r * pl.cell, pl.cell, COLORS[t]);
    }
  }

  // Line-clear flash: white band fading out over CLEAR_ANIM_MS.
  if (pl.clearing) {
    const a = Math.max(0, 1 - pl.clearing.t / CLEAR_ANIM_MS);
    ctx.fillStyle = `rgba(255,255,255,${a * 0.9})`;
    for (const r of pl.clearing.rows) ctx.fillRect(0, r * pl.cell, COLS * pl.cell, pl.cell);
  }

  // Ghost piece + active piece
  if (pl.piece && !pl.clearing) {
    const ghost = { ...pl.piece };
    while (!collidesAt(pl, pieceCells({ ...ghost, y: ghost.y + 1 }))) ghost.y++;
    ctx.globalAlpha = 0.25;
    for (const [cx, cy] of pieceCells(ghost))
      if (cy >= 0) drawBlock(ctx, cx * pl.cell, cy * pl.cell, pl.cell, COLORS[pl.piece.type]);
    ctx.globalAlpha = 1;
    for (const [cx, cy] of pieceCells(pl.piece))
      if (cy >= 0) drawBlock(ctx, cx * pl.cell, cy * pl.cell, pl.cell, COLORS[pl.piece.type]);
  }

  drawParticles(pl, ctx);
  drawPopups(pl, ctx);
  ctx.restore();
}

function render() {
  for (const pl of players) if (pl.ctx) renderPlayer(pl);
}

/* ============================================================
 * NEXT / HOLD MINI PANELS (per player)
 * ============================================================ */
function drawNext(pl) {
  const ctx = pl.nextCtx;
  if (!ctx) return;
  ctx.clearRect(0, 0, pl.miniW || 96, (pl.nextSlotH || 64) * 3);
  // Local players: top up the queue from their bag. Remote players: the queue
  // comes verbatim from snapshots — do NOT refill (it would corrupt it).
  if (!pl.remote) refillQueue(pl);
  for (let i = 0; i < 3 && i < pl.queue.length; i++)
    drawMiniPiece(ctx, pl.queue[i], (pl.miniW || 96) / 2, (pl.nextSlotH || 64) / 2 + i * (pl.nextSlotH || 64), pl.miniCell);
}

function drawHold(pl) {
  const ctx = pl.holdCtx;
  if (!ctx) return;
  ctx.clearRect(0, 0, pl.miniW || 96, pl.nextSlotH || 64);
  if (pl.heldType) drawMiniPiece(ctx, pl.heldType, (pl.miniW || 96) / 2, (pl.nextSlotH || 64) / 2, pl.miniCell);
}

/* ============================================================
 * STATS (per player)
 * ============================================================ */
function updateStats(pl) {
  if (!pl.elScore) return;
  pl.elScore.textContent = pl.score.toLocaleString("en-US");
  pl.elLevel.textContent = String(pl.level);
  pl.elLines.textContent = String(pl.linesCleared);
}

/* ============================================================
 * FULL-SCREEN STATE OVERLAYS (menu / waiting / countdown / pause / end)
 * ============================================================ */
const screenEl = document.getElementById("screen");
let screenKind = null;
let screenEls = {};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showMenu(count) {
  screenKind = "menu";
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">PLAYERS</h2>
      <div class="menu-count-row">
        <span class="arrow">&#9664;</span>
        <span class="menu-count" id="menuCountEl">${count}</span>
        <span class="arrow">&#9654;</span>
      </div>
      <p class="screen-hint">&larr; &rarr; change &middot; Enter to confirm</p>
      <p class="screen-hint" id="menuPadsEl"></p>
      <button class="btn" id="settingsBtn">&#9881;&nbsp; Settings (Player 1)</button>
    </div>`;
  screenEls = { count: screenEl.querySelector("#menuCountEl"), pads: screenEl.querySelector("#menuPadsEl") };
  document.getElementById("settingsBtn").onclick = () => openSettings();
  updateMenuPadsLine();
  screenEl.classList.remove("hidden");
}

function updateMenuPadsLine() {
  if (screenKind !== "menu" || !screenEls.pads) return;
  const n = connectedPads; // maintained by input.js
  screenEls.pads.textContent = n === 0
    ? "No controllers connected — plug one in and press any button"
    : `Controllers connected: ${n}`;
}

/* ============================================================
 * ONLINE SCREENS (home / net menu / lobby)
 * ============================================================ */
function showHome() {
  screenKind = "home";
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">TETRIS</h2>
      <div class="home-buttons">
        <button class="btn home-btn" id="homeLocal">Local Play</button>
        <button class="btn home-btn" id="homeOnline">Online Play</button>
      </div>
      <p class="screen-hint">Local: 1-4 players on this machine &middot; Online: garbage-attack multiplayer</p>
    </div>`;
  screenEls = {};
  document.getElementById("homeLocal").onclick = () => { state = State.MENU; showMenu(menuCount); };
  document.getElementById("homeOnline").onclick = () => { state = State.NET_MENU; showNetMenu(); };
  refreshHomeSelect();
  screenEl.classList.remove("hidden");
}

// Highlight the currently selected home option (driven by homeSelect in input.js).
function refreshHomeSelect() {
  if (screenKind !== "home") return;
  const local = document.getElementById("homeLocal");
  const online = document.getElementById("homeOnline");
  if (local) local.classList.toggle("selected", homeSelect === 0);
  if (online) online.classList.toggle("selected", homeSelect === 1);
}

function showNetMenu() {
  screenKind = "netmenu";
  const conn = netConnected ? '<span class="on">connected</span>' : '<span class="off">connecting…</span>';
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">ONLINE</h2>
      <p class="screen-hint">Server: ${conn}</p>
      <div class="net-form">
        <label class="net-label">Your name</label>
        <input class="net-input" id="netName" maxlength="16" placeholder="Player" />
        <div class="net-row">
          <button class="btn" id="netCreate">Create Room</button>
        </div>
        <div class="net-row join-row">
          <input class="net-input code-input" id="netCode" maxlength="4" placeholder="CODE" />
          <button class="btn" id="netJoin">Join</button>
        </div>
      </div>
      ${netError ? `<p class="screen-hint net-error">${escapeHtml(netError)}</p>` : ""}
      <p class="screen-hint">Esc to go back</p>
    </div>`;
  screenEls = {};
  const nameEl = document.getElementById("netName");
  const codeEl = document.getElementById("netCode");
  if (codeEl) codeEl.value = (codeEl.value || "").toUpperCase();
  document.getElementById("netCreate").onclick = () => {
    const name = (nameEl.value || "Player").trim();
    createRoom(name);
  };
  document.getElementById("netJoin").onclick = () => {
    const code = (codeEl.value || "").trim().toUpperCase();
    if (code.length !== 4) { netError = "Enter a 4-character code"; showNetMenu(); return; }
    const name = (nameEl.value || "Player").trim();
    joinRoom(code, name);
  };
  screenEl.classList.remove("hidden");
}

function showLobby() {
  screenKind = "lobby";
  const me = onlinePlayers.find(p => p.slot === mySlot);
  const isHost = me ? me.isHost : false;
  const rows = onlinePlayers.map(p => {
    const ready = p.ready ? '<span class="slot-ready">READY</span>' : '<span class="slot-waiting">waiting…</span>';
    const hostTag = p.isHost ? ' <span class="host-tag">HOST</span>' : "";
    const meTag = p.slot === mySlot ? ' <span class="me-tag">(you)</span>' : "";
    return `<div class="wait-slot${p.ready ? " ready" : ""}"><span class="slot-label">P${p.slot + 1}</span><span class="slot-src">${escapeHtml(p.name)}${hostTag}${meTag}</span>${ready}</div>`;
  }).join("");
  const emptyCount = 4 - onlinePlayers.length;
  const emptyRows = Array.from({ length: emptyCount }, (_, i) =>
    `<div class="wait-slot"><span class="slot-label">P${onlinePlayers.length + i + 1}</span><span class="slot-src">empty</span><span class="slot-waiting">—</span></div>`
  ).join("");
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">LOBBY</h2>
      <div class="room-code-row"><span class="room-code-label">ROOM CODE</span><span class="room-code">${escapeHtml(roomCode)}</span></div>
      <div class="wait-slots">${rows}${emptyRows}</div>
      <div class="lobby-actions">
        <button class="btn" id="lobbyReady">${me && me.ready ? "Unready" : "Ready"}</button>
        ${isHost ? '<button class="btn" id="lobbyStart">Start Match</button>' : '<p class="screen-hint">Waiting for host to start…</p>'}
      </div>
      ${netError ? `<p class="screen-hint net-error">${escapeHtml(netError)}</p>` : ""}
      <p class="screen-hint">Share the room code with your friends &middot; Esc to leave</p>
    </div>`;
  screenEls = {};
  document.getElementById("lobbyReady").onclick = () => setReady(!(me && me.ready));
  const startBtn = document.getElementById("lobbyStart");
  if (startBtn) startBtn.onclick = () => hostStart();
  screenEl.classList.remove("hidden");
}

function slotSourceLabel(slot) {
  const owner = slotOwner[slot];
  if (owner === "keyboard") return "Keyboard";
  if (owner && owner.startsWith("pad")) {
    const idx = parseInt(owner.slice(3));
    return padNames[idx] || `Controller ${idx + 1}`;
  }
  return `P${slot + 1}`;
}

function showWaiting() {
  screenKind = "waiting";
  const rows = players.map(pl => {
    const src = slotSourceLabel(pl.slot);
    const st = pl.ready
      ? '<span class="slot-ready">READY</span>'
      : '<span class="slot-waiting">waiting\u2026</span>';
    return `<div class="wait-slot${pl.ready ? " ready" : ""}"><span class="slot-label">P${pl.slot + 1}</span><span class="slot-src">${escapeHtml(src)}</span>${st}</div>`;
  }).join("");
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">WAITING FOR PLAYERS</h2>
      <div class="wait-slots">${rows}</div>
      <p class="screen-hint">P1: any key &middot; P2&ndash;P4: A button on your controller &middot; B or Esc to go back</p>
    </div>`;
  screenEls = {};
  screenEl.classList.remove("hidden");
}

function showCountdown() {
  screenKind = "countdown";
  screenEl.innerHTML = `<div class="screen-inner"><span class="cd-number" id="cdNumber">3</span></div>`;
  screenEls = { cd: screenEl.querySelector("#cdNumber") };
  screenEl.classList.remove("hidden");
}

function setCountdownNumber(n) { if (screenEls.cd) screenEls.cd.textContent = String(n); }

function showPaused() {
  screenKind = "paused";
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">PAUSED</h2>
      <p class="screen-hint">Press P or Esc to resume &middot; R for the menu</p>
    </div>`;
  screenEls = {};
  screenEl.classList.remove("hidden");
}

function showEndScreen(kind, winner) {
  screenKind = kind;
  const title = winner ? (online ? `${winner.name || ("P" + (winner.slot + 1))} WINS!` : `P${winner.slot + 1} WINS!`) : "GAME OVER";
  const rows = players.map(pl => {
    const isWinnerRow = winner && pl === winner;
    const dimmed = winner && !isWinnerRow;
    const label = online ? (pl.name || ("P" + (pl.slot + 1))) : ("P" + (pl.slot + 1));
    return `<div class="score-row${dimmed ? " dim" : ""}${isWinnerRow ? " win" : ""}"><span>${escapeHtml(label)}${dimmed ? " &middot; OUT" : ""}</span><b>${pl.score.toLocaleString("en-US")}</b></div>`;
  }).join("");
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title ${kind}">${title}</h2>
      <div class="score-list">${rows}</div>
      <p class="screen-hint">Press A, B or Enter to return to the menu</p>
    </div>`;
  screenEls = {};
  screenEl.classList.remove("hidden");
}

function hideScreen() {
  screenKind = null;
  screenEls = {};
  screenEl.classList.add("hidden");
}

// Re-render the current menu/waiting screen with fresh data (player count, pad names).
function refreshScreen() {
  if (screenKind === "menu") showMenu(menuCount);
  else if (screenKind === "waiting") showWaiting();
  else if (screenKind === "netmenu") showNetMenu();
  else if (screenKind === "lobby") showLobby();
}

/* ============================================================
 * PAD INDICATOR DOTS (per column header)
 * ============================================================ */
let lastDotSig = "";
function updatePadDots() {
  const sig = padNames.join("|") + "|" + slotOwner.join(",");
  if (sig === lastDotSig) return;
  lastDotSig = sig;
  for (const pl of players) {
    if (!pl.elPadDot) continue;
    const owner = slotOwner[pl.slot];
    const on = owner === "keyboard" || (owner && owner.startsWith("pad") && !!padNames[parseInt(owner.slice(3))]);
    pl.elPadDot.classList.toggle("on", on);
  }
}
