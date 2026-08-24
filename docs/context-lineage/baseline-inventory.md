# Context Lineage baseline inventory

**Status:** PR 0 working inventory
**Baseline:** `0627223840` (`mux: cheap-lane output cap so long streams end finish_reason=length`)
**Scope:** Native primitives to reuse for the Context Lineage MVP. This document records observed code paths; it does not change runtime behavior or select an external dependency.

## Product boundary

The first product slice is a deterministic, inspectable repository-evidence manifest. It must be useful before provider cache reuse is attempted. Existing subagent and session-fork cache routing is a later execution input, not the identity contract for repository manifests or logical checkpoints.

## Reusable native primitives

| Concern | Existing primitive | Reuse decision |
| --- | --- | --- |
| Repository state and history | `packages/coding-agent/src/utils/git.ts` exposes bounded wrappers for `status`, `diff`, `head`, `show`, `log`, `revList`, `ref`, and repository/worktree operations. | Reuse exclusively for snapshot resolution and later temporal retrieval; do not shell out directly. |
| Workspace discovery | `packages/coding-agent/src/workspace-tree.ts` uses native `listWorkspace`, respects gitignore for prompt-facing trees, reports truncation, and uses stable absolute timestamps for cached prompt text. | Reuse as a candidate-file discovery layer, not as the evidence graph. Its recency ordering is not a manifest ordering contract. |
| Source inspection | `packages/coding-agent/src/tools/read.ts`, `grep.ts`, and `ast-grep.ts`; native bindings live in `packages/natives`. | Reuse their bounded search/read capabilities where their APIs can provide source locations and truncation. Add manifest-specific normalizing code rather than duplicating scanners. |
| Symbol and semantic enrichment | `packages/coding-agent/src/lsp/` provides optional LSP clients, diagnostics, and workspace operations. | Optional enrichment only. A missing server must become explicit degraded evidence, never block current-state compilation. |
| Dependency and test discovery | No repository-wide dependency graph or test-discovery service exists in the coding agent. Package manifests are ordinary repository evidence; `package.json` scripts and package-local tests establish verification obligations. | Build bounded manifest selection on top of source/package evidence in PR 2. Do not introduce a guessed dependency graph in PR 0 or PR 1. |
| Project instructions and prompt context | `packages/coding-agent/src/system-prompt.ts` resolves `AGENTS.md` and project context; `workspace-tree.ts` collects applicable instruction files. | Reuse discovery/precedence behavior where appropriate; a manifest must record selected documents and their source bytes separately from rendered prompt context. |
| Session checkpoint semantics | `packages/coding-agent/src/session/checkpoint-entries.ts` normalizes current checkpoint/rewind tool results. | Reuse only as a bridge for future `current_checkpoint` plan bases. It is not yet an immutable logical-checkpoint store. |
| Session persistence and forks | `packages/coding-agent/src/session/session-manager.ts` persists JSONL sessions and forks history, retaining a parent session reference. | Reuse session lineage metadata, but do not use mutable transcript state as repository-manifest identity. |
| Sidecar storage | `packages/coding-agent/src/session/artifacts.ts` stores bounded tool artifacts and is intentionally shared by a parent/subagent tree. | Reuse the artifact protocol for inspectable outputs where feasible. Add a distinct typed lineage store before treating results as checkpoint extensions. |
| Task fan-out and lifecycle | `packages/coding-agent/src/task/executor.ts`, `parallel.ts`, `output-manager.ts`, and `persisted-revive.ts` implement task spawning, bounded concurrency, output delivery, and revival. | Reuse lifecycle/concurrency primitives for Milestone C. Preserve result isolation; do not make parent transcript injection the result store. |
| Provider request boundary | `packages/agent/src/agent.ts` passes `sessionId`, `promptCacheKey`, and payload hooks into each agent request. `packages/coding-agent/src/sdk.ts` constructs the coding-agent instance. | This is the first cache-relevant boundary to instrument once logical checkpoints exist. No raw prompt logging is required. |
| Cache identity and provider observations | `packages/ai/src/providers/openai-shared.ts` derives OpenAI-compatible cache keys; provider adapters parse cache usage. `packages/agent/src/telemetry.ts` and `packages/coding-agent/src/telemetry-export.ts` expose cache-read/write counters. | Reuse provider-reported telemetry. Treat a cache key as routing intent, not proof of reuse. |

## Observed cache and branch behavior

The existing tests below are the observable baseline fixtures. They prove request-option propagation and fork behavior; none proves a provider cache hit from a shared key.

| Surface | Existing fixture | Observable contract |
| --- | --- | --- |
| Normal parent request | `packages/agent/test/agent.test.ts` | An agent forwards its configured `promptCacheKey` on a stream request. |
| Full session fork | `packages/coding-agent/test/session-fork-prompt-cache-key.test.ts` | A full fork gets separate request lineage but may retain parent cache affinity; request-shaping overrides suppress automatic inheritance. |
| Task subagent | `packages/coding-agent/test/task/worktree.test.ts` and task-executor integration coverage | Task children have their own lifecycle/worktree behavior and share the parent artifact manager where configured. No test currently asserts parent cache-key propagation because the behavior does not exist. |
| Provider routing | `packages/ai/test/openai-codex-stream.test.ts` and `packages/ai/test/openai-responses-cache-affinity.test.ts` | OpenAI-compatible adapters serialize the supplied cache key to provider payloads. |
| Provider observations | Provider adapter tests and `packages/coding-agent/test/bench-cache.test.ts` | Cache-read/write values are provider-reported usage observations, not locally inferred hits. |

### Full session fork

`SessionManager.fork()` copies the existing history into a new session and records:

- `parentSession` as the former session ID;
- `providerPromptCacheKey` as the existing key, falling back to the parent session ID.

On startup, `createAgentSession()` in `sdk.ts` adopts that header key only when model, thinking level, system prompt, tools, and related prompt-shape inputs have not been overridden. It labels this source as `fork`.

**Parity interpretation:** this is an exact-history fork optimization with a cache-shape guard. It is not a general logical checkpoint and it does not establish provider reuse.

### Task subagent spawn

`task/executor.ts` creates a fresh `SessionManager` and calls `createAgentSession()` through `buildSubagentSessionOptions()`. That option builder forwards the task's system-prompt wrapper, tool selection, context, workspace tree, artifacts, telemetry, and lifecycle dependencies. It does **not** currently pass `providerPromptCacheKey` or `providerSessionId` from the parent.

**Parity interpretation:** task children are isolated fresh sessions. Any future shared-prefix behavior must be explicit, conditioned on provider-visible prompt equality, and observable; inheriting only a cache key would not make their rendered prompts equal.

### Provider-visible request and observation boundary

`Agent` retains `sessionId` and `promptCacheKey`, then forwards both with each stream request. OpenAI-compatible providers derive `prompt_cache_key` from those options, while individual adapters report cache-read and cache-write usage when the provider supplies it. Current telemetry captures token observations but has no logical checkpoint-family or first-divergence diagnostic.

**Required later contract:** record a non-secret digest of the canonical provider-visible prefix plus provider/model/rendering/tool-manifest compatibility attributes; separately record cache routing intent and provider-reported reuse.

## Deliberately absent from the native MVP

- No `Graphify` or `Graphiti` dependency or checked-in adapter is present in the repository.
- No authoritative repository graph, normalized evidence schema, dirty-overlay identity, or canonical manifest renderer exists.
- No typed context-lineage plan, logical checkpoint store, prepared-prefix family, or sidecar result lineage exists.
- No subagent cache-key inheritance is enabled.

These absences are expected at PR 0. They define PR 1 and PR 2 work; they are not gaps to patch opportunistically in the task executor.

## PR 0 evidence still to capture

1. Create deterministic, redacted request fixtures for: ordinary parent turn, full session fork, task child, and a provider response with cache usage.
2. Select three to five repository changes with known scope and verification obligations; record the expected files, dependencies, and tests before building a compiler.
3. Inspect Graphify and Graphiti revisions, licenses, schemas, update modes, and failure behavior in a read-only spike. Do not add either dependency.
4. Identify the smallest safe payload digest seam after provider request rendering, with raw prompt content excluded from logs and telemetry.

## Consequence for the next PR

PR 1 should add contracts only: repository snapshot and dirty-overlay identity, normalized evidence/provenance, manifest identity, logical checkpoint identity, and plan validation. It should consume none of the task-executor cache-routing paths above.
