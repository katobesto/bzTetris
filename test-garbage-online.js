// test-garbage-online.js — Verify the ONLINE garbage path end-to-end:
// clearing lines fires garbage that is relayed to the server targeting ONLY
// occupied slots (empty slots are spectators and the server drops garbage
// aimed at them). Also verifies that a received garbage message is applied
// to the local player's board.
//
// This is the path the user actually sees in online play. The local path is
// covered by test-garbage.js.
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = __dirname;
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
html = html.replace(/<script src="(javascript\/[^"\?]+)[^"]*"><\/script>/g, (m, src) => {
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

  console.log("Online garbage test (jsdom)\n");
  ok(errors.length === 0, "No runtime errors during boot" + (errors.length ? " -> " + errors.join(" | ") : ""));

  // Instrument the SFX hooks (also avoids the jsdom AudioContext lacking
  // createBufferSource when real sfx code runs).
  G("window.__sfx = { attack: 0, hit: 0, out: 0 };" +
    "sfxAttack = (n) => { window.__sfx.attack++; };" +
    "sfxGarbageHit = (r) => { window.__sfx.hit++; };" +
    "sfxOut = () => { window.__sfx.out++; }");

  // ---- Set up a 2-player ONLINE match: slots 0 and 1 occupied, 2 and 3 empty.
  // This mirrors setupOnlineMatch(): players[] always has 4 entries (all alive),
  // but onlinePlayers only lists the occupied slots.
  G("(() => {" +
    " online = true; mySlot = 0; netConnected = true;" +
    " onlinePlayers = [{slot:0,name:'Alice',ready:true,alive:true,isHost:true},{slot:1,name:'Bob',ready:true,alive:true,isHost:false}];" +
    " players.length = 0;" +
    " for (let i = 0; i < 4; i++) { const pl = makePlayer(i); pl.remote = i !== mySlot; players.push(pl); }" +
    " for (const pl of players) resetPlayer(pl);" +
    " state = State.PLAYING;" +
    " for (const pl of players) spawnPiece(pl);" +
    "})()");
  ok(G("online") === true, "online=true");
  ok(G("players.length") === 4, "4 player mirrors (slots 0-3)");
  ok(G("onlinePlayers.length") === 2, "2 occupied slots in the room");
  ok(G("state") === "playing", "Match in PLAYING");

  // ---- Intercept sendNet to capture the garbage messages the client emits.
  G("window.__sent = []; sendNet = (msg) => { window.__sent.push(msg); };");

  // ---- TEST 1: single-line clear in a 2P online match must target ONLY slot 1.
  // I piece at rot "0" is horizontal at matrix row 1 -> cols x..x+3, row y+1.
  // Place at x=3, y=ROWS-2 -> fills cols 3,4,5,6 of the bottom row (ROWS-1).
  G("(() => { const pl = players[0]; pl.board = emptyBoard();" +
    " for (let c = 0; c < COLS; c++) if (c < 3 || c > 6) pl.board[ROWS-1][c] = 'J';" +
    " pl.piece = { type: 'I', x: 3, y: ROWS-2, rot: '0' }; })()");
  G("lockPiece(players[0]); finalizeClearing(players[0])");
  const g1 = G("window.__sent.find(m => m.t === 'garbage')");
  ok(!!g1, "Single-line clear emitted a garbage message");
  ok(g1 && g1.rows.length === 1, "1 line -> 1 garbage row (got " + (g1 && g1.rows.length) + ")");
  // THE BUG: before the fix, targets could be [2] or [3] (empty slots) and the
  // server would drop the garbage. After the fix, the only valid rival is slot 1.
  ok(g1 && Array.isArray(g1.targets) && g1.targets.length === 1 && g1.targets[0] === 1,
    "Single-line targets ONLY the occupied rival slot 1 (got " + JSON.stringify(g1 && g1.targets) + ")");
  ok(g1 && !(Array.isArray(g1.targets) && (g1.targets.includes(2) || g1.targets.includes(3))),
    "Single-line never targets empty slots 2/3");

  // ---- TEST 2: Tetris (4 lines) targets "all" (server fans out to occupied).
  G("window.__sent.length = 0");
  G("(() => { const pl = players[0]; pl.board = emptyBoard();" +
    " for (let r = ROWS-4; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (c !== 5) pl.board[r][c] = 'J';" +
    " pl.piece = { type: 'I', x: 3, y: ROWS-4, rot: 'R' }; })()");
  G("lockPiece(players[0]); finalizeClearing(players[0])");
  const g2 = G("window.__sent.find(m => m.t === 'garbage')");
  ok(!!g2, "Tetris emitted a garbage message");
  ok(g2 && g2.rows.length === 4, "4 lines -> 4 garbage rows (got " + (g2 && g2.rows.length) + ")");
  ok(g2 && g2.targets === "all", "Tetris targets 'all' (got " + JSON.stringify(g2 && g2.targets) + ")");

  // ---- TEST 3: 2-line clear targets exactly the occupied rival (slot 1), not 2/3.
  G("window.__sent.length = 0");
  // Two full rows: fill rows ROWS-1 and ROWS-2 except cols 4..5, drop an O piece
  // (2x2) at x=4, y=ROWS-2 -> completes cols 4,5 of BOTH rows -> 2 lines.
  G("(() => { const pl = players[0]; pl.board = emptyBoard();" +
    " for (const r of [ROWS-1, ROWS-2]) for (let c = 0; c < COLS; c++) if (c < 4 || c > 5) pl.board[r][c] = 'J';" +
    " pl.piece = { type: 'O', x: 4, y: ROWS-2, rot: '0' }; })()");
  G("lockPiece(players[0]); finalizeClearing(players[0])");
  const g3 = G("window.__sent.find(m => m.t === 'garbage')");
  ok(!!g3, "2-line clear emitted a garbage message");
  ok(g3 && g3.rows.length === 2, "2 lines -> 2 garbage rows (got " + (g3 && g3.rows.length) + ")");
  ok(g3 && Array.isArray(g3.targets) && g3.targets.length === 1 && g3.targets[0] === 1,
    "2-line targets the occupied rival slot 1 (got " + JSON.stringify(g3 && g3.targets) + ")");

  // ---- TEST 4: a received garbage message is applied to the local board.
  // Reset the local board, then deliver a garbage message from slot 1 (Bob).
  G("(() => { const pl = players[0]; pl.board = emptyBoard(); pl.piece = null; })()");
  G("(() => { const row = new Array(COLS).fill('G'); row[3] = null; onGarbageReceived(1, [{ row, gap: 3 }]); })()");
  const bottom = G("players[0].board[ROWS-1].join('')");
  ok(bottom.includes("G"), "Received garbage landed on the local bottom row (row: " + bottom + ")");
  const gapCount = G("players[0].board[ROWS-1].filter(v => v === null).length");
  ok(gapCount === 1, "Received garbage row has exactly one gap (got " + gapCount + ")");
  ok(G("players[0].garbageFlash") > 0, "Local player flashed on garbage hit");
  ok(G("players[0].popups.some(p => p.text === '¡BASURA!')"), "Local player shows '¡BASURA!' popup");

  console.log("\n==============================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("==============================");
  window.close();
  process.exit(failed === 0 ? 0 : 1);
}, 300);
