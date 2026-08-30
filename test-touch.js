// test-touch.js — Verify touch controls: pad element, menu buttons, and
// pointer events on the pad don't throw. Inlines scripts like test-client.js.
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

// Canvas 2D stub
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

const errors = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://localhost/",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx2d(); };
    window.Audio = class { play() { return Promise.resolve(); } pause() {} };
    window.navigator.maxTouchPoints = 5; // simulate touch device
    window.addEventListener("error", (e) => errors.push(e.message));
  }
});

const G = (expr) => dom.window.eval(expr);
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ok - " + msg); }
  else { fail++; console.log("  FAIL - " + msg); }
}

setTimeout(() => {
  console.log("== Touch controls smoke test ==");

  // 1. Touchpad element exists in DOM
  const tp = dom.window.document.getElementById("touchpad");
  ok(!!tp, "touchpad element exists");
  ok(tp && tp.classList.contains("hidden"), "touchpad hidden by default");

  // 2. Touchpad has all expected buttons (real data-act values)
  if (tp) {
    const dirs = ["left", "right", "down"];
    const acts = ["rotateCCW", "rotateCW", "hardDrop", "hold"];
    for (const d of dirs) ok(!!tp.querySelector(`[data-act="${d}"]`), `pad has ${d} button`);
    for (const a of acts) ok(!!tp.querySelector(`[data-act="${a}"]`), `pad has ${a} button`);
    ok(!!tp.querySelector("#tpPause"), "pad has pause button");
  }

  // 3. Navigate HOME -> MENU and check menu buttons
  G("dispatchAction(0, 'Enter')"); // HOME -> MENU
  const doc = dom.window.document;
  ok(!!doc.getElementById("menuDec"), "menu has menuDec button");
  ok(!!doc.getElementById("menuInc"), "menu has menuInc button");
  ok(!!doc.getElementById("menuStart"), "menu has menuStart button");
  ok(!!doc.getElementById("menuCountEl"), "menu has menuCountEl label");

  // 4. Tap menuInc to change player count
  const before = G("menuCount");
  doc.getElementById("menuInc").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  ok(G("menuCount") === before + 1, "tapping menuInc increments player count");

  // 5. Tap menuStart -> WAITING
  doc.getElementById("menuStart").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  ok(G("state") === "waiting", "tapping menuStart -> WAITING (got: " + G("state") + ")");

  // 6. WAITING has joinBtn-N buttons (one per not-ready slot)
  const joinBtns = doc.querySelectorAll(".slot-join-btn");
  ok(joinBtns.length >= 1, "WAITING has join buttons (" + joinBtns.length + ")");
  ok(!!doc.getElementById("waitBack"), "WAITING has waitBack button");

  // 7. Tap joinBtn-0 for slot 0
  const jb0 = doc.getElementById("joinBtn-0");
  if (jb0) {
    jb0.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    ok(G("players[0].ready") === true, "tapping joinBtn-0 marks slot 0 ready");
  }

  // 8. Start the match (all ready) -> countdown -> playing, then check touchpad
  //    visibility: hidden by default, shown via the top-left toggle, and the
  //    board zooms to 80% while the pad is open.
  G("players.forEach(p => p.ready = true); startMatch();");
  // Let the loop run a few frames to transition countdown -> playing
  setTimeout(() => {
    const st = G("state");
    console.log("  (state after startMatch: " + st + ")");
    // Force into PLAYING to test pad visibility logic directly
    G("state = 'playing'");
    G("updateTouchpad()");
    ok(tp.classList.contains("hidden"), "touchpad hidden by default during PLAYING");
    ok(!dom.window.document.body.classList.contains("pad-open"), "no pad-open zoom while pad hidden");

    // 8b. Toggle button exists (top-left) and shows the pad
    const toggle = doc.getElementById("tpToggle");
    ok(!!toggle, "toggle button exists (top-left)");
    if (toggle) {
      toggle.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      G("updateTouchpad()");
      ok(!tp.classList.contains("hidden"), "touchpad visible after toggle (PLAYING)");
      ok(dom.window.document.body.classList.contains("pad-open"), "body.pad-open set -> 80% zoom");
      // Board scale must be smaller with the pad open than with it closed
      const scaleOpen = G("boardCellScale(players.length)");
      toggle.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      G("updateTouchpad()");
      const scaleClosed = G("boardCellScale(players.length)");
      ok(scaleOpen < scaleClosed, "board zooms to 80% with pad open (" + scaleOpen + " < " + scaleClosed + ")");
      ok(tp.classList.contains("hidden"), "touchpad hidden again after second toggle");
      // Re-open for the pointer-event checks below
      toggle.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      G("updateTouchpad()");
    }
    // And hidden again when we leave play (even if the user had it on)
    G("state = 'menu'");
    G("updateTouchpad()");
    ok(tp.classList.contains("hidden"), "touchpad hidden back in MENU");

    // 9. Simulate pointerdown/pointerup on pad buttons (no throw)
    const leftBtn = tp.querySelector('[data-act="left"]');
    try {
      leftBtn.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      leftBtn.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
      ok(true, "pointerdown/up on pad left: no throw");
    } catch (e) {
      ok(false, "pointerdown/up on pad left threw: " + e.message);
    }
    const dropBtn = tp.querySelector('[data-act="hardDrop"]');
    try {
      dropBtn.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      dropBtn.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
      ok(true, "pointerdown/up on pad hardDrop: no throw");
    } catch (e) {
      ok(false, "pointerdown/up on pad hardDrop threw: " + e.message);
    }

    // 10. Check no runtime errors accumulated
    ok(errors.length === 0, "no runtime errors (got: " + errors.join("; ") + ")");

    console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
    process.exit(fail ? 1 : 0);
  }, 300);
}, 300);
