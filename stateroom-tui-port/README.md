# omp TUI look → stateroom-ui port specs

Five copy-ready implementation specs for bringing omp's terminal aesthetic
(palette, bottom-area structure, rich text conventions) into `stateroom-ui`.
Each doc names omp source files (ground truth, in
`~/src/omp-quota-router/packages/coding-agent/src/modes/`) and the stateroom
target file, with concrete values — no guessed hex, no invented structure.

| Doc | Piece | Target | Effort |
|---|---|---|---|
| [01-palette.md](01-palette.md) | Colour tokens: `dark.json` → `theme.rs` | `stateroom-ui/src/theme.rs` | hours |
| [02-footer-status-bar.md](02-footer-status-bar.md) | Footer + status-line structure | `stateroom-ui/src/chrome.rs` | ~1 day |
| [03-session-panel.md](03-session-panel.md) | Session panel: tool grounds, output grey, diffs, spinners | `stateroom-ui/src/element.rs` | ~1 day |
| [04-markdown-blocks.md](04-markdown-blocks.md) | Markdown richness: headings, quotes, code, bullets, links | `stateroom-ui/src/md.rs` + `element.rs` | ~1 day |
| [05-density.md](05-density.md) | Spacing/line-height tuning | `stateroom-ui/src/element.rs` constants | afternoon |

**Ground rules (apply to every doc):**

1. **Law 1** — styling lands on chrome, panels, and evidence only. Never a
   second render path for body blocks; provenance still only picks colour +
   label (`theme.rs::participant` stays the only provenance→colour site).
2. **Port one theme, not the theme engine.** omp's schema + 90+ theme JSONs
   stay in omp. `Palette::wire()` gets new *values*, not a loader.
3. **Borders/rules are GPUI quads, never box-drawing characters.** omp's cell
   grid does not transfer; stateroom shapes text runs.
4. **Colour never rides alone** (law 8) — every new colour use pairs with an
   existing glyph or label; nothing in these docs adds colour-only signals.

Suggested order: 01 → 02 (visible immediately) → 03 → 04 → 05 (tune last,
after the look exists).
