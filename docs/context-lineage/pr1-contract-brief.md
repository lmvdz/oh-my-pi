# PR 1 contract brief

**Status:** implemented contract boundary; execution remains disabled
**Prerequisites:** [baseline inventory](baseline-inventory.md) and [benchmark corpus](benchmark-corpus.md)

## Proposed contract boundary

PR 1 adds type contracts, canonical identity functions, and validation only. It does not dispatch an agent, mutate provider cache routing, or alter task-subagent behavior. PR 2 now compiles bounded native current-state file evidence through the declared adapter boundary.

| Contract | Owns | Does not own |
| --- | --- | --- |
| `RepositorySnapshot` | Repository root identity, selected `HEAD`, declared staged/unstaged/untracked overlay policy, and immutable snapshot digest. | Source extraction, history traversal, or live filesystem mutation. |
| `EvidenceItem` and provenance | Evidence class, source location/digest, extractor identity/version, snapshot coverage, inclusion reason, confidence, and degraded status. | Authority to override current source or an unbounded graph. |
| `RepositoryContextManifest` | Manifest schema/renderer/retrieval-policy versions, snapshot reference, canonical evidence order, explicit omissions, and semantic identity. | A provider prompt, a mutable index, or all repository files. |
| `EvidenceAdapter` | Versioned optional input normalization and source-authority/degraded-state declarations. | Selection policy or direct authority over frozen source. |
| `LogicalCheckpoint` / `PreparedPrefix` | Immutable logical identity and compatibility metadata for later execution. | Provider KV state, cache writes, or a claim of cache reuse. |
| `ContextLineagePlan` | Base references, stages, tasks, dependencies, capabilities, result-selection policy, and semantic plan identity. | Prompt construction, provider-specific cache mechanics, or execution. |
| Validator | Duplicate IDs, missing references, cycles, unsupported capabilities, manifest/security-scope violations, and non-canonical identities. | Repository crawling or auto-repairing an invalid plan. |

Place the initial contracts beside the coding-agent domain that will own the repository-aware planning surface. Keep providers in `packages/ai` untouched and consume their existing cache telemetry later through an adapter boundary.

## Identity rules to settle in PR 1

- IDs are computed from canonical semantic fields, with display-only metadata excluded.
- Snapshot identity distinguishes commit state from staged, unstaged, and declared untracked overlay state.
- Manifest identity includes snapshot identity, evidence schema, retrieval-policy version, and renderer version.
- Plan and checkpoint identity contain references to immutable inputs, not mutable session file paths or provider cache keys.
- Every item referenced by a plan must belong to the declared manifest and security scope.

## Risks and unresolved decisions

1. **Dirty overlay model:** choose the exact inclusion and hashing policy for staged, unstaged, untracked, generated, and ignored files before PR 2.
2. **Canonical serialization:** define the stable structured serialization and digest algorithm without making display formatting an identity input.
3. **Current-source authority:** historical and adapter-produced claims must remain labeled evidence; they cannot silently replace frozen source facts.
4. **Minimum extraction surface:** native current-state selection must be bounded and useful without claiming a dependency graph or complete symbol index that OMP does not have.
5. **Plan artifact shape:** decide whether v1 is a typed tool call, a persisted plan artifact, or both; validation must be shared either way.
6. **Benchmark review protocol:** define the reviewer/scoring process before using benchmark results as a gate for default-on compilation.
7. **Security scope:** decide the first explicit policy for sensitive files and what evidence may be rendered versus only referenced.

## Explicitly deferred

- Task-subagent `promptCacheKey` inheritance.
- Provider cache mutation, prefix warming, cache-hit claims, and cache-aware scheduling.
- Plan dispatch, promotion, checkpoint extension, and result sidecars beyond existing artifacts.
- Graphify, Graphiti, embeddings, hosted services, and graph databases.

Implemented contracts are exported from `@oh-my-pi/pi-coding-agent/context-lineage`; focused tests cover identity independence, manifest-scoped evidence, plan DAG validation, capability rejection, and native-adapter provenance. The broader compiler and planning benchmark remain PR 2 and PR 3 work.

## v0.7 compliance notes

- **Command surface (§21.6):** lineage subcommands (`status`, `show`, `benchmark`, `plan`, bare compile) live on the dedicated `/lineage` command; `/context` keeps its pre-existing diagnostic meaning exactly.
- **Rollout gate:** every user-facing lineage surface, including `/wayfinder plan`, requires `contextLineage.enabled` (default off) until the PR 3A quality gate passes.
- **MVP storage rule (§14.1):** session records are digest-only; excerpt bytes persist once in the session artifact store and manifest identity is computed over excerpt digests, so stripped and materialized manifests share one identity.
- **NFR9:** overlay hashing is capped by `maxDirtyFiles` in the retrieval policy; overflow produces a `repository-overlay` degraded source plus an `overlayTruncated` disclosure on the snapshot identity.
- **Reviewer protocol (PR 3):** automated exact-path recall is the scoring floor; comparisons persist reviewer identity, mode, rules version, and post-normalization scores, bound into the benchmark record identity.
- **Fan-out lowering (§11.10):** `lowerFanoutRequest` produces the synthetic one-stage plan; execution hints ride in identity-excluded plan metadata.
- **Checkpoint extensions (FR22):** extension generations hash the base checkpoint plus canonically serialized output digests; identical selections reuse one generation, changed outputs version all descendants.
- **Crash-safe execution (NFR4/FR24):** each completed stage appends a `runId`-grouped progress record; a restarted run passes recovered completions via `resume` and skips those stages.
- **Compatibility families (FR19/FR20/FR25):** `partitionCompatibilityFamilies` explains family grouping and first capability divergences per execution target without weakening requirements.
- **Temporal slice (FR47–FR50):** `collectTemporalEvidence` produces corroborating-only `historical_observation`/`statistical_relationship` items from one budgeted tree scan; renames keep old→new lineage, evidence is never current truth, and `/lineage` enriches only when `contextLineage.repositoryContext.temporal` is on.
- **Named bases (PR 9):** names are validated, idempotent per checkpoint generation, and resolved latest-active; archiving tombstones without deletion. Recovery accepts derived generations when they stay scoped to an intact root manifest.
	`/lineage base <name>` names the latest checkpoint, `/lineage base list` shows active bases, `/lineage base archive <name>` retires one; status reports resolvable counts.
	Plans may root bases at `named_base` sources; resolution to concrete checkpoints happens from latest-active records before validation, and archived or unknown names fail validation.
- **Divergence diagnostics (FR3):** `firstPrefixDivergence` over canonical request-block views distinguishes expected sibling suffixes from kind changes and content divergence.
- **Synthesis stages (PR 6):** `mode: "synthesis"` reducers consume selector-selected upstream outputs and emit one named output; downstream extension bases and checkpoint extensions consume it like any selected result. No KV merge — the reducer is an ordinary verified runner invocation.
- **Failure policies (§11.8/§21.5):** `continue_independent` preserves successful siblings; `stop_dependents` (default) blocks only downstream stages; `stop_plan` halts immediately. Failed runs keep all completed stage outputs and progress records.
- **Promotion (PR 7/FR26–FR28):** `promoteContextLineageResult` requires an explicit origin leaf, delegates branch creation to a caller sink (SessionManager integration lands with the PR 8A board), persists digest-only provenance as a recoverable session record, and is idempotent per (origin, assignment, answer).
- **Economics (§20.4–§20.5):** `fanoutSharedCost` and `planInducedReuse` implement the PRD cost formulas over observed usage; expected compatibility and provider-observed reuse remain separate facts, and ambiguous accounting yields no claim.
- **Provider boundary (PR 4/NFR5–NFR6):** encoding and cache observation live behind `LineageProviderAdapter`; the deterministic fake provider + `FakePrefixCache` prove exact-family, duplicate-writer, hit/miss, and expiry contracts headless. Real-provider encoded-prefix fixtures (Gate E) remain open.
- **Warm coordination (§18.3):** `stagger_first` dispatches each stage's first task alone before releasing siblings (writer-then-readers); default `off`. Real-provider visibility timing (Gate F) remains open.
- **Side-request runner (PR 4/5):** tasks execute as no-tools ephemeral turns; answers persist as digest-verified session artifacts. Real-provider cache observations (Gate F) remain open.
- **External adapters (PR 3A):** read-only Graphify `graph.json` (`off` default) and SCIP/local-index (`auto` default) adapters normalize existing artifacts into candidate-authority evidence under §25.5 modes. Snapshot mismatch rejects under `requireSnapshotMatch` or stale-labels; `INFERRED`/`AMBIGUOUS` edges never normalize above `statistical_relationship`; unknown schema versions fail at the boundary; malformed artifacts degrade into failed collections (NFR16); record reordering cannot change normalized identity. `compareAdapterEvidenceAblations` separates unique useful coverage from duplicates and unsupported scope per Gate P. Live ablations need real external artifacts.
