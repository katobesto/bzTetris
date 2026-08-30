// net.js — WebSocket client for online multiplayer (Tetris 99-style garbage attack).
// Connects to the server, manages rooms (create/join/lobby/ready), relays garbage,
// and streams board snapshots so rivals can be rendered. The server is authoritative
// for membership, ready, out, and match end.

"use strict";

/* ============================================================
 * CONNECTION
 * ============================================================ */
let ws = null;
let netRetry = 0;

function netUrl() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  return proto + location.host; // same host:port as the page
}

function connectNet() {
  if (ws && (ws.readyState === 1 || ws.readyState === 0)) return;
  ws = new WebSocket(netUrl());
  ws.onopen = () => {
    netConnected = true;
    netRetry = 0;
    if (state === State.NET_MENU || state === State.LOBBY) refreshScreen();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleNetMessage(msg);
  };
  ws.onclose = () => {
    const wasConnected = netConnected;
    netConnected = false;
    // If we were mid-match or in a lobby, surface the disconnect.
    if (wasConnected && (state === State.PLAYING || state === State.LOBBY || state === State.COUNTDOWN)) {
      netError = "Conexión perdida";
      if (state === State.LOBBY) refreshScreen();
    }
  };
  ws.onerror = () => { /* onclose follows */ };
}

function sendNet(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/* ============================================================
 * ROOM ACTIONS
 * ============================================================ */
function createRoom(name) {
  connectNet();
  sendNet({ t: "create", name: name || "Jugador" });
}

function joinRoom(code, name) {
  connectNet();
  sendNet({ t: "join", code, name: name || "Jugador" });
}

function setReady(ready) {
  sendNet({ t: "ready", ready });
}

function hostStart() {
  sendNet({ t: "start" });
}

function sendOut() {
  sendNet({ t: "out" });
}

// Periodic snapshot of the local board so rivals can render us.
function sendSnapshot() {
  if (!online || !netConnected) return;
  const pl = players[mySlot];
  if (!pl) return;
  sendNet({
    t: "snapshot",
    board: encodeBoard(pl.board),
    piece: pl.piece ? { type: pl.piece.type, x: pl.piece.x, y: pl.piece.y, rot: pl.piece.rot } : null,
    held: pl.heldType,
    queue: pl.queue.slice(0, 3),
    score: pl.score,
    lines: pl.linesCleared,
    level: pl.level,
    alive: pl.alive
  });
}

/* ============================================================
 * MESSAGE HANDLING
 * ============================================================ */
function handleNetMessage(msg) {
  switch (msg.t) {
    case "joined": {
      roomCode = msg.room;
      mySlot = msg.slot;
      onlinePlayers = msg.players;
      netError = "";
      state = State.LOBBY;
      showLobby();
      break;
    }

    case "lobby": {
      onlinePlayers = msg.players;
      if (state === State.LOBBY) showLobby();
      break;
    }

    case "start": {
      // Server declared the match started. Build the local player array and go.
      setupOnlineMatch();
      break;
    }

    case "garbage": {
      if (state === State.PLAYING) onGarbageReceived(msg.from, msg.rows);
      break;
    }

    case "out": {
      if (state === State.PLAYING || state === State.COUNTDOWN) onRivalOut(msg.slot);
      break;
    }

    case "snapshot": {
      applyRemoteSnapshot(msg.slot, msg);
      break;
    }

    case "stats": {
      const pl = players[msg.slot];
      if (pl) { pl.score = msg.score; pl.linesCleared = msg.lines; updateStats(pl); }
      break;
    }

    case "end": {
      onOnlineEnd(msg.winnerSlot);
      break;
    }

    case "error": {
      netError = msg.msg || "Error";
      if (state === State.NET_MENU || state === State.LOBBY) refreshScreen();
      break;
    }
  }
}

// Apply a remote player's snapshot to their local mirror (rendered from here).
function applyRemoteSnapshot(slot, data) {
  const pl = players[slot];
  if (!pl || slot === mySlot) return;
  pl.board = decodeBoard(data.board);
  pl.piece = data.piece ? { type: data.piece.type, x: data.piece.x, y: data.piece.y, rot: data.piece.rot } : null;
  if (data.held !== undefined) { pl.heldType = data.held; drawHold(pl); }
  if (Array.isArray(data.queue)) { pl.queue = data.queue.slice(); drawNext(pl); }
  if (typeof data.score === "number") { pl.score = data.score; }
  if (typeof data.lines === "number") { pl.linesCleared = data.lines; }
  if (typeof data.level === "number") { pl.level = data.level; }
  if (data.alive === false && pl.alive) {
    pl.alive = false;
    if (pl.elOutBadge) pl.elOutBadge.classList.remove("hidden");
  }
  updateStats(pl);
}
