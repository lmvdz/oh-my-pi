# Settings, reflect role, and gating
STATUS: done
PRIORITY: p1
REPOS: oh-my-pi
COMPLEXITY: mechanical
TOUCHES: packages/coding-agent/src/config/settings-schema.ts, packages/coding-agent/src/config/model-roles.ts, packages/coding-agent/src/session/second-thought/gating.ts

## Goal
The feature's configuration surface exists: settings keys (default off), the optional
`reflect` model-role override, and the gate predicate module.

## Approach
- Settings block (pattern: existing `ttsr.*` schema entries), all under a
  "Second Thought" group: `secondThought.enabled` (bool, false),
  `secondThought.branchCount` (1, max 4), `secondThought.branchMaxTokens` (2048),
  `secondThought.harvestCapPerAtom` (20), `secondThought.atoms` (all four),
  `secondThought.maxContextTokens`, `secondThought.minConditioningChars`,
  `secondThought.deliveryCalls` (1), `secondThought.showInTranscript` (bool, false).
- `reflect` model role added to `ModelRole`/`MODEL_ROLES` as a hidden, optional override:
  UNSET means "use the primary model" (DESIGN: same-model default is the economically
  correct configuration; the smol chain is explicitly NOT the fallback — codex finding 7 /
  red-team B issue 1). When set, resolution goes through `resolveRoleSelection` and the
  result must still pass the Anthropic gate; `undefined` resolution ⇒ fall back to primary
  (never no-op silently into a wrong provider — red-team B issue 10).
- Gate predicate (`gating.ts`): enabled AND `agentKind === "main"` (the union is
  `"main" | "sub"` — there is no `"task"`; red-team A issue 8) AND primary model is
  Anthropic-API AND resolved branch model is Anthropic-API (gate the branch model too —
  codex finding 7). Determine "Anthropic-API" from the model's `api` field, not a
  nonexistent `resolveProvider` helper (grok assumptions table). One-time debug notice
  when the setting is on but a gate fails.

## Cross-Repo Side Effects
None.

## Verify
Settings schema round-trips (existing schema tests); gate predicate unit tests cover:
sub-session, non-Anthropic primary, reflect-role resolving to non-Anthropic, reflect-role
unresolvable (falls back to primary), all-pass.

## Resolution
Shipped: settings block + reflect role + gating.ts, merged via second-thought/05-settings-role-gating (final 8dad97f8c1). 2 rounds; generic numeric-range clamp added at settings resolution. Issue #7.
