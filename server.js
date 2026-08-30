// server.js — Static dev server + WebSocket multiplayer (Tetris 99-style garbage attack).
// Serves the project directory and hosts authoritative game rooms keyed by a 4-char code.
// The server is authoritative for: room membership, ready state, match start, who is out,
// and match end. It relays garbage rows verbatim between clients; each client simulates
// its own board physics locally and applies received garbage to its own stack.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0"; // bind all interfaces so LAN players can join
const ROOT = __dirname;
const MAX_PLAYERS = 4;
const COLS = 10; // must match constants.js
const ROWS = 20; // must match constants.js
// How long a dropped player's slot is held (as a "ghost") so their client can
// rejoin after a network blip / proxy idle-timeout drop. Cleared by the sweep.
const REJOIN_GRACE_MS = 60000;
// Cap for avatar data URLs. Photos are resized to 96x96 JPEG on the client
// (~5-15KB); this guard stops a client from stuffing a huge blob into the
// roster that gets broadcast to the whole room on every lobby change.
const MAX_PHOTO_BYTES = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  // Health endpoint (used by the Docker HEALTHCHECK and Coolify)
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: Math.floor(process.uptime()) }));
    return;
  }

  const filePath = path.join(ROOT, pathname);
  // Block path traversal: the resolved path must stay inside ROOT.
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found: " + pathname);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
});

/* ============================================================
 * MULTIPLAYER ROOMS
 * A room has 4 stable slots (index = slot). Slots are assigned in
 * join order (lowest free) and never re-indexed on leave, so every
 * client agrees on who is who for the life of the room.
 * ============================================================ */
const rooms = new Map(); // code -> room

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O, 1/I
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += chars[(Math.random() * chars.length) | 0];
  } while (rooms.has(c));
  return c;
}

function makeRoom(code) {
  // ghosts: slot -> { name, ready, leftAt } — a dropped lobby player's slot,
  // held for REJOIN_GRACE_MS so their client can rejoin after a drop.
  return { code, slots: [null, null, null, null], started: false, winner: -1, ghosts: {} };
}

function occupied(room) { return room.slots.filter(s => s !== null); }

function hostSlot(room) {
  for (let i = 0; i < room.slots.length; i++) if (room.slots[i]) return i;
  return -1;
}

function roomPlayers(room) {
  const out = [];
  const host = hostSlot(room);
  room.slots.forEach((p, i) => {
    if (p) out.push({ slot: i, name: p.name, ready: p.ready, alive: p.alive, isHost: i === host, photo: p.photo || null });
  });
  // Ghost slots (dropped lobby players) show up so the room doesn't look empty
  // while their client reconnects.
  for (const i of Object.keys(room.ghosts)) {
    const g = room.ghosts[i];
    if (!g) continue;
    out.push({ slot: Number(i), name: g.name, ready: g.ready, alive: true, isHost: false, ghost: true, photo: g.photo || null });
  }
  return out;
}

function sendTo(p, msg) {
  if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of room.slots) {
    if (!p || p.id === exceptId) continue;
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function startMatch(room) {
  if (room.started) return;
  room.started = true;
  room.winner = -1;
  for (const p of room.slots) if (p) p.alive = true;
  broadcast(room, { t: "start" });
}

function checkEnd(room) {
  if (!room.started) return;
  const alive = occupied(room).filter(p => p.alive);
  if (alive.length === 0) {
    room.winner = -1;
    broadcast(room, { t: "end", winnerSlot: -1 });
  } else if (occupied(room).length > 1 && alive.length === 1) {
    room.winner = alive[0].slot;
    broadcast(room, { t: "end", winnerSlot: alive[0].slot });
  }
}

/* ============================================================
 * WEBSOCKET HANDLER
 * ============================================================ */
const wss = new WebSocketServer({ server });

// Heartbeat: keep idle WebSockets alive so reverse proxies / load balancers
// (Traefik, nginx, cloud LBs, VPS firewalls) don't drop them on their idle
// timeout. Ping every 30s; terminate any client that fails to pong in time.
// This is what stops "la conexión se pierde" on the VPS — the socket stays
// open through the lobby and pauses where no game traffic flows.
const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already gone */ }
  }
  // Sweep expired ghost slots (dropped lobby players who didn't rejoin in time).
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    for (const i of Object.keys(room.ghosts)) {
      if (now - room.ghosts[i].leftAt > REJOIN_GRACE_MS) { delete room.ghosts[i]; changed = true; }
    }
    if (changed) {
      if (occupied(room).length === 0 && !Object.keys(room.ghosts).length) rooms.delete(room.code);
      else broadcast(room, { t: "lobby", players: roomPlayers(room) });
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref(); // don't keep the process alive (tests / graceful shutdown)

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

wss.on("connection", (ws) => {
  let player = null; // { id, name, ready, alive, ws, room, slot }

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    switch (msg.t) {
      case "create": {
        const code = genCode();
        const room = makeRoom(code);
        rooms.set(code, room);
        player = { id: code + "-0", name: String(msg.name || "Jugador").slice(0, 16), ready: false, alive: true, ws, room, slot: 0 };
        room.slots[0] = player;
        sendTo(player, { t: "joined", room: code, slot: 0, players: roomPlayers(room) });
        break;
      }

      case "join": {
        const code = String(msg.code || "").toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ t: "error", msg: "Sala no encontrada" })); return; }
        if (occupied(room).length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: "error", msg: "La sala está llena" })); return; }
        if (room.started) { ws.send(JSON.stringify({ t: "error", msg: "La partida ya ha comenzado" })); return; }
        let slot = -1;
        let rejoining = false;
        // Rejoin: if the client asks for its old slot and it's still held as a
        // ghost (dropped, not voluntarily left), restore it with name/ready.
        if (typeof msg.slot === "number" && room.ghosts[msg.slot] && !room.slots[msg.slot]) {
          slot = msg.slot;
          rejoining = true;
        }
        if (slot === -1) {
          for (let i = 0; i < room.slots.length; i++) if (!room.slots[i]) { slot = i; break; }
        }
        if (slot === -1) { ws.send(JSON.stringify({ t: "error", msg: "La sala está llena" })); return; }
        const ghost = rejoining ? room.ghosts[slot] : null;
        player = {
          id: code + "-" + slot,
          name: (ghost ? ghost.name : String(msg.name || "Jugador")).slice(0, 16),
          ready: rejoining ? !!ghost.ready : false,
          alive: true, ws, room, slot
        };
        room.slots[slot] = player;
        if (ghost) delete room.ghosts[slot];
        sendTo(player, { t: "joined", room: code, slot, players: roomPlayers(room), rejoined: rejoining });
        broadcast(room, { t: "lobby", players: roomPlayers(room) }, player.id);
        break;
      }

      case "ready": {
        if (!player) return;
        player.ready = !!msg.ready;
        const room = player.room;
        sendTo(player, { t: "lobby", players: roomPlayers(room) });
        broadcast(room, { t: "lobby", players: roomPlayers(room) }, player.id);
        // Auto-start when everyone is ready (and there are at least 2).
        if (occupied(room).length >= 2 && occupied(room).every(p => p.ready)) startMatch(room);
        break;
      }

      case "photo": {
        // A player uploads (or clears) their avatar. Stored on the slot and
        // broadcast to the room so everyone sees it in the lobby and can use
        // it in the garbage effect. Only accepted while in the lobby (the
        // roster is frozen once the match starts).
        if (!player || !player.room) return;
        if (player.room.started) return;
        const photo = (typeof msg.photo === "string" && msg.photo.startsWith("data:image/") && msg.photo.length <= MAX_PHOTO_BYTES)
          ? msg.photo : null;
        player.photo = photo;
        const room = player.room;
        sendTo(player, { t: "lobby", players: roomPlayers(room) });
        broadcast(room, { t: "lobby", players: roomPlayers(room) }, player.id);
        break;
      }

      case "start": {
        // Host force-start (works even if not everyone is ready).
        if (!player) return;
        const room = player.room;
        if (player.slot !== hostSlot(room)) return;
        if (occupied(room).length < 2) return;
        startMatch(room);
        break;
      }

      case "garbage": {
        if (!player || !player.room.started) return;
        const room = player.room;
        const from = player.slot;
        const rows = Array.isArray(msg.rows) ? msg.rows.slice(0, 4) : [];
        const targets = Array.isArray(msg.targets) ? msg.targets : "all";
        const targetSet = new Set();
        if (targets === "all") {
          room.slots.forEach((p, i) => { if (p && i !== from) targetSet.add(i); });
        } else {
          for (const t of targets) if (typeof t === "number" && t !== from && room.slots[t]) targetSet.add(t);
        }
        for (const t of targetSet) sendTo(room.slots[t], { t: "garbage", from, rows });
        break;
      }

      case "stats": {
        if (!player || !player.room.started) return;
        const room = player.room;
        const score = Number(msg.score) | 0;
        const lines = Number(msg.lines) | 0;
        broadcast(room, { t: "stats", slot: player.slot, score, lines }, player.id);
        break;
      }

      case "snapshot": {
        // Relay the sender's board snapshot to every other player in the room.
        if (!player || !player.room.started) return;
        const room = player.room;
        const snap = {
          t: "snapshot",
          slot: player.slot,
          board: String(msg.board || "").slice(0, COLS * ROWS),
          piece: msg.piece || null,
          held: msg.held || null,
          queue: Array.isArray(msg.queue) ? msg.queue.slice(0, 3) : [],
          score: Number(msg.score) | 0,
          lines: Number(msg.lines) | 0,
          level: Number(msg.level) | 0,
          alive: msg.alive !== false
        };
        broadcast(room, snap, player.id);
        break;
      }

      case "out": {
        if (!player || !player.room.started) return;
        if (!player.alive) return;
        player.alive = false;
        const room = player.room;
        broadcast(room, { t: "out", slot: player.slot });
        checkEnd(room);
        break;
      }

      case "leave": {
        if (player) leaveRoom(player, true); // voluntary: don't hold a ghost
        break;
      }
    }
  });

  ws.on("close", () => { if (player) leaveRoom(player); });
  ws.on("error", () => { if (player) leaveRoom(player); });
});

function leaveRoom(player, voluntary) {
  const room = player.room;
  if (!room) return;
  player.room = null;
  const slot = player.slot;
  room.slots[slot] = null;
  if (occupied(room).length === 0 && !Object.keys(room.ghosts).length) { rooms.delete(room.code); return; }
  if (room.started) {
    // A player dropped mid-match: they are out. Notify the others and re-evaluate.
    if (player.alive) {
      player.alive = false;
      broadcast(room, { t: "out", slot });
    }
    checkEnd(room);
  } else {
    // Lobby: hold the slot as a ghost (unless they left on purpose) so the
    // client can rejoin after a drop, and show it as "reconnecting".
    if (!voluntary) room.ghosts[slot] = { name: player.name, ready: player.ready, photo: player.photo || null, leftAt: Date.now() };
    else delete room.ghosts[slot];
    broadcast(room, { t: "lobby", players: roomPlayers(room) });
  }
}

server.listen(PORT, HOST, () => {
  console.log(`TETRIS dev server running at http://localhost:${PORT}/`);
  console.log(`Multiplayer WebSocket on ws://0.0.0.0:${PORT} (LAN: use this machine's IP)`);
  console.log("Press Ctrl+C to stop.");
});
