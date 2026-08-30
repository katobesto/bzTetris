// test-mobile.js — Verify mobile layout fixes:
//  1. boardCellScale() shrinks the board on narrow viewports (not on desktop)
//  2. buildColumns() produces smaller canvases on mobile (room for the pad)
//  3. Zoom prevention: gesturestart/dblclick handlers preventDefault
//  4. D-pad is a horizontal flex row (no absolute-positioned overlap) — CSS
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label); }
}

const ROOT = __dirname;
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "css/style.css"), "utf8");

// Inline every <script src="javascript/x.js"> so jsdom executes them in order
// with a shared global lexical scope (like a real browser).
html = html.replace(/<script src="(javascript\/[^"\?]+)[^"]*"><\/script>/g, (m, src) => {
  const code = fs.readFileSync(path.join(ROOT, src), "utf8");
  return "<script>\n" + code + "\n</script>";
});

// ---- Canvas 2D stub ----
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

// ---- Mobile viewport: iPhone 14 (390x844) ----
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://localhost/",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () {
      return makeCtx2d();
    };
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
    window.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} };
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  },
});
const { window } = dom;
const { document } = window;

// ---- 1. boardCellScale behavior (fits BOTH visible height AND width) ----
// iPhone 14 portrait (390x844): two boards side by side (716px) don't fit the
// 390px width -> width-limited shrink (this is the new behavior).
const s2 = window.eval("boardCellScale(2)");
ok(s2 < 1, `boardCellScale(2) on 390x844 = ${s2.toFixed(3)} < 1 (width-limited, 2 boards don't fit 390px)`);
// Fewer players = wider boards: 2 players scale bigger than 4 on the same phone.
const s4 = window.eval("boardCellScale(4)");
ok(s2 > s4, `fewer players = bigger boards: 2p ${s2.toFixed(3)} > 4p ${s4.toFixed(3)}`);

// Small phone 360x640: still shrinks (both height and width are tight).
Object.defineProperty(window, "innerWidth", { value: 360, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 640, configurable: true });
const s2small = window.eval("boardCellScale(2)");
ok(s2small < 1, `boardCellScale(2) on 360x640 = ${s2small.toFixed(3)} < 1 (shrinks)`);

// Tablet in LANDSCAPE (1024x768) with OS bars eating the visible area:
// window.innerHeight is 768 but visualViewport reports only 640 visible.
// Width is plenty (1024), so the SHORT VISIBLE HEIGHT is the constraint.
Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
window.visualViewport = { width: 1024, height: 640 };
const sTab = window.eval("boardCellScale(2)");
ok(sTab < 1, `boardCellScale(2) on 1024x768 tablet (640 visible) = ${sTab.toFixed(3)} < 1 (height-limited, fits visible area)`);
// Without the OS bars (full 768 visible) the board fits -> no shrink.
window.visualViewport = { width: 1024, height: 768 };
const sTabFull = window.eval("boardCellScale(2)");
ok(sTabFull === 1, `boardCellScale(2) on 1024x768 tablet (full) = ${sTabFull} (fits)`);

// Desktop: no shrink (both dimensions have room).
Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
window.visualViewport = null;
const sDesk = window.eval("boardCellScale(2)");
ok(sDesk === 1, `boardCellScale(2) on desktop = ${sDesk} (no shrink)`);

// 80% zoom when the pad is open. Use a wide-but-short viewport so HEIGHT is
// the limiter (not width), so the pad's 80% zoom is what changes the scale.
Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 640, configurable: true });
window.visualViewport = null;
document.body.classList.add("pad-open");
const sPad = window.eval("boardCellScale(2)");
document.body.classList.remove("pad-open");
const sNoPad = window.eval("boardCellScale(2)");
ok(sPad < sNoPad, `pad-open zoom: ${sPad.toFixed(3)} < ${sNoPad.toFixed(3)} (80% zoom applied)`);

// ---- 2. buildColumns produces smaller canvases when the board must shrink ----
// Local boot has one placeholder player (slot 0). On desktop it fits at full
// size: cell 30 -> board 300x600.
Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
window.eval("buildColumns()");
const boardW = document.getElementById("board-0").width;
const boardH = document.getElementById("board-0").height;
ok(boardW === 300, `desktop 1p board width ${boardW} === 300 (full size)`);
ok(boardH === 600, `desktop 1p board height ${boardH} === 600 (full size)`);

// ---- 2b. Online: only the slots that have a player get a column ----
// 4 slots exist but only 2 are filled -> only board-0 and board-1 render.
window.eval(`
  online = true;
  onlinePlayers = [{ slot: 0, name: "A" }, { slot: 1, name: "B" }];
  players.length = 0;
  for (let i = 0; i < 4; i++) players.push(makePlayer(i));
  buildColumns();
`);
ok(!!document.getElementById("board-0"), "online 2/4: board-0 rendered (present player)");
ok(!!document.getElementById("board-1"), "online 2/4: board-1 rendered (present player)");
ok(!document.getElementById("board-2"), "online 2/4: board-2 NOT rendered (empty slot)");
ok(!document.getElementById("board-3"), "online 2/4: board-3 NOT rendered (empty slot)");
// Reset to local single-player state.
window.eval(`
  online = false; onlinePlayers = [];
  players.length = 0; players.push(makePlayer(0));
  buildColumns();
`);

// ---- 3. Zoom prevention handlers ----
let prevented = 0;
const origPrevent = window.Event.prototype.preventDefault;
window.Event.prototype.preventDefault = function () { prevented++; origPrevent.call(this); };
try {
  document.dispatchEvent(new window.Event("gesturestart"));
  document.dispatchEvent(new window.Event("dblclick"));
} catch (e) {
  ok(false, "zoom prevention handlers throw: " + e.message);
}
window.Event.prototype.preventDefault = origPrevent;
ok(prevented >= 2, `zoom prevention: gesturestart+dblclick prevented (${prevented} calls)`);

// ---- 4. CSS: D-pad = [left][right] row with [down] below; toggle top-left ----
ok(/\.tp-dpad \{ display: flex; flex-direction: column; align-items: center; gap: 8px; \}/.test(css), "CSS: .tp-dpad is a centered column (row + down below)");
ok(/\.tp-dpad-row \{ display: flex; gap: 8px; \}/.test(css), "CSS: .tp-dpad-row holds left+right side by side");
ok(!/\.tp-dpad \.tp-left\s*\{[^}]*position: absolute/.test(css), "CSS: .tp-left NOT absolutely positioned");
ok(!/\.tp-dpad \.tp-right\s*\{[^}]*position: absolute/.test(css), "CSS: .tp-right NOT absolutely positioned");
ok(/\.tp-toggle \{/.test(css) && /left: 10px/.test(css), "CSS: .tp-toggle exists, top-left");
ok(/body\.tp-on-touch \.tp-toggle \{ display: block; \}/.test(css), "CSS: toggle only shown on touch devices");
ok(/touch-action: manipulation/.test(css), "CSS: body has touch-action: manipulation");
ok(/min-height: 100dvh/.test(css), "CSS: mobile uses 100dvh (address bar aware)");
ok(/user-scalable=no/.test(html), "HTML: viewport has user-scalable=no");
ok(/id="tpToggle"/.test(html), "HTML: toggle button in markup");
ok(/tp-dpad-row/.test(html), "HTML: D-pad row (left+right) in markup");

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
