// core.js — Multiplayer game state machine and per-player Tetris engine (SRS, 7-bag, hold, scoring).

"use strict";

/* ============================================================
 * STATE MACHINE
 * MENU -> WAITING -> COUNTDOWN -> PLAYING <-> PAUSED
 * PLAYING -> GAMEOVER (all out) / WINNER (one left standing)
 * Any state -> MENU (B/Esc or from the end screens)
 * ============================================================ */
const State = { MENU: "menu", WAITING: "waiting", COUNTDOWN: "countdown", PLAYING: "playing", PAUSED: "paused", GAMEOVER: "gameover", WINNER: "winner" };

let state = State.MENU;
let menuCount = 1;          // player count chosen in the menu (1-4)
const players = [];         // Player objects, one per slot (0..menuCount-1)
let countdownT = 0;         // ms remaining in the 3-2-1 countdown
let lastCdShown = -1;

/* ============================================================
 * PLAYER FACTORY — each player owns board, piece, bag, hold and score.
 * DOM/canvas refs (ctx, elScore, ...) are filled by buildColumns().
 * ============================================================ */
function makePlayer(slot) {
  return {
    slot,
    alive: true,
    ready: false,           // joined the match (WAITING screen)
    source: "",             // "keyboard" | "pad" — how this player joined
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
  pl.alive = true; pl.ready = false; pl.source = ""; pl.outAt = null;
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
  const m = SHAPES[piece.type];
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
    pl.alive = false;
    pl.outAt = performance.now();
    pl.piece = null;
    if (pl.elOutBadge) pl.elOutBadge.classList.remove("hidden");
    checkMatchEnd();
    return false;
  }
  pl.piece = piece;
  pl.canHold = true;
  pl.gravAcc = 0;
  pl.lockTimer = 0;
  drawNext(pl);
  return true;
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
    const cells = pieceCells({ ...piece, x: piece.x + kx, y: piece.y - ky });
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
    if (collidesAt(pl, pieceCells(pl.piece))) { pl.alive = false; pl.outAt = performance.now(); pl.piece = null; checkMatchEnd(); return; }
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
 * MATCH FLOW — menu, waiting, countdown, end screens
 * ============================================================ */
function changeMenuCount(delta) {
  if (state !== State.MENU) return;
  menuCount = Math.min(4, Math.max(1, menuCount + delta));
  refreshScreen(); // re-render the menu with the new count
}

function confirmMenu() {
  if (state !== State.MENU) return;
  players.length = 0;
  for (let i = 0; i < menuCount; i++) players.push(makePlayer(i));
  buildColumns(menuCount); // rebuild DOM/canvases sized for this player count
  state = State.WAITING;
  showWaiting();
}

// A player joins the match. When everyone is ready, start it.
function joinSlot(slot, source) {
  if (state !== State.WAITING || slot >= players.length) return;
  const pl = players[slot];
  if (pl.ready) return;
  pl.ready = true;
  pl.source = source;
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
  if (n !== lastCdShown && n >= 1) setCountdownNumber(n);
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
  state = State.MENU;
  showMenu(menuCount);
}

function pauseGame() {
  if (state !== State.PLAYING) return;
  state = State.PAUSED;
  showPaused();
}

function resumeGame() {
  if (state !== State.PAUSED) return;
  hideScreen();
  state = State.PLAYING;
}
