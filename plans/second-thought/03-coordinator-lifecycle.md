# Coordinator lifecycle state machine
STATUS: open
PRIORITY: p1
REPOS: oh-my-pi
COMPLEXITY: architectural
TOUCHES: packages/coding-agent/src/session/second-thought/coordinator.ts, packages/coding-agent/test/second-thought/coordinator.test.ts
BLOCKED_BY: 02

## Goal
`SecondThoughtCoordinator` exists with the full fork/cancel/harvest lifecycle, correct on
every loop exit path, testable with a stub host and no network.

## Approach
Host-interface-injected class (TtsrCoordinator pattern). State: fork generation counter
(monotonic, incremented per fork; NOT raw `message.timestamp` equality — same-millisecond
replacement hazard, red-team A issue 4), active branch handle (02), history-epoch at fork,
conditioning text, per-turn skip reason.

- **Fork trigger** (`onAssistantEvent`): fire on the first `toolcall_start` of a streaming
  message instance (NOT text events — text-only turns have no window and no next call;
  NOT toolcall_delta — no-arg tools may never delta; codex finding 19, grok finding 10).
  Single-fire per message instance. On a second streaming sequence within one turn
  (Harmony abort-retry — only reachable on non-Anthropic, so dormant in v1 but keep the
  logic correct): cancel the stale generation, re-arm. Truncate-resume does NOT re-fire
  streaming events — no re-arm expected (red-team A issue 4; encode in tests).
- **Skip conditions** (checked before fork, each recorded as a ledger skip reason):
  feature disabled; `agentKind !== "main"`; primary or resolved branch model not
  Anthropic-API; conditioning text below `secondThought.minConditioningChars` (empty or
  redacted thinking — codex finding 20); context estimate above
  `secondThought.maxContextTokens`; a 429 observed on the provider within the cooldown;
  in-flight cap for the provider configured and ≤ K+1; adaptive window skip — EMA of this
  session's recent tool-batch wall-clock below measured branch TTFT EMA (grok finding 10).
- **Cancel/harvest** (`onPrimaryTurnEnd`): abort all branch controllers synchronously;
  collect what settles within `~300ms` grace; hand settled text to harvest (parser, 01)
  and the fold store (04); detach remaining teardown + final usage collection to a
  background finalizer with the reference's 10s bound (never awaited by the loop —
  red-team A issue 5 / B issue 6). Drop the fold when the history epoch moved between
  fork and harvest (rewind/replaceMessages/compaction — `#promptGeneration` does not move
  on same-run rewind, red-team A issue 6).
- **Unconditional cleanup**: at fork time register abort on the run's AbortSignal;
  idempotent `cancelActive(reason)` also invoked from session `abort()`, `dispose()`,
  session switch/branch/tree navigation resets (codex finding 18: specify reset for new
  session, switch, fork, rewind, model change, config reload). Late results from a
  cancelled generation are discarded by generation id even if abort settlement failed
  (codex finding 4).
- **No pause-engage action** — an in-flight turn still reaches turn_end under pause;
  harvest covers it (red-team A issue 7).
- No-tool turns (stream ends with zero toolcall_start): nothing was forked; nothing to do.
  A fork whose turn ends up aborted: cancel-and-discard, no fold.

## Cross-Repo Side Effects
None (agent-session.ts wiring happens in 08).

## Verify
Stub-host unit tests forcing every exit path: normal harvest; user abort mid-stream;
abort mid-tool-batch; compaction abort; dispose; session switch; rewind-then-harvest
(epoch drop); Harmony abort-retry re-arm; truncate-resume no-re-arm; same-millisecond
replacement; each skip condition produces the right skip reason and no branch call; no
branch handle survives any test ("no branch outlives the coordinator" assertion in every
case); harvest grace never exceeds ~300ms even with a wedged fake stream.
