# Design (draft): Second Thought in oh-my-pi

Status: DRAFT — adversarial review pending. Built against LANDSCAPE.md (2026-08-17,
coven-bridge-next @ 02cdc617b1). File:line refs re-verified while drafting; a few shift with
unrelated commits, treat line numbers as pointers not guarantees.

Scope reminder: the mechanism (atoms, prompts, parser semantics) is fixed by the reference and
NOT redesigned here. No new message roles — `customType` only. No core changes to
`packages/ai`. Branches obey the 9 reference invariants verbatim.

---

## 1. Candidate architectures

### (a) SecondThoughtCoordinator in packages/coding-agent, TTSR-style

A new class `packages/coding-agent/src/session/second-thought-coordinator.ts`, structurally a
sibling of `TtsrCoordinator`: a host-interface-injected coordinator constructed in
`AgentSession`'s constructor, wired into the same two chains TTSR and advisors already share:

- `onAssistantMessageEventInterceptor` (agent-session.ts:1187-1196) — add a call
  `this.#secondThought.onAssistantEvent(message, assistantMessageEvent)` alongside
  `streamingEditGuard`/`loopGuards`. This is where "first content/toolcall event" fires the
  fork — the interceptor already receives every streaming event pre-classified.
- `onTurnEnd` closure (agent-session.ts:1036-1047) — add
  `await this.#secondThought.onPrimaryTurnEnd(messages, context, signal)` after advisors,
  before maintenance. This is the harvest/fold point: tool results are already persisted
  (agent-loop.ts:628), so folding after this call satisfies the "fold after tool results"
  placement constraint from LANDSCAPE §Fold with zero risk of colliding with
  transform-messages.ts's pending-call flush.
- Side calls go through `AgentSession.#sideStreamFn` (already the canonical recipe:
  settings-aware wrapper, distinct session id, dedicated AbortController) exactly like the
  advisor precedent at agent-session.ts:6820-6870.
- Scoped to primary only via the existing `#agentKind === "main"` check already present on
  `AgentSession` construction (no new isPrimary plumbing needed — subagents/task-tool
  sessions construct with `agentKind: "task"` and the coordinator simply no-ops there).

**Fork trigger lives**: interceptor closure in AgentSession.
**Branch calls run**: coordinator's own side-stream calls via `#sideStreamFn`, unawaited,
tracked in a `Set<AbortController>` + `Promise[]`.
**Harvest/fold**: `onTurnEnd` closure, after tool-result persistence.
**Blast radius**: one new file + ~15-line additions to agent-session.ts (three call sites) +
model-roles.ts (new role) + settings-schema.ts (new keys). No packages/agent changes. Mirrors
a pattern already reviewed and shipped (TTSR) — lowest-risk integration surface in the repo
for "hook into streaming + turn-end and inject a custom message."
**Testability**: unit-testable in isolation with a fake `AgentSessionEvent` host, same harness
`TtsrCoordinator` tests already use (`test/advisor/*`, `test/cli/ttsr-cli.test.ts` show the
pattern: construct with a stub host, drive `onAssistantEvent`/`onPrimaryTurnEnd` directly, no
network). Coordinator has no dependency on AgentSession internals beyond the host interface,
so tests don't need a live streaming loop.

### (b) Fork/harvest as an AgentLoopConfig capability in packages/agent

Push fork-trigger + branch-call + harvest into `packages/agent/src/agent-loop.ts` /
`types.ts` as a new optional `AgentLoopConfig.secondThought` capability block (a sibling of
`onAssistantMessageEvent`/`onTurnEnd`, but owned and driven by the loop itself rather than by
a chained consumer), so any embedder of pi-agent-core gets branch reflection "for free" by
supplying a `branchStreamFn` + atom prompts + model.

**Fork trigger lives**: inside `agent-loop.ts`'s own streaming-event handling, colocated with
the Harmony-retry logic (:1153-1195) it must coordinate with.
**Branch calls run**: loop-owned, using a caller-supplied `StreamFn` (the loop doesn't have
`#sideStreamFn`'s settings-awareness — that's a coding-agent-only concept — so the config
would need to accept a fully-formed `StreamFn`, meaning the caller still builds
`createSettingsAwareStreamFn` before handing it down. This mostly relocates, not removes, the
coding-agent-specific wiring).
**Harvest/fold**: loop's `onTurnEnd` call site (agent-loop.ts:628), producing a message the
loop appends directly — but the loop has no concept of `customType`/persistence entries
(`sessionManager.appendCustomMessageEntry` is a coding-agent construct); the loop would need
to hand back a message for the CALLER to persist, which re-introduces a chained hook anyway.
**Blast radius**: touches `packages/agent/src/types.ts` (AgentLoopConfig surface, a
core/shared file other embedders depend on), `agent-loop.ts` (the Harmony-retry-adjacent hot
path — highest-traffic file in the package), plus still needs coding-agent-side wiring for
settings, model-role resolution, persistence, and cost ledger. Net: touches MORE files across
MORE trust boundaries than (a), for a genericity benefit oh-my-pi doesn't currently need (no
second embedder of pi-agent-core wants this yet).
**Testability**: harder — fork/harvest logic becomes entangled with agent-loop.ts's existing
Harmony-retry/truncate-resume/steering-interrupt state machine (four documented hazards in
LANDSCAPE §Mid-turn loop hazards, all inside this one file), so testing requires driving the
full loop rather than a narrow coordinator with a stub host.

### (c) Hybrid — mechanism in packages/agent, policy in coding-agent

Split cleanly: `packages/agent` gets ONLY a passive extension point — expose the streaming
event and turn-end context with slightly richer typing (e.g. surface the accumulated
`thinking` text at first-content-event directly on the interceptor callback, saving each
consumer from re-deriving it from `partialMessage.content`), while ALL fork/branch/harvest
logic stays in a coding-agent coordinator identical to (a). This is (a) plus one small,
justified upstream addition instead of zero.

Evaluated and rejected for the initial slice: LANDSCAPE confirms
`onAssistantMessageEvent`/`onTurnEnd` already deliver everything the coordinator needs
(partialMessage has `.content` with thinking blocks in Anthropic ordering; turn-end context
carries `willContinue`). No upstream addition earns its blast radius yet. Revisit only if
implementation reveals the coordinator needs data the interceptor doesn't expose (e.g. a
"reasoning just finished, tool batch starting" boundary event distinct from
"first content/toolcall event" — currently the coordinator derives this itself from event
type, which is sufficient per LANDSCAPE's fork-trigger note).

**Verdict**: (a). It is architecture (c) with the packages/agent addition deferred until
proven necessary — same code, smaller diff, same rollback story (delete the coordinator, three
call sites, the role, the settings keys — no packages/agent history to unwind).

---

## 2. Key decisions

### 2.1 Fork-trigger event & re-arm semantics under Harmony retry

Trigger: `onAssistantEvent` fires on `assistantMessageEvent.type` transitioning into the first
`text_delta` / `thinking_delta`-then-content / `toolcall_delta` for the CURRENT streaming
message instance — i.e. first non-thinking content OR first tool-call delta, whichever comes
first, matching the reference's "first content/toolcall event" and the landscape's widened
omp window (rest of main stream + tool batch, since omp has native tool calls, not bash-block
detection).

State is keyed by **message instance identity** (`message.timestamp`, which is stable per
AssistantMessage instance and already used by TTSR for the identical problem —
`ttsr-coordinator.ts:96,243` keys off `event.message.timestamp` for exactly this reason), NOT
by turn. On Harmony-leak retry (agent-loop.ts:1153-1195) the partial is discarded and a second
full thinking/text sequence streams within the same turn_start/turn_end; the interceptor fires
again with a NEW message instance (new timestamp) once truncate-resume replaces it.
Coordinator behavior:

```
onAssistantEvent(message, event):
  if not is-fork-trigger-event(event): return
  if message.timestamp === #forkedForTimestamp: return   // already forked this instance
  if #activeBranches.size > 0:
    cancelAllBranches("retry-superseded")                // invariant 1: no orphaned branch task
    #activeBranches.clear()
  #forkedForTimestamp = message.timestamp
  #conditioningText = extractThinkingText(message)        // invariant 8
  spawnBranches(#conditioningText)                        // fire-and-forget, tracked
```

Single-fire is thus per-message-instance, and a retry that replaces the message instance is
treated as "re-arm": the stale branch set is cancelled (never left decoding, satisfying
invariant 1) and a fresh set is spawned against the new instance's conditioning text. This
converges with the reference's "single-fire per turn" (invariant 5) in the non-retry case and
correctly generalizes it for the retry case the reference didn't have to handle (its bash-block
detector had no equivalent mid-turn replace).

Cancellation trigger: tool batch completion. The coordinator does not get an explicit "tool
batch done" event, so it derives it from `onTurnEnd` firing — at that point the turn's tool
results are already persisted, so cancel-then-harvest happens in the same call:

```
onPrimaryTurnEnd(messages, context, signal):
  if #forkedForTimestamp === undefined: return             // no fork this turn
  results = await cancelAndCollect(deadline: 10s)           // invariant 2: time-bounded
  #forkedForTimestamp = undefined
  units = harvest(results)                                  // parse + truncate + interleave
  if units.length > 0: appendFoldMessage(units)
  recordCostLedger(results)
```

The reference forks at first-content and cancels at "tool batch execution complete," which in
omp is naturally `onTurnEnd` (fires after `agent-loop.ts:628`, i.e. after tool results
persist). This is slightly LATER than the reference's cancel point in wall-clock terms when
prose precedes tool calls (omp's widened window, already called out in LANDSCAPE), which only
grows the branches' available conditioning window — never shrinks it, so no invariant is
threatened by the shift.

Steering-interrupt-mid-tool-batch (agent-loop.ts:2245-2350): `onTurnEnd` still fires (per
LANDSCAPE, "the harvest point still fires, window shrinks; fine") — cancellation and harvest
proceed on whatever's ready, same 10s cap.

Pause-gate (pause.ts, parks at turn boundary only): a branch set in flight when pause engages
would otherwise keep decoding while the loop is frozen indefinitely. Coordinator subscribes to
the same pause signal AgentSession exposes and cancels active branches on pause engage (a
paused loop has no near-term turn_end to harvest against; treat pause as an early
cancel-and-discard, matching invariant 1's "no branch outlives ANY exit path").

Compaction mid-run (session-maintenance.ts:524-546): disconnects + aborts the run. The
branch snapshot is already an immutable copy taken at fork time (array slice, not a live
reference), so it's unaffected. The coordinator's own deadline covers "run dies before
turn_end fires" — `onPrimaryTurnEnd` is only reached if turn_end fires; if the run aborts
entirely, the coordinator needs an unconditional finally-guard on the AgentSession's abort/
dispose path too (mirroring the reference's fix for the same leak class — see Risk R1).

### 2.2 Branch call construction

Convert path: `AgentSession.#convertToLlm` (config.convertToLlm ?? convertToLlm,
agent-session.ts:1077) is the SAME converter the primary turn uses — reuse it, not a bespoke
path, so branch snapshots see exactly the same tool-result/compaction/redaction rules the main
call does. Construction:

```
snapshot = #convertToLlm(agent.state.messages)     // messages AS OF FORK TIME, immutable copy
branchContext = [
  ...snapshot,
  { role: "assistant", content: [{ type: "text", text: conditioningText }] },  // synthetic
  { role: "user", content: [{ type: "text", text: ATOM_PROMPTS[atom] }] },      // synthetic
]
```

Synthetic messages are constructed post-conversion (plain `LlmMessage` shape, not
`AgentMessage`/`CustomMessage`) — they never enter `agent.state.messages` and are never
persisted; they exist only inside the branch call's `context` array, discarded with the branch.
This keeps them out of every allowlist/switch that guards persisted-message roles (no new
customType needed for the synthetic scaffolding itself — only the FOLDED result becomes a
persisted message, see 2.3).

The 4 branches share the identical `snapshot` prefix (same array reference, same
`#convertToLlm` output) — this is what makes the Anthropic cache-key strategy (2.5) land.

### 2.3 Model-role wiring: new `reflect` role

Add `"reflect"` to `ModelRole` (model-roles.ts:22-32) and `MODEL_ROLES`
(model-roles.ts:42-, alongside `smol`/`advisor`):
`reflect: { tag: "REFLECT", name: "Reflect", color: "warning", hidden: true }` — hidden from
the model-selector UI at ship time (2.7's minimum-viable TUI is a footer counter, not a
selector entry) but functional via settings/resolver like every other role.

Resolution: `resolveRoleSelection(["reflect", "smol"], settings, registry.getAvailable())`
(model-resolver.ts:1380 pattern, exact chain already cited in LANDSCAPE) — an explicit
`modelRoles.reflect` setting wins; unset falls back to the `smol` chain, matching the
reference's cheap-model-by-default intent and the existing `tiny → smol` alias precedent
(model-resolver.ts:956-962). No priority.json changes needed for v1 — the smol fallback chain
already resolves to something on every configured provider.

Rejected: reusing `smol` directly without a distinct role. A distinct role lets a user pin
Second Thought to a different (even cheaper, or Anthropic-specific for conditioning parity)
model than whatever `smol` is doing for prewalk/title/classifier work, without those features
colliding on cost/rate-limit budget. Given LANDSCAPE's Anthropic-first framing (only Anthropic
gets real conditioning text; non-Anthropic primaries fork with empty conditioning as the
reference's own degraded fallback), a distinct role also lets the settings UI eventually
surface "reflect model" as an Anthropic-only recommendation without touching `smol`'s docs.

### 2.4 Fold mechanism

customType: `"second-thought"` (new, alongside existing `"advisor"` / `"ttsr-injection"` —
same enum-of-strings `customType` field, no new role, no switch-statement growth risk beyond
what those two already established).

Persisted via the SAME two-write pattern TTSR uses at ttsr-coordinator.ts:436-451 —
`agent.appendMessage({...})` (or `agent.followUp` if a turn is not currently active — see
below) for the live loop's `state.messages`, paired with
`sessionManager.appendCustomMessageEntry("second-thought", content, display, details,
"agent")` for on-disk persistence. Because the fold happens inside `onPrimaryTurnEnd`, which
runs BEFORE the next model call is built but AFTER the just-finished turn's messages persisted
(agent-loop.ts:628 ordering), `agent.appendMessage` (not `followUp`, which targets the
NEXT prompt's queue) is correct — the fold message must be visible when the very next model
call's `convertToLlm` runs, and appendMessage lands directly in `state.messages` synchronously
before that read.

```ts
{
  role: "custom",
  customType: "second-thought",
  content: formatReflectionUnits(units),   // reference's round-robin-interleaved rendering
  display: false,                          // hidden by default; TUI footer counter surfaces count only (2.7)
  attribution: "agent",
  details: { atoms: units.map(u => ({ atom: u.atom, text: u.text })), branchCostUsd, turnTimestamp },
  timestamp: Date.now(),
}
```

`convertOne`'s exhaustive switch (compaction/messages.ts:166-230) already handles unmatched
`customType` strings by falling through to the generic "custom → developer" branch (this is
exactly what makes `customType` extensible without touching the switch — confirmed by the
advisor/ttsr-injection precedent adding new types with zero convertOne edits). `convertOne`
therefore produces a `developer`-role message wrapping `content` verbatim for every provider —
no per-provider special-casing needed for the fold itself.

Placement: strictly AFTER tool results (LANDSCAPE's finding that inserting between an
assistant tool-call message and its results forces transform-messages.ts to synthesize "No
result provided" errors rules out paper-faithful between-action-and-observation placement).
`onPrimaryTurnEnd` firing after persistence guarantees this ordering by construction — no
extra bookkeeping needed to enforce it.

Multiple turns' worth of second-thought messages accumulate as separate custom messages
(one per turn that forked and harvested ≥1 unit), same as advisor cards accumulate — no
merging.

### 2.5 Reflection lifetime / elision policy

Decision: keep reflections as ordinary custom messages subject to the SAME compaction/cut-point
rules as advisor cards — no bespoke decay. Concretely:
- Legal compaction cut point (compaction.ts:530) — already true for any custom message.
- `serializeConversation` / snapcompact drop developer-role custom output from summary input
  (compaction/utils.ts:273-320) — reflections silently vanish once summarized past. This
  matches LANDSCAPE's "probably acceptable" read: reflections are meant to sharpen the VERY
  NEXT turn's judgment, not to survive as long-term memory, so losing them at a compaction
  boundary several turns later costs nothing the mechanism promised.
- No `display:false`-plus-elidable flag exists at message level (only
  `AgentToolResult.useless`); rather than inventing one, ship v1 with `display: false` (hidden
  from transcript UI, present in context) and defer any TTL/N-turn decay to a follow-up if a
  measured context-bloat problem shows up. Rationale: the reference's own reflect harvest is
  small (mean ≈7 units/turn, harvest cap 20/atom/turn) and each fold is one compact developer
  message — bloat risk is low enough that a follow-up (settings key
  `secondThought.retentionTurns`, elide via `display:false` + `excludeFromContext`-style flag
  after N turns) is not blocking for the minimal slice.

### 2.6 Per-provider cache-key strategy for the 4 branches

Anthropic (the only in-scope provider for real conditioning, per LANDSCAPE's Anthropic-first
decision): all 4 branches share `promptCacheKey: cacheSessionId` (same session id the main
call's cache prefix trims to) and the IDENTICAL `snapshot` array — per LANDSCAPE, this cache-
reads on the shared prefix as long as nothing is appended before the trailing breakpoints'
region and the suffix (conditioning + atom prompt) is appended strictly after. Each branch's
suffix differs only in the atom prompt text, which lands in exactly one new cache-write entry
per distinct atom (4 atoms × first-use-per-session, then reads thereafter) — acceptable, this
is the reference's own designed cache topology (shared prefix, atom-specific suffix). No
per-branch `promptCacheKey` suffixing needed on Anthropic; branches WANT to collide on the
prefix.

Side-call session id for tracing/isolation purposes (distinct from cache key) follows the
established recipe: `${cacheSessionId}:side:${Snowflake.next()}` per branch (LANDSCAPE
§Side-channel calls) — this is what keeps 4 concurrent Anthropic streams from stomping shared
mutable state (invariant 3), independent of the shared `promptCacheKey`.

Non-Anthropic providers (out of scope for real conditioning, forks with empty conditioning
text as the degraded fallback): OpenAI's `prompt_cache_key = sessionId`
(openai-shared.ts:454) makes 4 concurrent calls on one key the documented anti-pattern per
LANDSCAPE. Since non-Anthropic branches carry no real conditioning benefit anyway in this
slice, the pragmatic v1 choice is: **don't fork on non-Anthropic primaries at all** — gate
`secondThought.enabled` effectively short-circuits to no-op unless
`resolveProvider(primaryModel) === "anthropic"`. This sidesteps the OpenAI cache-contention
question entirely rather than half-solving it, and matches "other providers fork with empty
conditioning; parity deferred" from the LANDSCAPE goal statement — deferred means NOT shipped
in v1, not shipped-but-degraded. Follow-up ticket: distinct suffixed `prompt_cache_key` per
branch on OpenAI once parity work starts.

### 2.7 Cost ledger

Private cost map on the coordinator, following the advisor precedent exactly
(`#recordAdvisorCost`, session-advisors.ts:989-991): `#branchCosts: number` accumulator (total
USD) plus a per-turn breakdown kept only long enough to attach to the fold message's `details`
(2.4). On each branch's terminal `message_end` (or cancellation, which still bills
server-decoded tokens per LANDSCAPE's cost model — the branch's `usage` is read from whatever
partial/final message the side-stream returns even on abort, matching how the reference
accounts for "branches bill even when cancelled"), fold into `#branchCosts` via the same
`recordObservedUsage` broker-attribution path AgentSession already exposes for advisors
(agent-session.ts:2404-2415) — this is what makes the cost show up correctly attributed in
whatever cost/broker UI already reads `recordObservedUsage`, without a bespoke display path.

Surfacing: session-stats.ts sums ONLY assistant + task-toolResult usage (confirmed in
LANDSCAPE) — Second Thought cost stays off that headline number by design (it's optional
background spend, not primary-loop spend), but the fold message's `details.branchCostUsd`
makes it inspectable per-turn, and `recordObservedUsage` makes it inspectable in the broker/
cost-report surfaces that already aggregate advisor spend. No new cost UI required for v1;
follow-up: a `/cost` or footer breakdown line if usage data shows this needs more visibility
than "check the advisor-style ledger."

### 2.8 Kill-switch / gating

Settings keys, following the `ttsr.*` schema block pattern exactly (settings-schema.ts:3030-):

```
"secondThought.enabled": boolean, default: false   // top-level kill switch, default OFF per spec
"secondThought.atoms": array<enum>, default: ["check","rehearse","recall","alternative"]
                                     // lets a user disable individual atoms without disabling the feature
"secondThought.branchMaxTokens": number, default: 2048   // invariant 7's cap, user-tunable
"secondThought.harvestCapPerAtom": number, default: 20   // invariant 9, user-tunable
```

All under `ui: { tab: "context", group: "Second Thought" }`.

Per-session toggle: NOT exposed as a separate runtime command in v1 — settings changes apply
per-session the same way `ttsr.enabled` does (read fresh each turn via `this.#host.settings`,
no caching), so a user can flip it mid-session through the existing settings UI/CLI without a
bespoke slash command. A `/reflect on|off` convenience command is a natural, cheap follow-up
(mirrors `/ttsr` if one exists) but isn't required for the minimal slice.

Primary-session-only scoping: reuses the EXISTING `#agentKind` check already on every
AgentSession (`config.agentKind ?? "main"`) — the coordinator's constructor takes the agentKind
and short-circuits every method to a no-op when `agentKind !== "main"`. This is strictly
simpler than introducing a bespoke `isPrimary` flag (LANDSCAPE's suggested pattern) because
`agentKind` already IS that signal for every other agentKind-gated feature in the codebase; no
new field needed.

Additional automatic gate (not a setting, a hard invariant): `resolveProvider(primaryModel) ===
"anthropic"` per 2.6 — non-Anthropic primaries never fork in v1 regardless of
`secondThought.enabled`, and the coordinator should emit a one-time debug-level notice (not a
user-facing warning; this is expected/by-design, not an error) the first time a non-Anthropic
turn skips a fork with the setting on.

### 2.9 TUI treatment (minimum viable)

Hidden by default (`display: false` per 2.4) plus ONE footer counter: a small status-line
segment (mirrors existing advisor-status footer entries, e.g. "3 advisors running") reading
something like `↺ 2` when the current session has ≥1 harvested-unit fold pending display, or
simply omitted when 0/disabled. No expandable widget, no per-atom breakdown, no transcript
rendering of the reflection content itself in v1 (a user who wants to read it can toggle
`display: true` via... actually no toggle exists yet, so v1 truly is invisible content — the
footer counter is the ENTIRE UI surface). Follow-up: a collapsed widget (press to expand and
read harvested units) is the natural v1.1 if the feature proves useful, explicitly punted per
LANDSCAPE's "fog" list.

---

## 3. Module layout

New files:

| File | Responsibility | Est. size |
|---|---|---|
| `packages/coding-agent/src/session/second-thought-coordinator.ts` | Coordinator class: fork-trigger state machine, branch spawn/cancel, harvest orchestration, fold-message construction, cost ledger | ~450-550 lines (TtsrCoordinator is 496; this has less matcher/interrupt complexity but adds branch-lifecycle/cancellation bookkeeping) |
| `packages/coding-agent/src/session/second-thought-atoms.ts` | Ported verbatim: 4 atom continuation prompts (prompts.py), atom enum, `ATOM_PROMPTS` map | ~80-120 lines (prompt text dominates) |
| `packages/coding-agent/src/session/second-thought-parser.ts` | Ported: reflect-unit parser — count/parse typed units, `normalize_reflect_closers` malformed-closer repair, truncate-at-last-closer, round-robin interleave | ~200-280 lines (action_detector.py's reflect-half plus the conservative-promotion repair rule) |
| `packages/coding-agent/test/second-thought/second-thought-parser.test.ts` | Parser unit tests: well-formed units, malformed-closer repair (the 1.8%-measured cases: `</refresh>`, `</reflection>`, provider special tokens), truncation, interleave, harvest cap | ~250-400 lines |
| `packages/coding-agent/test/second-thought/second-thought-coordinator.test.ts` | Coordinator tests with stub host: fork-once-per-instance, retry re-arm/cancel, turn-end harvest, pause-engage cancel, agentKind !== "main" no-op, non-Anthropic no-op, cost ledger accumulation | ~300-450 lines |
| `packages/coding-agent/test/second-thought/second-thought-fold.test.ts` | Fold-message shape/persistence: customType round-trips through `appendCustomMessageEntry` + `convertOne` → developer message, compaction cut-point legality | ~120-180 lines |

Modified files:

| File | Change | Est. diff |
|---|---|---|
| `packages/coding-agent/src/session/agent-session.ts` | 3 call sites: coordinator construction (near TtsrCoordinator's, ~line 1125-1134), interceptor chain addition (~1187-1196), onTurnEnd closure addition (~1036-1047) | ~25-35 lines |
| `packages/coding-agent/src/config/model-roles.ts` | Add `"reflect"` to `ModelRole` union + `MODEL_ROLES` entry | ~4 lines |
| `packages/coding-agent/src/config/model-resolver.ts` | No structural change — `resolveRoleSelection(["reflect","smol"], ...)` called from the coordinator, resolver itself is generic | 0 lines (verify no role-specific special-casing exists that needs an entry — spot-checked, none found for `advisor`/`smol` beyond the alias table already covering fallback chains) |
| `packages/coding-agent/src/config/settings-schema.ts` | New `secondThought.*` block (4 keys), pattern-identical to `ttsr.*` | ~60-80 lines |
| `packages/coding-agent/src/session/session-advisors.ts` or new host wiring | None expected — Second Thought does not touch advisors | 0 lines |
| Session-stats / cost-report surface (exact file TBD at implementation time — wherever `recordObservedUsage` consumers already read advisor spend) | Confirm Second Thought's `recordObservedUsage` calls attribute correctly; likely 0 lines if the broker path is generic | 0-10 lines |
| TUI footer/status-line component (exact file TBD — wherever the advisor-count footer segment lives) | Add one conditional counter segment | ~15-25 lines |

Total new code: roughly 900-1400 lines including tests (parser + coordinator dominate,
matching the reference's own ~900-line core file's proportions once ablation arms are
dropped). Total modified-file diff: roughly 100-150 lines.

---

## 4. Risks, ranked

**R1 — Branch leak on an exit path the coordinator doesn't explicitly handle (HIGH).** The
reference's own history is a direct warning: 429s/transport drops leaked 4 decoding streams
into the retry before an unconditional finally-guard fixed it (invariant 1's origin story).
omp has MORE exit paths than the reference's mini-runner: Harmony retry, truncate-resume,
steering interrupt, pause gate, compaction-triggered abort, session dispose, process exit.
Mitigation: implement cancellation as a single `#cancelActiveBranches(reason)` method wrapped
in a `try/finally` at every one of these call sites, not scattered ad-hoc cancel calls — audit
against the exact list in LANDSCAPE §Mid-turn loop hazards during implementation, and add a
coordinator-level "no branch survives coordinator disposal" test that forces each exit path.

**R2 — Cache-key assumptions unverified against actual Anthropic billing (MEDIUM).** 2.6's
shared-prefix cache-read strategy is a documented mechanism (anthropic.ts:3121-3145) but LANDSCAPE
flags "shared-prefix side calls DO cache-read IF byte-identical prefix... nothing appended
before the trailing breakpoints' shared region" as a conditional, not a guarantee independent
of exact breakpoint placement. If the main call's own breakpoints shift per-turn (e.g. system
prompt caching boundaries move), 4 branches could each pay a fresh cache-write instead of a
cache-read, quietly 4x-ing cost without failing anything. Mitigation: instrument
`recordObservedUsage`'s cost breakdown to distinguish cache-read vs cache-write spend per
branch from day one (not a follow-up) so a regression here is visible in the ledger
immediately, not discovered via a cost audit weeks later.

**R3 — In-flight request caps silently serialize branches behind the main call (MEDIUM).**
LANDSCAPE: `maxInFlightRequests[provider]` configured means 4 branches + main serialize behind
a cross-process file lease — this defeats the entire "cost rides in the idle window, latency
cost ~zero" value proposition, turning Second Thought into a LATENCY cost when a user has
tuned in-flight caps for rate-limit reasons (a reasonably common Anthropic-tier-limited
config). Mitigation: coordinator checks the effective in-flight cap at fork time and skips
forking (not: forks and blocks) when `maxInFlightRequests.anthropic` is set below some
threshold (e.g. ≤4, main call already consumes 1 of the slots) — degrade to "feature quietly
does nothing this turn" rather than "feature silently makes the primary loop slower."

**R4 — Compaction/context-drop mid-fork corrupts the snapshot's usefulness (LOW-MEDIUM).**
Branch snapshot is an immutable array copy per LANDSCAPE ("it is, by construction"), so no
crash risk — but if compaction rewrites `agent.state.messages` mid-flight, the fold message
(built from the OLD snapshot's conversation) gets appended into a context that has since been
summarized past that point, producing a reflection that references content the model can no
longer see when it reads the fold on the next turn. Mitigation: `onPrimaryTurnEnd` should
check whether a compaction occurred between fork and harvest (a monotonic generation counter,
same pattern as `#promptGeneration` already used by TTSR) and drop the fold silently if stale
rather than append a dangling reference — cheap check, prevents a confusing artifact.

**R5 — `reflect`-role model selection lands on a model with mandatory reasoning (LOW).**
LANDSCAPE: mandatory-reasoning models silently clamp `disableReasoning` to lowest effort
(stream.ts:1392) rather than truly disabling it — if the `smol` fallback chain resolves to
such a model, branch calls cost more and take longer than the ~2048-token/thinking-disabled
budget assumes, again eroding the idle-window-only cost story. Mitigation: no code fix needed
in v1 (this is a pi-ai-level provider quirk, out of scope per "no core changes to
packages/ai") — document it in the settings UI description for `modelRoles.reflect`
("choose a fast, non-reasoning model for best results") and let R2's cost-ledger
instrumentation surface a cost anomaly if it happens in practice.

**R6 — Feature creep pressure to add the TUI widget / retention policy in v1 (LOW, process
risk not technical).** Both 2.5 and 2.9 explicitly defer real functionality (elision policy,
expandable widget) to keep the shippable slice small. Named here so the recommendation in §5
is legible as a deliberate scope cut, not an oversight.

---

## 5. Recommendation

**Architecture: (a)**, the `SecondThoughtCoordinator` in `packages/coding-agent/src/session/`,
TTSR-structured. It reuses a pattern already built, reviewed, and running in production
(TtsrCoordinator), touches zero files outside coding-agent, and keeps every reflection-specific
concern (settings, model roles, persistence, cost ledger, TUI) where those concerns already
live for every other coding-agent feature. Architecture (b)'s genericity has no second consumer
today and would spread fork/harvest logic into `agent-loop.ts`'s already-dense Harmony-retry
neighborhood — the highest-risk file to add complexity to per LANDSCAPE's own hazard list.
Architecture (c) is directionally right as a LATER refinement but has no concrete payload yet
that (a) can't already deliver via the existing interceptor/onTurnEnd surface.

**Minimal shippable slice** (all of §2, scoped as written above):
- Coordinator + parser + atom prompts, ported per LANDSCAPE's fixed-mechanism constraint.
- `reflect` model role, `secondThought.*` settings (default OFF), Anthropic-only gating,
  primary-session-only via existing `agentKind`.
- Fold as `customType: "second-thought"`, `display: false`, no elision policy beyond ordinary
  compaction cut-point behavior.
- Cost ledger via `recordObservedUsage`, no dedicated cost UI.
- TUI: single footer counter, no widget, no transcript rendering.
- Tests: parser (malformed-closer repair is the highest-value test given the reference's
  measured 1.8% incidence), coordinator lifecycle (all 6 exit paths from R1), fold shape.

**Explicit follow-ups (not v1)**:
- OpenAI/other-provider conditioning parity (distinct suffixed cache keys, real thinking-text
  extraction per provider) — deferred per the goal statement itself.
- Reflection retention/decay policy beyond compaction's natural drop (`secondThought.retentionTurns`).
- `/reflect on|off` slash command for mid-session toggle convenience.
- Expandable TUI widget to read harvested units instead of only a count.
- Partial-content-before-first-tool-call as additional conditioning source (LANDSCAPE fog item
  — needs its own measurement before deciding; the reference never had this case).
- Eval story: no SWE-bench harness in-repo; acceptance for v1 is unit tests + the parser's
  malformed-closer corpus behavior, not an end-to-end quality measurement. Flagged, not solved,
  here.
