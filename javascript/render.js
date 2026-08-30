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

// Visible viewport: the area actually on screen. On tablets in landscape the
// browser chrome / OS bars eat into window.innerHeight, so the game area can
// spill below the visible region. visualViewport reports the real visible
// size (and updates when the address bar shows/hides); fall back to window.
function visibleViewport() {
  const vv = window.visualViewport;
  if (vv && vv.height > 0) return { w: vv.width, h: vv.height };
  return { w: window.innerWidth, h: window.innerHeight };
}

// Players that should get a visible column. Local play: everyone. Online:
// only the slots that actually have a player in the room (empty slots are
// spectators — no column, so the present players' boards stay large enough
// to read on a phone/tablet).
function visiblePlayers() {
  if (!online) return players.slice();
  return players.filter(pl => onlinePlayers.some(p => p.slot === pl.slot));
}

// Scale factor for the board so it fits the visible viewport BOTH vertically
// and horizontally.
//  - Uses the visible viewport (not window.innerHeight) so the board fits on
//    tablets in landscape where the OS bars / browser chrome shrink the
//    visible area (a landscape tablet is wide, so a width-based check would
//    miss it — the constraint is the short visible height).
//  - When the touch pad is open (body.pad-open) the game area is zoomed to
//    80% to leave room for the controls at the bottom.
//  - Width: all `n` columns must fit side by side, so a 2-player online match
//    gets wider boards than a 4-player one (fewer columns = more room each).
//  - Returns 1 (no shrink) whenever the board already fits both ways.
function boardCellScale(n) {
  const base = CELL_BY_COUNT[n] || 21;
  const miniW = MINI_W_BY_COUNT[n] || 72;
  const { w, h } = visibleViewport();
  const padOpen = document.body.classList.contains("pad-open");
  const zoom = padOpen ? 0.8 : 1; // 80% zoom when the pad is shown
  const reserve = padOpen ? 290 : 140; // title + stats + header (+ pad when open)
  const availH = Math.max(160, (h - reserve) * zoom);
  const scaleH = Math.min(1, availH / (ROWS * base));

  // Horizontal fit: n columns of (board + mini) plus the fixed gaps/padding.
  const fixedPerCol = 30; // col-body gap + column padding (approx)
  const gap = 16;          // .game-row gap between columns
  const availW = Math.max(200, w - 24); // 24px page margin
  const scaleW = Math.min(1, (availW - n * fixedPerCol - (n - 1) * gap) / (n * (COLS * base + miniW)));

  return Math.min(scaleH, scaleW);
}
let lastBoardScale = 0;

function buildColumns() {
  const wrap = document.getElementById("columns");
  wrap.innerHTML = "";
  const vis = visiblePlayers();
  const n = vis.length;
  const scale = Math.round(boardCellScale(n) * 100) / 100;
  lastBoardScale = scale;
  const cell = Math.max(12, Math.floor((CELL_BY_COUNT[n] || 21) * scale));
  const mini = Math.max(9, Math.floor((MINI_BY_COUNT[n] || 13) * scale));
  const slotH = Math.max(30, Math.floor((SLOT_H_BY_COUNT[n] || 48) * scale));
  const miniW = Math.max(40, Math.floor((MINI_W_BY_COUNT[n] || 72) * scale));

  for (const pl of vis) {
    const i = pl.slot; // stable id per slot (works for local + online)
    pl.cell = cell; pl.miniCell = mini; pl.nextSlotH = slotH;
    const label = (online && pl.name) ? pl.name : ("P" + (i + 1));

    const col = document.createElement("div");
    col.className = "player-col";
    col.innerHTML = `
      <div class="col-header">
        <span class="p-label">${escapeHtml(label)}</span>
        <span class="pad-dot" id="padDot-${i}"></span>
        <span class="out-badge hidden" id="outBadge-${i}">FUERA</span>
      </div>
      <div class="col-body">
        <canvas id="board-${i}"></canvas>
        <div class="side-mini">
          <div class="mini-card"><h3>Siguiente</h3><canvas id="next-${i}"></canvas></div>
          <div class="mini-card"><h3>Guardar</h3><canvas id="hold-${i}"></canvas></div>
        </div>
      </div>
      <div class="stats-strip">
        <div class="stat"><span class="label">Puntos</span><span class="value" id="score-${i}">0</span></div>
        <div class="stat-row">
          <div class="stat"><span class="label">Nivel</span><span class="value small" id="level-${i}">1</span></div>
          <div class="stat"><span class="label">Líneas</span><span class="value small" id="lines-${i}">0</span></div>
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

  // Garbage flash: red overlay fading out when garbage rows land.
  if (pl.garbageFlash > 0) {
    ctx.fillStyle = `rgba(255,45,85,${pl.garbageFlash * 0.35})`;
    ctx.fillRect(0, 0, COLS * pl.cell, ROWS * pl.cell);
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
  pl.elScore.textContent = pl.score.toLocaleString("es-ES");
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
      <h2 class="screen-title">JUGADORES</h2>
      <div class="menu-count-row">
        <button class="arrow menu-arrow" id="menuDec" aria-label="Menos jugadores">&#9664;</button>
        <span class="menu-count" id="menuCountEl">${count}</span>
        <button class="arrow menu-arrow" id="menuInc" aria-label="Más jugadores">&#9654;</button>
      </div>
      <button class="btn" id="menuStart">&#9654;&nbsp; Iniciar</button>
      <p class="screen-hint">&larr; &rarr; cambiar &middot; Enter para confirmar</p>
      <p class="screen-hint" id="menuPadsEl"></p>
      <button class="btn" id="settingsBtn">&#9881;&nbsp; Ajustes (Jugador 1)</button>
    </div>`;
  screenEls = { count: screenEl.querySelector("#menuCountEl"), pads: screenEl.querySelector("#menuPadsEl") };
  document.getElementById("settingsBtn").onclick = () => openSettings();
  document.getElementById("menuDec").onclick = () => changeMenuCount(-1);
  document.getElementById("menuInc").onclick = () => changeMenuCount(1);
  document.getElementById("menuStart").onclick = () => confirmMenu();
  updateMenuPadsLine();
  screenEl.classList.remove("hidden");
}

function updateMenuPadsLine() {
  if (screenKind !== "menu" || !screenEls.pads) return;
  const n = connectedPads; // maintained by input.js
  screenEls.pads.textContent = n === 0
    ? "No hay mandos conectados — conecta uno y pulsa cualquier botón"
    : `Mandos conectados: ${n}`;
}

/* ============================================================
 * ONLINE SCREENS (home / net menu / lobby)
 * ============================================================ */
function showHome() {
  screenKind = "home";
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">BZTETRIS</h2>
      <div class="home-buttons">
        <button class="btn home-btn" id="homeLocal">Juego local</button>
        <button class="btn home-btn" id="homeOnline">Juego online</button>
      </div>
      <p class="screen-hint">Local: 1-4 jugadores en este equipo &middot; Online: multijugador con ataque de basura</p>
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
  const conn = netConnected ? '<span class="on">conectado</span>' : '<span class="off">conectando…</span>';
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">ONLINE</h2>
      <p class="screen-hint">Servidor: ${conn}</p>
      <div class="net-form">
        <label class="net-label">Tu nombre</label>
        <input class="net-input" id="netName" maxlength="16" placeholder="Jugador" />
        <div class="net-row">
          <button class="btn" id="netCreate">Crear sala</button>
        </div>
        <div class="net-row join-row">
          <input class="net-input code-input" id="netCode" maxlength="4" placeholder="CÓDIGO" />
          <button class="btn" id="netJoin">Unirse</button>
        </div>
      </div>
      ${netError ? `<p class="screen-hint net-error">${escapeHtml(netError)}</p>` : ""}
      <button class="btn" id="netBack">Volver</button>
      <p class="screen-hint">Esc para volver</p>
    </div>`;
  screenEls = {};
  const nameEl = document.getElementById("netName");
  const codeEl = document.getElementById("netCode");
  if (codeEl) codeEl.value = (codeEl.value || "").toUpperCase();
  document.getElementById("netBack").onclick = () => returnHome();
  document.getElementById("netCreate").onclick = () => {
    const name = (nameEl.value || "Jugador").trim();
    createRoom(name);
  };
  document.getElementById("netJoin").onclick = () => {
    const code = (codeEl.value || "").trim().toUpperCase();
    if (code.length !== 4) { netError = "Introduce un código de 4 caracteres"; showNetMenu(); return; }
    const name = (nameEl.value || "Jugador").trim();
    joinRoom(code, name);
  };
  screenEl.classList.remove("hidden");
}

function showLobby() {
  screenKind = "lobby";
  const me = onlinePlayers.find(p => p.slot === mySlot);
  const isHost = me ? me.isHost : false;
  const rows = onlinePlayers.map(p => {
    const ghost = p.ghost;
    const ready = ghost
      ? '<span class="slot-waiting">reconectando…</span>'
      : (p.ready ? '<span class="slot-ready">LISTO</span>' : '<span class="slot-waiting">esperando…</span>');
    const hostTag = p.isHost ? ' <span class="host-tag">ANFITRIÓN</span>' : "";
    const meTag = p.slot === mySlot ? ' <span class="me-tag">(tú)</span>' : "";
    return `<div class="wait-slot${p.ready && !ghost ? " ready" : ""}${ghost ? " ghost" : ""}"><span class="slot-label">P${p.slot + 1}</span><span class="slot-src">${escapeHtml(p.name)}${hostTag}${meTag}</span>${ready}</div>`;
  }).join("");
  const emptyCount = 4 - onlinePlayers.length;
  const emptyRows = Array.from({ length: emptyCount }, (_, i) =>
    `<div class="wait-slot"><span class="slot-label">P${onlinePlayers.length + i + 1}</span><span class="slot-src">vacío</span><span class="slot-waiting">—</span></div>`
  ).join("");
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">SALA</h2>
      <div class="room-code-row"><span class="room-code-label">CÓDIGO DE SALA</span><span class="room-code">${escapeHtml(roomCode)}</span></div>
      <div class="wait-slots">${rows}${emptyRows}</div>
      <div class="lobby-actions">
        <button class="btn" id="lobbyReady">${me && me.ready ? "Cancelar listo" : "Listo"}</button>
        ${isHost ? '<button class="btn" id="lobbyStart">Iniciar partida</button>' : '<p class="screen-hint">Esperando a que el anfitrión inicie…</p>'}
        <button class="btn" id="lobbyLeave">Salir de la sala</button>
      </div>
      ${netError ? `<p class="screen-hint net-error">${escapeHtml(netError)}</p>` : ""}
      <p class="screen-hint">Comparte el código de sala con tus amigos &middot; Esc para salir</p>
    </div>`;
  screenEls = {};
  document.getElementById("lobbyReady").onclick = () => setReady(!(me && me.ready));
  const startBtn = document.getElementById("lobbyStart");
  if (startBtn) startBtn.onclick = () => hostStart();
  document.getElementById("lobbyLeave").onclick = () => returnHome();
  screenEl.classList.remove("hidden");
}

function slotSourceLabel(slot) {
  const owner = slotOwner[slot];
  if (owner === "keyboard") return "Teclado";
  if (owner && owner.startsWith("pad")) {
    const idx = parseInt(owner.slice(3));
    return padNames[idx] || `Mando ${idx + 1}`;
  }
  return `P${slot + 1}`;
}

function showWaiting() {
  screenKind = "waiting";
  const rows = players.map(pl => {
    const src = slotSourceLabel(pl.slot);
    const st = pl.ready
      ? '<span class="slot-ready">LISTO</span>'
      : `<button class="btn slot-join-btn" id="joinBtn-${pl.slot}">Listo</button>`;
    return `<div class="wait-slot${pl.ready ? " ready" : ""}"><span class="slot-label">P${pl.slot + 1}</span><span class="slot-src">${escapeHtml(src)}</span>${st}</div>`;
  }).join("");
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title">ESPERANDO JUGADORES</h2>
      <div class="wait-slots">${rows}</div>
      <button class="btn" id="waitBack">Volver al menú</button>
      <p class="screen-hint">P1: cualquier tecla &middot; P2&ndash;P4: botón A de tu mando &middot; B o Esc para volver</p>
    </div>`;
  screenEls = {};
  for (const pl of players) {
    if (pl.ready) continue;
    const b = document.getElementById(`joinBtn-${pl.slot}`);
    if (b) b.onclick = () => joinSlot(pl.slot);
  }
  document.getElementById("waitBack").onclick = () => returnToMenu();
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
      <h2 class="screen-title">PAUSA</h2>
      <button class="btn" id="pauseResume">&#9654;&nbsp; Continuar</button>
      <button class="btn" id="pauseMenu">Volver al menú</button>
      <p class="screen-hint">Pulsa P o Esc para continuar &middot; R para el menú</p>
    </div>`;
  screenEls = {};
  document.getElementById("pauseResume").onclick = () => resumeGame();
  document.getElementById("pauseMenu").onclick = () => returnToMenu();
  screenEl.classList.remove("hidden");
}

function showEndScreen(kind, winner) {
  screenKind = kind;
  const title = winner ? (online ? `${winner.name || ("P" + (winner.slot + 1))} GANA` : `P${winner.slot + 1} GANA`) : "FIN DE LA PARTIDA";
  const rows = players.map(pl => {
    const isWinnerRow = winner && pl === winner;
    const dimmed = winner && !isWinnerRow;
    const label = online ? (pl.name || ("P" + (pl.slot + 1))) : ("P" + (pl.slot + 1));
    return `<div class="score-row${dimmed ? " dim" : ""}${isWinnerRow ? " win" : ""}"><span>${escapeHtml(label)}${dimmed ? " &middot; FUERA" : ""}</span><b>${pl.score.toLocaleString("es-ES")}</b></div>`;
  }).join("");
  screenEl.innerHTML = `
    <div class="screen-inner">
      <h2 class="screen-title ${kind}">${title}</h2>
      <div class="score-list">${rows}</div>
      <button class="btn" id="endBack">Volver al menú</button>
      <p class="screen-hint">Pulsa A, B o Enter para volver al menú</p>
    </div>`;
  screenEls = {};
  document.getElementById("endBack").onclick = () => returnToMenu();
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
