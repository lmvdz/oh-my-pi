# Hierarchical context cache — design

STATUS: proposed (rev 2)
PLANE: none
OWNER: lars

## Problem

Parallel subagents cost `N × (shared context)` in cold cache reads today, even
when each needs a large slice of the parent's context. Verified in
`buildSubagentSessionOptions` (`task/executor.ts`): subagent spawns omit
`promptCacheKey`, so they get a fresh cache identity. And a subagent's system
prompt differs from the parent's, so even inheriting the parent's key would
not hit a byte-prefix cache.

Prefix caches (`cache_control` on Anthropic, `prompt_cache_key` on OpenRouter)
match a **contiguous, byte-identical prefix from token 0**. Cache reuse between
a parent and its subagents is possible only when the subagent's context is
ordered so its needed slice is a stable prefix shared with (a slice of) the
parent. The hard problem is the representation: what is actually shareable,
and how to order it so plausible subagent working sets are prefix-addressable.

## The distinction that frames everything: INPUT substrate vs TRANSCRIPT

A session's prompt is two very different things, and they do NOT behave the
same under a prefix cache:

- **INPUT substrate** (shareable): system prompt, model identity, repo tree /
  root metadata, static docs, `contextFiles`, the task assignment. This is the
  task-agnostic, turn-independent foundation. It is identical across the main
  agent and any subagent that inherits it. **This is what prefix caching can
  reuse.**

- **TRANSCRIPT tail** (NOT shareable): assistant turns, tool calls, tool
  results, user follow-ups accumulated during the parent's run. These are
  turn-dependent trajectory state — a subagent forked from the parent cannot
  reuse them as a prefix because they encode the parent's specific decisions,
  and any subagent context intentionally starts fresh (`subagent-system-prompt.md`
  replaces the parent system, `options.context` seeds a new first turn).

**Therefore the reusable prefix is the INPUT substrate only.** The segment tree
models the construction of the input substrate, NOT the transcript. Treating
tool results as a "segment" is wrong — they are trajectory, cannot be shared,
and any claim of cache reuse for them is invalid. The transcript tail is always
the cold, per-invocation suffix.

This reframing makes the design tractable: we are not canonicalizing a message
log; we are building a **stable, ordered, prefix-able assembly of the input
substrate**, which is a much smaller and more tractable object.

## Goal

A hierarchical cache model over the INPUT substrate: the parent builds its
substrate in a **stable, segment-ordered** way so that any subagent inheriting a
subtree hits the cache for the inherited segments and pays only for its own
leaf + its transcript tail.

## Core insight: a segment tree with per-segment cache keys, over the substrate

Replace the single monolithic `promptCacheKey` with a **tree of cache segments**
(rooted at the session). Each segment:

- stable `segmentId` (→ cache key / `cache_control` boundary)
- ordered list of child segments (canonical ordering)
- `solidified: boolean` — content frozen, so cacheable
- content hash (invalidate a subtree when a parent segment's content changes)

Concrete substrate inventory for an omp agent:

```
segment 0 [global: system prompt + model identity + global tool schemas]  // always inherited
  ├─ segment 1 [repo: root tree / index / metadata]                        // inherited by repo-scoped subagents
  │    ├─ segment 3 [context file A]
  │    └─ segment 4 [context file B]
  └─ segment 2 [agent/task identity]                                       // per spawn; leaf
```

The **transcript tail** is not in this tree — it is appended after the
inherited substrate prefix on each invocation, cold.

## Rules that make inheritance work

1. **Substrate only, global first.** Only input substrate is a segment. System
   prompt + model identity is always segment 0; every agent inherits it. This
   is the 91%-cache-read case we measured on the main loop, preserved and made
   explicit.

2. **Segments immutable once solidified.** A solidified segment's content never
   mutates; stable key preserved. A change appends a NEW child segment rather
   than editing in place, so the old prefix stays valid for anyone still on it.

3. **Canonical child ordering.** Children ordered by a stable rule (declaration
   order, then hash). Two agents sharing a parent agree on prefix byte-order.
   No reorder after solidify (reorder breaks contiguity — see "not this
   design").

4. **Derived cache key = stable hash of the prefix path + content hash.** A
   subagent's `promptCacheKey` is derived from its inherited segments, so
   `key(subagent) == key(parent's same segments)`. Leading segments hit the
   provider cache; only the divergent leaf + transcript tail are cold. Where a
   backend exposes explicit breakpoints (`cache_control` on Anthropic,
   `prompt_cache_key` on OpenRouter), pin each solidified boundary.

5. **Subagent spawn inherits the parent prefix chain** — `buildSubagentSessionOptions`
   sets `promptCacheKey` = `deriveKey(parent.substratePrefix + ownLeaf)`, fixing
   the verified gap. Requires that the subagent's assembled prompt actually
   starts with the inherited substrate bytes (rule 1 guarantees segment 0; the
   spawn must prepend the parent's substrate verbatim, not re-derive it).

6. **Transcript tail is always cold.** By construction each invocation appends
   its own transcript; never treat trajectory as a shareable segment.

## How a subagent is assembled (the concrete flow)

```
subagent.request =
    [parent.substratePrefix]   // verbatim bytes, segments 0..k, cache-warm
    + [subagent own leaf]      // its task/identity, cold
    + [subagent transcript]    // its own trajectory, cold
promptCacheKey(subagent) = deriveKey(substratePrefix) → hits provider cache
                            on segments 0..k
```

The cost of a parallel batch of `N` subagents each inheriting `S` substrate
tokens becomes:

- cache-read on `S` for each of `N` (`~0.1 × S × N` on Anthropic-style caching),
- full price on each divergent leaf + its own trail.

vs today (`N × S` full-price). This is the sharding cost model the user asked
about, and it is why prefix-sharing the substrate before sharding matters.

## What this fixes

- **Parallel subagents** (`task` batch): share segments 0..k → cache hit on the
  shared substrate, pay only the divergent leaf + own transcript.
- **Forks / branches**: `providerPromptCacheKey` already inherits at session
  level (`agent-session.ts`); segment level lets a branch reuse the parent's
  solidified substrate even as its tail diverges.
- **Long-lived campaign agents**: stable substrate root + per-turn leaf; every
  turn re-reads the solidified root.

## Provider mapping

- **Anthropic**: `cache_control: { type: "ephemeral" }` on the last block of
  each solidified segment (machinery already in `applyPromptCaching` /
  `applyCacheControlToLastBlock`, `anthropic.ts`). Multi-breakpoint is native.
- **OpenRouter**: `prompt_cache_key` on the substrate prefix (already used at
  `getOpenAIPromptCacheKey`, `openai-shared.ts`); single key for the whole
  substrate head is acceptable — no need for per-segment keys on the wire.
- **Codex / Copilot**: vary; fall back to the single substrate key or none.
  A provider abstraction maps a segment chain → wire format.

## Open problems / tradeoffs

1. **Representation cost.** Segment tree + solidified tracking is real
   machinery. Payoff only when subagents share large substrate AND run in
   parallel (the `stateroom` campaign pattern). For a single linear main-agent
   session the current single-key implicit cache already captures 91%.
2. **"Verbatim" inherit is the crux.** The subagent must prepend the parent's
   substrate *bytes unchanged*. The moment its system prompt or tool set
   reorders the substrate, the prefix breaks and inheritance is worthless.
   This is likely the single hardest engineering constraint.
3. **Provider variance** (above). Not every backend supports multi-breakpoint;
   some ignore key length. Keep the substrate head under backend limits or hash.
4. **Mutation invalidation.** A parent substrate change (e.g. repo tree edit)
   alters descendants' hashes → their caches invalidate. Mitigated by
   immutability, but a repo-level change can still cascade. Acceptable: it is
   proportional to the real change.
5. **Substrate vs session state.** Some "static" context (workspace roots,
   enabled tools) changes only rarely; detect drift via content hash, not by
   assuming immutability.

## Not this design

- **Per-task model hopping** (kills the cache — rejected).
- **Blind prompt sharding** (`N × cold substrate` unless prefix-shared; and
  sequential/dependent work — compile → test → fix — cannot shard anyway).
- **Full fingerprint "scrubber" with arbitrary reorder** — reordering breaks
  prefix contiguity. The immutable ordered segment tree is the safe form.
- **Reusing the transcript tail** — trajectory is never shareable.

## Prerequisite / sequencing

Before any hierarchy: the cheap-lane **clean output cap** (streams end
`finish_reason:"length"` instead of dangling) — every shard/subagent inherits
truncation otherwise. Then:

1. Layer 0 — cheap output cap (unblock, foundation).
2. Layer 1a — inherit parent `promptCacheKey` into subagent spawns.
3. Layer 1b — segment-ordered substrate + per-segment keys; pass parent prefix
   chain (verbatim bytes) into subagents.
4. Layer 2 — bounded parallel shard dispatch + merge over the shared substrate.

## Current state / verified findings

- subagents omit `promptCacheKey` (`buildSubagentSessionOptions`)
- subagent system prompt differs → prefix mismatch (`subagent-system-prompt.md`)
- 91% cache-read already on main loop (routing log, 1,649 cheap requests)
- `cache_control` / `applyPromptCaching` machinery exists (`anthropic.ts`)
- `providerPromptCacheKey` session inheritance exists (`agent-session.ts`)
- OpenRouter `prompt_cache_key` derivation exists (`getOpenAIPromptCacheKey`)
