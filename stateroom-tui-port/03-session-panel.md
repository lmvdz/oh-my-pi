# 03 — Session panel: tool grounds, output grey, diffs, spinners → `element.rs`

**omp sources:**
- `dark.json` — `toolPendingBg #1d2129`, `toolSuccessBg #161a1f`,
  `toolErrorBg #291d1d`, `toolOutput: gray #777d88`, `toolTitle: ""` (bright),
  `toolDiffAdded green / toolDiffRemoved red / toolDiffContext gray`
- `packages/coding-agent/src/modes/components/bash-execution.ts`,
  `diff.ts`, `bordered-loader.ts` — the panel conventions (title line bright,
  output dim-grey, ground tint by state, loader with animated frames)
- `packages/coding-agent/src/modes/theme/symbols.ts` — spinner/icon presets

**Target:** `stateroom-ui/src/element.rs` — the session TUI panel
(`RowContent::Trace` branch, ~line 966+) and `ToolTone`.
**Effort:** ~1 day.

## Current stateroom behaviour

Session panel paints trace lines as shaped text with `ToolTone::{Ok, Busy,
Fail}` selecting accent colours; panel ground is the flat `term` colour;
spinner is `["|", "/", "—", "\\"]` at the panel bottom; mapped-write results
are text lines.

## Port spec

### A. Ground tint by state (the big feel change)

omp gives every tool/panel a **background tint by lifecycle state**. Map:

| Session state | Panel ground | omp token |
|---|---|---|
| run queued / turn pending | `tool_pending_bg #1d2129` | `toolPendingBg` |
| turn completed clean (last stop = Done) | `tool_success_bg #161a1f` | `toolSuccessBg` |
| failed / cancelled with error | `tool_error_bg #291d1d` | `toolErrorBg` |

Paint as the panel quad behind the transcript (stateroom already paints a
code-panel ground — same mechanism, `paint_quad` behind the session lines).
The tint is subtle by design: it must read at a glance as
"waiting/ok/broke" without touching the status glyphs (law 3: liveness/state
on the run record, epistemics on `s=` — the bg is *state*, never trust).

### B. Text roles inside the panel

| Line kind | Colour | omp convention |
|---|---|---|
| Header (`session_header`) | `tx0` bright + `sl_model` route chip | `toolTitle` bright |
| `t=call` title line | `tx1` | tool title line |
| `t=result` output text | `tx2` (→ `#777d88` after doc 01) | `toolOutput` grey |
| `t=say` agent prose | `tx1` | assistant text |
| `t=ask` (You) | `tx1`, label `sl_path` teal | user label |
| `t=deny` / error | `red` | error |
| timestamps/counts | `tx3` dim | footer dim |

Rule: **output is always the dimmest readable grey; titles bright; metadata
dimmest.** That hierarchy *is* the omp look.

### C. Diff rendering for mapped writes

Where a `t=result` line corresponds to a mapped file write (and later, the
`PortalTab::Changes` review pane), render diff lines omp-style:

- `+` lines: `grn #89d281` on `grnbg` (from `toolSuccessBg`-derived ground)
- `−` lines: `red #fc3a4b` on `redbg`
- context lines: `tx2` grey (`toolDiffContext`)
- hunk header `@@ … `: `sl_ctx` lavender (omp diff.ts convention)

The data exists: mapped writes already produce supersessions with old/new
block text — diff them line-by-line at paint time (or reuse whatever
`PortalTab::Changes` builds).

### D. Spinner vocabulary

Replace `["|", "/", "—", "\\"]` with omp-grade frames. omp's presets live in
`symbols.ts` (33KB of symbol tables with unicode/nerd variants). Minimal
unicode set that reads on GPUI (no nerd-font dependency):

```
⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏    (braille, 80ms)
```

Fallback (ascii-safe): `◐ ◒ ◓ ◑`. Keep the position rule already in
element.rs:1250 — **the working indicator lives at the bottom of the session,
where the next thing will happen** — and keep pairing it with the `turn`
phase text (`tool:Writing the plan section`) in `tx2` so the animation is
never the only signal (law 8).

### E. Panel chrome

- Header underline: 1px quad `line` (`#3d424a` after doc 01), never `─`
  characters.
- Prompt row ground when focused: `bg3 #1e1e24` with `❯` in `brass`.
- Rounded corners: omp is square in-terminal; stateroom's 3px radius is fine
  and reads equivalent at panel scale — keep it (no change).

## Law checks

- Ground tints encode run/turn **state** (lifecycle plane) — never epistemic
  status; `s=` glyphs unchanged (law 3).
- Diff colours pair with `+`/`−` glyphs (law 8).
- Panel is evidence surface (law 12): tints and text roles style the trace
  container only; effects outside stay ordinary body blocks.

## Acceptance

- Seeded session (`STATEROOM_SEED=session`): panel ground shifts
  pending-blue-grey → near-black-green as the run completes; a failed run
  (cancel fixture) shows the red-tinted ground.
- Tool result lines read dimmer than say-lines at a glance; call titles pop.
- Spinner animates braille frames with phase text beside it.
- A mapped write's result line (or Changes pane entry) shows green/red diff
  lines with grey context.
