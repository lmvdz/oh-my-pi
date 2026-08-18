You are adversarially reviewing a design for: porting "Second Thought" (parallel branch
reflection for LLM agent loops) into the oh-my-pi coding agent as a built-in,
settings-gated (default off), Anthropic-first feature.

Read these files in this repository first:
- plans/second-thought/LANDSCAPE.md   — verified phase-1 exploration (trusted facts, file:line refs)
- plans/second-thought/DESIGN-draft.md — the draft design you are attacking
- plans/second-thought/reference/second_thought/mini_runner/streaming_agent.py — Python reference mechanism
- plans/second-thought/reference/second_thought/prompts.py and action_detector.py

Then verify claims against the actual TypeScript source wherever you doubt them:
- packages/coding-agent/src/session/agent-session.ts (interceptor chain ~1187, onTurnEnd ~1036, side stream ~6820)
- packages/coding-agent/src/session/ttsr-coordinator.ts (the pattern the coordinator copies)
- packages/agent/src/agent-loop.ts (Harmony retry ~1153, steering ~2245, abort paths)
- packages/agent/src/compaction/ and packages/coding-agent/src/session/messages.ts (custom message conversion/persistence)
- packages/ai/src/stream.ts and packages/ai/src/providers/anthropic.ts (side-call caching, abort, retries)

Your job is to ATTACK this design. Find:
1. Failure modes the designer didn't consider (concurrency, partial failure, orphaned
   streams, double-fire, state corruption across Harmony retries / compaction aborts /
   session branch+rewind / subagent loops)
2. Cost or latency regressions that only appear in real sessions (prompt-cache
   invalidation, branch decode billing after cancel, in-flight cap serialization
   starving the MAIN call, provider rate-limit interactions)
3. Edge cases that break the happy path (empty thinking, redacted thinking, zero tool
   calls in a turn, steering interrupts, session fork/rewind onto a turn that carried
   reflections, model switch mid-session, reflect-role model unavailable)
4. Simpler alternatives the designer missed
5. Assumptions that are wrong or unverified against the actual code
6. Places where the fold (customType "second-thought" developer message appended after
   tool results) corrupts provider expectations, compaction, session tree operations,
   or the TUI

For each issue:
- SEVERITY: critical (blocks shipping) | significant (causes bugs) | minor (suboptimal)
- EVIDENCE: why you believe this is a real issue — cite file:line in this repo, not theory
- SUGGESTION: how to address it (or "needs more research")

Be specific. "This might not scale" is useless. "With maxInFlightRequests['anthropic']=2,
the 4 branch calls queue ahead of the NEXT turn's main call because X at stream.ts:559..."
is useful.

End your review with a line starting exactly with:
VERDICT: <one of: DESIGN-SOUND-WITH-FIXES | DESIGN-NEEDS-REWORK | DESIGN-FUNDAMENTALLY-WRONG> — <one-sentence justification>
