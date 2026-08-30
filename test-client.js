// test-client.js — Smoke test: load index.html in jsdom with all scripts inlined
// (so top-level let/const share the global lexical scope, exactly like a real
// browser), run them, and verify the client boots to HOME and can navigate to
// the online menu and create a room against the REAL server on :3000.
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = __dirname;
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// Inline every <script src="javascript/x.js"> so jsdom executes them in order
// with a shared global lexical scope (like a real browser).
html = html.replace(/<script src="(javascript\/[^"\?]+)[^"]*"><\/script>/g, (m, src) => {
  const code = fs.readFileSync(path.join(ROOT, src), "utf8");
  return "<script>\n" + code + "\n</script>";
});

const errors = [];

// ---- Canvas 2D stub (jsdom has no canvas implementation) ----
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

// ---- WebSocket stub backed by the REAL server (ws module) ----
const RealWS = require("ws");
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._real = new RealWS(url);
    this._real.on("open", () => { this.readyState = 1; this.onopen && this.onopen(); });
    this._real.on("message", (buf) => { this.onmessage && this.onmessage({ data: buf.toString() }); });
    this._real.on("close", () => { this.readyState = 3; this.onclose && this.onclose(); });
    this._real.on("error", () => { this.onerror && this.onerror(); });
  }
  send(d) { if (this._real.readyState === 1) this._real.send(d); }
  close() { this._real.close(); }
}

const dom = new JSDOM(html, {
  url: "http://localhost:3000/",
  runScripts: "dangerously",
  pretendToBeVisual: true, // requestAnimationFrame
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function (type) {
      return type === "2d" ? makeCtx2d() : null;
    };
    window.WebSocket = FakeWebSocket;
    window.AudioContext = class {
      constructor() { this.destination = {}; this.currentTime = 0; this.state = "running"; }
      createGain() { return { gain: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {}, disconnect: () => {} }; }
      createOscillator() { return { type: "sine", frequency: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: () => {}, start: () => {}, stop: () => {} }; }
      createBuffer() { return { getChannelData: () => new Float32Array(0) }; }
      resume() { return Promise.resolve(); }
      suspend() { return Promise.resolve(); }
    };
    window.addEventListener("error", (e) => {
      errors.push(e.message + " @ " + (e.filename || "inline") + ":" + (e.lineno || ""));
    });
  }
});
const { window } = dom;
// Top-level let/const live in the global lexical scope, not on window — read via eval.
const G = (expr) => window.eval(expr);

setTimeout(() => {
  const doc = window.document;
  let passed = 0, failed = 0;
  const ok = (c, label) => { if (c) { passed++; console.log("  PASS  " + label); } else { failed++; console.log("  FAIL  " + label); } };

  console.log("Client smoke test (jsdom + real server on :3000)\n");
  ok(errors.length === 0, "No runtime errors during boot" + (errors.length ? " -> " + errors.join(" | ") : ""));
  ok(G("state") === "home", "Boots to HOME state (got: " + G("state") + ")");
  ok(G("screenKind") === "home", "Screen kind is 'home' (got: " + G("screenKind") + ")");
  const screenText = doc.getElementById("screen") ? doc.getElementById("screen").textContent : "";
  ok(/TETRIS/.test(screenText), "Home screen shows TETRIS title");
  ok(/Juego local/.test(screenText), "Home screen shows 'Juego local'");
  ok(/Juego online/.test(screenText), "Home screen shows 'Juego online'");
  ok(G("netConnected") === true, "WebSocket connected to server");
  ok(G("players.length") === 1, "One placeholder player behind home screen");

  // Navigate HOME -> NET_MENU via the same path the keyboard uses.
  // (left/down = Local Play, right/up = Online Play)
  G("dispatchAction(0, 'right')");
  ok(G("homeSelect") === 1, "Arrow-right moves home selection to Online Play");
  G("dispatchAction(0, 'Enter')");
  ok(G("state") === "netmenu", "Enter opens the online menu (got: " + G("state") + ")");
  const netText = doc.getElementById("screen") ? doc.getElementById("screen").textContent : "";
  ok(/Crear sala/i.test(netText), "Net menu shows create option");
  ok(/Unirse/i.test(netText), "Net menu shows join option");

  // Create a room from the client -> should land in LOBBY.
  G("createRoom('Tester')");
  setTimeout(() => {
    ok(G("state") === "lobby", "After createRoom, client is in LOBBY (got: " + G("state") + ")");
    ok(typeof G("roomCode") === "string" && G("roomCode").length === 4, "Room code received: " + G("roomCode"));
    ok(G("mySlot") === 0, "Client is slot 0 (host)");
    const lobbyText = doc.getElementById("screen") ? doc.getElementById("screen").textContent : "";
    ok(/Tester/.test(lobbyText), "Lobby shows the player name 'Tester'");

    G("setReady(true)");
    setTimeout(() => {
      ok(G("onlinePlayers.some(p => p.ready)"), "Ready state propagated to lobby roster");

      // ---- LOCAL MODE regression check (same-window multiplayer) ----
      // Leave the online lobby, go home, then drive the LOCAL menu:
      // pick 2 players and confirm -> WAITING screen with 2 slots.
      G("returnHome()");
      ok(G("state") === "home", "returnHome() back to HOME (got: " + G("state") + ")");
      G("dispatchAction(0, 'left')");   // selection -> Local Play
      G("dispatchAction(0, 'Enter')");  // open local menu
      ok(G("state") === "menu", "Local menu opened (got: " + G("state") + ")");
      G("dispatchAction(0, 'right')");  // 1 -> 2 players
      ok(G("menuCount") === 2, "Menu count set to 2 players");
      G("dispatchAction(0, 'Enter')");  // confirm -> WAITING
      ok(G("state") === "waiting", "Local match confirmed -> WAITING (got: " + G("state") + ")");
      ok(G("players.length") === 2, "Two local players created");
      ok(G("online") === false, "Local mode is NOT online (online=false)");

      console.log("\n==============================");
      console.log(`RESULT: ${passed} passed, ${failed} failed`);
      console.log("==============================");
      window.close();
      process.exit(failed === 0 ? 0 : 1);
    }, 400);
  }, 400);
}, 800);
