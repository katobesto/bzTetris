# TETRIS — Status & Testing Plan

## What's done

### Core game engine (`index.html`, ~1100 lines)
- **SRS rotation** with full kick tables for all 7 pieces (I, J, L, O, S, T, Z). CW/CCW rotation verified via unit tests (8 groups passed: roundtrip, cell count, piece-specific orientation, kick table completeness).
- **7-bag randomizer** — standard Tetris randomizer (bag shuffles, next 3 queued).
- **Board logic** — collision detection (walls, floor, locked blocks), piece locking, row clearing, score/level/lines tracking, gravity curve (`Math.max(1000 × 0.85^(level-1), 70)` ms).
- **Hold system** (C key) — swap current piece with held, one hold per drop.
- **Pause** (P/Esc) — overlay with resume.
- **Game over** — overlay with final score, restart (R).

### Visuals
- Dark theme with radial gradient background, neon glow accents.
- Board: 10×20 cells, 30px each, devicePixelRatio-aware canvas scaling.
- Right panel with glassmorphism cards: Next queue (3 pieces), Hold slot, Score/Level/Lines stats, Controls legend.
- Title "TETRIS" with animated gradient text.
- Tetromino colors: vivid modernized palette (cyan, yellow, purple, green, red, blue, orange).
- Each cell drawn with vertical gradient (lighter top), darker border, inner highlight for "juicy" look.
- Ghost piece: translucent outline at landing position.

### Particle system (canvas-based, additive blending)
- **Collision sparks** — 4–8 sparks per contact cell when a piece locks (piece color + white sparks, short life, upward bias).
- **Line-clear explosion** — 10–16 particles per cleared cell, radial burst, gravity pull, horizontal flash/shockwave band. Tetris (4 lines) gets extra: more particles per cell + ring of sparks from board center.
- **Score popups** — floating text rising ~40px and fading over ~1s: "+100", "+300 DOUBLE!", "+500 TRIPLE!", "+800 TETRIS!" (tetris popup larger, gold).
- **Hard-drop dust** — 6–10 gray/white particles along landing row + subtle screen shake (±3px decaying for ~120ms).
- Particle engine: capped at 600, framerate-independent (delta time), additive blending (`lighter`).

### Input handling
- Keyboard controls with DAS/ARR (Delayed Auto Shift / Auto Repeat Rate): 160ms initial delay, 45ms repeat.
- PreventDefault on arrows/space to stop page scrolling.

## Known bugs (FIXED but NOT YET VERIFIED)

### `ArrowDown` drift bug
**Symptom**: Holding `ArrowDown` caused the piece to drift right instead of just dropping.
**Root cause**: The original `dasStep` function called `Object.keys(heldDirs)` (which includes `"down"`) to determine `moveDir`. When only `ArrowDown` was held, `moveDir` was set to `"down"`, then `tryMove(moveDir === "left" ? -1 : 1)` evaluated `tryMove(1)` — moving the piece right.
**Fix applied**: Replaced the broken logic with a filtered approach: horizontal DAS now only processes `"left"` and `"right"` keys (`Object.keys(heldDirs).filter(d => d === "left" || d === "right")`), and a separate `heldDirs.down` check handles soft drop. The edit was submitted but the `oldString` didn't match (file may have been modified by a prior edit). **Needs verification: reload page and hold `ArrowDown` — piece should drop straight down without drifting.**

## What still needs testing (in priority order)

### 1. DAS fix verification
- Reload the page.
- Hold `ArrowDown` for ~500ms.
- **Expected**: Piece drops straight down, x-position unchanged.
- **If still drifting**: The edit didn't apply — the file still has the broken `dasStep`. Need to re-apply the fix.

### 2. Key swap: Space ↔ ArrowUp
**Current mapping** (before fix):
| Key | Action |
|---|---|
| `Space` | Hard drop (instant land, +2pts/cell) |
| `ArrowUp` / `X` | Rotate CW |
| `Z` | Rotate CCW |

**Requested mapping**:
| Key | Action |
|---|---|
| `Space` | **Rotate CW** (replaces ArrowUp) |
| `ArrowUp` | **Hard drop** (instant land, +2pts/cell, replaces Space) |
| `Z` | Rotate CCW (unchanged) |

This requires changing the `keydown` handler in the `switch` block:
- `case " ":` → call `tryRotate(1)` (CW rotation) instead of `hardDrop()`
- `case "ArrowUp":` → call `hardDrop()` instead of `tryRotate(1)`
- Update the controls legend card text to reflect the new mapping.

### 3. Particle system visual verification
- Lock a piece on top of other blocks → should see **collision sparks** (colored + white, short burst at contact points).
- Clear 1–4 lines → should see **line explosions** (radial burst per cell, horizontal flash band, score popups).
- Hard drop (with new Space=rotate, so hard drop = ArrowUp) → should see **dust puff** + **screen shake**.
- Tetris (4 lines) → should see **extra particles** + **center ring** + **larger gold popup** + **bigger screen shake**.

### 4. Ghost piece
- Spawn a piece, move it horizontally → should see a translucent outline showing where it will land.

### 5. Hold system (C key)
- Spawn a piece, press C → piece should swap with the one in the Hold slot (displayed on the right panel).
- Press C again immediately → should be blocked (one hold per drop).

### 6. Next queue (right panel)
- Should show 3 upcoming pieces, updating as pieces are spawned.

### 7. Scoring & leveling
- Clear 1/2/3/4 lines → score should increase by 100/300/500/800 × level.
- Every 10 lines → level increases, gravity speeds up.

### 8. Pause / Resume (P / Esc)
- Pause should show "PAUSED" overlay.
- Press P or Esc → game resumes from same state.

### 9. Game Over
- Fill the board until a new spawn collides immediately → "GAME OVER" overlay with final score.
- Press R or Enter → restart from scratch.

### 10. Controls legend
- After key swap, the legend card should list:
  ```
  Move: ← →
  Rotate: Space
  Hard drop: ↑
  Rotate CCW: Z
  Soft drop: ↓
  Hold: C
  Pause: P / Esc
  Restart: R
  ```

## Test sequence (once everything is fixed)

1. **Reload page** → verify "TETRIS" overlay + "Press Enter or click to start".
2. **Press Enter** → game starts, first piece spawns, ghost visible, next/hold panels populated.
3. **Move left/right** (← →) → piece moves without drifting.
4. **Hold ArrowDown** → piece drops straight down, no horizontal drift.
5. **Press Space** → piece rotates CW (not hard drop).
6. **Press ArrowUp** → piece hard drops to bottom, dust + shake visible, score +2/cell.
7. **Press Z** → piece rotates CCW.
8. **Press C** → piece swaps to Hold, next piece spawns.
9. **Clear lines** → explosions, score popups, flash band visible.
10. **Clear 4 lines (Tetris)** → extra particles, center ring, gold popup, bigger shake.
11. **Press P** → pause overlay. **Press P again** → resume.
12. **Play until game over** → overlay with final score.
13. **Press R** → restart, score resets to 0.
14. **Blur window** (click outside) → game auto-pauses.

## Files

- `/Users/javiermac/Documents/Opencode/GentleTest/TETRIS/index.html` — single self-contained HTML file, ~1100 lines, zero external dependencies.
- `/Users/javiermac/Documents/Opencode/GentleTest/TETRIS/AGENTS.md` — this file.
