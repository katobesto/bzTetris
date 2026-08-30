// constants.js — Board dimensions, piece shapes/colors, SRS kick tables, scoring and timing config.

"use strict";

/* ============================================================
 * CONFIG
 * ============================================================ */
const COLS = 10;
const ROWS = 20;
const CELL = 30;            // CSS pixels per cell on the board canvas
const MINI_CELL = 19;       // cell size for next/hold previews
const LOCK_DELAY_MS = 400;  // grace period before a grounded piece locks
const DAS_MS = 160;         // delayed auto shift: initial delay
const ARR_MS = 45;          // delayed auto shift: repeat rate
const MAX_PARTICLES = 600;

const COLORS = {
  I: "#00e5ff",
  O: "#ffd60a",
  T: "#b44cff",
  S: "#3ddc84",
  Z: "#ff4d6d",
  J: "#4d79ff",
  L: "#ff9f1c",
  G: "#8a8f98" // garbage (online attack rows)
};

const LINE_SCORES = [0, 100, 300, 500, 800]; // index = lines cleared at once
const CLEAR_ANIM_MS = 260;

/* ============================================================
 * UTILS
 * ============================================================ */
function rand(min, max) { return min + Math.random() * (max - min); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Lighten a #rrggbb color by `amt` percent toward white. Used for the top gradient of blocks.
function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.min(255, Math.round(r + (255 - r) * amt / 100));
  g = Math.min(255, Math.round(g + (255 - g) * amt / 100));
  b = Math.min(255, Math.round(b + (255 - b) * amt / 100));
  return `rgb(${r},${g},${b})`;
}

/* ============================================================
 * SRS PIECES, ROTATION AND KICK TABLES
 * ============================================================ */
const SHAPES = {
  I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  J: [[1,0,0],[1,1,1],[0,0,0]],
  L: [[0,0,1],[1,1,1],[0,0,0]],
  O: [[1,1],[1,1]],
  S: [[0,1,1],[1,1,0],[0,0,0]],
  T: [[0,1,0],[1,1,1],[0,0,0]],
  Z: [[1,1,0],[0,1,1],[0,0,0]]
};

const ROT_ORDER = ["0", "R", "2", "L"];

// Standard SRS wall-kick data. Tables use +y up; canvas uses +y down,
// so the y component is flipped when a kick is applied.
const KICKS_JLSTZ = {
  "0R": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  "R0": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  "R2": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  "2R": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  "2L": [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  "L2": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  "L0": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  "0L": [[0,0],[1,0],[1,1],[0,-2],[1,-2]]
};

const KICKS_I = {
  "0R": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  "R0": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  "R2": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
  "2R": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  "2L": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  "L2": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  "L0": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  "0L": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]]
};

function rotateMatrix(m, dir) {
  const n = m.length;
  const w = m[0].length;
  const out = Array.from({ length: w }, () => new Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < w; c++) {
      if (!m[r][c]) continue;
      // dir +1 = clockwise, -1 = counter-clockwise
      if (dir > 0) out[c][n - 1 - r] = 1;
      else         out[w - 1 - c][r] = 1;
    }
  }
  return out;
}

// Precompute all four SRS rotation states for each piece, indexed by ROT_ORDER state.
// pieceCells() looks the active matrix up here so rotation actually changes the shape.
const ROTATIONS = {};
for (const type of Object.keys(SHAPES)) {
  ROTATIONS[type] = {};
  let m = SHAPES[type];
  for (const st of ROT_ORDER) {
    ROTATIONS[type][st] = m;
    m = rotateMatrix(m, 1); // step clockwise to build the next state
  }
}

function spawnX(type) {
  if (type === "O") return 4;
  return 3; // width-3 and width-4 pieces
}
