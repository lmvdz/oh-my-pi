# ST-02 build notes — branch request builder

## Decision: the branch suffix is ONE synthetic USER message, not an assistant prefill

**Status:** adopted, gauntlet round 1 fix. **Authority:** DESIGN.md's cache-read
acceptance gate (`cache_read_input_tokens > 0` on the branch call before the feature
ships default-off). **Deviation from:** the reference implementation's
continuation-prompting shape, which conditions a branch by replaying the just-emitted
reasoning as a synthetic ASSISTANT message and asking the model to continue it.
**Reopen if wrong:** if a later change makes `latestSurvivingAssistantIndex` irrelevant
to prefix encoding, or if harvest quality measurably drops against the assistant-prefill
shape, revisit — the golden test below is the gate either way.

### What was wrong

`packages/ai/src/providers/transform-messages.ts` computes a single
`latestSurvivingAssistantIndex` for the whole message list, and several Anthropic
thinking-block policies key off it. Appending a synthetic assistant message moves that
index off the conversation's real last assistant turn, so the PREFIX — the bytes the
branch shares with the main call — is encoded under a different policy than the main
call encodes it.

The worst case is routine, not exotic: an **abandoned tool-use** assistant turn
(`stopReason !== "toolUse"` while the content still carries `toolCall` blocks — what
adaptive-thinking Opus/Fable does when it emits tool calls and then ends on
`end_turn`/`stop`) carrying **signed thinking**.

- Main call: that turn IS the latest surviving assistant, so
  `isLatestSurvivingAssistant && abandonedToolUse && !crossProviderSource` short-circuits
  and the thinking blocks go on the wire byte-for-byte, signatures intact — which is
  exactly what Anthropic requires of its own most recent response.
- Branch call with an assistant suffix: that turn is no longer latest, so
  `abandonedToolUse` marks every signature untrustworthy and strips it;
  `dropsAllSameModelVisibleThinking` then demotes or drops the blocks entirely.

Same prefix objects, different wire bytes. Cost: the branch pays full uncached input over
the entire conversation on every fork (the exact failure DESIGN's cache gate exists to
catch), plus a live risk of `400 Invalid signature in thinking block`.

The original in-memory parity test could not see any of this: it compared
`JSON.stringify` of the branch's message array prefix against the main call's, and those
ARE identical. The divergence only exists after encoding.

### The golden test

`packages/coding-agent/test/second-thought/branch-prefix-golden.test.ts` drives the
deepest host-side encoder reachable without a network — `convertAnthropicMessages`, which
runs the full `transformMessages` pipeline and produces the exact `messages` array
`buildParams` puts on the wire — over a fixture whose last real assistant is
abandoned-tool-use with signed thinking, and byte-compares the encoded prefix.

It asserts, in order:

1. the fixture really does exercise the path (the main call's encoded assistant param
   carries `signature: "sig-abcdef0123456789"`);
2. with the user-message suffix, `branchParams.slice(0, mainParams.length)` is
   `JSON.stringify`-identical to `mainParams`, and the branch adds exactly one param;
3. system prompt and tool set are verbatim;
4. **negative control:** with the reference's assistant-prefill suffix the encoded prefix
   DIFFERS, and the prefix's signed thinking block is gone;
5. the prefix stays byte-identical with each cache-hostile parity flag flipped on the
   host options (`toolChoice`, `disableReasoning`, `forceReasoningOff`,
   `anthropicCacheRefresh` — each also asserted absent from the built stream options) and
   with each pass-through flag set (`reasoning`, `hideThinkingSummary`, `cacheRetention` —
   each asserted preserved);
6. the prefix is invariant to the conditioning text and to a custom combined prompt.

### The shape that was adopted

`buildBranchSuffix` returns a single `UserMessage` (`synthetic: true`,
`attribution: "agent"`) whose text is
`buildBranchConditioningPrompt(conditioningText, prompt)`:

```
Your reasoning so far in this turn:

<conditioning text>

---

<combined-branch.md>
```

The last assistant message stays exactly where the main call has it, so
`latestSurvivingAssistantIndex` is unchanged and the encoded prefix is byte-identical.
`combined-branch.md` already opens with "Continue from the reasoning above", which reads
correctly against quoted conditioning; the prompt file was not changed.

Cost of the deviation: the model sees the conditioning as quoted user-supplied text
rather than as its own turn to continue. That is a weaker continuation signal than a
prefill. It is the right trade — the cache read is the acceptance gate, and a signed
thinking 400 is a hard failure while a slightly weaker conditioning signal is a quality
gradient.

## Other round-1 fixes

- **Snapshot integrity.** `structuredClone` only; the `JSON.parse(JSON.stringify(...))`
  fallback is gone. It silently turned a `Uint8Array` payload into `{"0":137,…}`. A
  context that cannot be cloned now throws from `snapshotBranchContext`, and a branch
  that hits it settles as `outcome: "error"` rather than shipping corrupted bytes.
- **Per-context deep copy.** `buildBranchContext` deep-copies the snapshot on every call,
  so a `startMany` fan-out never shares object refs between calls or with the host — a
  mutating `obfuscateContext` hook can no longer reach the queued branches.
- **Stagger gate.** Resolves only on the first `text_delta` (a `start` event fires before
  the provider has produced cacheable output, which made the stagger a no-op). Bounded by
  `streamOptions.streamFirstEventTimeoutMs`, else `DEFAULT_STAGGER_TIMEOUT_MS` (10s), and
  released by the caller's abort signal. After the gate the fan-out is CANCELLED — not
  merely un-staggered — when the caller aborted or call 1 settled `aborted`/`error`.
- **Never-throws.** The entire `#execute` body is guarded, including `normalizeBranchAtoms`,
  the context build, and every host hook (`obfuscateContext`, `prepareStreamOptions`,
  `deobfuscateText`, `onTextDelta`, `now`, `nextSideCallId`). `start()` cannot throw
  synchronously — an id source or `addEventListener` failure returns a settled `error`
  handle. Settlement uses `.then`, not `.finally`, so a cleanup failure can never replace
  a settled result with a rejection.
- **Usage.** The last streamed `partial.usage` is retained and surfaced when an abort or
  error leaves no terminal usage. On a unit-cap stop the loop keeps reading (bounded at
  32 events) so the provider's terminal event still yields authoritative usage.
- **Outcomes.** An abort landing after a natural `done` stays `completed`. A unit-cap stop
  truncates the accumulated text with `truncateToUnitCap` (built on
  `truncateAtLastCompleteReflect`) so a delta that closes several units at once cannot
  overshoot the cap.
- **Parity.** `forceReasoningOff` is stripped alongside `disableReasoning` — same axis,
  two fields. `BranchStreamOptions` makes `reasoning`, `hideThinkingSummary`, and
  `cacheRetention` required KEYS of the host contract (values may be `undefined`) so a
  host cannot silently omit part of the primary call's cache identity.
- **Docs.** The module doc records that `branchMaxTokens` is a ceiling request, not a
  guarantee: on budget-style thinking models the Anthropic provider's
  `ensureMaxTokensForThinking` RAISES `max_tokens` to at least
  `budget_tokens + OUTPUT_FALLBACK_BUFFER`. Deliberate — lowering the budget instead would
  change the thinking configuration and invalidate the messages-tier cache.
