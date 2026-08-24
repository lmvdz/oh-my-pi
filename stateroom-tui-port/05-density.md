# 05 — Density: line height, gaps, padding → omp tightness

**omp reference:** the terminal grid itself — line height = 1 cell, no
inter-block air beyond one blank line, panels padded 1 cell. omp's footer and
status line are single-cell rows with no vertical padding.
**Target:** `stateroom-ui/src/element.rs` layout constants (top of file).
**Effort:** an afternoon of tuning against a side-by-side window.

## Current constants

```rust
pub const LINE_HEIGHT: f32 = 20.0;   // element.rs:20
const PAD_X: f32 = 12.0;             // :27
const PAD_Y: f32 = 16.0;             // :28
const ROW_GAP: f32 = 4.0;            // :29
const MARKS_W: f32 = 140.0;          // :30
pub const CODE_PAD: f32 = 8.0;       // :24
```

At the default body font size, 20px line height is ~1.4× leading — comfortable
prose, visibly looser than a terminal.

## Target values (tune by eye, these are starting points)

| Constant | Current | Start at | Rationale |
|---|---|---|---|
| `LINE_HEIGHT` | 20.0 | **17.0** | ~1.2× leading at the body size — the single biggest "terminal density" lever. Do not go to exact 1.0×; proportional prose needs ≥1.15 to not collide descenders/IME marks |
| `ROW_GAP` | 4.0 | **2.0** | blocks read as one flow; blank-line rhythm comes from empty paragraphs, not gap |
| `PAD_Y` | 16.0 | **10.0** | canvas inset |
| `PAD_X` | 12.0 | **12.0** | keep — gutter needs it |
| `CODE_PAD` | 8.0 | **6.0** | code panels hug their text |
| `MARKS_W` | 140.0 | keep | marks column is stateroom-specific (threads/mentions) |

Session-panel internal leading (element.rs `TraceVisual` line stacking) uses
`LINE_HEIGHT` — it inherits the tightening automatically, which is what makes
the session TUI read like omp's transcript.

## Order of operations

1. Land docs 01–04 first. Density tuning on the old palette tells you
   nothing — omp's density reads *because* the colours are dim-correct.
2. Change `LINE_HEIGHT` + `ROW_GAP` only. Live with it for a session.
3. Then `PAD_Y`/`CODE_PAD`.
4. Check IME composition, grapheme editing, and the gutter grid at the new
   height before committing — hit-testing math all derives from
   `LINE_HEIGHT`, so a change is global by construction (that's why it's one
   constant).

## Acceptance

- Side-by-side with omp: session panel line rhythm is visually equivalent;
  body prose is tighter but still comfortable.
- No clipped descenders, no IME underline overlap, caret height still spans
  the full line.
- `tests/canvas.rs` click/selection tests still pass (they resolve through
  `RowLayout`, which derives from the constants — green here means the
  geometry stayed consistent).
