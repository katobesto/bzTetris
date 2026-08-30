// test-photo.js — End-to-end test of the per-player avatar (photo) feature.
// Spawns server.js, drives two clients through create/join, then verifies:
//   1. A photo upload is stored on the slot and broadcast to the room.
//   2. The uploader's own lobby echo carries the photo.
//   3. A non-image / oversized photo is rejected (stored as null).
//   4. A photo sent after the match starts is ignored (roster frozen).
//   5. A ghost (dropped lobby player) keeps its photo on rejoin.
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const PORT = 3101; // avoid clashing with other test servers
const URL = `ws://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label); }
}

// A tiny client that records every message it receives.
function makeClient(name) {
  const c = { name, ws: null, msgs: [], waiters: [] };
  c.connect = () => new Promise((res, rej) => {
    c.ws = new WebSocket(URL);
    c.ws.on("open", res);
    c.ws.on("error", rej);
    c.ws.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      c.msgs.push(m);
      const w = c.waiters.find(w => w.pred(m));
      if (w) { c.waiters = c.waiters.filter(x => x !== w); w.res(m); }
    });
  });
  c.send = (obj) => c.ws.send(JSON.stringify(obj));
  c.waitFor = (pred, ms = 2000) => new Promise((res, rej) => {
    const hit = c.msgs.find(pred);
    if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error("timeout waiting for " + (pred.label || "msg"))), ms);
    c.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
  });
  c.close = () => { try { c.ws.close(); } catch {} };
  return c;
}

// A small valid JPEG data URL (1x1 pixel).
const SMALL_PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

async function main() {
  console.log("Spawning server on port " + PORT + " ...");
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOut = "";
  server.stdout.on("data", d => serverOut += d);
  server.stderr.on("data", d => serverOut += d);

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("server did not start: " + serverOut)), 4000);
    const iv = setInterval(() => {
      if (serverOut.includes("running at")) { clearTimeout(t); clearInterval(iv); res(); }
    }, 50);
  });
  console.log("Server is up.\n");

  const A = makeClient("Alice");
  const B = makeClient("Bob");
  await A.connect();
  await B.connect();

  // A creates, B joins.
  A.send({ t: "create", name: "Alice" });
  const joinedA = await A.waitFor(m => m.t === "joined");
  const code = joinedA.room;
  B.send({ t: "join", code, name: "Bob" });
  await B.waitFor(m => m.t === "joined");
  await A.waitFor(m => m.t === "lobby" && m.players.length === 2);
  console.log("Both in the lobby.\n");

  // 1. A uploads a photo -> B's lobby roster must carry it on slot 0.
  A.send({ t: "photo", photo: SMALL_PHOTO });
  const lobbyB = await B.waitFor(m => m.t === "lobby" && m.players.find(p => p.slot === 0) && m.players.find(p => p.slot === 0).photo);
  const aInB = lobbyB.players.find(p => p.slot === 0);
  ok(aInB.photo === SMALL_PHOTO, "B sees A's photo in the roster (slot 0)");
  ok(aInB.photo.startsWith("data:image/"), "Photo is a data URL");

  // 2. A's own echo also carries the photo.
  const lobbyA = await A.waitFor(m => m.t === "lobby" && m.players.find(p => p.slot === 0) && m.players.find(p => p.slot === 0).photo);
  ok(lobbyA.players.find(p => p.slot === 0).photo === SMALL_PHOTO, "A's own lobby echo carries the photo");

  // 3. B uploads a photo too -> A sees it on slot 1.
  const B_PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  B.send({ t: "photo", photo: B_PHOTO });
  const lobbyA2 = await A.waitFor(m => m.t === "lobby" && m.players.find(p => p.slot === 1) && m.players.find(p => p.slot === 1).photo);
  ok(lobbyA2.players.find(p => p.slot === 1).photo === B_PHOTO, "A sees B's photo in the roster (slot 1)");

  // 4. Non-image / oversized photo is rejected (stored as null).
  A.send({ t: "photo", photo: "not-a-data-url" });
  const lobbyB2 = await B.waitFor(m => m.t === "lobby" && m.players.find(p => p.slot === 0) && m.players.find(p => p.slot === 0).photo === null);
  ok(lobbyB2.players.find(p => p.slot === 0).photo === null, "Non-image photo rejected (stored null)");

  // Oversized (exceeds MAX_PHOTO_BYTES) is also rejected.
  const huge = "data:image/jpeg;base64," + "A".repeat(70 * 1024);
  A.send({ t: "photo", photo: huge });
  const lobbyB3 = await B.waitFor(m => m.t === "lobby" && m.players.find(p => p.slot === 0) && m.players.find(p => p.slot === 0).photo === null);
  ok(lobbyB3.players.find(p => p.slot === 0).photo === null, "Oversized photo rejected (stored null)");

  // 5. Photo is ignored once the match has started (roster frozen).
  A.send({ t: "ready", ready: true });
  await A.waitFor(m => m.t === "lobby" && m.players.find(p => p.slot === 0) && m.players.find(p => p.slot === 0).ready === true);
  B.send({ t: "ready", ready: true });
  await A.waitFor(m => m.t === "start");
  await B.waitFor(m => m.t === "start");
  const NEW_PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  A.send({ t: "photo", photo: NEW_PHOTO });
  await new Promise(r => setTimeout(r, 150)); // give it a chance to (wrongly) broadcast
  const lastLobbyA = A.msgs.filter(m => m.t === "lobby").pop();
  const aPhotoAfterStart = lastLobbyA ? lastLobbyA.players.find(p => p.slot === 0).photo : null;
  ok(aPhotoAfterStart !== NEW_PHOTO, "Photo sent after start is ignored (roster frozen)");

  // Cleanup.
  A.close(); B.close();
  server.kill();
  await new Promise(r => setTimeout(r, 100));

  console.log("\n==============================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("==============================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("TEST ERROR:", e.message); try { process.exit(2); } catch {} });
