# Landscape: Second Thought port into oh-my-pi

Phase-1 exploration output (2026-08-17). Inputs for DESIGN. File:line refs verified against
the working tree (branch coven-bridge-next, 02cdc617b1; canonical branch is `main`, 9 behind / 1 ahead).

## Goal

Port "Second Thought" — parallel branch reflection for agent loops — from the Python
reference implementation at `/mnt/c/Users/Lars/Downloads/2nd-thought` into oh-my-pi as a
**built-in coding-agent feature** (settings-gated, default off), **Anthropic-first** for
branch conditioning (other providers fork with empty conditioning; parity deferred).

Mechanism: while the main model call streams and its tools run, the provider is otherwise
idle. At the moment the main call's reasoning ends (first content/toolcall event), fork K=4
cheap "reflection branches" — independent LLM calls, thinking disabled, each answering one
reflective question (atoms: check / rehearse / recall / alternative) conditioned on the
just-finished reasoning. Cancel them when the tool batch completes; truncate each buffer at
the last complete `</reflect>`; parse typed units; round-robin interleave; fold into context
so the NEXT turn sees the reflections. Cost rides in the idle window; latency cost ~zero.

## Reference implementation (read in full)

- Core: `second_thought/mini_runner/streaming_agent.py` (ReflectAgent, ~900 lines with
  ablation arms we will NOT port: s1extend, reflect_sync, reflect_oracle, reflect_inprompt,
  multi-fire refined reflect — rolled back upstream 2026-05-24).
- Prompts: `second_thought/prompts.py` — the 4 atom continuation prompts, port verbatim.
  Branch input = conversation snapshot + synthetic assistant(just-finished reasoning) +
  user(atom prompt). Same snapshot across all 4 branches → shared prefix → cache hits.
- Parser: `second_thought/action_detector.py` — reflect-unit half only (count units,
  parse typed units, truncate at last closer, round-robin interleave). MUST port
  `normalize_reflect_closers`: 1.8% of 292,778 measured units close with a malformed tag
  (`</refresh>`, `</reflection>`, provider special tokens); without repair a malformed unit
  merges with its neighbor and unbalanced markup enters context. Conservative rule: promote
  the first foreign closer only when no genuine `</reflect>` exists before the next opener.
- The bash-block action detector does NOT port — omp has native structured tool calls, so
  the fork point is the first text/toolcall streaming event and the branch window is
  (rest of main stream) + (tool batch execution), wider than the reference's.

Invariants encoded in the reference's tests (`tests/test_branch_lifecycle.py` etc.):
1. No branch task outlives its turn on ANY exit path (429s / transport drops used to leak
   4 decoding streams into the retry — fixed with an unconditional finally-guard).
2. Cancellation is time-bounded (10s) even against a branch wedged in stream teardown;
   use "wait what settles" semantics, never a bare await on all branch promises.
3. Per-call buffers, never shared mutable model state (concurrent streams stomp it).
4. Branch calls never count toward the agent's step budget.
5. Single-fire per turn (fork once at first content event).
6. Branch failure is never a turn failure (swallow, log).
7. `branch_max_tokens` ~2048: measured p99.9 branch output ≈ 1.2k tokens; the cap bounds
   what the SERVER keeps decoding after client disconnect (vLLM etc. bill it).
8. Conditioning content matters (measured ablation) — fork with the just-finished
   reasoning text, not an empty buffer; empty is the degraded fallback.
9. Harvest cap per atom per turn (reference: 20 complete units).

## omp integration surface (verified)

### Fork trigger / harvest hooks
- `AgentLoopConfig.onAssistantMessageEvent` (packages/agent/src/types.ts:381) fires per
  streaming event with (partialMessage, event); single-owner setter
  `Agent.setAssistantMessageEventInterceptor` (agent.ts:798), already claimed by
  AgentSession (agent-session.ts:1187-1196) which hand-chains streamingEditGuard +
  loopGuards. New consumers get added there — no fan-out machinery.
- `onTurnEnd` (types.ts:488) awaited at agent-loop.ts:628 after tool results persist,
  before next model call. AgentSession's closure at agent-session.ts:1036-1047 chains
  rewind/loopGuards/prewalk/advisors/maintenance by hand.
- Composable alternative: AgentSession session events — `turn_end` emit at
  agent-session.ts:3180-3187 is awaited FIFO; `message_update` emit to extensions at
  :3195-3201 is FIRE-AND-FORGET (unordered) — fine for UI, racy for a fork trigger.
  Built-in feature ⇒ wire into the interceptor/closure chain directly.

### Fold (context injection)
- Established pattern: `role: "custom"` + new `customType` (advisors:
  session-advisors.ts:852-958 customType "advisor"; TTSR agent-session.ts:2344).
  Persists as `custom_message` entry, is a legal compaction cut point
  (compaction.ts:530), converts to a `developer` message
  (compaction/messages.ts:166-230). A brand-new role would touch ~13 files
  (convertOne exhaustive switch messages.ts:1082, persistence allowlist
  agent-session.ts:2073-2081, cut points, serializeConversation, snapcompact, 4+ UI
  switches) — do not add a role.
- Anthropic encoder stable-partitions assistant content [non-tool_use..., tool_use...]
  (anthropic.ts:3808-3841): text spliced "after the action" inside the assistant message
  gets REORDERED before the tool_use blocks (and skips the byte-identical fast path).
- Inserting any message between the assistant tool-call message and its toolResults makes
  transform-messages.ts:882-1073 flush pending calls and synthesize "No result provided"
  error results. Paper-faithful between-action-and-observation placement is effectively
  impossible; fold AFTER the tool results.
- Per-request rewrite alternative: extensions' `context` event (ContextEventResult)
  rewrites messages per request without persistence (runner.ts:1061-1105, sdk.ts:2915).
  Built-in analogue: `transformContext` / convertOne special-casing.
- Compaction hazards: serializeConversation (compaction/utils.ts:273-320) summarizes only
  user/assistant/toolResult — developer-role output of custom messages is DROPPED from
  summary input; snapcompact likewise renders only those three. Reflections older than the
  compaction cut vanish silently (probably acceptable; note it).
- No message-level "useless"/elidable flag exists (only AgentToolResult.useless). Nearest
  analogues: display:false, excludeFromContext on bash/python messages.

### Side-channel LLM calls (branch execution)
- Canonical recipe: AgentSession `#sideStreamFn` (agent-session.ts:536, default :1006,
  usage example :6820-6870): settings-aware stream wrapper
  (session/settings-stream-fn.ts:30 — bare streamSimple bypasses sticky routing,
  watchdogs, in-flight caps; its header documents the bug), session id
  `${cacheSessionId}:side:${Snowflake.next()}` with `promptCacheKey: cacheSessionId`,
  API key via `modelRegistry.resolver(model, sessionId)` (getApiKey BEFORE
  metadataForProvider — ordering constraint documented at auto-thinking/classifier.ts:80-86),
  dedicated AbortController.
- Model roles: `resolveRoleSelection(["reflect", "smol"], settings, registry.getAvailable())`
  pattern (config/model-resolver.ts:1380; role enum config/model-roles.ts:22; add a role
  there + settings-schema modelRoles + priority.json chain or alias).
- Cost: side calls are INVISIBLE to session stats (session-stats.ts:43-103 sums only
  assistant + task-toolResult usage). Advisors precedent: private cost map
  (session-advisors.ts:990) + `recordObservedUsage` (agent-session.ts:2404-2415) for
  broker attribution. Second Thought must keep its own ledger and surface it.

### Streaming layer facts (packages/ai)
- `streamSimple(model, context, options)` (stream.ts:1008). `disableReasoning: true`
  (types.ts:569) → Anthropic thinkingEnabled:false (stream.ts:1489), OpenAI
  reasoningDisableMode (openai-shared.ts:952). CAVEAT: mandatory-reasoning models silently
  clamp disableReasoning to lowest effort (stream.ts:1392; Kimi K3 special case :1191) —
  branch cost model must not assume thinking is truly off everywhere.
- Abort: real HTTP cancellation on all major providers (anthropic.ts:2081/2104,
  openai-responses.ts:403/545, google-shared.ts:872-1019). A cancelled call does NOT
  retry (wasCallerAbort short-circuits, anthropic.ts:2691; empty-completion retry gated
  on !signal.aborted; auth-rotation loop breaks on aborted).
- Provider retry loop (up to 10 on Anthropic, honoring retry-after) CAN fire on a branch
  before it's cancelled — branches must tolerate slow starts and the fork-to-first-token
  latency eating the window.
- In-flight caps: `withProviderInFlightLimit` (stream.ts:559) — if
  maxInFlightRequests[provider] is configured, 4 branches + main serialize behind a
  cross-process file lease. Branch fan-out must respect / degrade under this.
- OpenAI stateful Responses chaining (`previous_response_id`, openai-responses.ts:200):
  concurrent side calls sharing providerSessionState corrupt the chain — side calls must
  set statefulResponses:false or isolate state.
- Prompt cache: Anthropic — 4 breakpoints (anthropic.ts:3121-3145), shared-prefix side
  calls DO cache-read IF byte-identical prefix, same cacheRetention, nothing appended
  before the trailing breakpoints' shared region; appending the atom prompt at the tail
  creates one new suffix entry (expected; the shared prefix still reads). OpenAI —
  prompt_cache_key = sessionId (openai-shared.ts:454): 4 concurrent calls sharing one key
  is the documented anti-pattern; give branches distinct suffixed keys or accept
  contention.

### Thinking availability at fork time (conditioning)
- Anthropic-family: full thinking text streams before text/tool_use — reliable
  conditioning. Exceptions: redacted_thinking (opaque), hideThinkingSummary omitted mode.
- OpenAI Responses/Codex: lossy summaries (sometimes empty; xai-oauth forces none).
- openai-completions dialects: reasoning_content fields, sometimes CUMULATIVE deltas
  (openai-shared.ts:810).
- Owned dialects: thinking known only after closing fence scan.
⇒ Anthropic-first decision. Conditioning source = thinking blocks of the partial
  AssistantMessage at fork; empty string elsewhere (reference fallback).

### Mid-turn loop hazards (agent-loop.ts)
- Harmony-leak retry (:1153-1195): partial discarded, SECOND full thinking/text sequence
  streams within the SAME turn_start/turn_end; onAssistantMessageEvent fires for both.
  Fork logic must cancel branch set and re-arm on retry (or key state by message
  instance, not by turn).
- Truncate-resume (:1169-1185): message replaced without re-stream; extra
  message_start/message_end pair.
- Steering interrupt mid tool-batch (:2245-2350): tools skipped, turn ends early — the
  harvest point still fires (turn_end) but the window shrinks; fine.
- Pause gate (pause.ts): parks at TURN BOUNDARY only — a fork in flight keeps decoding
  while the loop is frozen. Consider pausing/cancelling branches on gate engage.
- Compaction mid-run (session-maintenance.ts:524-546): disconnects + aborts the run and
  mutates/replaces context messages. Branch snapshot must be an immutable copy taken at
  fork (it is, by construction); harvest must tolerate the run dying before turn_end
  (finally-guard cancels).
- Deadline: merged into the run signal; branches must chain to it.
- Subagents: coding-agent runs nested Agents (task tool, advisors) — feature must scope
  to the primary session loop only (advisors' `isPrimary` pattern).

## Cost model (design input)

Per turn in reflect mode: 4 extra prompt-cache-read-priced prefixes + ≤2048 output tokens
each (typically ≤300), on the `reflect`-role model (default: smol-class). The reference
measured mean harvest ≈ 7 units/turn with K=4. Branches bill even when cancelled
(server-side decode until disconnect honored) — the max_tokens cap bounds this.

## Not yet specified (fog, carried into DESIGN)

- Whether reflections should decay/elide after N turns (omp has compaction; reference
  keeps them forever because mini-swe-agent has none).
- TUI presentation: hidden entirely vs a collapsed widget showing harvested units.
- Whether to also condition on partial CONTENT emitted before the first tool call (omp
  models often write prose before tool calls; the reference only had reasoning).
- Eval story inside omp (no SWE-bench harness in-repo; what's the acceptance evidence
  beyond unit tests?).
