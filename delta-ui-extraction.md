# Delta UI Extraction — design, elements, layouts

**Source:** `~/stateroom/research/Screenshot 2026-08-23 165641.png` — Zed Delta, a live session
("Cache SumTree node summaries across seeks", branch `main`, model chip "Claude
Fable 5", diffstat `+6 -4`). This is the product stateroom's PRD §2 benchmarks
against; the screenshot shows their shipped session UX.

**Purpose:** inventory what they built, then map each element onto
`stateroom-ui` surfaces (chrome / view / element / model / vocab) with law
compliance noted. Colors are approximations from a dark screenshot, not
sampled tokens.

---

## 1. Layout anatomy

Three vertical panes, roughly 24% / 43% / 33%:

```
┌──────────┬───────────────────────────┬──────────────────────┐
│ sidebar  │ session / conversation    │ review changes       │
│ ~230px   │ ~410px                    │ ~390px               │
│          │                           │                      │
│ Pinned   │ header: title + avatars   │ header: "Review      │
│ Projects │ selected prose (blue sel) │  Changes" + controls │
│  zed     │ compact turn cards        │ scope: Uncommitted ⌄ │
│  gpui ▸  │ agent turns: evidence row │ diffstat: +6 -4      │
│  cosmic- │  + response prose         │ file: sum_tree.rs ⌄  │
│   text ▸ │                           │ code diff, line nums │
│ Threads  │ status strip: delta·main  │ +/- gutter marks     │
│          │  +6 -4 · attach · mic ·   │ red/green hunks      │
│ user chip│  model chip · Local chip  │                      │
└──────────┴───────────────────────────┴──────────────────────┘
```

Key observation: **the conversation pane is a narrow column, not the whole
window.** The artifact (code review) is a peer pane. The document/conversation
stays primary; the review of *what the agent did to the artifact* gets its own
surface.

## 2. Element inventory

### Left sidebar — work management
- **Section labels** (`Pinned`, `Projects`, `Threads`) — small caps, muted.
- **Task/thread rows**: one line, truncated, icon + text. Icons encode live
  state: **spinner** = running now, **hollow dot** = pending/queued, plain =
  done/idle. This is a run-status legend without labels (state → icon, same
  discipline as our vocab tables).
- **Projects as expandable groups** (`zed`, `gpui`, `cosmic-text`) with nested
  threads — sessions are grouped by artifact, not by time.
- **User chip** pinned bottom: avatar + name + org ("nathansobo · Zed ⌄").
- Top row: sidebar toggle, search, new-item affordances.

### Center pane — the session
- **Header**: bold session title + **avatar cluster** (3 overlapping
  participants) + pane controls. Presence roster lives in the header.
- **Selectable prose mid-conversation**: a multi-line paragraph under a blue
  selection — the transcript is real text you can select/copy (our law 10).
- **Compact turn cards**: short user messages render as small bordered
  rounded-rect cards, avatar left, one line each. Low-height, clearly
  bounded — visual unit = "one utterance".
- **Agent turn anatomy** (the important pattern):
  1. avatar + name row,
  2. **collapsed evidence row**: muted "Thought 1 time, read 3 files ›" —
     one line, chevron, counts instead of content,
  3. the response prose with inline code styled (`SummaryCache`,
     `Cursor::seek`).
  Evidence is *summarized, not hidden*: counts + chevron invite expansion.
- **Bottom status strip** (per-pane, not global): project name · branch chip ·
  **diffstat chip `+6 -4`** (green/red) · attach icon · mic icon · **model
  chip "Claude Fable 5"** with AI glyph · **locality chip "Local"**. The
  model/route and the blast radius of pending changes are always visible.

### Right pane — Review Changes
- Header + view controls (jump, settings, layout, close).
- **Scope selector**: "Uncommitted ⌄" + diffstat chip — review scope is a
  choice (uncommitted now; presumably bases/branches later).
- **File breadcrumb**: `sum_tree.rs crates/sum_tree/src/ ⌄` — review is
  file-scoped, switchable.
- **Code diff**: line numbers, **left gutter +/- marks**, red/green line
  tints, syntax-highlighted Rust. Two hunks visible: an enum field addition
  and a function-body change. Classic review surface, done at full pane width.

## 3. Visual language

- **Palette**: near-black panels with subtle luminance steps between panes
  (sidebar darkest, editor mid, review mid); hairline borders; muted gray
  secondary text; blue selection; green/red diff tints; white primary text.
- **Type**: small dense sans for chrome and prose; monospace for code and
  chips; evidence rows smaller and muted relative to responses.
- **Shape language**: rounded-rect cards with thin borders for utterances;
  circular avatars for humans; **the AI avatar is a rounded-square glyph** —
  actor class encoded in *shape*, not color alone (our law 8, their practice).
- **Chips**: pill/rounded-rect chips for branch, diffstat, model, locality —
  metadata rides in labeled chips, never bare text.
- **Avatars**: per-participant identity, overlapping cluster in headers;
  every turn attributed by avatar (identity at point of read).

## 4. Interaction patterns

1. **Evidence collapse with counts** — "Thought 1 time, read 3 files ›".
   Default hides detail, advertises volume, one click expands.
2. **Live state as icon** — spinners in the sidebar mean "running now";
   glanceable fleet status without opening anything.
3. **Review pairing** — conversation pane and review pane are peers; reading
   what the agent *said* and what it *changed* are two panes of one layout.
4. **Scope + diffstat** — review has an explicit scope selector and a
   +N −M summary; blast radius is quantified before you read a hunk.
5. **Model/route visibility** — the active model is a persistent chip in the
   session strip, switchable (our RouteBadge intent, their placement).
6. **Mid-stream selection** — prose inside the conversation selects like a
   document (supports copy/comment-anchoring).

## 5. Mapping to stateroom-ui

| # | Delta element | Stateroom surface today | Suggested application | Law check |
|---|---|---|---|---|
| 1 | Collapsed evidence row w/ counts ("Thought 1 time, read 3 files ›") | `TraceSize::Collapsed` shows session header only (element.rs) | Collapsed container renders one muted line: step counts derived from trace lines (N calls · N results · N thoughts) + chevron. Counts from `TraceContainer.lines` — derived, never stored | Law 12 ok (still one container); law 8 ok (label + count, not color) |
| 2 | Review Changes pane (file-scoped diff, +/− gutter) | Effects listed as text inside full-size session panel ("effects (N) — what this session wrote") | Contextual review pane paired to the focused session: each mapped write renders as before→after supersession diff (old block vs new), file-chip per target. Open from the effects row; closes with the session. Not a permanent rail (we removed that deliberately) | Law 12 ok — effects are already separate blocks; this only *views* them. Law 1 ok — it's a review surface, not a render path for body blocks |
| 3 | Diffstat chip `+6 -4` | Effects count only | Per-session chip in session header: `+N −M` computed from the session's effects (inserted chars vs superseded chars). Also a doc-level chip in chrome status bar = unsealed changes since last base (pairs with seal/bases, D17) | None — derived metadata |
| 4 | Model chip "Claude Fable 5" | Route badge exists in vocab (`t=route`, run record `route`); status bar has tok ticker | Persistent route chip in session header (agent + route), flashes on RouteChanged — PRD FR-4 `<RouteBadge>` placement, Delta validates it belongs in the session strip, not the doc margin | Law 3 ok — route is provenance/lifecycle, not epistemic status |
| 5 | Locality chip "Local" | Connection chip in chrome status bar (`ConnectionState`, fails closed) | Keep; Delta confirms locality belongs in a chip. Optionally mirror per-session (session spawned local vs workspace) once FR-3A lands | Law 7 ok — same fail-closed resolver |
| 6 | Sidebar threads w/ live spinners, grouped by project | No rail (removed 2026-08-23); running count in status bar only | When a doc carries >~3 sessions: left rail listing runs — icon from `run_label`/`ToolState` vocab (queued ○ / running spinner / done / failed ✗), grouped by… nothing yet (single doc). Entry click scrolls to + expands that session block. Keep it *opt-in chrome*, not a default pane | None — navigation only; canvas remains the surface (matches our rail removal rationale) |
| 7 | Avatar cluster in session header | `author_change` labels in gutter; session header shows agent name | Overlapping participant chips in session header: agent + operator (from run record author). Shape-differentiated: circle = human, rounded-square = agent (adopt their shape trick; it satisfies law 8 better than hue alone) | Law 8 ok; law 1 ok (header is chrome) |
| 8 | Turn cards (bordered compact utterances) | `t=ask` / `t=say` lines render as plain shaped text in the panel | Style human asks (`t=ask`) as bordered compact cards inside the session panel; agent `t=say` stays plain prose. This is *evidence styling inside one container*, not body-block geometry — but it does break ask/say symmetry. Decide explicitly: readability vs strict one-path | ⚠ Law 1 adjacent — allowed reading: provenance picks treatment of *evidence lines* (we already label ask "You" vs say "Agent"). Document the ruling if adopted |
| 9 | Selectable prose mid-conversation | Already true — stream is document, hit-tests at char level | Nothing to adopt; validation of law 10 | ✓ already ours |
| 10 | Bottom strip chips (branch/diffstat/model/locality) | chrome.rs status bar: connection + running + tok ticker | Add doc-level chips: base/seal state ("since `q3-plan` base"), pending diffstat, active route. Same strip, richer metadata | None |
| 11 | Inline code styling in responses | md.rs live markdown already styles `` `code` `` | Nothing to adopt | ✓ already ours |

## 6. What NOT to copy

- **A bottom composer / send bar.** Their strip is status+model chips, not a
  required input; keep it that way. Our law 2 (composer is the cursor) and the
  per-session prompt row (`❯ message {agent}`) already cover input.
- **Chat-bubble geometry for body blocks.** Cards for utterances live only
  inside session evidence; the document body stays one render path (law 1).
- **A permanent right rail.** We removed ours yesterday; Delta's review pane
  is *contextual* (pairs with a focused session). Build it as a paired view,
  not fixed furniture.
- **Hiding evidence behind counts only.** Their chevron expands; our trace
  sizes + LIFT already go further (law 12 liftable lines). Adopt their
  *count summary*, keep our expansion.

## 7. Build-order suggestion (smallest first)

1. Collapsed-trace count line (model.rs derive + element.rs paint) — hours.
2. Session-header chips: route + `+N −M` diffstat + participant shapes.
3. Doc-level diffstat/base chip in chrome status bar.
4. Contextual review pane for a session's effects (supersession diffs) —
   the real feature; pair open/close with session focus.
5. Optional runs rail (only when session count grows; reuse vocab icons).
