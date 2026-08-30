// core.js — Multiplayer game state machine and per-player Tetris engine (SRS, 7-bag, hold, scoring).

"use strict";

/* ============================================================
 * STATE MACHINE
 * MENU -> WAITING -> COUNTDOWN -> PLAYING <-> PAUSED
 * PLAYING -> GAMEOVER (all out) / WINNER (one left standing)
 * Any state -> MENU (B/Esc or from the end screens)
 * ============================================================ */
const State = { HOME: "home", MENU: "menu", NET_MENU: "netmenu", LOBBY: "lobby", WAITING: "waiting", COUNTDOWN: "countdown", PLAYING: "playing", PAUSED: "paused", GAMEOVER: "gameover", WINNER: "winner" };

let state = State.HOME;
let menuCount = 1;          // player count chosen in the menu (1-4)
const players = [];         // Player objects, one per slot (0..menuCount-1)
let countdownT = 0;         // ms remaining in the 3-2-1 countdown
let lastCdShown = -1;

/* ============================================================
 * ONLINE STATE (Tetris 99-style garbage attack)
 * online=true when this client is in a networked match. The server is
 * authoritative for membership/ready/out/end; each client simulates its
 * own board and applies garbage rows it receives from rivals.
 * ============================================================ */
let online = false;
let mySlot = 0;             // this client's slot in the room
let roomCode = "";          // 4-char room code
let onlinePlayers = [];     // [{slot, name, ready, alive, isHost}] from the server
let onlineWinner = -1;      // slot of the winner (set on end)
let netConnected = false;   // WebSocket open
let netError = "";          // last error message to show in the lobby

/* ============================================================
 * PLAYER FACTORY — each player owns board, piece, bag, hold and score.
 * DOM/canvas refs (ctx, elScore, ...) are filled by buildColumns().
 * ============================================================ */
function makePlayer(slot) {
  return {
    slot,
    alive: true,
    ready: false,           // joined the match (WAITING screen)
    outAt: null,            // timestamp when this player went out
    board: emptyBoard(),
    piece: null,
    bag: [], queue: [], heldType: null, canHold: true,
    score: 0, level: 1, linesCleared: 0,
    gravAcc: 0, lockTimer: 0, clearing: null,
    // per-player effects (drawn on this player's own canvas)
    particles: [], popups: [],
    // DOM/canvas refs + sizing (filled by buildColumns)
    cell: CELL, miniCell: MINI_CELL, nextSlotH: 64,
    ctx: null, nextCtx: null, holdCtx: null,
    elScore: null, elLevel: null, elLines: null, elOutBadge: null, elPadDot: null,
  };
}

function emptyBoard() { return Array.from({ length: ROWS }, () => new Array(COLS).fill(null)); }

// Reset one player's game state (keeps DOM refs). Used at match start.
function resetPlayer(pl) {
  pl.alive = true; pl.ready = false; pl.outAt = null;
  pl.board = emptyBoard();
  pl.piece = null; pl.bag = []; pl.queue = []; pl.heldType = null; pl.canHold = true;
  pl.score = 0; pl.level = 1; pl.linesCleared = 0;
  pl.gravAcc = 0; pl.lockTimer = 0; pl.clearing = null;
  pl.particles.length = 0; pl.popups.length = 0;
  if (pl.elOutBadge) pl.elOutBadge.classList.add("hidden");
}

/* ============================================================
 * PER-PLAYER BOARD LOGIC
 * ============================================================ */
function pieceCells(piece) {
  const cells = [];
  const m = ROTATIONS[piece.type][piece.rot];
  for (let r = 0; r < m.length; r++)
    for (let c = 0; c < m[r].length; c++)
      if (m[r][c]) cells.push([piece.x + c, piece.y + r]);
  return cells;
}

function collidesAt(pl, cells) {
  for (const [x, y] of cells) {
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y >= 0 && pl.board[y][x]) return true;
  }
  return false;
}

function refillQueue(pl) {
  while (pl.queue.length < 3) {
    if (!pl.bag.length) pl.bag = shuffle(Object.keys(SHAPES));
    pl.queue.push(pl.bag.pop());
  }
}

function spawnPiece(pl) {
  refillQueue(pl);
  const type = pl.queue.shift();
  const piece = { type, x: spawnX(type), y: -1, rot: "0" };
  if (collidesAt(pl, pieceCells(piece))) {
    // Spawn blocked: this player is out. The match may end here.
    markOut(pl);
    return false;
  }
  pl.piece = piece;
  pl.canHold = true;
  pl.gravAcc = 0;
  pl.lockTimer = 0;
  drawNext(pl);
  return true;
}

// Central "player is out" path. Local: re-evaluate the match end.
// Online: tell the server (it is authoritative for who is out / match end).
function markOut(pl) {
  if (!pl.alive) return;
  pl.alive = false;
  pl.outAt = performance.now();
  pl.piece = null;
  if (pl.elOutBadge) pl.elOutBadge.classList.remove("hidden");
  if (online) sendOut();
  else checkMatchEnd();
}

function tryMove(pl, dx) {
  if (!pl.alive || !pl.piece || pl.clearing) return false;
  const cells = pieceCells({ ...pl.piece, x: pl.piece.x + dx });
  if (collidesAt(pl, cells)) return false;
  pl.piece.x += dx;
  pl.lockTimer = 0; // moving resets the lock delay
  return true;
}

function tryRotate(pl, dir) {
  if (!pl.alive || !pl.piece || pl.clearing) return;
  const piece = pl.piece;
  if (piece.type === "O") return; // O doesn't rotate
  const from = piece.rot;
  const to = ROT_ORDER[(ROT_ORDER.indexOf(from) + (dir > 0 ? 1 : 3)) % 4];
  const kicks = (piece.type === "I" ? KICKS_I : KICKS_JLSTZ)[from + to] || [[0, 0]];
  for (const [kx, ky] of kicks) {
    // Kick tables use +y up; canvas uses +y down -> flip y.
    const cells = pieceCells({ ...piece, rot: to, x: piece.x + kx, y: piece.y - ky });
    if (!collidesAt(pl, cells)) {
      piece.rot = to;
      piece.x += kx;
      piece.y -= ky;
      pl.lockTimer = 0;
      return;
    }
  }
}

function hardDrop(pl) {
  if (!pl.alive || !pl.piece || pl.clearing) return;
  let drop = 0;
  while (!collidesAt(pl, pieceCells({ ...pl.piece, y: pl.piece.y + 1 }))) { pl.piece.y++; drop++; }
  pl.score += drop * 2; // 2 points per cell dropped (guideline)
  hardDropDust(pl, pl.piece);
  triggerShake(3, 120);
  addPopup(pl, "+" + (drop * 2), COLS * pl.cell / 2, ROWS * pl.cell * 0.35, 26, "#9aa3b2");
  updateStats(pl);
  lockPiece(pl);
}

function doHold(pl) {
  if (!pl.alive || !pl.piece || pl.clearing || !pl.canHold) return;
  const cur = pl.piece.type;
  if (pl.heldType) {
    const swap = pl.heldType;
    pl.heldType = cur;
    pl.piece = { type: swap, x: spawnX(swap), y: -1, rot: "0" };
    if (collidesAt(pl, pieceCells(pl.piece))) { markOut(pl); return; }
  } else {
    pl.heldType = cur;
    spawnPiece(pl);
  }
  pl.canHold = false;
  drawHold(pl);
}

function lockPiece(pl) {
  const piece = pl.piece;
  if (!piece) return;
  collisionSparks(pl, piece);
  for (const [cx, cy] of pieceCells(piece))
    if (cy >= 0 && cy < ROWS) pl.board[cy][cx] = piece.type;
  pl.piece = null;

  const fullRows = [];
  for (let r = 0; r < ROWS; r++)
    if (pl.board[r].every(v => v !== null)) fullRows.push(r);

  if (fullRows.length) {
    // Hold the board frozen while the clear animation runs.
    pl.clearing = { rows: fullRows, t: 0 };
  } else {
    spawnPiece(pl);
  }
  updateStats(pl);
}

function finalizeClearing(pl) {
  const rows = pl.clearing.rows;
  for (const r of rows) {
    pl.board.splice(r, 1);
    pl.board.unshift(new Array(COLS).fill(null));
  }
  const n = rows.length;
  pl.score += LINE_SCORES[n] * pl.level;
  pl.linesCleared += n;
  pl.level = 1 + Math.floor(pl.linesCleared / 10);

  // Online: attack rivals with garbage rows equal to the lines cleared.
  if (online) {
    const rivals = players.filter(p => p.slot !== mySlot && p.alive).map(p => p.slot);
    let targets;
    if (n >= 4) targets = "all";
    else {
      // Pick up to n distinct rivals (shuffled so it's not always the same one).
      targets = shuffle(rivals.slice()).slice(0, n);
    }
    const garbageRows = [];
    for (let i = 0; i < n; i++) garbageRows.push(generateGarbageRow());
    sendGarbage(garbageRows, targets);
  }

  lineExplosion(pl, rows, n === 4);
  const labels = ["", "+100", "+300 DOUBLE!", "+500 TRIPLE!", "+800 TETRIS!"];
  addPopup(pl, (n > 1 ? labels[n] : "+" + LINE_SCORES[1]) , COLS * pl.cell / 2, ROWS * pl.cell * 0.3, n === 4 ? 34 : 26, n === 4 ? "#ffd60a" : "#ffffff");
  if (n >= 2) triggerShake(n === 4 ? 7 : 4, n === 4 ? 260 : 150);

  pl.clearing = null;
  spawnPiece(pl);
  updateStats(pl);
}

function dropInterval(pl) { return Math.max(1000 * 0.85 ** (pl.level - 1), 70); }

/* ============================================================
 * GARBAGE ATTACK (online, Tetris 99-style)
 * Clearing N lines sends N garbage rows to rivals:
 *   1 line -> 1 rival, 2 -> 2 rivals, 3 -> 3 rivals, 4 (Tetris) -> everyone.
 * A garbage row is 10 cells with a single T-junction: one gap at a random
 * column, with a block stacked on top of it.
 * ============================================================ */
function generateGarbageRow() {
  const row = new Array(COLS).fill("G");
  const gap = (Math.random() * COLS) | 0;
  row[gap] = null;
  return { row, gap };
}

// Apply received garbage rows to a player's board. Rows are pushed from the
// floor up. If any cell would land above the top of the board, the player is out.
function applyGarbage(pl, rows) {
  if (!pl || !pl.alive) return;
  for (const { row, gap } of rows) {
    // Push the row in at the bottom: shift everything up by one, place the row at the floor.
    const topRow = pl.board[0];
    if (topRow.some(v => v !== null)) {
      // Board is already full at the top: this garbage overflows -> out.
      markOut(pl);
      return;
    }
    pl.board.splice(0, 1); // drop the top row (it's empty, guaranteed above)
    pl.board.push(row.slice());
    // The T-junction block sits one row above the gap.
    const gapRow = pl.board[ROWS - 2];
    if (gapRow && gapRow[gap] === null) gapRow[gap] = "G";
  }
  // If the active piece now overlaps the new garbage, nudge it up until it fits.
  if (pl.piece) {
    let guard = 0;
    while (collidesAt(pl, pieceCells(pl.piece)) && guard++ < ROWS) pl.piece.y--;
    if (collidesAt(pl, pieceCells(pl.piece))) markOut(pl);
  }
}

// Compact board encoding for snapshots: 200 chars, one per cell (null -> ".").
function encodeBoard(board) {
  let s = "";
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) s += board[r][c] || ".";
  return s;
}

function decodeBoard(s) {
  const b = emptyBoard();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const ch = s[r * COLS + c];
      if (ch && ch !== ".") b[r][c] = ch;
    }
  return b;
}

// Send garbage to the server (relayed to the chosen targets). Called from
// finalizeClearing when online. targets: "all" or an array of rival slots.
function sendGarbage(rows, targets) {
  if (!online || !netConnected) return;
  sendNet({ t: "garbage", rows, targets });
}

// Called by net.js when a garbage message arrives from a rival.
function onGarbageReceived(from, rows) {
  const pl = players[mySlot];
  if (!pl) return;
  applyGarbage(pl, rows);
  // Visual feedback: a brief shake + popup on the local board.
  triggerShake(3, 120);
  addPopup(pl, "¡BASURA!", COLS * pl.cell / 2, ROWS * pl.cell * 0.5, 24, "#ff4d6d");
}

// Called by net.js when a rival is reported out by the server.
function onRivalOut(slot) {
  const pl = players[slot];
  if (pl && pl.alive) {
    pl.alive = false;
    pl.outAt = performance.now();
    pl.piece = null;
    if (pl.elOutBadge) pl.elOutBadge.classList.remove("hidden");
  }
}

// Called by net.js when the server declares the match over.
function onOnlineEnd(winnerSlot) {
  onlineWinner = winnerSlot;
  stopMusic();
  const winner = winnerSlot >= 0 ? players[winnerSlot] : null;
  state = winner ? State.WINNER : State.GAMEOVER;
  showEndScreen(winner ? "winner" : "gameover", winner);
}

// Build the local player array for an online match from the server's roster.
// Slot i maps to players[i]; the local client is players[mySlot].
function setupOnlineMatch() {
  online = true;
  players.length = 0;
  for (let i = 0; i < 4; i++) {
    const info = onlinePlayers.find(p => p.slot === i);
    const pl = makePlayer(i);
    pl.name = info ? info.name : ("P" + (i + 1));
    pl.remote = i !== mySlot; // remote players are rendered from snapshots
    players.push(pl);
  }
  buildColumns(4); // always 4 columns online (empty slots show as idle)
  for (const pl of players) resetPlayer(pl);
  shake.t = 0; shake.mag = 0;
  state = State.COUNTDOWN;
  countdownT = 3000;
  lastCdShown = -1;
  showCountdown();
  startMusic();
}

/* ============================================================
 * MATCH FLOW — menu, waiting, countdown, end screens
 * ============================================================ */
function changeMenuCount(delta) {
  if (state !== State.MENU) return;
  menuCount = Math.min(4, Math.max(1, menuCount + delta));
  refreshScreen(); // re-render the menu with the new count
}

function confirmMenu() {
  if (state !== State.MENU) return;
  resetSlotAssignment(); // fresh slot claims for this match
  players.length = 0;
  for (let i = 0; i < menuCount; i++) players.push(makePlayer(i));
  buildColumns(menuCount); // rebuild DOM/canvases sized for this player count
  state = State.WAITING;
  showWaiting();
}

// A player joins the match. When everyone is ready, start it.
function joinSlot(slot) {
  if (state !== State.WAITING || slot >= players.length) return;
  const pl = players[slot];
  if (pl.ready) return;
  pl.ready = true;
  showWaiting(); // refresh the slot list
  if (players.every(p => p.ready)) startMatch();
}

function startMatch() {
  for (const pl of players) resetPlayer(pl);
  shake.t = 0; shake.mag = 0;
  state = State.COUNTDOWN;
  countdownT = 3000; // 3-2-1, one second each
  lastCdShown = -1;
  showCountdown();
  startMusic(); // random track, plays from the countdown on
}

function updateCountdown(dtMs) {
  countdownT -= dtMs;
  const n = Math.max(0, Math.ceil(countdownT / 1000));
  if (n !== lastCdShown && n >= 1) { setCountdownNumber(n); lastCdShown = n; }
  if (countdownT <= 0) {
    hideScreen();
    state = State.PLAYING;
    for (const pl of players) spawnPiece(pl);
  }
}

function checkMatchEnd() {
  if (state !== State.PLAYING) return;
  const alive = players.filter(p => p.alive);
  if (alive.length === 0) endMatch(null);
  else if (players.length > 1 && alive.length === 1) endMatch(alive[0]);
}

function endMatch(winner) {
  stopMusic();
  state = winner ? State.WINNER : State.GAMEOVER;
  showEndScreen(winner ? "winner" : "gameover", winner);
}

function returnToMenu() {
  stopMusic();
  for (const pl of players) { pl.particles.length = 0; pl.popups.length = 0; }
  shake.t = 0; shake.mag = 0;
  if (online) { returnHome(); return; }
  resetSlotAssignment(); // clear slot claims for the next match
  state = State.MENU;
  showMenu(menuCount);
}

// Leave an online match (or the lobby) and go back to the home screen.
function returnHome() {
  stopMusic();
  for (const pl of players) { pl.particles.length = 0; pl.popups.length = 0; }
  shake.t = 0; shake.mag = 0;
  resetSlotAssignment();
  // Tell the server we're leaving the room (if in one) and stop auto-reconnect.
  if (roomCode) sendNet({ t: "leave" });
  closeNet();
  online = false;
  onlinePlayers = [];
  onlineWinner = -1;
  roomCode = "";
  mySlot = 0;
  netError = "";
  // Reset to a single idle board behind the home screen.
  players.length = 0;
  players.push(makePlayer(0));
  buildColumns(1);
  state = State.HOME;
  showHome();
}

function pauseGame() {
  if (state !== State.PLAYING) return;
  state = State.PAUSED;
  pauseMusic();
  showPaused();
}

function resumeGame() {
  if (state !== State.PAUSED) return;
  hideScreen();
  state = State.PLAYING;
  resumeMusic();
}
