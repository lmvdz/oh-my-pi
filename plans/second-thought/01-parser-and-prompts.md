# Reflect-unit parser and atom prompt assets
STATUS: done
PRIORITY: p1
REPOS: oh-my-pi
COMPLEXITY: mechanical
TOUCHES: packages/coding-agent/src/session/second-thought/parser.ts, packages/coding-agent/src/session/second-thought/prompts/atom-check.md, packages/coding-agent/src/session/second-thought/prompts/atom-rehearse.md, packages/coding-agent/src/session/second-thought/prompts/atom-recall.md, packages/coding-agent/src/session/second-thought/prompts/atom-alternative.md, packages/coding-agent/src/session/second-thought/prompts/combined-branch.md, packages/coding-agent/src/session/second-thought/atoms.ts, packages/coding-agent/test/second-thought/parser.test.ts

## Goal
The reflect-unit parser and the atom prompts exist as tested TypeScript + `.md` assets,
ported faithfully from `plans/second-thought/reference/second_thought/` (`action_detector.py`
reflect-half, `prompts.py` atom texts).

## Approach
- Port `normalize_reflect_closers` exactly (conservative promotion: only when no genuine
  `</reflect>` exists before the next opener; idempotent; unclosed tail stays unclosed),
  plus `count_reflect_units`, `parse_reflect_typed_units`,
  `truncate_at_last_complete_reflect`, `interleave_typed_units_by_atom`. Regexes translate
  1:1; keep the reference's semantics test-for-test (`tests/test_action_detector.py`,
  `tests/test_malformed_closers.py` translate mechanically).
- Add a defensive pass the reference lacked (red-team R4): reject units containing nested
  control tags and enforce a per-unit and per-fold byte cap before anything reaches
  context injection.
- Prompt text goes into `.md` files imported `with { type: "text" }` per AGENTS.md
  convention (grok finding 11) — the four atom prompts verbatim, plus a new
  `combined-branch.md` template that asks for all four atom types in one call (K=1
  default per DESIGN) with an explicit "answer only in `<reflect type=...>` units; do not
  call tools" instruction. `atoms.ts` exports the atom enum and prompt loading.
- Extend the parser test corpus beyond the reference's cases with Claude-style
  leaked-thinking shapes (`<thinking>` fragments interleaved with reflect units — the
  branch runs with thinking config inherited, so leakage into text is plausible) and
  provider special-token closers.

## Cross-Repo Side Effects
None.

## Verify
`bun test packages/coding-agent/test/second-thought/parser.test.ts` green; every
translated reference test present; malformed-closer cases from the reference README
(`</refresh>`, `</reflection>`, `</ref lect>`, DSML token) all repaired; nested-control-tag
and byte-cap rejections covered.

## Resolution
Shipped: parser + .md prompt assets, merged via second-thought/01-parser-and-prompts (final 81c6af7551). Gauntlet: 2 rounds (opus blind w/ 3000-case python differential + 21-mutant probe; codex verify). Issue #3.
