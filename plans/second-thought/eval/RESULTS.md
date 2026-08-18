# Second Thought eval — results (ST-09)

Evidence for the ticket's question: does the omp variant of parallel branch
reflection (K=1, same model, thinking-on branches, user-role post-observation
fold) earn its cost? This document reports what was measured and what was not.
It deliberately makes no ship / default-on recommendation — ST-09 is `MODE:
hitl` and that judgment is the user's.

- Branch: `second-thought/09-eval`, off `fork/second-thought/integration` at
  `232551532f`.
- Harness: `plans/second-thought/eval/harness.ts`, runner
  `plans/second-thought/eval/run.ts`, raw output `plans/second-thought/eval/raw/`.
- Reproduce: `bun plans/second-thought/eval/run.ts` (`ST_EVAL_REPS=30` default).
- Machine: 4-core WSL2 Linux, bun 1.3.14, load average ~1.6–2.5 during the run.

## Which lane ran, and why

The ticket asked for a live lane first: short coding tasks run twice, feature on
and off, against an Anthropic model. **That lane could not run.** Two independent
findings closed it:

1. `evaluateSecondThoughtGate` (`src/session/second-thought/gating.ts:74-81`)
   requires `model.api === "anthropic-messages"` for *both* the primary and the
   branch model. Any other provider skips every fork with
   `primary-model-not-anthropic`. The feature is unobservable on a non-Anthropic
   model by construction, and the eval reproduces exactly that (E2, below).
2. No usable Anthropic credential exists in this environment. Both the
   from-source CLI and the user's global `omp` install fail identically with
   `No API key found for anthropic` against `~/.omp/agent/agent.db`, while the
   same binaries complete a live turn on the default `openai-codex` model. So
   headless mode works, auth discovery works, and the one provider the feature
   needs is the one that is unavailable.

Everything below is therefore the **scripted lane**: the real `AgentSession`,
the real coordinator, ledger, fold store and Anthropic wire encoder, driven by a
provider scripted at the `streamFn` boundary. No network call was made for any
number in this document.

The `-p` / `--print` headless path, `--mode json`, `--config` overlays and
`--max-time` all exist and work, so the live lane is a re-run away once an
Anthropic credential is available. Nothing else blocks it.

## Metric definitions (fixed before measuring)

| metric | definition | measurable here |
|---|---|---|
| reflection adoption | does the turn after a fold behaviourally reference or act on a unit | **no** — needs a live model |
| task outcome on/off | does the fixture's test suite pass | **no** — needs a live model |
| branch cache-read fraction | `cache_read_input_tokens > 0` on branch calls | **no** — its *precondition* is measured instead (E3) |
| harvest rate per fork | `harvests / forks` from `ledger.report()` | yes |
| skip / drop breakdown | `report().skips` and `report().drops` by reason | yes |
| added cost per session | branch tokens and USD at catalog rates | yes, structurally (E3) |
| turn-end latency delta | p50/p95 of `session.prompt()` wall time, on vs off | yes (E1, E1b) |

## E1 — mechanism overhead at turn end

30 reps per condition, one two-call turn (thinking + tool call, then text),
3 warm-up reps discarded. Control is `secondThought.enabled: false`.

| condition | turn p50 | turn p95 | Δ vs off p50 | Δ p95 | tail after last provider call p50 / p95 |
|---|---|---|---|---|---|
| off (control) | 27.63 ms | 32.98 ms | — | — | 0.61 / 1.06 ms |
| on, branch settles instantly | 27.27 ms | 41.55 ms | −0.36 ms | +8.56 ms | 0.59 / 1.36 ms |
| on, branch settles at 50 ms | 27.67 ms | 37.60 ms | +0.05 ms | +4.62 ms | 0.60 / 1.65 ms |
| on, branch settles at 150 ms | 26.34 ms | 43.70 ms | −1.29 ms | +10.71 ms | 0.59 / 3.11 ms |
| on, branch settles at 600 ms | 27.05 ms | 43.66 ms | −0.58 ms | +10.68 ms | 0.59 / 0.93 ms |
| on, branch never settles | 26.46 ms | 35.06 ms | −1.16 ms | +2.08 ms | 0.61 / 1.07 ms |

Two readings, and the second is the load-bearing one:

- The p50 deltas are negative in four of five on-conditions. That is not a
  speed-up; it means **the effect is smaller than the run-to-run noise** of a
  session on this box. E1b isolates it properly.
- The **turn-end tail** — how long `prompt()` stays open after the last provider
  request was issued, which is where harvest lives — is 0.59–0.61 ms p50 and
  ≤3.11 ms p95 in *every* condition including the branch that never settles.
  The 300 ms harvest grace never materialises as latency.

Why the grace never costs anything: `onPrimaryTurnEnd` aborts the fork
synchronously *before* the first await, then `#harvest` runs `#awaitGrace`
(`coordinator.ts:764-880`). The grace therefore only collects results that are
already resolving; it never extends a branch's deadline. This has a cost
consequence and a value consequence, both in E1c.

## E1b — overhead as a function of context size

The fork snapshots the conversation, so its cost should scale with what it
copies. Two warm-up turns inflate the transcript via tool output, then the third
turn is timed. 10 reps per cell.

| prefix at turn 3 | off p50 / p95 | on p50 / p95 | Δ p50 | Δ p95 |
|---|---|---|---|---|
| 947 tok | 1.06 / 3.73 ms | 1.67 / 1.99 ms | +0.61 ms | −1.74 ms |
| 8,207 tok | 1.20 / 2.97 ms | 2.15 / 5.20 ms | +0.94 ms | +2.23 ms |
| 30,427 tok | 1.54 / 2.05 ms | 2.76 / 3.19 ms | +1.23 ms | +1.13 ms |
| 74,877 tok | 2.37 / 3.47 ms | 7.97 / 14.58 ms | +5.60 ms | +11.12 ms |

Overhead is sub-millisecond on a small transcript and reaches **+5.6 ms p50 /
+11.1 ms p95 at a 75k-token prefix**, growing faster than linearly. Against a
real turn — seconds of model time — this is noise. Forks continued to fire at
75k; `secondThought.maxContextTokens` defaults to 100,000, above which the
feature skips itself with `context-too-large`.

## E1c — the race that decides whether a fork pays off

A branch is forked at `toolcall_start` and harvested at turn end, so it is
racing the remainder of the turn. Branch latency swept against how long the turn
stays open (modelled as tool-execution time). One run per cell; the outcome is
deterministic.

| turn stays open | branch 100 ms | 500 ms | 2,000 ms | 5,000 ms |
|---|---|---|---|---|
| 0 ms | — | — | — | — |
| 250 ms | harvest | — | — | — |
| 1,000 ms | harvest | harvest | — | — |
| 3,000 ms | harvest | harvest | harvest | — |

A clean staircase: **a fork harvests if and only if its branch settles before
the turn ends.** Not one cell is rescued by the 300 ms grace — including
`turn 250 ms / branch 500 ms`, where a deadline extension would have won.

Every losing cell records the same thing on the ledger: `terminations.cancelled:
1`, `drops: {"no-units": 1}`, `tokens.totalTokens: 0`, and
**`undercountBoundTokens: 2048`** — the ledger's own explicit statement that up
to `branchMaxTokens` of output may have been billed by the provider and never
observed. At Sonnet 4.5 output rates that is a **$0.031 upper bound per lost
fork, for nothing**. The scripted branch reports zero usage on abort; a real
provider bills for what it generated before the abort, which is exactly the gap
`undercountBoundTokens` exists to bound.

This is the single largest unknown the scripted lane cannot close: real branch
latency (a thinking-on Sonnet call capped at 2048 tokens) against real turn
duration determines the harvest rate, and both distributions require a live run.

## E2 — harvest, skip and drop behaviour

18 scenarios, one session each, read from `ledger.report()`.

| scenario | forks | branches | harvests | units | skips / drops | fold on call |
|---|---|---|---|---|---|---|
| baseline | 1 | 1 | 1 | 2 | — | 1 |
| no tool call in the turn | 0 | 0 | 0 | 0 | — | — |
| two tool calls, one stream | 1 | 1 | 1 | 2 | — | 1 |
| conditioning below `minConditioningChars` | 0 | 0 | 0 | 0 | skip `conditioning-too-short` | — |
| `maxContextTokens: 1` | 0 | 0 | 0 | 0 | skip `context-too-large` | — |
| `enabled: false` | — | — | — | — | no runtime constructed | — |
| sub-session (`agentKind: "sub"`) | — | — | — | — | no runtime constructed | — |
| non-Anthropic primary (`openai/gpt-5.1`) | 0 | 0 | 0 | 0 | skip `primary-model-not-anthropic` | — |
| host without `sideStreamFn` | — | — | — | — | no runtime constructed | — |
| branch returns no `<reflect>` units | 1 | 1 | 0 | 0 | drop `no-units` | — |
| branch returns 40 units, cap 5 | 1 | 1 | 1 | 5 | termination `unit-cap` | 1 |
| 8 units, `atoms: ["check"]` | 1 | 1 | 1 | 2 | — | 1 |
| branch never settles | 1 | 1 | 0 | 0 | cancelled, drop `no-units` | — |
| branch settles past the grace | 1 | 1 | 0 | 0 | cancelled, drop `no-units` | — |
| `branchCount: 2` | 1 | 2 | 1 | 4 | — | 1 |
| `branchCount: 4` | 1 | 4 | 1 | 8 | — | 1 |
| `deliveryCalls: 2` | 2 | 2 | 2 | 4 | — | 1 and 2 |
| three-turn session | 3 | 3 | 3 | 6 | — | per turn |

Observations, stated without judgment:

- Under scripted conditions where the branch wins the race, **harvest rate per
  fork is 1.0** and each fork yields the units the branch emitted, filtered by
  the configured atom set and capped per atom.
- The three "no runtime" rows are stronger than a skip: with the feature off, in
  a sub-session, or on a host that passes no `sideStreamFn`, `session.secondThought`
  is `undefined` and no accounting object exists at all.
- `branchCount: 4` harvested 8 units from four identical branches — **there is
  no cross-branch dedupe**. With K=1 (the shipped default) this never arises;
  raising `branchCount` multiplies both spend and redundant units.
- One fork per *stream*, not per tool call: a turn emitting two tool calls in one
  assistant message forks once.

## E3 — fold fidelity, cache-prefix parity, token accounting

### Fold injection

Two-fork session, `deliveryCalls: 1`:

- The fold appears on main calls 1 and 2 — i.e. **call N+1 after each fork**, and
  never on the call that produced the fork.
- On every call carrying it, the fold is the **final message on the wire** and
  its role is **`user`**.
- `foldsThatBecameConversationMessages: 0` — the fold never enters the durable
  message history. Four `custom` diagnostic entries were written instead.

### Branch cache-prefix parity — the acceptance gate's precondition

The design's stated gate is `cache_read_input_tokens > 0` on branch calls. That
is a live-provider assertion. What is checkable offline is its precondition: the
branch request's encoded prefix must be byte-identical to the main call's, or the
provider cannot hit the cache.

Across **all 18 branch calls produced by the E2 matrix**, encoded through the
real `convertAnthropicMessages`:

- byte-identical prefix: **18 / 18 (100%)**
- appended messages over the main prefix: exactly **1** in all 18 cases (the
  synthetic conditioning turn)

So the wire shape that the gate depends on holds universally in these scenarios.
Whether the provider actually returns a cache read remains unverified.

### Token accounting (exact tokenizer, catalog prices)

Counted with `@oh-my-pi/pi-natives countTokens`; prices from the bundled
`anthropic/claude-sonnet-4-5` catalog entry (input $3, output $15, cache read
$0.30, cache write $3.75 per Mtok).

Per fork, the branch request is the main call's entire prefix plus:

| component | tokens |
|---|---|
| combined branch prompt | 117 |
| appended conditioning turn (total, incl. prompt) | 188 |
| branch output cap (`branchMaxTokens` default) | 2,048 |

The fold added to the next main call:

| units harvested | fold tokens | fold bytes |
|---|---|---|
| 1 | 126 | 584 |
| 2 | 155 | 702 |
| 4 | 213 | 938 |
| 8 | 329 | 1,410 |
| 16 | 561 | 2,361 |

Roughly 29 tokens per unit above a ~97-token wrapper.

Marginal USD per fork, as a function of how large the reused prefix is:

| prefix | prefix warm (cache read) | prefix cold (full input) | appended | output at cap | total warm | total cold |
|---|---|---|---|---|---|---|
| 10k tok | $0.0030 | $0.0300 | $0.0006 | $0.0307 | **$0.0343** | $0.0613 |
| 30k tok | $0.0090 | $0.0900 | $0.0006 | $0.0307 | **$0.0403** | $0.1213 |
| 100k tok | $0.0300 | $0.3000 | $0.0006 | $0.0307 | **$0.0613** | $0.3313 |

The cache gate is worth **10× on the prefix component** — which at a 100k prefix
is the difference between $0.061 and $0.331 per fork. Whether branches run warm
is the unverified gate.

Framed per turn: enabling the feature adds approximately **one extra model call
per turn** — same prefix, +188 input tokens, up to 2,048 output tokens — plus
126–561 tokens of fold on the following call. Actual branch output length is
unknown; the 2,048 figure is the cap, not a measurement, and a real ledger
records the true value.

## Limitations

Stated plainly, because they bound every conclusion above.

1. **No live provider.** Anthropic credentials are unavailable in this
   environment and the feature refuses to run on any other provider. Adoption,
   task outcome, real branch latency, real branch output length, and the actual
   `cache_read_input_tokens > 0` gate are all **unmeasured**.
2. **Adoption is not approximated.** Nothing here says whether a folded unit
   changes what the next turn does. That is the feature's entire value
   proposition and it is untested.
3. **Task outcome on/off is not approximated.** Six fixture tasks were prepared
   for the live lane and discarded unused; a scripted provider cannot solve them.
4. **Harvest rate here is a mechanism property, not a field rate.** The 1.0
   harvest-per-fork figure holds only when the branch wins the race in E1c. The
   field rate is `P(branch latency < remaining turn duration)` and neither
   distribution was observed.
5. **Latency deltas are floor values.** They measure the mechanism with an
   instant provider; they do not include contention for provider rate limits,
   connection pool pressure, or a real branch competing with the main call.
6. **Cost figures are structural.** Input-side numbers are exact token counts at
   catalog prices; the output side is bounded by the cap, not observed. The
   ledger reports `costIsIndicative` for OAuth-served providers, which the user's
   Anthropic credential likely is.
7. **Single machine, moderate load.** E1's p95 deltas (up to +10.7 ms) are within
   this box's noise; E1b's paired design is the more trustworthy overhead read.
8. **`report()` has no user-visible surface.** No flag, env var, log line or
   slash command prints it, and the TUI diagnostic seam is unwired. The eval
   reaches it programmatically. A live run would need that surface, or would have
   to parse `second_thought_fold` custom entries out of session files.

## What the numbers support

Neutral summary. No recommendation follows from it.

- **The mechanism is cheap in wall time.** Turn-end harvest costs ≤3.1 ms p95
  under every branch condition tested, including a branch that never returns.
  Total per-turn overhead is +0.6 ms p50 on a small transcript and +5.6 ms p50 /
  +11.1 ms p95 at a 75k-token prefix. Nothing here suggests latency is a reason
  to keep the feature off.
- **The plumbing does what the design says.** The fold lands on call N+1, as the
  final message, in the user role, and never becomes a durable conversation
  message. Every gating, skip, drop and termination path fires with the reason it
  claims. Disabled, sub-session and bare-host configurations construct no runtime
  at all.
- **The cache gate's precondition holds universally** — 18/18 branch calls carry
  a byte-identical prefix with exactly one appended message. The gate itself is
  still unverified, and it is worth 10× on the prefix component of branch spend.
- **The cost is structurally about one extra model call per turn**, and it is
  incurred at fork time, before anything is known about whether the branch will
  be useful or even finish.
- **A fork that loses the race costs up to 2,048 output tokens (~$0.031) and
  returns nothing**, and the grace period does not protect against this. How
  often that happens is the central open question, and it is a live-run
  measurement.
- **Nothing here speaks to value.** Every number above is about cost, overhead
  and correctness. Whether a reflection unit ever changes the next turn's
  behaviour, and whether that improves task outcomes, is exactly what the missing
  live lane would have measured.

## To close this ticket

The live lane needs one thing: a working Anthropic credential in
`~/.omp/agent/agent.db`. With it, `bun packages/coding-agent/src/cli.ts -p
--model claude-sonnet-4-5 --config <overlay> --session-dir <dir>` runs each
fixture task twice, and the per-session `second_thought_fold` entries plus a
`report()` surface supply adoption, harvest rate, cache-read fraction and outcome
directly.
