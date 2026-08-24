# Context Lineage planning benchmark corpus

**Status:** PR 0 candidate corpus
**Baseline:** `0627223840`

The same cases are available to the PR 3 evaluator as `CONTEXT_LINEAGE_BENCHMARK_CASES` from `@oh-my-pi/pi-coding-agent/context-lineage`; this document remains the reviewer-facing rationale and full obligation record.

These are completed, local commits. For each case the historical patch supplies the expected scope and test obligations before a Repository Context Compiler is built. The benchmark evaluates a plan's proposed scope and verification work; it does not ask the planner to reproduce the patch.

## Scoring

For every case, record whether a plan identifies the required source areas, verification obligations, and any uncertainty. Score exact scope recall, missed required areas, unsupported extra areas, dependency ordering, verification coverage, and evidence references. A plan receives no credit for a plausible claim that is not linked to selected manifest evidence or explicitly marked as an assumption.

## Cases

### CL-01 — Stable cacheable system prompt

- **Reference commit:** `30f92ad986347b38308d856ce17929846a56e3b4`
- **Task framing:** Keep date and working-directory context available to the model without invalidating a stable system-prompt/tool prefix when the date or cwd changes.
- **Known affected scope:** system-prompt assembly, SDK request transformation, a static reminder prompt asset, session request handling, and documentation.
- **Known verification obligations:** the provider-visible system prompt remains byte-stable; a date/cwd reminder is attached once to the first user message; it refreshes when the date changes; no-prompt contexts remain unchanged.
- **Reference tests:** `packages/coding-agent/test/date-cwd-reminder.test.ts`, `agent-session-message-pipeline.test.ts`, `agent-session-tool-rebuild-skip.test.ts`, `system-prompt-dedup.test.ts`, and `system-prompt-model.test.ts`.
- **Why it belongs:** a focused cross-layer change with an explicit prefix-stability contract. It tests whether evidence selection connects prompt rendering, session behavior, and wire-level verification without dumping the repository.

### CL-02 — Preserve artifacts across a full session fork

- **Reference commit:** `8dddee7578491c5cc55f5a1d2e72f4de62e1ebf0`
- **Task framing:** Preserve referenced artifacts when a CLI session is forked, without leaving the child session pointing to missing files.
- **Known affected scope:** `AgentSession` fork handling, including its bridge to session-manager artifact-copy behavior. The reference patch changes `packages/coding-agent/src/session/agent-session.ts`; the session-manager and TAN surfaces remain verification context, not required change scope.
- **Known verification obligations:** the fork carries/copies the appropriate artifact content; resulting artifact references resolve from the child; fork metadata and cache affinity remain valid; ordinary session-fork behavior is not regressed.
- **Reference tests:** `packages/coding-agent/test/session/session-manager-fork.test.ts` and `packages/coding-agent/test/modes/controllers/tan-command-controller.test.ts`.
- **Why it belongs:** it exercises session lineage, durable sidecars, and a cross-file safety condition—useful later when Context Lineage introduces result artifacts, but solvable by current-state evidence alone.

### CL-03 — Reset Second Thought at the state mutation boundary

- **Reference commit:** `29e9857a04b4584a88844d43af328e3dbd2ec713`
- **Task framing:** Reset the Second Thought branch state at the committed branch transition rather than after a later cosmetic rename.
- **Known affected scope:** `AgentSession` branch-transition lifecycle and Second Thought integration coverage.
- **Known verification obligations:** the reset occurs on the mutation transition; a subsequent cosmetic event cannot be the only reset trigger; the integrated state remains correct across the transition.
- **Reference test:** `packages/coding-agent/test/second-thought/integration.test.ts`.
- **Why it belongs:** it is a compact lifecycle regression whose relevant evidence is a state transition rather than a filename or keyword match. It measures whether a manifest helps the planner choose the right integration test and temporal ordering.

## Evaluation protocol

1. Check out the parent of the reference commit with no working-tree overlay.
2. Give the planner only the task framing and the compiled current-state manifest.
3. Compare its evidence-grounded plan with the known affected scope and obligations above; do not expose the reference patch during generation.
4. Repeat with the existing unguided planning path under the same model, prompt budget, and task framing.
5. Preserve generated plans, manifests, scores, and reviewer notes as sidecar benchmark artifacts. Report cache metrics separately and do not use them as a quality score.

The corpus is intentionally small. Add cases only when they exercise a distinct failure mode or repository-analysis boundary.
