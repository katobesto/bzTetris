// fx.js — Particle system, score popups and screen shake effects.
// Particles and popups are per-player (each drawn on that player's own canvas);
// the screen shake is global (it shakes the whole window).

"use strict";

/* ============================================================
 * PARTICLE SYSTEM (per-player)
 * ============================================================ */
function spawnParticle(pl, x, y, opts) {
  if (pl.particles.length >= MAX_PARTICLES) pl.particles.shift();
  const angle = rand(opts.angle - opts.spread / 2, opts.angle + opts.spread / 2);
  const speed = rand(opts.speed[0], opts.speed[1]);
  pl.particles.push({
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed - (opts.upBias || 0),
    g: opts.gravity,
    life: rand(opts.life[0], opts.life[1]),
    maxLife: 0, // set below
    size: rand(opts.size[0], opts.size[1]),
    color: pick(opts.colors)
  });
  const pt = pl.particles[pl.particles.length - 1];
  pt.maxLife = pt.life;
}

function burst(pl, x, y, count, opts) {
  for (let i = 0; i < count; i++) spawnParticle(pl, x, y, opts);
}

// Sparks where a locked piece touches the stack or floor.
function collisionSparks(pl, piece) {
  const color = COLORS[piece.type];
  for (const [cx, cy] of pieceCells(piece)) {
    const belowFloor = cy + 1 >= ROWS;
    const belowBlock = !belowFloor && pl.board[cy + 1][cx];
    if (!belowFloor && !belowBlock) continue;
    const px = (cx + 0.5) * pl.cell;
    const py = (cy + 1) * pl.cell; // contact line, bottom edge of the cell
    burst(pl, px, py, rand(4, 8) | 0 || 6, {
      angle: -Math.PI / 2, spread: Math.PI * 0.9,
      speed: [110, 330], upBias: 40, gravity: 500,
      life: [0.22, 0.5], size: [1.5, 3.5],
      colors: [color, color, "#ffffff"]
    });
  }
}

// Full explosion for every cell of the cleared rows.
function lineExplosion(pl, rows, isTetris) {
  for (const r of rows) {
    for (let c = 0; c < COLS; c++) {
      const type = pl.board[r][c];
      if (!type) continue;
      const px = (c + 0.5) * pl.cell;
      const py = (r + 0.5) * pl.cell;
      burst(pl, px, py, isTetris ? 18 : 12, {
        angle: Math.PI / 2, spread: Math.PI * 2, // full radial ring
        speed: [60, isTetris ? 380 : 300], upBias: 70, gravity: 430,
        life: [0.5, 1.0], size: [2, 5],
        colors: [COLORS[type], COLORS[type], "#ffffff"]
      });
    }
  }
  if (isTetris) {
    // Extra ring from the board center for a big finish.
    burst(pl, COLS * pl.cell / 2, ROWS * pl.cell / 2, 40, {
      angle: Math.PI / 2, spread: Math.PI * 2,
      speed: [150, 520], upBias: 0, gravity: 300,
      life: [0.6, 1.1], size: [2, 4.5],
      colors: ["#ffd60a", "#ffffff", "#b44cff"]
    });
  }
}

// Small dust puff along the landing row after a hard drop.
function hardDropDust(pl, piece) {
  const bottomByCol = {};
  for (const [cx, cy] of pieceCells(piece)) {
    if (bottomByCol[cx] === undefined || cy > bottomByCol[cx]) bottomByCol[cx] = cy;
  }
  for (const cxStr in bottomByCol) {
    const cx = Number(cxStr);
    const py = (bottomByCol[cx] + 1) * pl.cell;
    burst(pl, (cx + 0.5) * pl.cell, py, rand(4, 7) | 0 || 5, {
      angle: -Math.PI / 2, spread: Math.PI * 0.8,
      speed: [40, 160], upBias: 30, gravity: 380,
      life: [0.25, 0.55], size: [1.5, 3],
      colors: ["#9aa3b2", "#ffffff"]
    });
  }
}

function updateParticles(pl, dt) {
  for (let i = pl.particles.length - 1; i >= 0; i--) {
    const pt = pl.particles[i];
    pt.life -= dt;
    if (pt.life <= 0) { pl.particles.splice(i, 1); continue; }
    pt.vy += pt.g * dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
  }
}

function drawParticles(pl, ctx) {
  if (pl.particles.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const pt of pl.particles) {
    const t = Math.max(pt.life / pt.maxLife, 0);
    ctx.globalAlpha = t;
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, Math.max(pt.size * (0.5 + t * 0.5), 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ============================================================
 * SCORE POPUPS (per-player) AND SCREEN SHAKE (global)
 * ============================================================ */
function addPopup(pl, text, x, y, size, color) {
  pl.popups.push({ text, x, y, t: 0, dur: 1.05, size, color });
}

function updatePopups(pl, dt) {
  for (let i = pl.popups.length - 1; i >= 0; i--) {
    const pp = pl.popups[i];
    pp.t += dt;
    if (pp.t >= pp.dur) pl.popups.splice(i, 1);
  }
}

function drawPopups(pl, ctx) {
  for (const pp of pl.popups) {
    const k = pp.t / pp.dur;
    ctx.save();
    ctx.globalAlpha = k < 0.6 ? 1 : Math.max(1 - (k - 0.6) / 0.4, 0);
    ctx.font = `800 ${pp.size}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = pp.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = pp.color;
    ctx.fillText(pp.text, pp.x, pp.y - k * 42);
    ctx.restore();
  }
}

const shake = { t: 0, dur: 0, mag: 0 };

function triggerShake(mag, durMs) {
  shake.mag = Math.max(shake.mag, mag);
  shake.dur = Math.max(shake.dur * (shake.t / (shake.dur || 1)), durMs / 1000);
  shake.t = shake.dur;
}

function updateShake(dt) {
  if (shake.t > 0) {
    shake.t -= dt;
    if (shake.t <= 0) { shake.mag = 0; }
  }
}
