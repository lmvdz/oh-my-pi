# AgentSession integration and end-to-end acceptance
STATUS: done
PRIORITY: p1
REPOS: oh-my-pi
COMPLEXITY: architectural
TOUCHES: packages/coding-agent/src/session/agent-session.ts, packages/coding-agent/src/sdk.ts, packages/coding-agent/test/second-thought/integration.test.ts
BLOCKED_BY: 03, 04, 05, 06

## Goal
The coordinator is wired into a live AgentSession behind the gate, all exit paths are
covered in an end-to-end harness, and the cache-read acceptance gate passes.

## Approach
This concern is the SOLE owner of agent-session.ts edits (03/04/06 build against a host
interface) to avoid shared-file conflicts. Call sites:
1. Construction near TtsrCoordinator's, with the settings-aware stream fn passed
   explicitly (precondition from 02 — AgentSession's own `#sideStreamFn` default is bare
   `streamSimple`).
2. Interceptor chain (`setAssistantMessageEventInterceptor` closure, ~agent-session.ts:1187):
   `secondThought.onAssistantEvent(...)` — fork trigger.
3. `onTurnEnd` closure (~:1036): `await secondThought.onPrimaryTurnEnd(...)` ordered
   BEFORE advisors' `waitForCatchup` (grok alternative 3: never queue the ≤300ms harvest
   behind a potentially 30s advisor backlog wait) and before maintenance.
4. `abort()` and `dispose()`: `secondThought.cancelActive(reason)` — the exit paths
   turn_end never covers (all four reviewers).
5. Session switch / branch / tree-navigation reset sites: coordinator reset (codex
   finding 18 list).
6. Per-request injection hook: wire 04's fold delivery into the session's context
   assembly (transformContext/convert pipeline call site in sdk.ts/agent-session.ts —
   choose the single point through which EVERY provider request passes, including
   continuation calls inside a run; this is the fix for the draft's fatal
   appendMessage-invisible-to-live-run flaw, so the integration test must prove a fold
   reaches call N+1 of the SAME run).
- End-to-end harness with a scripted provider: multi-tool-call run where turn N harvests
  and call N+1's request contains the fold; abort/compaction/rewind variants confirm no
  fold and no leaked branch; `bun run check` (or repo equivalent) green.
- Cache acceptance gate: recorded-fixture or live-flagged test asserting branch
  `cache_read_input_tokens > 0` against the main call's prefix (06).
- Update AGENTS.md/docs feature inventory if the repo maintains one.

## Cross-Repo Side Effects
None.

## Verify
Integration suite green including every exit path from 03's list driven through the REAL
AgentSession (not the stub host); fold visible in same-run next request; repo typecheck/
lint/test pipeline green; feature off by default confirmed by a no-settings smoke run.

## Resolution
Shipped: AgentSession wiring (wiring.ts + call sites), merged via second-thought/08-integration (final 29e9857a04). 4 rounds; disabled-path zero-delta enforced at construction; fold re-obfuscation; unconditional resets at committed transitions. Deviations (addBeforeModelCall arming + injection) adjudicated and recorded. Issue #10.
