// input.js — Keyboard + up to 4 gamepads, key rebinding, settings overlay.
// Inputs claim player slots dynamically in activation order (see claimSlot).

"use strict";

/* ============================================================
 * KEY BINDINGS (rebindable for P1; pads use the fixed layout)
 * ============================================================ */
const DEFAULT_BINDS = { left: "ArrowLeft", right: "ArrowRight", down: "ArrowDown", rotateCW: "Space", hardDrop: "ArrowUp", rotateCCW: "KeyZ", hold: "KeyC", pause: "KeyP", settings: "KeyO", restart: "KeyR" };
let binds = loadBinds();

function loadBinds() {
  try { const s = localStorage.getItem("tetris-binds"); if (s) return { ...DEFAULT_BINDS, ...JSON.parse(s) }; } catch {}
  return { ...DEFAULT_BINDS };
}
function saveBinds() { try { localStorage.setItem("tetris-binds", JSON.stringify(binds)); } catch {} }

// Fixed gamepad layout (W3C standard indices): [A]=start, [B]=restart, [X]=settings,
// [Y]=hold, [LB]=rotate CCW, [RB]=hard drop, [Back]=pause, [Start]=rotate CW.
// A/B are contextual: A confirms in menus and rotates left in play;
// B goes back in menus and rotates right in play.
// dpad/up/down/left/right = move + soft drop.
const PAD_BUTTONS = { 0: "start", 1: "restart", 2: "settings", 3: "hold", 4: "rotateCCW", 5: "hardDrop", 8: "pause", 9: "rotateCW" };

// Soft-drop repeat rate while ArrowDown / dpad-down is held.
const SOFT_DROP_MS = 40;

/* ============================================================
 * SETTINGS OVERLAY LABELS (key rebinding table)
 * ============================================================ */
const ACTION_LABELS = { left: "Move Left", right: "Move Right", down: "Soft Drop", rotateCW: "Rotate CW", hardDrop: "Hard Drop", rotateCCW: "Rotate CCW", hold: "Hold", pause: "Pause", settings: "Settings", restart: "Back / Rotate Right" };

const KEY_NAMES = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Enter: "Enter", Escape: "Esc", Tab: "Tab", Backspace: "Bksp",
  KeyW: "W", KeyA: "A", KeyS: "S", KeyD: "D", KeyZ: "Z", KeyX: "X", KeyC: "C", KeyV: "V", KeyF: "F", KeyG: "G", KeyH: "H", KeyJ: "J", KeyK: "K", KeyL: "L",
  KeyQ: "Q", KeyE: "E", KeyR: "R", KeyT: "T", KeyY: "Y", KeyU: "U", KeyI: "I", KeyO: "O", KeyP: "P",
  Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9", Digit0: "0"
};

/* ============================================================
 * PER-SLOT HELD STATE (DAS/ARR + soft drop)
 * ============================================================ */
const heldBySlot = Array.from({ length: 4 }, () => ({}));

function pressDir(slot, dir) {
  if (state !== State.PLAYING || slot >= players.length) return;
  const pl = players[slot];
  if (!pl.alive || !pl.piece || pl.clearing) return;
  const h = heldBySlot[slot];
  if (h[dir]) return;
  h[dir] = { t0: performance.now(), last: performance.now() };
  if (dir === "down") softDropStep(pl);
  else tryMove(pl, dir === "left" ? -1 : 1);
}

function releaseDir(slot, dir) { delete heldBySlot[slot][dir]; }

function clearAllHelds() { for (const h of heldBySlot) Object.keys(h).forEach(d => delete h[d]); }

function dasStep(pl, now) {
  if (!pl.piece || pl.clearing) return;
  const h = heldBySlot[pl.slot];
  // Only horizontal keys drive DAS — "down" is handled separately so holding
  // ArrowDown never drifts the piece sideways.
  const hDirs = Object.keys(h).filter(d => d === "left" || d === "right");
  if (hDirs.length === 1) {
    const dir = hDirs[0];
    const info = h[dir];
    const elapsed = now - info.t0;
    if (elapsed < DAS_MS) return;
    const interval = Math.max(ARR_MS, (elapsed - DAS_MS) / 4); // ramp up to ARR after ~4 repeats
    if (now - info.last >= interval) {
      tryMove(pl, dir === "left" ? -1 : 1);
      info.last = now;
    }
  }
  if (h.down) {
    const info = h.down;
    if (now - info.last >= SOFT_DROP_MS) { softDropStep(pl); info.last = now; }
  }
}

function softDropStep(pl) {
  if (!pl.alive || !pl.piece || pl.clearing) return;
  if (!collidesAt(pl, pieceCells({ ...pl.piece, y: pl.piece.y + 1 }))) {
    pl.piece.y++;
    pl.score += 1; // 1 point per soft-drop cell (guideline)
    pl.gravAcc = 0;
    pl.lockTimer = 0;
    updateStats(pl);
  }
}

/* ============================================================
 * DYNAMIC SLOT ASSIGNMENT — inputs claim slots in activation order.
 * slotOwner[slot] = "keyboard" | "pad0".."pad3" | null
 * inputSlot[inputId] = slot | null
 * ============================================================ */
const slotOwner = [null, null, null, null];
const inputSlot = { keyboard: null, pad0: null, pad1: null, pad2: null, pad3: null };

function resetSlotAssignment() {
  for (let s = 0; s < slotOwner.length; s++) slotOwner[s] = null;
  inputSlot.keyboard = null;
  inputSlot.pad0 = null; inputSlot.pad1 = null; inputSlot.pad2 = null; inputSlot.pad3 = null;
  clearAllHelds(); // stale directions must not carry into the next match
  for (const ps of padState) { ps.holds.left = ps.holds.right = ps.holds.down = false; }
}

// Claim the lowest free slot for an input (idempotent per input).
// Returns the slot, or null when every slot is taken.
function claimSlot(inputId) {
  if (inputSlot[inputId] !== null) return inputSlot[inputId];
  for (let s = 0; s < players.length; s++) {
    if (slotOwner[s] === null) {
      slotOwner[s] = inputId;
      inputSlot[inputId] = s;
      return s;
    }
  }
  return null;
}

/* ============================================================
 * ACTION DISPATCH — one entry point for keyboard and pads.
 * ============================================================ */
function dispatchAction(slot, action) {
  switch (state) {
    case State.MENU:
      // Any input can drive the menu (the slot is irrelevant here).
      if (action === "left") changeMenuCount(-1);
      else if (action === "right") changeMenuCount(1);
      else if (action === "start" || action === "Enter") confirmMenu(); // B is back-only, never confirms
      else if (action === "settings") openSettings();
      return;

    case State.WAITING:
      // Joining is handled by the input handlers (claimSlot + joinSlot).
      // B / R goes back to the menu.
      if (action === "restart") returnToMenu();
      return;

    case State.COUNTDOWN:
      return; // no input during the countdown

    default: {
      if (slot >= players.length) return;
      const pl = players[slot];
      switch (state) {
        case State.PLAYING:
          if (!pl.alive) return;
          switch (action) {
            case "left": pressDir(slot, "left"); break;
            case "right": pressDir(slot, "right"); break;
            case "down": pressDir(slot, "down"); break;
            case "start": tryRotate(pl, -1); break; // A: rotate left
            case "restart": tryRotate(pl, 1); break; // B: rotate right
            case "rotateCW": tryRotate(pl, 1); break;
            case "rotateCCW": tryRotate(pl, -1); break;
            case "hardDrop": hardDrop(pl); break;
            case "hold": doHold(pl); break;
            case "pause": pauseGame(); break;
            case "settings": if (slot === 0) openSettings(); break; // settings is P1-only
          }
          return;

        case State.PAUSED:
          if (action === "pause" || action === "start") resumeGame();
          else if (action === "restart") returnToMenu();
          return;

        case State.GAMEOVER:
        case State.WINNER:
          // Any player's Start/R (or P1's Enter) returns to the menu.
          if (action === "start" || action === "restart" || action === "Enter") returnToMenu();
          return;
      }
    }
  }
}

/* ============================================================
 * KEYBOARD — P1 only (slot 0)
 * ============================================================ */
function keyToAction(e) {
  for (const [action, code] of Object.entries(binds)) if (code === e.code) return action;
  // Enter is a system action (confirm / return), not a rebindable play binding.
  if (e.code === "Enter") return "Enter";
  return null;
}

window.addEventListener("keydown", (e) => {
  // Settings overlay: Esc closes it; everything else is swallowed.
  if (settingsOpen) {
    if (e.key === "Escape") closeSettings();
    e.preventDefault();
    return;
  }

  // WAITING: if the keyboard hasn't claimed a slot yet, any key claims the
  // lowest free slot and joins with it.
  if (state === State.WAITING && inputSlot.keyboard === null && e.key !== "Escape") {
    const slot = claimSlot("keyboard");
    if (slot !== null) {
      e.preventDefault();
      joinSlot(slot);
      return;
    }
    // Every slot is taken: fall through (a bound "restart" key still works).
  }

  // Esc is hardwired: pause/resume in game, back-to-menu everywhere else.
  if (e.key === "Escape") {
    e.preventDefault();
    if (state === State.PLAYING) pauseGame();
    else if (state === State.PAUSED) resumeGame();
    else returnToMenu();
    return;
  }

  const action = keyToAction(e);
  if (!action) return;
  e.preventDefault(); // stop page scroll on bound keys
  if (e.repeat) return;

  // MENU: any input drives the menu (slot is irrelevant).
  // Otherwise the keyboard controls the slot it claimed in WAITING.
  const slot = state === State.MENU ? 0 : inputSlot.keyboard;
  if (slot === null) return; // keyboard never joined; it controls no player
  dispatchAction(slot, action);
});

window.addEventListener("keyup", (e) => {
  const slot = inputSlot.keyboard;
  if (slot === null) return;
  for (const dir of ["left", "right", "down"]) if (binds[dir] === e.code) releaseDir(slot, dir);
});

/* ============================================================
 * GAMEPADS — up to 4 pads; each pad claims a player slot
 * dynamically in activation order (see claimSlot).
 * P1's pad (index 0) is the one that can be captured in settings.
 * ============================================================ */
const PAD_DEADZONE = 0.5;
const padNames = ["", "", "", ""];
let connectedPads = 0;
const padState = Array.from({ length: 4 }, () => ({ g: null, prevButtons: [], holds: { left: false, right: false, down: false }, menuLeft: false, menuRight: false }));

function pollGamepads() {
  const list = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
  let count = 0;

  for (let i = 0; i < padState.length; i++) { // only 4 pads are ever used; ignore the rest
    const g = list[i] || null;
    const ps = padState[i];
    const inputId = "pad" + i;

    if (!g) {
      if (ps.g) { // disconnected: drop name, held directions, and any claimed slot
        ps.g = null; ps.prevButtons = []; ps.name = "";
        padNames[i] = "";
        const slot = inputSlot[inputId];
        if (state === State.WAITING && slot !== null) {
          slotOwner[slot] = null;
          inputSlot[inputId] = null;
          players[slot].ready = false;
          showWaiting();
        }
        if (slot !== null) {
          releaseDir(slot, "left"); releaseDir(slot, "right"); releaseDir(slot, "down");
        }
      }
      continue;
    }

    count++;
    if (!ps.g) { // just connected: remember name for the waiting screen / dots
      ps.g = g;
      padNames[i] = (g.id || `Controller ${i + 1}`).split("(")[0].trim().slice(0, 40);
    }

    const pressed = Array.from(g.buttons, b => b.pressed || b.value > PAD_DEADZONE);

    // Settings capture: only P1's pad can be rebinded.
    if (settingsOpen) {
      // B (button 1) closes settings, mirroring Esc on keyboard.
      if (pressed[1] && !ps.prevButtons[1]) closeSettings();
      ps.prevButtons = pressed;
      continue; // no gameplay input while settings is open
    }

    // MENU: any pad drives the menu (slot is irrelevant).
    if (state === State.MENU) {
      const leftNow = g.axes[2] < -PAD_DEADZONE || !!g.buttons[14]?.pressed;
      const rightNow = g.axes[2] > PAD_DEADZONE || !!g.buttons[15]?.pressed;
      if (leftNow && !ps.menuLeft) dispatchAction(0, "left");
      if (rightNow && !ps.menuRight) dispatchAction(0, "right");
      ps.menuLeft = leftNow;
      ps.menuRight = rightNow;
      for (let b = 0; b < pressed.length; b++) {
        const action = PAD_BUTTONS[b];
        if (action && pressed[b] && !ps.prevButtons[b]) dispatchAction(0, action);
      }
      ps.prevButtons = pressed;
      continue;
    }

    // WAITING: any button press claims the next free slot for this pad.
    let joinedNow = false;
    if (state === State.WAITING && inputSlot[inputId] === null) {
      const anyPressed = pressed.some((p, j) => p && !ps.prevButtons[j]);
      if (anyPressed) {
        const slot = claimSlot(inputId);
        if (slot !== null) { joinSlot(slot); joinedNow = true; }
      }
    }

    const slot = inputSlot[inputId];

    // Edge-triggered actions (only for pads that own a slot).
    if (!joinedNow && slot !== null) {
      for (let b = 0; b < pressed.length; b++) {
        const action = PAD_BUTTONS[b];
        if (action && pressed[b] && !ps.prevButtons[b]) dispatchAction(slot, action);
      }
    }
    ps.prevButtons = pressed;

    // Held directions (dpad / left stick). pressDir/releaseDir guard on state.
    if (slot !== null) {
      const want = {
        left: g.axes[2] < -PAD_DEADZONE || !!g.buttons[14]?.pressed,
        right: g.axes[2] > PAD_DEADZONE || !!g.buttons[15]?.pressed,
        down: g.axes[3] > PAD_DEADZONE || !!g.buttons[13]?.pressed,
      };
      for (const d of ["left", "right", "down"]) {
        if (want[d] && !ps.holds[d]) pressDir(slot, d);
        else if (!want[d] && ps.holds[d]) releaseDir(slot, d);
        ps.holds[d] = want[d];
      }
    }
  }

  connectedPads = count;
  updatePadStatus();
  updateMenuPadsLine();
  updatePadDots();
}

/* ============================================================
 * SETTINGS OVERLAY (key rebinding for P1 + pad status)
 * ============================================================ */
const settingsEl = document.getElementById("settings");
let settingsOpen = false;
let capture = null; // { action, input } while waiting for a new key/pad button
let settingsPausedGame = false;

function openSettings() {
  if (state === State.PLAYING) { state = State.PAUSED; settingsPausedGame = true; pauseMusic(); }
  else settingsPausedGame = false;
  renderBindTable();
  updatePadStatus();
  settingsEl.classList.remove("hidden");
  settingsOpen = true;
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  capture = null;
  settingsEl.classList.add("hidden");
  if (settingsPausedGame) { state = State.PLAYING; resumeMusic(); } // resume silently (no overlay flash)
  settingsPausedGame = false;
}

function renderBindTable() {
  const tbody = document.getElementById("bindBody");
  tbody.innerHTML = "";
  for (const [action, label] of Object.entries(ACTION_LABELS)) {
    const tr = document.createElement("tr");
    const cur = binds[action];
    const isPad = typeof cur === "string" && cur.startsWith("Pad");
    const display = isPad ? cur.replace(/^Pad\d+:/, "Pad ") : (KEY_NAMES[cur] || cur);
    tr.innerHTML = `<td>${label}</td><td><button class="btn bind-btn" data-action="${action}">${display}</button></td>`;
    tbody.appendChild(tr);
  }
  // Wire capture buttons.
  tbody.querySelectorAll(".bind-btn").forEach(btn => {
    btn.onclick = () => startCapture(btn.dataset.action, "keyboard");
  });
}

function startCapture(action, input) {
  capture = { action, input };
  renderBindTable();
  const btn = document.querySelector(`.bind-btn[data-action="${action}"]`);
  if (btn) { btn.classList.add("capture"); btn.textContent = input === "gamepad" ? "Press pad button…" : "Press key…"; }
}

// Shared binding helper: rejects conflicts, persists, and re-renders the table.
function tryBind(value) {
  const conflict = Object.entries(binds).find(([a, code]) => a !== capture.action && code === value);
  if (conflict) { flashConflict(capture.action); return; } // keep capturing
  binds[capture.action] = value;
  saveBinds();
  cancelCapture();
}

function cancelCapture() { capture = null; renderBindTable(); }

function flashConflict(action) {
  const btn = document.querySelector(`.bind-btn[data-action="${action}"]`);
  if (btn) { btn.classList.add("conflict"); setTimeout(() => btn.classList.remove("conflict"), 600); }
}

function updatePadStatus() {
  const el = document.getElementById("padStatus");
  if (!el) return;
  if (connectedPads === 0) {
    el.textContent = "No controllers connected — plug one in and press any button";
  } else {
    el.innerHTML = `<span class="on">${connectedPads} controller${connectedPads > 1 ? "s" : ""} connected</span>` + (padNames[0] ? ` — ${escapeHtml(padNames[0])}` : "");
  }
}

// Keyboard capture: listen for the next keydown while capturing.
window.addEventListener("keydown", (e) => {
  if (!settingsOpen || !capture || capture.input !== "keyboard") return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { cancelCapture(); return; } // Esc cancels the capture
  tryBind(e.code);
}, true);

/* ============================================================
 * WINDOW BLUR — clear held keys and auto-pause.
 * ============================================================ */
window.addEventListener("blur", () => {
  clearAllHelds();
  for (const ps of padState) { ps.holds.left = ps.holds.right = ps.holds.down = false; }
  if (state === State.PLAYING && !settingsOpen) pauseGame();
});
