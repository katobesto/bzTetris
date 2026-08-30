// test-net.js — End-to-end test of the multiplayer server with 2 simulated clients.
// Spawns server.js as a child, drives the full flow (create/join/ready/start/
// garbage/out/end), asserts each step, then kills the server and reports.
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const PORT = 3100; // avoid clashing with anything on 3000
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
  // Wait for the first message matching pred (with timeout).
  c.waitFor = (pred, ms = 2000) => new Promise((res, rej) => {
    const hit = c.msgs.find(pred);
    if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error("timeout waiting for " + (pred.label || "msg"))), ms);
    c.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
  });
  c.close = () => { try { c.ws.close(); } catch {} };
  return c;
}

async function main() {
  console.log("Spawning server on port " + PORT + " ...");
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOut = "";
  server.stdout.on("data", d => serverOut += d);
  server.stderr.on("data", d => serverOut += d);

  // Wait for the server to announce it's listening.
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
  console.log("Both clients connected.\n");

  // 1. A creates a room.
  A.send({ t: "create", name: "Alice" });
  const joinedA = await A.waitFor(m => m.t === "joined");
  ok(joinedA.t === "joined" && joinedA.slot === 0, "A created room, got slot 0");
  const code = joinedA.room;
  ok(typeof code === "string" && code.length === 4, "Room code is 4 chars: " + code);
  ok(joinedA.players.length === 1 && joinedA.players[0].isHost === true, "A is host, 1 player in lobby");

  // 2. B joins with the code.
  B.send({ t: "join", code, name: "Bob" });
  const joinedB = await B.waitFor(m => m.t === "joined");
  ok(joinedB.slot === 1, "B joined, got slot 1");
  const lobbyA = await A.waitFor(m => m.t === "lobby");
  ok(lobbyA.players.length === 2, "A sees 2 players in lobby");
  ok(lobbyA.players.find(p => p.slot === 1).name === "Bob", "A sees Bob in lobby");

  // 3. Both ready -> auto-start.
  A.send({ t: "ready", ready: true });
  await A.waitFor(m => m.t === "lobby" && m.players.every(p => p.ready === (p.slot === 0)));
  B.send({ t: "ready", ready: true });
  const startA = await A.waitFor(m => m.t === "start");
  const startB = await B.waitFor(m => m.t === "start");
  ok(startA.t === "start" && startB.t === "start", "Both received 'start' (auto-start when all ready)");

  // 4. A sends garbage to B (target slot 1).
  A.send({ t: "garbage", rows: [{ row: "GGGGGGGGGG", gap: 3 }], targets: [1] });
  const gB = await B.waitFor(m => m.t === "garbage");
  ok(gB.t === "garbage" && gB.from === 0 && gB.rows.length === 1, "B received garbage from A (slot 0)");
  ok(gB.rows[0].gap === 3, "Garbage row preserved (gap=3)");
  // A should NOT receive its own garbage.
  ok(!A.msgs.some(m => m.t === "garbage"), "A did not receive its own garbage");

  // 5. A sends a Tetris (targets "all") -> B gets it.
  A.send({ t: "garbage", rows: [{ row: "GGGGGGGGGG", gap: 0 }, { row: "GGGGGGGGGG", gap: 1 }, { row: "GGGGGGGGGG", gap: 2 }, { row: "GGGGGGGGGG", gap: 3 }], targets: "all" });
  const gB2 = await B.waitFor(m => m.t === "garbage" && m.rows.length === 4);
  ok(gB2.rows.length === 4, "B received 4-row Tetris garbage (targets=all)");

  // 6. Snapshot relay: A sends a board snapshot, B receives it.
  const board = ".".repeat(200);
  A.send({ t: "snapshot", board, piece: { type: "I", x: 3, y: 0, rot: "0" }, held: "T", queue: ["O", "S", "Z"], score: 1234, lines: 5, level: 2, alive: true });
  const snapB = await B.waitFor(m => m.t === "snapshot");
  ok(snapB.slot === 0 && snapB.board.length === 200, "B received A's snapshot (slot 0, 200-char board)");
  ok(snapB.piece && snapB.piece.type === "I" && snapB.score === 1234, "Snapshot carried piece + score");

  // 7. B goes out -> A is notified, and (with 2 players) the match ends with A winning.
  B.send({ t: "out" });
  const outA = await A.waitFor(m => m.t === "out");
  ok(outA.slot === 1, "A received 'out' for slot 1 (B)");
  const endA = await A.waitFor(m => m.t === "end");
  ok(endA.t === "end" && endA.winnerSlot === 0, "Match ended, winner = slot 0 (A)");
  const endB = await B.waitFor(m => m.t === "end");
  ok(endB.winnerSlot === 0, "B also received the end (winner slot 0)");

  // 8. Error handling: join a nonexistent room.
  const C = makeClient("Carol");
  await C.connect();
  C.send({ t: "join", code: "ZZZZ", name: "Carol" });
  const errC = await C.waitFor(m => m.t === "error");
  ok(errC.t === "error" && /not found/i.test(errC.msg), "Joining a bad room returns an error");

  // 9. Disconnect mid-match: A drops, B should get 'out' for slot 0.
  // (Room still has B alive; with 1 alive of 2, B wins.)
  A.close();
  const outB2 = await B.waitFor(m => m.t === "out" && m.slot === 0);
  ok(outB2.slot === 0, "B received 'out' for slot 0 when A disconnected");

  // Cleanup.
  B.close(); C.close();
  server.kill();
  await new Promise(r => setTimeout(r, 100));

  console.log("\n==============================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("==============================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error("TEST ERROR:", e.message); try { process.exit(2); } catch {} });
