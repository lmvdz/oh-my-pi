# Second Thought

## Outcome
- oh-my-pi gains an opt-in (default off) reflection feature: while a turn's tool batch
  runs, one cheap same-model side call generates typed reflections (check / rehearse /
  recall / alternative) conditioned on the just-finished thinking; the harvest is
  injected ephemerally into the next model call and every token of side spend is
  attributed and inspectable.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 parser + prompts](01-parser-and-prompts.md) | The mechanism's fixed text-processing core, ported from the reference | mechanical | second-thought/parser.ts, prompts/*.md |
| [02 branch request builder](02-branch-request-builder.md) | Cache-compatible side-call construction and execution | architectural | second-thought/branch-call.ts |
| [03 coordinator lifecycle](03-coordinator-lifecycle.md) | Fork/cancel/harvest correct on every loop exit path | architectural | second-thought/coordinator.ts |
| [04 ephemeral fold](04-ephemeral-fold.md) | Reflections reach the live run's next call without persisted context messages | architectural | second-thought/fold.ts |
| [05 settings + role + gating](05-settings-role-gating.md) | Config surface, reflect-role override, Anthropic/primary-session gates | mechanical | settings-schema.ts, model-roles.ts, gating.ts |
| [06 cost ledger](06-cost-ledger.md) | Token/USD attribution, cache-economics visibility, circuit-breaker data | architectural | second-thought/ledger.ts |
| [07 TUI surface](07-tui-surface.md) | Users can see and read what they pay for | mechanical | interactive mode footer + renderer |
| [08 integration](08-integration.md) | Sole owner of agent-session.ts wiring; end-to-end + cache acceptance gate | architectural | agent-session.ts, sdk.ts |
| [09 replay eval](09-replay-eval.md) | The omp variant is a redesign; its value needs measuring before default-on | research | plans/second-thought/eval/ |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 05 | Independent leaves, fully parallel |
| 2 | 02 | Needs 01's prompts/parser |
| 3 | 03 | Needs 02's branch handle |
| 4 | 04, 06 | Both extend the coordinator via separate modules; parallel |
| 5 | 07, 08 | 07 needs 04's entry; 08 needs 03-06. Parallel (disjoint files) |
| 6 | 09 | Needs the shipped feature |

## Dependency graph
| Concern | Blocked by | 30s check (VERIFY_BLOCKER) |
|---|---|---|
| 02 | 01 | `ls packages/coding-agent/src/session/second-thought/prompts/combined-branch.md` |
| 03 | 02 | branch-call.ts exports a spawn/abort handle (grep `export` in it) |
| 04 | 03 | coordinator.ts exposes harvest output + epoch (grep coordinator exports) |
| 06 | 03 | same as 04 |
| 07 | 04 | fold.ts writes the diagnostic entry type (grep its entry-type constant) |
| 08 | 03,04,05,06 | all four modules export their wiring interfaces; parser+gating tests green |
| 09 | 08 | integration suite green on the branch |

## Shared-file analysis
agent-session.ts and sdk.ts are touched ONLY by 08; 03/04/06 code against a host
interface. 01-07 have pairwise-disjoint TOUCHES. No sequential conflicts inside any batch.

## Not yet specified
- (none)

## Out of scope
- OpenAI/other-provider conditioning parity — deferred by the approved provider-scope
  decision; revisit after 09.
- Reflection retention beyond next-call delivery, `/reflect` slash command, expandable
  TUI widget — DESIGN.md "Open questions" follow-ups.
- `reflect_inprompt`-style single-prompt control arm — candidate extra arm for 09, not a
  build concern.
- s1extend / reflect_sync / reflect_oracle ablation arms from the reference — benchmark
  controls, never product.

## Decisions so far
- [DESIGN.md](DESIGN.md) — same-model K=1 branches, ephemeral user-role fold, toolcall_start
  trigger, hardened lifecycle; arbitrated from 4 adversarial reviews (all
  DESIGN-NEEDS-REWORK on the draft, all endorsing the coordinator architecture).

## Notes
- Phase-0 WIP scan 2026-08-17: clean slate (0 open plans in this repo).
- User approved: built-in feature packaging; Anthropic-first provider scope; final
  DESIGN.md (gate answered "Approve, decompose").
- Base implementation on `main` (canonical; local checkout `coven-bridge-next` is a
  feature branch) — builders should branch from origin/main.
- Red-team record: draft in DESIGN-draft.md; critiques from 2× fable (subagents),
  codex/gpt-5.6-sol, grok-4.6; grok lane status OK. The four reviews' full texts live in
  the session transcripts; every accepted finding is traceable via DESIGN.md's
  "Red team concerns addressed" table.
- Reference implementation vendored at plans/second-thought/reference/ (from
  C:\Users\Lars\Downloads\2nd-thought) so builders and critics can read it in-repo.
