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
html = html.replace(/<script src="(javascript\/[^\"]+)"><\/script>/g, (m, src) => {
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

// ---- 1. boardCellScale behavior ----
const s2 = window.eval("boardCellScale(2)");
ok(s2 < 1, `boardCellScale(2) on 390x844 = ${s2.toFixed(3)} < 1 (board shrinks)`);
const s4 = window.eval("boardCellScale(4)");
ok(s4 === 1, `boardCellScale(4) on 390x844 = ${s4} (fits, no shrink)`);

// Small phone 360x640: strong shrink
Object.defineProperty(window, "innerWidth", { value: 360, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 640, configurable: true });
const s2small = window.eval("boardCellScale(2)");
ok(s2small < 0.7, `boardCellScale(2) on 360x640 = ${s2small.toFixed(3)} < 0.7 (strong shrink)`);

// Desktop: no shrink
Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
const sDesk = window.eval("boardCellScale(2)");
ok(sDesk === 1, `boardCellScale(2) on desktop = ${sDesk} (no shrink)`);

// Back to mobile for the buildColumns check
Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });

// ---- 2. buildColumns produces smaller canvases on mobile ----
window.eval("buildColumns(2)");
const boardW = document.getElementById("board-0").width;
const boardH = document.getElementById("board-0").height;
// dpr=1 in jsdom. Mobile 2P: cell = floor(27 * 0.97) = 26 -> 260x520. Desktop: 270x540.
ok(boardW < 270, `mobile board width ${boardW} < desktop 270 (scaled down)`);
ok(boardH < 540, `mobile board height ${boardH} < desktop 540 (scaled down)`);
ok(boardH >= 240, `mobile board height ${boardH} >= 240 (still playable)`);

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

// ---- 4. CSS: D-pad is a flex row (no absolute positioning) ----
ok(/\.tp-dpad \{ display: flex; gap: 8px; \}/.test(css), "CSS: .tp-dpad is a flex row (no overlap)");
ok(!/\.tp-dpad \.tp-left\s*\{[^}]*position: absolute/.test(css), "CSS: .tp-left NOT absolutely positioned");
ok(!/\.tp-dpad \.tp-right\s*\{[^}]*position: absolute/.test(css), "CSS: .tp-right NOT absolutely positioned");
ok(/touch-action: manipulation/.test(css), "CSS: body has touch-action: manipulation");
ok(/min-height: 100dvh/.test(css), "CSS: mobile uses 100dvh (address bar aware)");
ok(/user-scalable=no/.test(html), "HTML: viewport has user-scalable=no");

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
