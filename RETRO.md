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
### ST-01 parser + prompts (#3) — closed 2026-08-17
- 1 build round (codex sol) + 1 fix round (codex terra) + 2 gauntlet rounds (opus blind →
  codex terra verify).
- r1 was the strongest critic round of the campaign so far: PASS on semantics via a
  3,000-case randomized differential against the vendored Python (0 divergences), but a
  21-mutant probe found 4 semantics-changing mutants the 28-test suite missed — worst was
  silent text loss after a repaired closer (763/3000 divergences, invisible to every test).
- r2 verified: all 4 mutants now caught, nested-tag bypass variants rejected, prompts
  byte-verbatim, 37 tests green.
- Refuted: none. Routed onward: atom-type filtering through ATOM_NAMES → ticket 03/#5.
- Process lesson: "tests pass + reference-faithful" and "tests would catch a regression"
  are different properties — the mutation probe is what separates them; keep it in every
  parser-ish gauntlet prompt.
### ST-02 branch request builder (#4) — closed 2026-08-17
- 1 build round (opus) + 2 fix rounds (opus, codex terra) + 3 gauntlet rounds (r1+r2
  dual-lineage codex+grok; r3 codex verify) + 1 orchestrator fixture fix.
- r1: the dual-lineage pairing earned its cost in one round — codex probed 5 runtime/race
  defects (stagger no-op, gate deadlock, never-throws holes, usage-on-abort, shared
  snapshot); grok found the wire-level critical neither tests nor codex saw: the synthetic
  conditioning ASSISTANT stole latestSurvivingAssistant and rewrote the PREFIX's signed
  thinking encoding. The r2 fix proved it empirically (golden test) and moved conditioning
  into the combined user message — a recorded, reopenable deviation from the reference's
  continuation-prompting shape.
- r2: fixes verified; grok found the fix-round regression class the doctrine predicts:
  the user suffix suppresses Fable 5's developer→system upgrade on developer-tailed
  snapshots → prefix split for that shape; no suffix satisfies both transform policies.
  Pinned as expected-divergence golden + tail predicate; skip policy routed to ST-03.
- r3: implementation verified; the surviving mutant was setTimeout's ~1ms clamping of
  degenerate delays making the mutated gate accidentally bounded — killed by asserting the
  gate HOLDS mid-bound, not merely that it releases.
- Refuted: none. Process lesson: "the gate releases" and "the gate holds until it should"
  are different assertions; for any timeout logic, test the hold, not just the release.
### ST-03 coordinator lifecycle (#5) — closed 2026-08-17
- 1 build round + 2 fix rounds (all opus) + 3 gauntlet rounds (r1+r2 dual-lineage, r3
  codex verify). Ship-blockers stopped by r3, on pattern.
- r1's grok catch was the campaign's best harness-fidelity lesson: single-fire keyed on
  partial OBJECT IDENTITY worked perfectly against a stub that reused one object and
  would have cancel+re-forked on EVERY toolcall_start against the real loop, which
  deep-snapshots per event. The 'start'-event re-arm path was dead code on the live
  surface. Rule: a stub host must emit what the real surface emits — new object per
  event, real replacement-path event sets — or the suite proves nothing about production.
- r2 found the fix-round regression (settled-tail stealing harvest's handles via the
  microtask woken by the turn-end abort) and codex found the rewind EMA hole; r3 fixed
  both with self-probes and the verifier confirmed all probes lethal.
- Also fixed on the way: in-flight cap off-by-one that would have made the natural
  anthropic:2 config NEVER fork (the feature would have shipped permanently inert for
  such users — caught only because a critic checked the boundary against its comment).
- Builder judgment worth keeping: adaptive-skip probe every 20th qualifying turn so the
  skip cannot freeze its own EMA input; reset() clears EMAs (they describe one
  conversation+model pairing).
- Routed onward: stream-token arming contract + discarded-message_end hazard → #10.
### ST-04 ephemeral fold (#6) — closed 2026-08-17
- 1 build round (opus) + 1 fix round (codex sol) + 2 gauntlet rounds (opus blind ×2) +
  orchestrator hygiene pass.
- r1's security catch is the reason blind critics execute payloads instead of reading
  code: a reflect-unit body could close the observation wrapper and forge a
  <system-reminder> OUTSIDE it — structural inertness was a doc claim, not a property.
  Fixed in BOTH layers (parser rejection list + fold boundary re-cap), verified
  independently (fold layer alone neutralizes with the parser layer reverted).
- r1 also caught the replay path bypassing the epoch re-check (re-injecting retired
  folds into post-rewind history) and the whole-array idempotency scan letting a user
  paste of the literal marker suppress delivery forever.
- r2: PASS, 8/8 mutation probes caught; three LOW hygiene residuals closed by
  orchestrator edits (buildFoldBlock boundary guard, ceiling pin, refusal counters),
  each verified against the receipt list item-by-item.
- Routed onward: fold must be the LAST transform in request assembly (extension context
  + steering wraps run after transformContext) → #10.
- Process lesson: "the wrapper says observations-not-instructions" protects nothing;
  only delimiter hygiene at every public boundary does.
### ST-06 cost ledger (#8) — closed 2026-08-17
- 1 build round (opus) + 2 fix rounds (codex terra) + 3 gauntlet rounds (grok ×3).
- The build's contradiction hunt found the campaign's most consequential wiring defect:
  header-ingest isolation was structurally broken (SessionProviderBoundary injects the
  session onResponse; ingestProviderUsageHeaders hard-codes the primary sessionId) —
  branch spend would have polluted the primary OAuth quota window. Fixed with an
  onResponse strip at both option-build and post-host-prep in branch-call.
- grok's accounting lane earned three rounds: r1 caught the undercount bound keying off
  the collapsed termination label (completed tool-use leaks reporting 1.6k phantom
  tokens), live-read ceilings, and ghost-rollup resurrection; r2 caught that the fix
  round silently skipped findings 3/4/5 — the orchestrator had accepted the diff off
  summary bullets instead of the receipt checklist. Standing rule from that slip: land a
  fix round only after verifying the diff against the receipt's numbered list.
- r3: all residuals implemented and test-pinned; PASS.
### ST-07 TUI surface (#9) — closed 2026-08-17
- 1 build round (opus) + 1 fix round (codex terra) + 2 gauntlet rounds (opus blind ×2) +
  orchestrator one-liners.
- The build's contradiction hunt was ship-saving: the ticket targeted FooterComponent,
  which is dead code — the live surface is StatusLineComponent. A ticket written from an
  older mental model would have shipped an invisible feature.
- r1's render-reality brief caught what unit tests structurally cannot: the card broke
  the TUI's physical-row contract at ≤150 columns (only unit lines were clamped), and
  model-authored unit text reached the TTY with VT/OSC escapes intact (ESC[2J, OSC-title,
  BEL) — terminal-escape injection from branch output, with the sibling surface's own
  sanitizer sitting unused. Both invisible to the 296-test suite.
- r2: PASS, all probes lethal; residual one-line boundary-guard hole + two cosmetic gaps
  closed by orchestrator edits verified against the receipt list.
- Process lesson: for TUI work, "render the real component at real widths with hostile
  payloads" belongs in the FIRST critic brief; assertions on string output only prove
  what the fixture shape allows.
### ST-08 integration (#10) — closed 2026-08-18
- 1 build round + 1 fix round (both opus) + 3 gauntlet rounds (r1 grok+opus-execution,
  r2 codex-fresh+grok, r3 codex focused) + 2 orchestrator fixes with lethal probes.
- The build itself found a production-killer: normalizeTools puts execute functions into
  Context.tools → structuredClone throws → every fork would have skipped
  snapshot-failed. Golden fixtures with hand-built tools cannot see this class; only
  wiring against the real Agent did.
- r1's execution critic measured a disabled-path regression: registering the repo's
  first-ever beforeModelCall armed a dead agent-loop branch and changed abort behavior
  with the feature OFF (2→1 provider calls, deterministic). The zero-delta claim now has
  a delta test with a positive control. grok found the fold re-obfuscation hole
  (deobfuscated harvest re-introducing plaintext secrets) and the shared
  providerSessionState flag leak.
- r2 accepted both addBeforeModelCall deviations; codex's fresh look found the
  skip-restore branch gap; r3's focused verify found its deeper form — the
  sessionTransitioned flag was set AFTER a throwing-capable cosmetic step, so a
  committed boundary crossing could go unrecorded. Fixed by marking the transition at
  the mutation commit.
- Orchestrator near-miss for the record: my first planted-fold test was vacuous (passed
  under mutation — onRunEnd already retires natural folds) and my probe-revert wiped the
  source fix via `git checkout --`. Both caught by the mandatory-probe discipline.
  Rules: probe every fix including your own; never revert probes with git checkout when
  the tree carries unlanded edits — use a file backup.
- Deviations recorded: arming + fold injection via addBeforeModelCall (adjudicated by
  both lineages against the loop's real ordering); reopen if agent-loop's hook
  semantics change.
