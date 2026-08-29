// main.js — Boot, game loop (update + render), and per-player update step.

"use strict";

/* ============================================================
 * GAME LOOP
 * ============================================================ */
let lastTime = performance.now();

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1); // clamp to avoid huge jumps after tab switch
  lastTime = now;

  stepMusicFades(performance.now()); // music crossfade (music.js; danger switching is in updateDangerMusic)
  updateDangerMusic();         // stack-height driven track swap
  pollGamepads();              // gamepad polling (input.js)
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
    }
    updateShake(dt);
  }

  if (state === State.COUNTDOWN) {
    updateCountdown(dt * 1000);
    return;
  }
  if (state !== State.PLAYING) return;

  for (const pl of players) {
    // Skip dead players, but keep ticking a player mid line-clear: during the
    // clear animation pl.piece is null yet pl.clearing must still advance.
    if (!pl.alive || (!pl.piece && !pl.clearing)) continue;
    updatePlayer(pl, dt, now);
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
 * BOOT — build the initial (empty) columns behind the menu and start.
 * ============================================================ */
players.push(makePlayer(0)); // placeholder so empty boards show behind the menu
buildColumns(1);
showMenu(menuCount);
requestAnimationFrame(frame);
