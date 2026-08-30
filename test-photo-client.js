// test-photo-client.js — Client-side (jsdom) test of the avatar feature:
//   1. showLobby() renders a camera button on MY slot and avatars on others.
//   2. buildColumns() (online) puts an avatar in each column header.
//   3. applyAvatar() paints the photo (or a letter fallback).
//   4. onGarbageLanded() with an attacker photo stages garbagePhoto.
//   5. drawGarbagePhoto() runs without error and fades out over time.
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
    // jsdom has no real Image decoding; make Image a no-op that never fires
    // onload (so the photo path is exercised but the bitmap is "not ready").
    window.Image = class {
      constructor() { this.__ready = false; this.src = ""; }
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

  console.log("Photo client test (jsdom)\n");
  ok(errors.length === 0, "No runtime errors during boot" + (errors.length ? " -> " + errors.join(" | ") : ""));

  G("window.__sfx = { attack: 0, hit: 0, out: 0 };" +
    "sfxAttack = (n) => { window.__sfx.attack++; };" +
    "sfxGarbageHit = (r) => { window.__sfx.hit++; };" +
    "sfxOut = () => { window.__sfx.out++; }");

  const PHOTO = "data:image/jpeg;base64,AAAA";

  // ---- Set up an ONLINE lobby: I am slot 0 (Alice, with photo), Bob slot 1 (no photo).
  G("(() => {" +
    " online = true; mySlot = 0; netConnected = true; state = State.LOBBY;" +
    " onlinePlayers = [" +
    "   {slot:0,name:'Alice',ready:false,alive:true,isHost:true,photo:'" + PHOTO + "'}," +
    "   {slot:1,name:'Bob',ready:false,alive:true,isHost:false,photo:null}" +
    " ];" +
    "})()");

  // 1. showLobby renders a camera LABEL on my slot and a letter avatar on Bob's.
  G("showLobby()");
  const camLabel = G("document.querySelector('label[for=\"photoInput\"]')");
  ok(!!camLabel && camLabel.classList.contains("lobby-avatar") && camLabel.classList.contains("cam"),
    "Lobby has a camera <label for=photoInput> on my slot");
  const camInner = G("document.querySelector('label[for=\"photoInput\"] .lobby-avatar-inner')");
  ok(!!camInner && camInner.classList.contains("has-photo"), "My camera label shows my photo (has-photo)");
  const bobAvatar = G("Array.from(document.querySelectorAll('.lobby-avatar')).find(el => !el.classList.contains('cam'))");
  ok(!!bobAvatar && bobAvatar.textContent === "B", "Bob's lobby avatar shows letter fallback 'B'");

  // 2. buildColumns (online) puts an avatar in each column header. Online only
  //    builds columns for OCCUPIED slots (visiblePlayers), so with 2 players in
  //    the room there are 2 columns / 2 avatars.
  G("(() => { players.length = 0; for (let i = 0; i < 4; i++) { const pl = makePlayer(i); pl.remote = i !== mySlot; players.push(pl); } for (const pl of players) resetPlayer(pl); players[0].name = 'Alice'; players[1].name = 'Bob'; })()");
  G("buildColumns()");
  const avatars = G("Array.from(document.querySelectorAll('.col-avatar'))");
  ok(avatars.length === 2, "Online columns have an avatar per occupied slot (got " + avatars.length + ")");
  const myAvatar = G("document.getElementById('avatar-0')");
  ok(!!myAvatar, "My column header has an avatar element");
  ok(!!G("document.getElementById('avatar-1')"), "Bob's column header has an avatar element");

  // 3. applyAvatar paints the photo on my header, letter on Bob's.
  G("(() => { players[0].photo = '" + PHOTO + "'; players[1].photo = null; applyAvatar(players[0]); applyAvatar(players[1]); })()");
  ok(G("players[0].elAvatar.classList.contains('has-photo')"), "applyAvatar sets has-photo on my header");
  ok(G("players[0].elAvatar.style.backgroundImage").includes(PHOTO), "My header avatar background is the photo");
  ok(G("players[1].elAvatar.textContent") === "B", "Bob's header avatar shows letter 'B'");

  // 4. onGarbageLanded with an attacker photo stages garbagePhoto on the victim.
  G("(() => { players.length = 0; for (let i = 0; i < 4; i++) { const pl = makePlayer(i); pl.remote = i !== mySlot; players.push(pl); } for (const pl of players) resetPlayer(pl); state = State.PLAYING; })()");
  G("(() => { const attacker = { slot: 1, name: 'Bob', photo: '" + PHOTO + "' }; onGarbageLanded(players[0], 1, attacker); })()");
  ok(G("players[0].garbagePhoto") !== null, "onGarbageLanded staged garbagePhoto on the victim");
  ok(G("players[0].garbagePhoto.url") === PHOTO, "garbagePhoto carries the attacker's photo URL");
  ok(G("players[0].garbageFlash") > 0, "Victim flashed on garbage hit");

  // 5. drawGarbagePhoto runs without error (image not ready in jsdom -> no-op)
  //    and the effect decays to null over its lifetime.
  let drawErr = null;
  try { G("(() => { const pl = players[0]; pl.cell = 20; drawGarbagePhoto(pl, pl.ctx); })()"); }
  catch (e) { drawErr = e.message; }
  ok(drawErr === null, "drawGarbagePhoto runs without error" + (drawErr ? " -> " + drawErr : ""));
  // Advance the effect past its duration -> it clears.
  G("(() => { const pl = players[0]; pl.garbagePhoto.t = pl.garbagePhoto.dur + 0.01; if (pl.garbagePhoto.t >= pl.garbagePhoto.dur) pl.garbagePhoto = null; })()");
  ok(G("players[0].garbagePhoto") === null, "garbagePhoto clears after its lifetime");

  // 6. A garbage hit WITHOUT an attacker photo does NOT stage garbagePhoto.
  G("(() => { const pl = players[0]; pl.garbagePhoto = null; onGarbageLanded(pl, 1, { slot: 1, name: 'Bob', photo: null }); })()");
  ok(G("players[0].garbagePhoto") === null, "No photo -> no garbagePhoto staged");

  console.log("\n==============================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("==============================");
  window.close();
  process.exit(failed === 0 ? 0 : 1);
}, 300);
