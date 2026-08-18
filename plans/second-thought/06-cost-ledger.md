# Cost ledger and instrumentation
STATUS: open
PRIORITY: p1
REPOS: oh-my-pi
COMPLEXITY: architectural
TOUCHES: packages/coding-agent/src/session/second-thought/ledger.ts, packages/coding-agent/test/second-thought/ledger.test.ts
BLOCKED_BY: 03

## Goal
Every branch call's spend is attributed and inspectable — in tokens and USD, split by
cache-read / cache-write / uncached input / output — and skip decisions are recorded, so
cache-economics regressions and window-effectiveness are visible from day one.

## Approach
- Coordinator-owned ledger (advisors' private-map precedent — there is no shared side-call
  meter; the draft's `recordObservedUsage`-as-advisor-path claim was false, red-team B
  issue 8). Per-branch-call record: usage {input, output, cacheRead, cacheWrite}, USD via
  the model's cost table, wall times (fork→first-token, fork→cancel), termination
  (completed / cancelled / error / toolUseLeak), units harvested. Session totals + per-turn
  rollup stored in the diagnostic entry (04).
- **Token-denominated reporting is primary** — on OAuth the user pays in quota-window
  burn, not dollars (red-team B issue 7); USD shown alongside.
- Call `authStorage.recordObservedUsage` directly for broker attribution, tagged with the
  side session id; ensure branch responses do NOT flow through the primary session's
  header-ingest path (`ingestProviderUsageHeaders` attaches per-sessionId — grok finding
  14; the distinct side sessionId from 02 is the isolation mechanism, verify it).
- Document (in code comment + diagnostic entry field) the systematic undercount on
  cancelled streams: server-side decode between last usage delta and disconnect is billed
  but unobservable; bound it as `branchMaxTokens − observedOutput` (red-team A issue 10).
- Skip reasons (03's list) counted per session — this is the data that decides whether
  the adaptive window skip and circuit breakers are tuned right.
- 429 observation hook feeding 03's cooldown circuit breaker lives here.

## Cross-Repo Side Effects
None.

## Verify
Unit tests: usage aggregation across completed/cancelled/error branches; undercount bound
computation; skip-reason counters; a fake OAuth model reports token-primary. Integration
assertion (wired in 08): on a live or recorded Anthropic exchange, the branch call's
`cache_read_input_tokens > 0` — this is the DESIGN's acceptance gate for the same-model
cache strategy (red-team B issue 2 suggestion).
