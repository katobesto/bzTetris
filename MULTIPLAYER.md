# TETRIS — Multiplayer Roadmap (planned)

Goal: up to 4 simultaneous players, each with their own gamepad, each play area rendered as its own column. This document is the plan; the input layer below is already built for it.

## What exists today (foundation)

- `ACTIONS` + `DEFAULT_BINDINGS`: logical actions (`left`, `right`, `down`, `rotateCW`, `rotateCCW`, `hardDrop`, `hold`, `pause`, `start`, `restart`, `settings`) mapped to keyboard keys and gamepad button indices. One binding set per player slot; slot 0 (Player 1) is the only one routed today.
- `dispatchAction(action)`: single entry point every input goes through. Multiplayer adds a slot parameter.
- `pressDir` / `releaseDir` + `heldDirs`: DAS/ARR auto-repeat is input-source agnostic — keyboard and gamepad already share it.
- `pollGamepad()`: Web Gamepad polling with edge detection; currently only the first connected pad (index 0).
- Settings/rebind UI + localStorage persistence (`tetris.settings.v1`): Player 1 only today.

## Target architecture

### Data model
- Extract the single-player globals (`board`, `piece`, `bag`, `queue`, `heldType`, `canHold`, `score`, `level`, `linesCleared`, `gravAcc`, `lockTimer`, `clearing`, `state`) into a `createPlayer(slot)` object: an isolated game instance.
- `players = []` (1–4 instances). All game logic functions take the player instance instead of touching globals.
- Particles / popups / shake: keep one shared FX engine but tag effects per column (position offset), or give each player a private FX canvas overlay. Decide at M2.

### Layout (columns)
- `.game-row` becomes a dynamic grid — 1 column (classic), 2 columns, or 4 side by side; each column = board canvas (10×20, scaled) + mini Next + mini Hold + score strip + player label + pad status dot.
- 4 columns: `grid-template-columns: repeat(4, 1fr)`; on narrow screens fall back to a 2×2 grid.
- One canvas per board (reuse the canvas setup and draw functions parameterized by ctx) — simpler than one wide canvas and matches per-player input.

### Input routing
- Slots: P1 = keyboard + pad 0, P2 = pad 1, P3 = pad 2, P4 = pad 3 (connection order; remapping is a later nicety).
- `BINDINGS[slot]` per slot (extend the settings UI to tabs P1–P4; storage key version bump `tetris.settings.v2`).
- `dispatchAction(slot, action)`; per-player `heldDirs` so each player's DAS is independent.
- `pollGamepad()` iterates all connected pads; pad index → slot.

### Match flow
1. Each player presses Start on their pad (P1: Enter) → that column enters "READY".
2. 1 player ready → classic solo mode (no behavior change). 2–4 ready → countdown, then everyone plays together.
3. Open questions (decide before M4):
   - Shared level/gravity: follow the leader (max level among players) vs per-player level.
   - Match end: last survivor standing vs first game over vs timed match.
   - Music: keep one global track; danger music if any player crosses the 70% threshold? Or per-player audio (Web Audio, up to 4 voices)?

## Milestones

- **M1 — Player extraction**: refactor the game core into `createPlayer(slot)`; 1-player mode pixel-identical to today. No visual change.
- **M2 — Two players, columns**: two columns, P1 keyboard + P2 pad 1, join via Start. Shared-FX decision lands here.
- **M3 — Four players**: four columns, pads 2–3, per-slot settings tabs.
- **M4 — Match rules**: leader level, end condition, winner overlay.
- **M5 — Polish**: pad remapping UI, connection indicators in each column, per-player audio.

## TO IMPLEMENT

Pulsar Enter o un boton del gamepad DEBE comenzar el juego. Ahora se queda bloqueado en la pantalla de seleccion de jugadores. Arregla esto. 

