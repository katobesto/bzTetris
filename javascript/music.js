// music.js — Background music: random track per match with automatic danger swap at the 70% stack-fill threshold.

"use strict";

/* ============================================================
 * MUSIC — random track per match, automatic danger swap
 * When a match starts, one of the two tracks is picked at
 * random (one global track for all players). While ANY alive
 * player's stack reaches DANGER_THRESHOLD of the board height,
 * playback swaps to that track's "- Danger" variant; it returns
 * to the normal track as soon as every stack drops below the
 * threshold again. Files live in music/.
 * ============================================================ */
const DANGER_THRESHOLD = 0.7;  // fraction of board height that triggers danger music
const MUSIC_FADE_MS = 300;      // crossfade duration when swapping tracks
const MUSIC_VOLUME = 0.7;

const TRACKS = {
  1: { normal: "01. MUSIC-1.mp3", danger: "02. MUSIC-1 - Danger.mp3" },
  2: { normal: "03. MUSIC-2.mp3", danger: "04. MUSIC-2 - Danger.mp3" },
};

// Pre-create the four looping players so track swaps are instant.
const musicAudio = {};
for (const k in TRACKS) {
  musicAudio[k] = {};
  for (const mode of ["normal", "danger"]) {
    const a = new Audio("music/" + TRACKS[k][mode]);
    a.preload = "auto";
    a.loop = true;
    a.volume = 0;
    musicAudio[k][mode] = a;
  }
}

let musicTrack = 0;    // 1 or 2, rolled when a game starts
let musicMode = "off"; // "off" | "normal" | "danger"
let musicFades = [];   // pending volume fades: { a, from, to, pauseAtEnd, t0 }

function fadeAudio(a, to, pauseAtEnd) {
  musicFades = musicFades.filter(f => f.a !== a);
  musicFades.push({ a, from: a.volume, to, pauseAtEnd: !!pauseAtEnd, t0: performance.now() });
}

function stepMusicFades(now) {
  if (!musicFades.length) return;
  const keep = [];
  for (const f of musicFades) {
    const k = Math.min(1, (now - f.t0) / MUSIC_FADE_MS);
    f.a.volume = f.from + (f.to - f.from) * k;
    if (k >= 1) { if (f.pauseAtEnd) f.a.pause(); }
    else keep.push(f);
  }
  musicFades = keep;
}

function startMusic() {
  musicTrack = Math.random() < 0.5 ? 1 : 2;
  for (const k in musicAudio)
    for (const mode of ["normal", "danger"]) {
      const a = musicAudio[k][mode];
      a.pause();
      a.volume = 0;
      if (mode === "normal") a.currentTime = 0;
    }
  musicFades = [];
  const n = musicAudio[musicTrack].normal;
  n.play().catch(() => {}); // startGame always runs from a user gesture
  fadeAudio(n, MUSIC_VOLUME);
  musicMode = "normal";
}

function stopMusic() {
  if (musicMode === "off") return; // never started — musicAudio[musicTrack] would be undefined
  for (const mode of ["normal", "danger"]) fadeAudio(musicAudio[musicTrack][mode], 0, true);
  musicMode = "off";
}

// Pause the current track in place: fade both variants out (only one is
// audible at a time) and keep the position so resumeMusic() continues there.
function pauseMusic() {
  if (musicMode === "off") return;
  fadeAudio(musicAudio[musicTrack].normal, 0, true);
  fadeAudio(musicAudio[musicTrack].danger, 0, true);
}

// Resume the track that was active when pauseMusic() ran.
function resumeMusic() {
  if (musicMode === "off") return;
  const a = musicAudio[musicTrack][musicMode];
  a.play().catch(() => {});
  fadeAudio(a, MUSIC_VOLUME);
}

// Stack height: rows from the floor up to the highest locked cell.
// Multiplayer: the max over all alive players (danger if ANY is >= threshold).
function stackHeight() {
  let best = 0;
  for (const pl of players) {
    if (!pl.alive) continue;
    for (let y = 0; y < ROWS; y++)
      if (pl.board[y].some(v => v !== null)) { best = Math.max(best, ROWS - y); break; }
  }
  return best;
}

function updateDangerMusic() {
  if (musicMode === "off") return;
  const danger = stackHeight() >= DANGER_THRESHOLD * ROWS;
  if (danger === (musicMode === "danger")) return;
  const n = musicAudio[musicTrack].normal;
  const d = musicAudio[musicTrack].danger;
  if (danger) {
    d.currentTime = 0;
    d.play().catch(() => {});
    fadeAudio(d, MUSIC_VOLUME);
    fadeAudio(n, 0, true); // fades out, keeps position to resume from
    musicMode = "danger";
  } else {
    fadeAudio(d, 0, true);
    n.play().catch(() => {}); // resumes where it was paused
    fadeAudio(n, MUSIC_VOLUME);
    musicMode = "normal";
  }
}
