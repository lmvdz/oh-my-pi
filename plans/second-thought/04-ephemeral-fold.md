# Ephemeral fold injection and diagnostic entry
STATUS: done
PRIORITY: p1
REPOS: oh-my-pi
COMPLEXITY: architectural
TOUCHES: packages/coding-agent/src/session/second-thought/fold.ts, packages/coding-agent/test/second-thought/fold.test.ts
BLOCKED_BY: 03

## Goal
Harvested reflect units reach the next model call(s) of the live run as an inert
user-role observation block, are retired after delivery, and are inspectable via a
non-context session entry — with zero persisted context messages.

## Approach
- **Fold store**: coordinator-held pending fold {units, formatted block, epoch, turn
  timestamp}. Injection happens at per-request context assembly — a hook the coordinator
  exposes and the integration concern (08) wires into the session's transformContext /
  convert pipeline. The injected message is a **user-role** message appended strictly
  after the tool results of the fold's turn (end of the array at injection time), never
  `developer`/custom→developer (developer upgrades to system authority on current
  Anthropic models — codex finding 14; user-role placement after toolResults is
  pairing-safe per transform-messages rules).
- **Framing**: fixed wrapper text marking the block as the model's own background
  reflections, observations-not-instructions, with the round-robin-interleaved typed units
  inside a single delimited section. Byte-capped (01's cap). Wrapper text lives in a
  `.md` asset.
- **Retirement**: the fold delivers to request N+1 and is retired once that request has
  been assembled (`secondThought.deliveryCalls` default 1; injecting into later requests
  would shift message positions across requests and churn the provider cache prefix —
  deliver once, retire). If the run ends before delivery (turn N was the last), retire
  undelivered — reflections do not carry into the next user prompt in v1 (matches
  "sharpen the very next call", avoids stale-context injection).
- **Diagnostic entry**: append a non-context session entry (CustomEntry-style state
  entry, NOT custom_message — it must not become a compaction cut point or context
  message; codex findings 15/16) recording units per atom, skip/harvest stats, branch
  usage, and whether delivery happened. This is what the TUI (07) renders and what
  reload shows; it never reaches convertToLlm.
- Ephemeral injection sidesteps: persistence-order race, compaction cut points,
  session-tree editability, snapcompact, history-format allowlists (red-team A issue 2,
  codex findings 15-17).

## Cross-Repo Side Effects
None.

## Verify
Unit tests: injected message is user-role, correctly placed after the fold turn's tool
results, byte-capped, absent from the request after retirement; undelivered fold retires
on run end; epoch-stale fold never injects; diagnostic entry round-trips through session
reload without entering context (buildSessionContext ignores it); a simulated
convert-pipeline run shows identical output for all requests except the single delivery
request.

## Resolution
Shipped: fold.ts + fold-wrapper.md, merged via second-thought/04-ephemeral-fold (final 1ffa41895e). 2 rounds; delimiter-escape hardening in both layers; replay epoch gate. Issue #6.
