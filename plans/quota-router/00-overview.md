# Quota router

STATUS: in progress
PLANE: none

## Outcome

oh-my-pi spends Max / Codex / SuperGrok first and spills to OpenRouter Flash
before a subscription window hits 100%. Switchyard picks cheap vs capable.
The auth-gateway binds capable to a live seat. Second Thought is not in this
path except as a consumer: it still only forks on `anthropic-messages`.

## Why this repo

Sibling of Second Thought, not an extension of it. ST requires same-model
Anthropic prefix cache. Mid-session provider hops reset it. The mux therefore
sticks a capable session to one seat until that seat closes.

## Work

| Slice | Status | Notes |
|---|---|---|
| mux policy + seat picker | done | `packages/ai/src/auth-gateway/mux.ts` |
| gateway `mux/cheap` `mux/capable` | done | close at 70% weekly / 60% 5h |
| Switchyard routes.toml | done | `deploy/quota-router/` |
| omp role snippet | done | `deploy/quota-router/config.snippet.yml` |
| live campaign proof | open | one fleet with smol→Flash; Max 7-day stays <70% |

## Rules

- Do not give Switchyard Max/Codex refresh tokens.
- Do not resolve `secondThought` / `reflect` through `mux/cheap`.
- Do not add ST-10 here. New plan dir only.
