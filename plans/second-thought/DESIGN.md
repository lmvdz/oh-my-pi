# Design: Second Thought in oh-my-pi

Status: FINAL — arbitrated 2026-08-17 from one draft (sonnet) and four independent
adversarial reviews (2× fable, codex/gpt-5.6-sol, grok-4.6). All four returned
DESIGN-NEEDS-REWORK against the draft; all four endorsed the coordinator architecture.
This document is the reworked design. Draft preserved as DESIGN-draft.md; full critiques
in the arbitration record (00-overview.md Notes).

## Approach

A `SecondThoughtCoordinator` in `packages/coding-agent/src/session/` (TTSR-style sibling),
wired into AgentSession's existing interceptor and turn-end chains. Default **off**;
primary sessions only; v1 activates only when **both** the primary model and the resolved
branch model are Anthropic-API models.

Per turn, when the streaming assistant message opens its **first tool call**
(`toolcall_start`), the coordinator forks **one** side call (K=1 by default, K configurable
up to 4) against the **primary model with an identical request shape** — same system
prompt, same tools, same thinking config — carrying the conversation snapshot, a synthetic
assistant message with the just-finished thinking text, and a combined prompt asking for
all four reflection atoms (check / rehearse / recall / alternative) as typed
`<reflect>` units, with an instruction not to call tools. When the turn ends, branches are
aborted immediately, whatever has already settled is harvested within a ~300 ms grace, and
stream teardown plus cost finalization detach to the background.

Harvested units are **not persisted as context messages**. They are held on the
coordinator and injected ephemerally — a clearly delimited, inert, **user-role**
observation block appended after the tool results during per-request context assembly for
the next model call(s), then retired. A separate non-context session entry records the
units, per-turn token/cost figures, and skip reasons for inspection and reload-safe
diagnostics.

Turns that never open a tool call do not fork; a fork whose turn aborts, rewinds, or
compacts is cancelled and discarded via a history-epoch check. An adaptive skip suppresses
forking when the session's recent tool batches complete faster than measured branch
time-to-first-token, when context exceeds a size threshold, when the provider has recently
429'd, or when in-flight caps leave no spare slot.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Architecture | Coordinator in coding-agent | Loop capability in pi-agent-core; hybrid | Unanimous across draft + 4 reviews; TTSR precedent; smallest blast radius |
| Branch model | Primary model, identical request shape | `reflect`→`smol` role chain | Anthropic caches are model-scoped and thinking-config-sensitive; a cheap-model branch pays full-price input on the whole conversation every turn — 10× the intended cost. Cache-read pricing requires same model + same shape. `reflect` role still exists as explicit override |
| Branch count | K=1 combined-atoms call, configurable | K=4 parallel (reference) | Reference's K=4 bought vLLM KV-sharing, not available over a paid API; 4-way fork = 4-way full-price race on uncached suffix, 4 in-flight slots, 4× rate-limit pressure. Staggered fire if K>1 |
| Thinking on branches | Left as the main call's config | disableReasoning (reference invariant) | Disabling thinking invalidates the Anthropic messages-tier cache and is silently ignored on all current adaptive-only Anthropic models anyway. Harvest text only; cap max_tokens |
| Fork trigger | First `toolcall_start` | First text/toolcall event (draft) | Text-only turns have no idle window and no next call to influence; no-arg tool calls can complete without deltas |
| Fold | Ephemeral per-request injection, user-role inert block after tool results; retired after delivery | Persisted `customType` custom message → developer role (draft); queue/aside delivery | Persisted custom messages: convert to developer and get **upgraded to system authority** on current Anthropic models (prompt-injection amplifier), become compaction cut points, leak into the session tree as editable nodes, and the draft's `appendMessage` never reaches the live run's context copy. Ephemeral injection avoids the entire class; a non-context diagnostic entry keeps inspectability |
| Cancel/harvest | Abort at turn end; ≤300 ms harvest grace; background teardown (10 s bound); cancel also wired to the run abort signal at fork time, and in `abort()`/`dispose()` | Awaited 10 s `cancelAndCollect` in onTurnEnd (draft) | Turn-end hooks are skipped on every abort-shaped exit (user Esc, compaction, deadline), and an awaited teardown bound puts up to 10 s on the primary loop's critical path |
| Staleness | History-epoch counter bumped by rewind/replaceMessages/compaction; drop fold when epoch moved between fork and harvest | `#promptGeneration` check (draft) | Same-run rewind doesn't move `#promptGeneration`; the draft's mitigation was inert for exactly the case it targeted |
| Snapshot | Fully materialized provider-request snapshot at fork time (deep-copied model-facing messages) | Array slice (draft) | Compaction pruning/shake mutate message content in place; a branch queued behind an in-flight lease can otherwise see a different context than it forked from |
| Gating | `secondThought.enabled` (default off) + both primary and branch model resolve to Anthropic API + `agentKind === "main"` | Primary-provider check only (draft) | The draft gated the primary but let the branch resolve to Cerebras/Gemini via the smol chain |
| Cost | Coordinator-owned ledger (tokens + USD), distinct side sessionId, no primary-account header ingest, documented undercount on aborted streams; cache-read rate is an acceptance-gate metric | recordObservedUsage-as-advisor-path (draft — the path doesn't exist as described) | Branch spend must be attributable and cache regressions visible immediately; ledger bounds (not observes) post-abort decode |
| Prompts | Four atom prompts + combined-call template as static `.md` assets | TS string map (draft) | Repo convention (AGENTS.md): prompts are `.md` + Handlebars imported as text |
| TUI | Footer counter + `secondThought.showInTranscript` toggle rendering the diagnostic entry | Counter only, invisible content (draft) | Users must be able to read what they pay for |
| Parser | Verbatim port incl. malformed-closer repair; test corpus extended with Claude-style leaked-thinking output | Port as-is | The 1.8% malformed-closer rate was measured on DeepSeek; Claude-with-suppressed-thinking has its own leak shapes |

## Risks

- **R1 — Branch leak on an unguarded exit path.** More exit paths than the reference
  (abort, dispose, compaction abort, Harmony retry, steering). Mitigation: single
  idempotent cancel method; registration on the run signal at fork time; forced-exit tests
  for every path; late results rejected by fork-generation id.
- **R2 — Cache economics regress silently.** Same-model/same-shape is designed for
  cache-reads but unverified against live billing. Mitigation: ledger separates
  cache-read/write/uncached input from day one; an integration acceptance gate asserts
  `cache_read_input_tokens > 0` on the branch call before the feature ships default-off →
  available.
- **R3 — The idle window is too small on fast local tool batches.** Mitigation: adaptive
  skip (EMA of tool-batch wall vs branch TTFT) plus context-size and 429 circuit breakers;
  ledger records skip reasons so effectiveness is measurable.
- **R4 — Injected reflections influence the model as instructions.** Even user-role
  inert framing may be over-weighted. Mitigation: explicit "observations, not
  instructions" delimiter text; byte cap per fold; nested-control-tag rejection in the
  parser; this is also what the eval must measure.
- **R5 — This is a semantic redesign, not a validated port.** Same-model branches,
  K=1, thinking-on, user-role fold, post-observation placement — the reference's
  benchmark numbers no longer transfer. Mitigation: ship default-off as an experiment;
  acceptance is unit tests + ledger instrumentation + a small replay eval, not a claimed
  quality win.

## Red team concerns addressed

| Concern (reviewer) | Severity | Resolution |
|---|---|---|
| Fold invisible to live run's context copy (A, codex, grok) | critical | Ephemeral per-request injection into context assembly; no appendMessage |
| Persistence race → reload corruption (A, codex) | critical | No context-message persistence; diagnostic entry only |
| developer→system privilege elevation of model output (codex, grok, B) | critical | User-role inert block; never developer |
| smol-default breaks model-scoped cache economics (B, codex, grok) | critical | Same-model default; branch-provider gate |
| Thinking-config divergence kills messages-tier cache (B) | critical | Branch inherits main thinking config |
| Abort paths skip harvest/cancel hook (all four) | critical/significant | Run-signal registration + abort()/dispose() call sites |
| K=4 concurrent full-price race (B, codex) | significant | K=1 default; stagger if K>1 |
| 10 s teardown on critical path (A, B, grok) | significant | ≤300 ms grace + background finalizer |
| Same-run rewind staleness invisible to promptGeneration (A) | significant | History-epoch counter |
| Shallow snapshot mutated in place (codex) | significant | Materialized request snapshot at fork |
| Context normalized for wrong model (codex) | significant | Same-model default dissolves it; role override re-normalizes for target |
| Compaction cut points / tree editing / hidden-custom leaks (codex, grok) | significant | No context-message persistence |
| Turn-end maintenance compacts fold before use (codex, grok) | significant | Injection happens at request assembly, after maintenance |
| Fork on text-only/terminal turns wasted (codex, grok) | significant | toolcall_start trigger; discard on no-tool turns |
| Window smaller than branch TTFT on fast tools (grok) | significant | Adaptive skip + skip-reason ledger |
| Rate-limit/429 storm, OAuth window burn (B, codex) | significant | Circuit breakers; token-denominated ledger; OAuth usage note |
| Empty/redacted thinking degrades conditioning (codex) | significant | Min-conditioning threshold: skip fork below it |
| Truncate-resume re-arm mechanism wrong (A) | significant | Corrected semantics; Harmony tests deferred to non-Anthropic slice |
| Pause-engage cancel destroys valid harvest (A, codex) | minor | No pause-engage action; normal turn-end harvest |
| Factual errors: agentKind "task", convertOne fallthrough, sideStreamFn settings-awareness, resolveProvider helper (A, grok) | minor | Corrected throughout; settings-aware stream fn asserted as precondition |
| Prompts as TS strings violate repo rule (grok) | minor | `.md` assets |
| Cost-attribution path misdescribed; header ingest mixes accounts (B, grok) | minor | Coordinator-owned ledger; side ingest isolated |

## Open questions

None blocking. Deferred (tracked as follow-ups, not v1): OpenAI-family conditioning
parity; reflection retention beyond next-call delivery (currently: retire after delivery);
`/reflect` toggle command; expandable TUI widget; `reflect_inprompt`-style single-prompt
control arm for A/B comparison; replay-eval harness scope.
