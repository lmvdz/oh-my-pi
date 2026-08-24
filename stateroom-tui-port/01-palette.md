# 01 — Palette: omp `dark.json` → `stateroom-ui/src/theme.rs`

**omp source:** `packages/coding-agent/src/modes/theme/dark.json` (the default
dark theme; also the base most bundled themes derive from).
**Target:** `Palette::wire()` in `stateroom-ui/src/theme.rs`.
**Effort:** hours. Pure token translation; no call-site changes if roles keep
their names.

## Principle

omp's palette is: near-black grounds, a 4-step grey text ramp, one warm accent
(brass/amber), semantic green/red/yellow, and a *separate* family of
status-line colours (pink model, teal path, lavender context) that give the
bottom area its identity. Stateroom already has the same *shape* of palette
(`tx0–tx3` ramp, `brass`, `grn/amb/red` + bg tints, `slots`). The port
re-values stateroom's tokens and adds the missing status-line + markdown
roles.

## Token mapping

### Grounds and text ramp

| Stateroom token | Current | → omp value | omp source |
|---|---|---|---|
| `bg0` (page) | `0x101312` | `#18181e` | `export.pageBg` |
| `term` (session ground) | `0x0b0d0c` | `#121212` | `statusLineBg` |
| `bg3` (panel) | `0x141817` | `#1e1e24` | `export.cardBg` |
| `bg6` (raised panel) | `0x1a1f1d` | `#26262e` | `export.infoBg` |
| `line` | `0x22282a` | `#3d424a` | `darkGray` |
| `line2` | `0x2c3335` | `#5f6673` | `dimGray` |
| `tx0` (bright text) | `0xe6ece7` | `#e8e8e8`* | terminal default fg — pick `#e8e8e8` |
| `tx1` (body text) | `0xc9d2cb` | `#d4d4d4` | `syntaxOperator` (omp's working text tone) |
| `tx2` (muted) | `0x7e8982` | `#777d88` | `gray` |
| `tx3` (dim) | `0x4a5450` | `#5f6673` | `dimGray` |

\* omp leaves `"text": ""` = terminal default; `#e8e8e8` is the neutral
choice. If you want to keep stateroom's slight green cast in prose, keep
`tx0/tx1` as-is and only re-value the chrome tokens — but full port means
neutral text.

### Semantic colours

| Stateroom token | Current | → omp value | Note |
|---|---|---|---|
| `grn` | `0x5cb27a` | `#89d281` | `green` — success, diff added |
| `grn2` | `0x78c991` | `#89d281` | same source; keep two tokens if agent-default colour must differ from success, else collapse |
| `grnbg` | `0x14261b` | `#1d2129`* | see bg note below |
| `amb` | `0xc99a3f` | `#e4c00f` | `yellow` — warning/gate |
| `ambbg` | `0x221c0e` | keep or `#29241a` | omp has no warning bg; derive +20% toward yellow |
| `red` | `0xd4604a` | `#fc3a4b` | `red` — error, diff removed |
| `redbg` | `0x261311` | `#291d1d` | `toolErrorBg` |
| `blu` | `0x8ab4f8` | `#178fb9` | `blue` — omp's blue is teal-ish; keep `#8ab4f8` for human presence if you prefer the current friendly blue. **Decision point**, see below |
| `blubg` | `0x16222f` | keep | |
| `brass` | `0xc9a56a` | `#febc38` | `accent` — headings, bullets, seals |
| `brassbg` | `0x2a2416` | `#2a2517` | derive from accent |

\* omp's semantic bgs come from the tool-bg family: `toolPendingBg #1d2129`,
`toolSuccessBg #161a1f`, `toolErrorBg #291d1d`. Prefer mapping stateroom's
`tone_bg` roles onto **these three** (doc 03) and deriving `grnbg` from
`toolSuccessBg`.

### New tokens to add (the status-line family — the identity of the bottom area)

Add to `Palette`:

```rust
// status-line family (omp dark.json `statusLine*`)
pub sl_model: Hsla,   // #d787af  pink   — model/route chip
pub sl_path: Hsla,    // #00afaf  teal   — doc/path chip
pub sl_ctx: Hsla,     // #8787af  lavender — context %
pub sl_cost: Hsla,    // #ff5faf  (256-idx 205) — cost/spend
pub sl_git_ok: Hsla,  // #5faf00  (256-idx 70)  — clean / sealed
pub sl_git_dirty: Hsla, // #d7af00 (256-idx 178) — dirty / unsealed
pub sl_sep: Hsla,     // #808080  (256-idx 244) — separators
// markdown family (doc 04)
pub md_heading: Hsla, // #febc38
pub md_link: Hsla,    // #0088fa
pub md_link_url: Hsla,// #5f6673
pub md_code: Hsla,    // #e5c1ff
pub md_code_block: Hsla, // #9CDCFE
pub md_quote: Hsla,   // #777d88
// syntax family (tree-sitter re-token, doc 04)
pub syn_comment: Hsla,  // #6A9955
pub syn_keyword: Hsla,  // #569CD6
pub syn_function: Hsla, // #DCDCAA
pub syn_variable: Hsla, // #9CDCFE
pub syn_string: Hsla,   // #CE9178
pub syn_number: Hsla,   // #B5CEA8
pub syn_type: Hsla,     // #4EC9B0
pub syn_operator: Hsla, // #D4D4D4
// tool grounds (doc 03)
pub tool_pending_bg: Hsla, // #1d2129
pub tool_success_bg: Hsla, // #161a1f
pub tool_error_bg: Hsla,   // #291d1d
```

### Slots (participant hues)

Keep stateroom's six slots — they carry per-participant identity that omp
doesn't have. If you want omp's flavour, swap slot 3 `0xe0c077` → `#febc38`
and slot 5 `0xc7a8ff` → `#b281d6` (omp's `customMessageLabel`/thinking-xhigh
purple) so the families agree.

## Decision point: the blue

omp's `blue #178fb9` is a desaturated teal used for borders. Stateroom's
`blu #8ab4f8` is the *human* colour (gutter, cursors, tone). Recommendation:
**keep `#8ab4f8` for humans**, use omp's `#178fb9` only for chrome borders
(`border` role) — human identity outranks theme fidelity, and law 8 wants
human/agent maximally distinguishable.

## tone() mapping after re-value

`tone()`/`tone_bg()` keep their structure; only values move:
`Verified→grn2 #89d281`, `Needs→amb #e4c00f`, `Failed/Destructive→red
#fc3a4b`, `Human→blu #8ab4f8`, `Neutral→tx2 #777d88`. Backgrounds:
`Verified→tool_success_bg`, `Neutral→tool_pending_bg`, `Failed→tool_error_bg`
— this single change gives blocks the omp panel feel everywhere tones render.

## Acceptance

- `cargo run -p stateroom-ui --example demo` with `STATEROOM_SEED=showcase`:
  page ground `#18181e`, session panels visibly cooler/darker (`#121212`),
  brass accents pop warmer (`#febc38`), certified green reads `#89d281`.
- No call-site edits outside `theme.rs` (values-only change).
- Side-by-side with `omp` in its default theme: the greys and accents are
  recognisably the same family.
