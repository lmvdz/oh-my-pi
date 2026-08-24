# D19 — Artifact / Process / Map layering, outline presence, gutter-fold sessions

**Status:** proposed (design session 2026-08-23)
**Extends:** D11 (runs, mentions, three-plane rule), D18 (trace and effects),
D17 (base retention / seal), D02 (block schema), phase-2 UI (TraceSize,
projection, chrome)
**Origin:** Delta UI extraction (`research/delta-ui-extraction.md`) + the
observation that interactive sessions already keep process out of the body —
the only inline residue is the trace container itself. This record rules the
presentational and navigation layer that completes that separation.

## Resolution

### 1. Three layers, one substrate

| Layer | What | Where it lives | Shares/references |
|---|---|---|---|
| **Artifact** | the document a reader is meant to read — effects as ordinary blocks | CRDT body (unchanged) | sealed to a base (D17); exports to markdown |
| **Process** | sessions: conversation (`t=say`/`t=ask`), tool calls, plans, journals | CRDT trace blocks + run records + journals (unchanged, D11/D18) | anchored to regions via `run=` and run-record `scope` |
| **Map** | outline + presence: who is where, what is running | **derived render state only — nothing stored** | reads artifact + process layers |

Nothing in this record adds a stored field. The map layer must be derivable
by any replica from (body, runs, awareness) alone — live-and-replay applies
to it like everything else.

### 2. Markdown is the export, never the base

The block schema (D02) carries provenance, status, spans, run attribution,
and identity-anchored certifications. Markdown carries none of them. Ruling:

- The **base stays blocks**. Actor floor and anchors-bind-to-identity are the
  two hardest properties to retrofit; markdown as base loses both.
- A **sealed base serializes to clean markdown** (headings, paragraphs, code,
  lists, quotes, images). Provenance may be rendered as optional footnotes;
  status glyphs and traces never leak into the export.
- **Cross-document references** use `base + BlockId` (both CRDT-native,
  D17/D02). A referenced span from a sealed base is stable content; a
  reference into an unsealed working layer is a live link and degrades like
  any anchor (law 7).

### 3. The outline pane (left) is the map

A left pane listing the heading tree. Every row derived per §4. One row per
section (heading through next same-or-higher heading):

```
Q3 rollout plan
├─ Background        ●maya
├─ Wave plan         ▣analyst⟳  ▣scout⟳
├─ Risks             ▣analyst✓  ✗scout
└─ Timeline          ●maya ●leo
```

- **Avatar shape language (adopted from Delta):** circle = human,
  rounded-square = agent. Shape carries actor class; hue carries participant
  slot (law 8: shape + label, never color alone — the outline is chrome, but
  the rule holds).
- **Agent state ring:** animated ring/arc while `RunStatus::Running` (the
  run-record `turn` phase is the animation source: `working · thinking ·
  tool:<title> · replying`); static ✓ on done; ✗ tint on failed; hollow ○
  queued. All from `RunStatus` + `turn` — no new state.
- **Interactions:** click section → scroll canvas to it; click agent avatar →
  focus that session (expand inline to its previous size, or open the
  effects-review pane when built); click human cluster → no-op (presence
  only). Double-click section → collapse/expand its subtree.
- **Viewport indicator:** sections currently on screen are marked; the
  current-caret section is highlighted.
- The outline is **chrome, opt-in, default-on for documents with ≥1 heading
  and ≥1 session**; a flat prose doc hides it. It never renders body content.

### 4. Derivation rules (all map state)

| Map datum | Derived from |
|---|---|
| Section tree + ranges | heading blocks in `DocModel` rows; range = [heading, next same-or-higher heading) |
| Humans in section | `Peer.cursor`/selection block ∈ range (awareness) |
| Agents in section | run record `scope` ∩ range, else anchor block ∈ range |
| Agent status | `RunStatus` (queued/running/done/failed/cancelled) |
| Agent activity animation | run-record open-map key `turn` (already written once per phase transition by the adapter) |
| Session home when scope spans sections | the section containing the run's anchor block. Whole-doc scope → document root row. **One home, never duplicated.** |
| Completed-session pile-up | cluster per section with counts (e.g. `▣✓×2 ✗×1`) beyond three avatars |

### 5. Gutter-fold: the fourth TraceSize

`TraceSize::Gutter` — below Collapsed. The session's trace container renders
as a **right-gutter mark**: avatar + state ring, zero inline height. The
blocks stay in the CRDT; only the render changes (law 1 unaffected — this is
a size, not a second render path).

Session size lifecycle:

1. **Spawned/live** → `Expanded` (you summoned it; you are watching).
   Stream-is-document applies to its effects as always.
2. **Turn completes** (`RunStatus` leaves `Running`, or `turn` clears) →
   **auto-fold to `Gutter`** unless the reader pinned the container open
   (pin = view-local, like projection; never stored).
3. **Reader folds manually** at any size → `Gutter`.
4. **Reading projection** (`Projection::READING`) → gutter marks hidden
   entirely; the document is pure artifact.

The gutter mark is a click target: click → restore previous size at the
session's anchor. Hover → phase tooltip (`tool:Writing the plan section`).

### 6. Law checks

- **Law 1 (one render path):** Gutter is a `TraceSize`, same mechanism as
  Collapsed/Expanded/Full. No `if agent` branch; avatars render for humans
  too (presence clusters).
- **Law 3 (trust ⊥ liveness):** the state ring animates liveness; it never
  touches `s=`.
- **Law 7 (no false ✓):** unknown `turn` phase → no ring, static avatar;
  disconnected replica → outline shows last-known presence with the
  connection chip already failing closed. The map degrades with the doc.
- **Law 8:** shape + hue + label; animation is motion, not the only signal —
  queued/running/done/failed each have a distinct static form.
- **Law 12 (trace ≠ effects):** unchanged; Gutter only shrinks where evidence
  *paints*, never where it *lands*. Effects always land as body blocks.

## Consequences

- The artifact reads clean at rest without an export step; sharing = seal +
  markdown export (§2).
- Multi-session documents become navigable: the question "where is the
  action" is answered by the outline before any scrolling.
- Zero schema change; the entire feature is derive + render + two view-local
  pins (outline visibility, per-container pin-open). Two replicas derive
  identical maps independently.
- Delta's left rail is superseded by a document-native map: grouped by the
  artifact's own structure, not by session lists.
- The effects-review pane (Delta extraction #2) slots in later as the
  avatar-click alternate target without touching this ruling.

## Build order (smallest first)

1. `TraceSize::Gutter` + auto-fold-on-completion + pin-open (model.rs,
   element.rs, view.rs) — the decluttering win standalone.
2. Outline pane: section tree + humans (awareness) + viewport indicator.
3. Agent avatars in outline + gutter marks from run records (`scope`, `turn`,
   `RunStatus`).
4. Markdown export of a sealed base (D17 pair).
5. Effects-review pane as second avatar-click target (Delta extraction #2).

## Reopen if

- Documents emerge whose primary content *is* process (e.g. a session
  transcript as the deliverable) — then process-as-artifact needs first-class
  blocks and this layering needs an explicit escape hatch.
- Whole-doc agent scopes dominate (agents writing everywhere at once) — the
  one-home pinning rule may need a "spans everything" root treatment with
  per-section activity dots instead.
- Outline presence proves noisy at high peer counts (>~8 concurrent) —
  cluster + counts may need to become the default earlier.
