// test-garbage.js — Verify the garbage system in LOCAL multiplayer:
// clearing lines fires garbage at rivals (applied directly, no server),
// with sound hooks + visual feedback (flash, popup), and garbage can
// eliminate a player.
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = __dirname;
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
html = html.replace(/<script src="(javascript\/[^\"]+)"><\/script>/g, (m, src) => {
  const code = fs.readFileSync(path.join(ROOT, src), "utf8");
  return "<script>\n" + code + "\n</script>";
});

const errors = [];
function makeCtx2d() {
  const noop = () => {};
  const store = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop === "canvas") return {};
      if (prop === "measureText") return () => ({ width: 10 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient")
        return () => ({ addColorStop: noop });
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof prop === "string" && !(prop in t)) t[prop] = noop;
      return t[prop];
    },
    set(t, prop, v) { t[prop] = v; return true; }
  });
}

const dom = new JSDOM(html, {
  url: "http://localhost:3000/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function (type) {
      return type === "2d" ? makeCtx2d() : null;
    };
    // jsdom doesn't implement HTMLMediaElement.play() — stub it to return a
    // Promise (music.js calls .play().catch(...)).
    window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    window.HTMLMediaElement.prototype.pause = function () { return Promise.resolve(); };
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
    window.AudioContext = class {
      constructor() { this.destination = {}; this.currentTime = 0; this.state = "running"; }
      createGain() { return { gain: { value: 0, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }; }
      createOscillator() { return { type: "sine", frequency: { value: 0, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {}, start: () => {}, stop: () => {} }; }
      createBuffer() { return { getChannelData: () => new Float32Array(0) }; }
      resume() { return Promise.resolve(); }
    };
    window.addEventListener("error", (e) => {
      errors.push(e.message + " @ " + (e.filename || "inline") + ":" + (e.lineno || ""));
    });
  }
});
const { window } = dom;
const G = (expr) => window.eval(expr);

setTimeout(() => {
  let passed = 0, failed = 0;
  const ok = (c, label) => { if (c) { passed++; console.log("  PASS  " + label); } else { failed++; console.log("  FAIL  " + label); } };

  console.log("Local garbage test (jsdom)\n");
  ok(errors.length === 0, "No runtime errors during boot" + (errors.length ? " -> " + errors.join(" | ") : ""));

  // Instrument the SFX hooks to verify they fire.
  G("window.__sfx = { attack: 0, hit: 0, out: 0 };" +
    "sfxAttack = (n) => { window.__sfx.attack++; window.__sfx.lastAttackN = n; };" +
    "sfxGarbageHit = (r) => { window.__sfx.hit++; window.__sfx.lastHitRows = r; };" +
    "sfxOut = () => { window.__sfx.out++; }");

  // Set up a 2-player LOCAL match.
  G("dispatchAction(0, 'left')");   // home -> Local Play
  G("dispatchAction(0, 'Enter')");  // open local menu
  G("dispatchAction(0, 'right')");  // 1 -> 2 players
  G("dispatchAction(0, 'Enter')");  // confirm -> WAITING
  ok(G("state") === "waiting", "Local 2P match in WAITING (got: " + G("state") + ")");
  ok(G("players.length") === 2, "Two local players");
  ok(G("online") === false, "online=false (local mode)");

  G("joinSlot(0); joinSlot(1)"); // both ready -> startMatch -> COUNTDOWN
  ok(G("state") === "countdown", "Both ready -> COUNTDOWN (got: " + G("state") + ")");

  // Skip the countdown and spawn pieces.
  G("state = State.PLAYING; for (const pl of players) spawnPiece(pl)");

  // ---- TEST 1: single line clear fires 1 garbage row at the rival ----
  // I piece at rot "0" is horizontal at matrix row 1 -> cells at cols x..x+3, row y+1.
  // Place at x=3, y=ROWS-2 -> fills cols 3,4,5,6 of the bottom row (ROWS-1).
  G("(() => { const pl = players[0]; pl.board = emptyBoard();" +
    " for (let c = 0; c < COLS; c++) if (c < 3 || c > 6) pl.board[ROWS-1][c] = 'J';" +
    " pl.piece = { type: 'I', x: 3, y: ROWS-2, rot: '0' }; })()");
  const ROWS = G("ROWS");
  const cells = G("pieceCells(players[0].piece).map(c => c.join(',')).join(';')");
  ok(cells.split(";").every(s => s.endsWith("," + (ROWS - 1))), "I piece cells land on bottom row (cells: " + cells + ")");

  G("lockPiece(players[0])");
  ok(G("players[0].clearing !== null"), "Line clear animation started");
  G("finalizeClearing(players[0])");

  const p1 = G("players[1]");
  const bottom = G("players[1].board[ROWS-1].join('')");
  ok(bottom.includes("G"), "P1 bottom row now has garbage (row: " + bottom + ")");
  const gapCount = G("players[1].board[ROWS-1].filter(v => v === null).length");
  ok(gapCount === 1, "Garbage row has exactly one gap (got " + gapCount + ")");
  const tBlock = G("players[1].board[ROWS-2].filter(v => v === 'G').length");
  ok(tBlock === 1, "T-junction block placed above the gap (got " + tBlock + ")");
  ok(p1.garbageFlash > 0, "P1 garbageFlash triggered (got " + p1.garbageFlash + ")");
  ok(p1.popups.some(p => p.text === "¡BASURA!"), "P1 shows '¡BASURA!' popup");
  ok(G("window.__sfx.attack") === 1, "sfxAttack fired for the attacker (got " + G("window.__sfx.attack") + ")");
  ok(G("window.__sfx.lastAttackN") === 1, "sfxAttack got 1 line (got " + G("window.__sfx.lastAttackN") + ")");
  ok(G("window.__sfx.hit") === 1, "sfxGarbageHit fired for the victim (got " + G("window.__sfx.hit") + ")");
  ok(G("players[0].linesCleared") === 1, "P0 linesCleared = 1");

  // ---- TEST 2: Tetris (4 lines) fires garbage at ALL rivals ----
  // Vertical I at rot "R" occupies matrix column 2 -> at x=3 that's board col 5.
  // Place at x=3, y=ROWS-4 -> fills col 5, rows ROWS-4..ROWS-1.
  G("(() => { const pl = players[0]; pl.board = emptyBoard();" +
    " for (let r = ROWS-4; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (c !== 5) pl.board[r][c] = 'J';" +
    " pl.piece = { type: 'I', x: 3, y: ROWS-4, rot: 'R' }; })()");
  const vCells = G("pieceCells(players[0].piece).map(c => c.join(',')).join(';')");
  ok(vCells.split(";").every(s => s.startsWith("5,")), "Vertical I piece in col 5 (cells: " + vCells + ")");
  G("lockPiece(players[0]); finalizeClearing(players[0])");
  ok(G("players[0].linesCleared") === 5, "P0 linesCleared = 5 (1 + 4)");
  ok(G("window.__sfx.lastAttackN") === 4, "sfxAttack got 4 lines for Tetris (got " + G("window.__sfx.lastAttackN") + ")");
  const p1Rows = G("players[1].board.filter(r => r.some(v => v === 'G')).length");
  ok(p1Rows >= 4, "P1 received 4 garbage rows from Tetris (got " + p1Rows + " rows with G)");

  // ---- TEST 3: garbage can eliminate a player (overflow) ----
  G("(() => { const pl = players[1]; pl.board = emptyBoard();" +
    " for (let c = 0; c < COLS; c++) pl.board[0][c] = 'J'; })()"); // top row full
  G("(() => { const pl = players[0]; pl.board = emptyBoard();" +
    " for (let c = 0; c < COLS; c++) if (c < 3 || c > 6) pl.board[ROWS-1][c] = 'J';" +
    " pl.piece = { type: 'I', x: 3, y: ROWS-2, rot: '0' }; })()");
  G("lockPiece(players[0]); finalizeClearing(players[0])");
  ok(G("players[1].alive") === false, "P1 eliminated by garbage overflow");
  ok(G("window.__sfx.out") >= 1, "sfxOut fired on elimination (got " + G("window.__sfx.out") + ")");
  ok(G("state") === "winner", "Match ends with a winner (got: " + G("state") + ")");

  console.log("\n==============================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("==============================");
  window.close();
  process.exit(failed === 0 ? 0 : 1);
}, 300);
