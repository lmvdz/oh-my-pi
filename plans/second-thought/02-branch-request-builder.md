# Branch request builder and side-call executor
STATUS: done
PRIORITY: p1
REPOS: oh-my-pi
COMPLEXITY: architectural
TOUCHES: packages/coding-agent/src/session/second-thought/branch-call.ts, packages/coding-agent/test/second-thought/branch-call.test.ts
BLOCKED_BY: 01

## Goal
A branch call can be constructed and executed: given a fork-time snapshot, conditioning
text, and target model, it produces one streaming side call whose request shape is
byte-compatible with the main call's cache prefix, and returns the accumulated text (or a
clean abort).

## Approach
- **Snapshot**: materialize the full provider-facing request at fork time — run the
  session's convert pipeline over the messages as of fork and deep-copy the result (codex
  finding 5: array slices are shallow; compaction pruning/shake mutate content in place
  while a branch waits on an in-flight lease). Capture system prompt and the full
  normalized tool set the way `Agent.buildSideRequestContext` (packages/agent/src/agent.ts:764)
  does — identical shape is what buys the cache-read (DESIGN key decision).
- **Request shape**: same model as primary (default; explicit `reflect` role override
  re-normalizes for the target model — codex finding 6), same thinking config as the main
  call (do NOT disableReasoning — messages-tier cache invalidation + silently ignored on
  adaptive-only models, red-team B issue 2/5), `maxTokens` from
  `secondThought.branchMaxTokens` (default 2048), no toolChoice parameter (cache-affecting;
  tool avoidance is steered by combined-branch.md prompt text instead — codex finding 4).
- **Suffix**: snapshot + synthetic assistant message carrying the conditioning text +
  user message with the combined-atom prompt. Synthetic messages never enter
  agent.state.messages.
- **Execution**: through the settings-aware stream fn — assert it as a constructor
  precondition, never default to bare `streamSimple` (AgentSession's own default is bare;
  settings-awareness comes from the SDK construction path — red-team A issue 8). Side
  session id `${cacheSessionId}:side:reflect:${Snowflake.next()}`; dedicated
  AbortController chained to the caller-provided run signal; `statefulResponses` isolation
  not needed in v1 (Anthropic-only) but note it for the parity follow-up.
- Accumulate `text_delta`s into a per-call buffer; stop early when the parser (01) counts
  `secondThought.harvestCapPerAtom × atomCount` complete units. Thinking deltas are
  ignored (harvest text only). Tool-call deltas mark the call `toolUseLeak: true` for the
  ledger. On abort: return whatever accumulated plus whatever usage arrived; never throw
  into the caller; never retry after caller abort (verified provider behavior).
- If K>1 is configured: stagger — fire call 1, await its first streamed token, then fire
  the rest (concurrent identical-prefix requests all pay full price until the first
  response begins streaming — red-team B issue 3).

## Cross-Repo Side Effects
None.

## Verify
Unit tests with a scripted StreamFn: request shape equality against a reference main-call
request (system, tools, thinking config, message prefix all byte-equal up to the synthetic
suffix); abort mid-stream returns partial buffer and does not retry; early-stop at unit
cap; stagger ordering when K>1; toolUseLeak flagging.

## Resolution
Shipped: branch-call.ts, merged via second-thought/02-branch-request-builder (final 6aedf87822). 3 gauntlet rounds, dual-lineage; conditioning moved from assistant-suffix to combined user message after the golden test proved wire-prefix divergence (recorded deviation). Issue #4.
