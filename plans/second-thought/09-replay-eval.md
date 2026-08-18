# Replay eval: does it actually help?
STATUS: open
PRIORITY: p2
REPOS: oh-my-pi
COMPLEXITY: research
TOUCHES: plans/second-thought/eval/ (harness + results doc; location adjustable)
BLOCKED_BY: 08
MODE: hitl

## Goal
Evidence that the omp variant (same-model, K=1, thinking-on branches, user-role
post-observation fold) earns its cost — because it is a semantic redesign, not the
configuration the paper validated (codex finding 22), the reference's benchmark numbers
do not transfer.

## Approach
- Define the metric set up front: reflection adoption (does the next turn's behavior
  reference/act on a unit), harvest rate per fork, skip-rate breakdown, branch
  cache-read fraction, added cost per session (tokens + USD), p50/p95 turn-end latency
  delta, and task outcome on a small fixed task set.
- Cheapest credible harness: N scripted coding tasks run twice (feature on/off, same
  model, same seed-ish conditions) inside omp; plus replaying a handful of real recorded
  sessions with fold injection to inspect adoption qualitatively.
- MODE hitl because the ship/no-ship/default-on judgment from the numbers is the user's.

## Cross-Repo Side Effects
None.

## Verify
A results doc in the plan dir with the metrics above and an explicit recommendation
(keep experimental / promote / kill). The feature stays default-off until this concern
closes.

## Status note
Harness/run in flight on second-thought/09-eval (issue #11); final judgment HITL.
