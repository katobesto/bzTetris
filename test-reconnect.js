// test-reconnect.js — Verify the reconnect flow: a dropped lobby player's slot
// is held as a "ghost" (shown as "reconnecting") and the client can rejoin the
// SAME slot with its name/ready restored. Also verifies voluntary leave does
// NOT create a ghost.
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const PORT = 3101; // avoid clashing with test-net.js (3100)
const URL = `ws://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label); }
}

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
  c.waitFor = (pred, ms = 2500) => new Promise((res, rej) => {
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
  server.stdout.on("data", (d) => { serverOut += d; });
  server.stderr.on("data", (d) => { serverOut += d; });

  // Wait for the server to be ready.
  await new Promise((res) => {
    const t = setInterval(() => {
      if (serverOut.includes("running at")) { clearInterval(t); res(); }
    }, 100);
    setTimeout(() => { clearInterval(t); res(); }, 3000);
  });

  const host = makeClient("Ana");
  const drop = makeClient("Beto");
  const third = makeClient("Carmen");

  try {
    // 1. Host creates a room.
    await host.connect();
    host.send({ t: "create", name: "Ana" });
    const joined = await host.waitFor(m => m.t === "joined");
    const code = joined.room;
    ok(!!code, "host created room " + code);

    // 2. Beto joins (slot 1) and Carmen joins (slot 2).
    await drop.connect();
    drop.send({ t: "join", code, name: "Beto" });
    const dropJoined = await drop.waitFor(m => m.t === "joined");
    ok(dropJoined.slot === 1, "Beto joined slot 1");

    await third.connect();
    third.send({ t: "join", code, name: "Carmen" });
    const thirdJoined = await third.waitFor(m => m.t === "joined");
    ok(thirdJoined.slot === 2, "Carmen joined slot 2");

    // 3. Beto sets ready, then DROPS (simulated network loss: terminate).
    drop.send({ t: "ready", ready: true });
    await host.waitFor(m => m.t === "lobby" && m.players.find(p => p.slot === 1 && p.ready), 2500);
    ok(true, "Beto ready broadcast received");

    // Simulate a hard drop (proxy idle-timeout kill): terminate, not a clean close.
    drop.ws.terminate();
    const ghostLobby = await host.waitFor(
      m => m.t === "lobby" && m.players.find(p => p.slot === 1 && p.ghost), 2500
    );
    ok(!!ghostLobby, "Beto's slot held as ghost after drop");
    const ghost = ghostLobby.players.find(p => p.slot === 1);
    ok(ghost.name === "Beto" && ghost.ready === true, "ghost keeps name + ready");

    // 4. Beto reconnects and rejoins the SAME slot (slot: 1).
    const drop2 = makeClient("Beto");
    await drop2.connect();
    drop2.send({ t: "join", code, name: "Beto", slot: 1 });
    const rejoined = await drop2.waitFor(m => m.t === "joined");
    ok(rejoined.slot === 1, "Beto rejoined the SAME slot 1");
    ok(rejoined.rejoined === true, "server flagged the rejoin");
    const reLobby = await host.waitFor(
      m => m.t === "lobby" && m.players.find(p => p.slot === 1 && !p.ghost && p.ready), 2500
    );
    ok(!!reLobby, "ghost cleared + Beto back as ready in lobby");

    // 5. Voluntary leave does NOT create a ghost.
    third.send({ t: "leave" });
    const leaveLobby = await host.waitFor(
      m => m.t === "lobby" && !m.players.find(p => p.slot === 2), 2500
    );
    ok(!!leaveLobby, "voluntary leave removes slot (no ghost)");
    const noGhost = !leaveLobby.players.find(p => p.slot === 2 && p.ghost);
    ok(noGhost, "no ghost after voluntary leave");

    // 6. A fresh join now takes the lowest free slot (slot 2, Carmen's old one).
    const fourth = makeClient("Dani");
    await fourth.connect();
    fourth.send({ t: "join", code, name: "Dani" });
    const fourthJoined = await fourth.waitFor(m => m.t === "joined");
    ok(fourthJoined.slot === 2, "new joiner takes freed slot 2");

  } catch (e) {
    failed++;
    console.log("  FAIL  exception: " + e.message);
    console.log("  server output:\n" + serverOut);
  } finally {
    for (const c of [host, drop, third]) c.close();
    server.kill();
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
