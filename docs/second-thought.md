# Second Thought

Background reflection while tool calls run. Default **off** (`secondThought.enabled`),
main sessions only, Anthropic-API models only.

Design authority: `plans/second-thought/DESIGN.md`. This file documents what is wired
where; each module's own header documents its contract.

## What it does

When the streaming assistant message opens its **first tool call**, a side call forks
against the **primary model with an identical request shape** — same system prompt, same
tools, same thinking config, the conversation snapshot plus one synthetic user turn
carrying the just-finished thinking text and a prompt asking for typed `<reflect>` units.
Identical shape is the point: Anthropic's cache is model- and shape-scoped, so the branch
reads the main call's prefix from cache instead of paying for it.

When the turn ends the branch is aborted, whatever settled within ~300 ms is harvested,
and stream teardown detaches to the background. The harvested units are **never persisted
as context messages**. They are held as one *pending fold* and injected — once, as an
inert `user`-role observation block, as the LAST message — into the next provider request
of the same run, then retired. A non-context `custom` session entry records what happened
for inspection.

Turns that open no tool call do not fork. A fork whose turn aborts, rewinds, or compacts
is cancelled and discarded.

## Modules

| File (`packages/coding-agent/src/session/second-thought/`) | Owns |
|---|---|
| `gating.ts` | `secondThought.enabled` + main-session + both-models-Anthropic gate; branch-model resolution |
| `branch-call.ts` | Branch request assembly, prefix parity, the eager fan-out, stream execution |
| `coordinator.ts` | Fork / cancel / harvest lifecycle, circuit breakers, adaptive skip |
| `parser.ts`, `atoms.ts` | `<reflect>` unit parsing (incl. malformed-closer repair); atom prompts |
| `fold.ts` | Pending fold, injection, retirement, the diagnostic entry payload |
| `ledger.ts` | Branch token/cost accounting, skip and drop reasons, broker attribution |
| `wiring.ts` | `SecondThoughtRuntime` — assembles the above and exposes the surface `AgentSession` calls |

## Host wiring (`agent-session.ts`)

The runtime is constructed only for `agentKind === "main"` **and** only when the host
supplied a settings-aware `sideStreamFn` (the SDK does; `AgentSession`'s own fallback is
bare `streamSimple`, which drops provider routing and in-flight caps). A subagent or a
bare-constructed session therefore carries none of the feature.

| Site | Call |
|---|---|
| `agent.addBeforeModelCall` | `onProviderCall` — arms the stream, injects the pending fold as the final message, captures the fork context |
| `setAssistantMessageEventInterceptor` | `onAssistantEvent` — fork trigger on the first `toolcall_start` |
| `message_start` (assistant) | `noteStreamStart` — a no-op by construction; see below |
| `setOnTurnEnd`, before the advisors | `onPrimaryTurnEnd` — abort + ≤300 ms harvest |
| `agent_end` | `onRunEnd` — retire an undelivered fold |
| `abort()` | `cancelActive("session-abort")` |
| `beginDispose()` | `dispose()` |
| session switch / branch / tree navigation / new session | `reset()` |
| `agent.replaceMessages` (wrapped) | `bumpHistoryEpoch()` |

**Stream identity** is the provider-CALL sequence, not the message object. `agent-loop`
reassigns `event.partial` on every event, the Harmony truncate-resume path re-pushes
`message_start` for a message recovered without a new provider call, and two further
no-content `message_start`/`message_end` pairs are not replacement streams. All of them
carry a sequence the real stream already consumed, so arming is idempotent on them. The
Harmony abort-retry *does* open a new provider call, moves the sequence, and correctly
re-arms — cancelling the abandoned stream's fork.

**Fold placement** is `addBeforeModelCall` rather than `transformProviderContext` for two
reasons: it is strictly the last thing added before the wire (`extensionRunner.emitContext`
and `wrapSteeringForModel` run inside `transformContext` and would append after the fold),
and it is main-loop-only — `transformProviderContext` is also reached by
`buildSideRequestContext` (handoff, `/btw`, ephemeral turns), where a delivered fold would
be permanently spent on a request it was never meant for.

**History staleness** is a host-owned epoch counter, bumped by wrapping
`agent.replaceMessages`. `#promptGeneration` does not move on a same-run rewind, which is
exactly the case this guards; and there are 25+ `replaceMessages` call sites across
prewalk, maintenance, turn-recovery, TTSR, and handoff, so wrapping the one method they
all pass through is the only enforceable form of the rule.

## Accounting

Branch spend never enters the session totals. `branch-call` strips `onResponse` both
before and after host option preparation, so the session's provider-header ingest — which
hard-codes the primary session id — is never reached by a branch response. Attribution
runs through the ledger, under the branch's own side session id, and the ledger reports
tokens first (an OAuth credential burns quota, not dollars) with USD as an indicative
secondary figure.

The post-abort decode undercount is reported as a **bound** (`branchMaxTokens −
observedOutput`), not as an observation: nothing on the wire reports what the provider
decoded after the disconnect.

## Settings

`secondThought.enabled`, `.branchCount`, `.branchMaxTokens`, `.harvestCapPerAtom`,
`.atoms`, `.maxContextTokens`, `.minConditioningChars`, `.deliveryCalls`,
`.showInTranscript`. See `config/settings-schema.ts`.

## Tests

`packages/coding-agent/test/second-thought/`. `integration.test.ts` drives a real
`AgentSession` against a scripted provider and asserts the same-run delivery, the
final-message placement, primary-accounting isolation, every abort-shaped exit, and the
cache acceptance gate (branch prefix byte-identical to the main call's, encoded through
`convertAnthropicMessages`). A live `cache_read_input_tokens > 0` assertion needs a paid
call and is out of scope; the wire-shape precondition is what is asserted here.
