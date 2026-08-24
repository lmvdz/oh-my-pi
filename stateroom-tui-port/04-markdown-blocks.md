# 04 — Markdown richness: headings, quotes, code, bullets, links

**omp sources:**
- `dark.json` — `mdHeading #febc38`, `mdLink #0088fa`, `mdLinkUrl #5f6673`,
  `mdCode #e5c1ff`, `mdCodeBlock #9CDCFE`, `mdCodeBlockBorder gray`,
  `mdQuote gray`, `mdQuoteBorder #3d424a`, `mdHr #3d424a`,
  `mdListBullet #febc38`, plus the `syntax*` family (VS Code dark+)
- `packages/coding-agent/src/modes/markdown-prose.ts` — block rendering
  conventions (heading weight, quote bar, code fence border, bullet glyph)

**Targets:** `stateroom-ui/src/md.rs` (span kinds — already sufficient) and
`stateroom-ui/src/element.rs` (paint: inline colours + block treatments).
**Effort:** ~1 day. `md.rs` classification needs **no structural change** —
it already emits `Bold/Italic/Code/Strike/LinkText/LinkUrl/Marker/
ListMarker/QuoteMarker/Quote` spans; this doc re-colours and adds block-level
paint.

## A. Inline span → colour table (element.rs paint sites)

| `md::Inline` span | Colour | omp token |
|---|---|---|
| `Code` content | `md_code #e5c1ff` | `mdCode` |
| `Code` markers (backticks) | `tx3` dim | marker dimming (already stateroom's approach) |
| `LinkText` | `md_link #0088fa` | `mdLink` |
| `LinkUrl` | `md_link_url #5f6673` | `mdLinkUrl` |
| `Quote` content | `md_quote #777d88` | `mdQuote` |
| `QuoteMarker` / `Marker` | `tx3` dim | (stateroom already dims markers — keep) |
| `ListMarker` | `brass #febc38` | `mdListBullet` |
| `Bold` | `tx0` + bold face | (weight, not colour) |
| `Italic` | `tx1` + italic face | |
| `Strike` | `tx2` + strike-through deco | |

`chrome.rs::md_text` (the portal-grade StyledText path) gets the same table —
keep the two paint sites in lockstep or factor one helper.

## B. Block-level treatments (element.rs paint)

omp's block conventions, translated to quads + runs:

| Block | Treatment |
|---|---|
| Heading (h1/h2/h3) | text `md_heading #febc38`; h1 bright + bold, h2 bold, h3 semibold; sizes step down (omp scales ~1.5/1.3/1.15× body). Keep heading blocks' gutter glyph unchanged |
| Code block (fence) | panel ground `bg3 #1e1e24` (already painted) + **1px left border `line`** and text `md_code_block #9CDCFE` base with tree-sitter colours on top |
| Tree-sitter palette | re-token to omp `syntax*`: comment `#6A9955`, keyword `#569CD6`, function `#DCDCAA`, variable `#9CDCFE`, string `#CE9178`, number `#B5CEA8`, type `#4EC9B0`, operator/punct `#D4D4D4` |
| Quote block | **3px left bar** `mdQuoteBorder #3d424a` full block height + text `md_quote` grey (stateroom paints range decos already — a `paint_range` variant) |
| List | bullet glyph in `brass`; text normal; continuation indent unchanged |
| HR (`---`) | 1px quad `line` across text width (never `───` characters) |
| Link (block context) | text `md_link`, url dim — same as inline |

## C. Where each paint lands

- Inline colours: the per-run highlight construction in `element.rs`'s text
  painting (where `md::inline_spans` is consumed) — colour lookup switches
  from current ad-hoc values to the `Palette` md-family.
- Quote bar / HR / code border: new small `paint_quad` calls in the block
  paint path, keyed off `Row.kind` / leading span kind. Quote bar needs the
  row's quote-span presence (md.rs already reports `QuoteMarker`/`Quote` —
  no model change).
- Heading colour: `Row.kind == Heading` branch — colour by
  `heading_level`.

## D. What NOT to port

- omp's **cell-alignment** of code blocks (line-number gutters inside
  markdown fences) — stateroom's code editor rows already have their own
  gutter; don't double-gutter.
- ASCII box-drawing around blockquotes/fences — quads only (README rule 3).
- omp's export/HTML theming (`export.pageBg` etc. is already consumed by
  doc 01 for grounds; the HTML export pipeline itself is out of scope).

## Law checks

- Law 1: markdown styling applies to **all** body blocks regardless of
  provenance — human and agent prose get identical treatment. This doc adds
  no provenance branch anywhere.
- Law 8: every colour pairs with an existing glyph/marker (`**` markers still
  render dimmed in-source; quote bar accompanies `>` markers; bullets are
  still `- ` characters styled brass).
- Stream-is-document: live-styled markdown on streaming agent text works
  because classification is per-paint, never per-write — unchanged.

## Acceptance

- `STATEROOM_SEED=code demo`: heading amber and weight-stepped, code fence
  shows left border + `#9CDCFE`-based highlighting with green comments /
  blue keywords, list bullets brass, quote grey with dark left bar.
- Type `**bold**`, `` `code` ``, `> quote`, `- list` live: colours apply
  mid-typing; markers stay visible and dimmed.
- Same document rendered for a `~` agent block vs a human block: identical
  treatment (law 1 eyeball check).
