# 02 — Footer + status bar: omp's bottom area → `chrome.rs`

**omp sources:**
- `packages/coding-agent/src/modes/components/footer.ts` (two-line dim footer)
- `packages/coding-agent/src/modes/components/status-line/segments.ts`
  (segment registry with per-segment colours)
- `packages/coding-agent/src/modes/components/status-line/context-thresholds.ts`
  (context % → colour escalation)

**Target:** `stateroom-ui/src/chrome.rs` — `AppShell` status bar (currently:
connection · running count · tok ticker · notice) and session headers.
**Effort:** ~1 day. All data already exists in stateroom; this is layout +
colour + threshold logic.

## What omp's bottom area actually is

Two components stacked:

1. **Footer** (footer.ts `render()`): line 1 = `~/path (branch)` dim; line 2 =
   left `↑in ↓out RcacheRead WcacheWrite $cost ctx%` + right `model • thinking`,
   the whole line dim **except** the context %, which escalates
   muted → warning → error by threshold.
2. **Status line** (segments.ts): a configurable segment strip — each segment
   a `(glyph?, text, themeColor)` triple: `pi · model · mode · path · git ·
   pr · subagents · tokens-in/out/total/rate · cost · context% · time ·
   session · cache · usage`. Colours from the `statusLine*` family (doc 01).

The feel: **dim by default, colour only where it means state** — exactly
stateroom's law-8 instinct.

## Port spec

### A. Footer → `AppShell` status bar, two-line form

Replace the current single-line status bar with:

```
line 1 (tx3/dim):   ~/docs/q3-plan · base "kickoff" ●sealed
line 2 (dim):       ↑12.3k ↓4.5k R89k $1.24 42%   ····   omp acp • analyst
```

- **Line 1 left:** doc title + current base name + seal state glyph.
  Source: `DocModel.state` / covenant bases. Colour: `sl_git_ok` when sealed,
  `sl_git_dirty` when unsealed changes exist (omp's git clean/dirty semantics
  map exactly onto seal state).
- **Line 2 left — session stats** (aggregate across the doc's runs, from run
  records `usage`):
  - `↑in` `↓out` — `formatNumber` compact (12.3k, 1.2M — copy omp's
    `formatNumber`)
  - `R` cache-read, `W` cache-write when non-zero (omp footer.ts:153–156)
  - `$cost` — sum of `usage.cost`, 3 decimals, `sl_cost` colour
    (footer.ts:162–179; subscription/`S` prefix not applicable — drop)
  - **context %** — per *live session*: `SessionState.usage = (used, size)`
    already flows (`UsageUpdate`); show the focused session's `used/size` as
    percent with omp's threshold escalation:
    | level | condition | colour |
    |---|---|---|
    | ok | < 60% | `sl_ctx` lavender |
    | warn | 60–85% | `amb #e4c00f` |
    | error | > 85% | `red #fc3a4b` |
    (mirror `context-thresholds.ts`; exact breakpoints there if you want
    parity — the shape is what matters)
- **Line 2 right:** focused/last-active session's agent + route:
  `omp acp • analyst` with model/route in `sl_model` pink. Source: run
  record `route` + agents map name. This is the RouteBadge placement the
  Delta extraction called for (extraction #4) — same chip, omp colours.
- **Everything else stays dim** (`tx3`). omp dims each span independently
  around the coloured context % (footer.ts:247–253) — in GPUI this is
  trivial: per-run highlights, dim runs + one coloured run.

### B. Status-line segments → session header chips

`segments.ts` registry → chips in the session panel header (element.rs
`session_header`). Segment → chip table:

| omp segment | stateroom chip | colour | source |
|---|---|---|---|
| model | route (`switchyard/strong`) | `sl_model` | run record `route` |
| path | mapped-file target of last write | `sl_path` | effects list |
| git | seal state | `sl_git_ok/dirty` | document state |
| tokens in/out | `↑↓` pair | dim | run `usage` |
| cost | `$x.xxx` | `sl_cost` | run `usage.cost` |
| context% | `used/size` | threshold trio | `SessionState.usage` |
| time | turn wall time | dim | run timestamps |
| subagents | N live sessions | `brass` | live_session_runs() |
| mode | interactive/one-shot | dim | session kind |

Keep the chip grammar omp uses: `glyph text` pairs separated by `sl_sep`
`│` or `·`, single mono line, truncate middle-out.

### C. Notices

omp renders extension statuses as an extra dim footer line
(footer.ts:256–264). Stateroom's `notice` field maps to this: render
notices as a third dim line, never a modal.

## Law checks

- Law 8: threshold escalation pairs colour with the numeric percent (number
  always visible) — colour is never the only signal.
- Law 3: seal-state colour says *authority* state, not liveness; liveness
  stays in run status/presence. No overlap.
- Law 1: chrome only; nothing here renders body blocks.

## Acceptance

- `STATEROOM_SEED=session demo`: status bar reads as two dim lines with one
  lavender/amber context % and a pink model chip; sealed doc shows green
  base chip.
- Start a live `omp acp` session: `↑↓` counters tick per turn, `$` accumulates,
  context % escalates colour at thresholds.
- With zero sessions: line 2 left shows doc totals or hides cleanly (no
  `↑0 ↓0` noise — omp omits zero parts, footer.ts:153).
