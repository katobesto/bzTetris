// main.js — Boot, game loop (update + render), and per-player update step.

"use strict";

/* ============================================================
 * GAME LOOP
 * ============================================================ */
let lastTime = performance.now();
let snapAcc = 0; // accumulator for the 10 Hz online snapshot timer

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1); // clamp to avoid huge jumps after tab switch
  lastTime = now;

  stepMusicFades(performance.now()); // music crossfade (music.js; danger switching is in updateDangerMusic)
  updateDangerMusic();         // stack-height driven track swap
  updateMenuMusic();           // menu.mp3 on home/menus/lobby/pause (music.js)
  pollGamepads();              // gamepad polling (input.js)
  updateTouchpad();            // show/hide the on-screen touch pad (input.js)
  update(dt, now);             // state machine + per-player physics
  render();                    // draw every player column

  requestAnimationFrame(frame);
}

/* ============================================================
 * UPDATE — effects always tick; gameplay only while PLAYING.
 * ============================================================ */
function update(dt, now) {
  if (state !== State.PAUSED) {
    for (const pl of players) {
      updateParticles(pl, dt);
      updatePopups(pl, dt);
      if (pl.garbageFlash > 0) pl.garbageFlash = Math.max(0, pl.garbageFlash - dt / 0.4); // fade over 0.4s
    }
    updateShake(dt);
  }

  if (state === State.COUNTDOWN) {
    updateCountdown(dt * 1000);
    return;
  }
  if (state !== State.PLAYING) return;

  for (const pl of players) {
    // Online: only simulate the local player. Rivals are rendered from
    // snapshots (applyRemoteSnapshot) and their physics run on their own machines.
    if (online && pl.remote) continue;
    // Skip dead players, but keep ticking a player mid line-clear: during the
    // clear animation pl.piece is null yet pl.clearing must still advance.
    if (!pl.alive || (!pl.piece && !pl.clearing)) continue;
    updatePlayer(pl, dt, now);
  }

  // Online: stream our board to rivals at 10 Hz so they can render us.
  if (online) {
    snapAcc += dt;
    if (snapAcc >= 0.1) { snapAcc = 0; sendSnapshot(); }
  }
}

function updatePlayer(pl, dt, now) {
  dasStep(pl, now); // DAS/ARR horizontal repeat + soft-drop repeat (input.js)

  if (pl.clearing) {
    pl.clearing.t += dt * 1000;
    if (pl.clearing.t >= CLEAR_ANIM_MS) finalizeClearing(pl);
    return; // board frozen during the clear animation
  }

  const canDown = !collidesAt(pl, pieceCells({ ...pl.piece, y: pl.piece.y + 1 }));

  if (!canDown) {
    // Piece is resting on something: start the lock delay.
    pl.lockTimer += dt * 1000;
    if (pl.lockTimer >= LOCK_DELAY_MS) lockPiece(pl);
  } else {
    pl.lockTimer = 0;
    pl.gravAcc += dt * 1000;
    const interval = dropInterval(pl);
    while (pl.gravAcc >= interval && !collidesAt(pl, pieceCells({ ...pl.piece, y: pl.piece.y + 1 }))) {
      pl.piece.y++;
      pl.gravAcc -= interval;
    }
  }
}

/* ============================================================
 * BOOT — build the initial (empty) columns behind the home screen and start.
 * ============================================================ */
players.push(makePlayer(0)); // placeholder so an empty board shows behind the home screen
buildColumns(1);
connectNet();   // open the WebSocket so online play is ready (net.js)
state = State.HOME;
showHome();
requestAnimationFrame(frame);
