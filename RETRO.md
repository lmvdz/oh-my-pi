# RETRO — Second Thought campaign

Standing rules (from campaign doctrine, created at CHART):

1. **Every closed build ticket appends an entry here** — rounds taken, what each gauntlet
   round caught, findings refuted with evidence, one process lesson. No entry, no close.
2. **Everything expirable names its expiry condition** — fog entries state what they hang
   on; decisions carry "reopen if wrong"; briefs carry provenance headers.
3. **Stay youthful** — phase-boundary retros prune at least one process rule, fund one
   divergent pass, track reopens as a vitality metric, rotate one critic lens per phase.

Provenance: plan + design arbitrated 2026-08-17 (see plans/second-thought/DESIGN.md;
draft + 4 adversarial reviews indexed there). Landscape file:line refs were verified on
v17.1.8-era trees; upstream main is now v17.3.7 — **every builder re-verifies ticket
file:line claims against its checkout and reports contradictions** (ticket-decay rule).

## Entries


### ST-05 settings/role/gating (#7) — closed 2026-08-17
- 1 build round (codex terra) + 2 fix rounds + 2 gauntlet rounds (codex terra, blind).
- r1 caught: branchCount max=4 was UI-only — reproduced live (isolated 5 → read 5); fixed
  with a GENERIC clamp at the settings resolution site (benefits every ranged NumberDef).
- r2 verified all r1 findings fixed; residual LOW (no lower-bound regression test) closed
  by a one-line orchestrator edit, adjudicated as not worth a lane cycle.
- Refuted/none. Confirmed: `anthropic-messages` is the correct api predicate (Vertex
  Claude shares it; Bedrock correctly excluded).
- Process lesson (cost an extra round-trip): committing in a `worktree add --detach` tree
  and pushing the BRANCH NAME pushes the stale tip — the new commit dangles. Caught by an
  expect-count mismatch (21 vs 22) on the merged tree. Rule: land on a checked-out branch,
  or push the sha explicitly; always re-verify the merged tree's test counts against the
  lane's.
