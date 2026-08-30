// sfx.js — Synthesized sound effects via the Web Audio API (no audio files).
// The AudioContext is created lazily on first use and resumed on user gesture,
// so it satisfies browser autoplay policies (the match always starts from a
// click/keypress, by which time the context is running).
//
// In environments without Web Audio (e.g. jsdom tests) every function is a
// safe no-op — they never throw.
"use strict";

let _actx = null;
let _masterGain = null;

function _audio() {
  if (!_actx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) _actx = new AC();
    } catch (e) { _actx = null; }
  }
  if (_actx && _actx.state === "suspended") _actx.resume().catch(() => {});
  return _actx;
}

function _master() {
  const ctx = _audio();
  if (!ctx) return null;
  if (!_masterGain) {
    _masterGain = ctx.createGain();
    _masterGain.gain.value = 0.5; // keep SFX below the music
    _masterGain.connect(ctx.destination);
  }
  return _masterGain;
}

// One oscillator tone. slideTo ramps the frequency down/up for a "thud" feel.
function _tone(freq, dur, type, vol, when, slideTo) {
  const ctx = _audio();
  const g = _master();
  if (!ctx || !g) return;
  const t0 = ctx.currentTime + (when || 0);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "square";
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  gain.gain.setValueAtTime(vol || 0.3, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain); gain.connect(g);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

// A burst of decaying white noise (impact / crunch).
function _noise(dur, vol, when) {
  const ctx = _audio();
  const g = _master();
  if (!ctx || !g) return;
  const t0 = ctx.currentTime + (when || 0);
  const len = Math.max(1, (ctx.sampleRate * dur) | 0);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol || 0.3, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(gain); gain.connect(g);
  src.start(t0);
}

// ATTACK — the player cleared lines and is firing garbage at rivals.
// An ascending arpeggio; more lines = more notes, Tetris gets a top note.
function sfxAttack(n) {
  const base = [523, 659, 784, 1047]; // C5 E5 G5 C6
  const count = Math.min(4, Math.max(1, n | 0));
  for (let i = 0; i < count; i++) _tone(base[i], 0.12, "square", 0.25, i * 0.06);
  if (n >= 4) _tone(1568, 0.25, "square", 0.3, 0.24); // Tetris: extra high note
}

// GARBAGE HIT — garbage rows just landed on this player's board.
// A descending thud + noise impact; heavier for multiple rows.
function sfxGarbageHit(rows) {
  const r = Math.min(4, Math.max(1, rows | 0));
  _tone(220, 0.18, "sawtooth", 0.3, 0, 80);   // descending thud
  _noise(0.15, 0.25, 0);                        // impact crunch
  if (r >= 2) _tone(160, 0.2, "sawtooth", 0.25, 0.08, 60); // extra thud for multi-row
}

// OUT — a player has been eliminated (topped out / garbage overflow).
function sfxOut() {
  _tone(440, 0.15, "triangle", 0.3, 0, 220);
  _tone(220, 0.3, "triangle", 0.3, 0.12, 110);
}
