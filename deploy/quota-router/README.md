# Quota router

Spend Max / Codex / SuperGrok first. Spill to OpenRouter Flash **before** a
subscription window hits 100%. Switchyard decides whether the turn is cheap or
capable. The omp auth-gateway binds `capable` to a live seat.

Second Thought is unchanged: it only forks when the live primary is
`anthropic-messages`. A mid-session hop off Anthropic still resets it — that
is why capable sessions stick to one seat until that seat closes.

```
oh-my-pi
  plan/slow  → switchyard :4001  route=ship     (capable-biased)
  default    → switchyard :4001  route=fleet    (cheap until stuck)
  smol/task  → mux/cheap                         (cannot escalate)
  advisor    → xai-oauth/grok-4.6                (pinned lineage)
        │
        ▼
switchyard-server :4001
  fleet  stage_router     cheap | capable
  ship   escalation       cheap | capable
        │
        ▼
omp auth-gateway :4010
  mux/cheap    → openrouter/deepseek/deepseek-v4-flash
  mux/vision   → openrouter/qwen/qwen3.8-27b (image-bearing requests)
  mux/capable  → anthropic → openai-codex → xai-oauth
                 (close a seat at 70% weekly / 60% 5-hour)
```

## Bring-up

Set this in `~/.omp/agent/config.yml` and a plain `omp` starts the sidecar
if it is not already up (injects `OMP_AUTH_GATEWAY_TOKEN` so `models.yml`
resolves). PATH 17.1.8 picks this up via
`~/.omp/agent/extensions/quota-router`. The 17.3.7 clone does it in-process.

```yaml
quotaRouter:
  enabled: true
  broker: true
  gateway: true
  switchyard: true
  root: /home/lars/src/omp-quota-router
```

`start.sh` is still the process supervisor. It starts this clone's 17.3.7 CLI
(the one with `mux/cheap` and `mux/capable`), not whatever `omp` is on PATH.

PATH `omp` on this box is 17.1.8 — no mux. Pointing the gateway at that
binary is why the stack looked up but did nothing.

```bash
# one shot: broker (if down) → 17.3.7 mux gateway :4010 → Switchyard :4001
./deploy/quota-router/start.sh \
  --with-switchyard \
  --gateway-bind 127.0.0.1:4010 \
  --switchyard-bind 127.0.0.1:4001

# if 17.1.8 is already sitting on those ports:
./deploy/quota-router/start.sh --with-switchyard --replace
```

What it does:

1. Resolve `packages/coding-agent/scripts/omp` and refuse to continue unless
   that binary reports 17.3+.
2. Start `auth-broker serve` from the same CLI if `$BROKER_URL/v1/healthz`
   is down. A healthy older broker is reused (the vault, not the mux).
3. Create `~/.omp/auth-gateway.token` if missing and export it as
   `OMP_AUTH_GATEWAY_TOKEN`. Switchyard's `api_key_env` must match the
   gateway's inbound token file — not the broker token.
4. Bind the gateway, wait for `/healthz` to show 17.3+, then prove
   `GET /v1/mux` returns `mux/cheap`.
5. With `--with-switchyard`, render `routes.toml` (Switchyard does not
   interpolate `base_url`) and exec `switchyard-server`.

`--replace` kills whatever is listening on the gateway / switchyard binds.
A 17.1.8 broker is replaced automatically: OpenRouter credit probes run
inside the broker, and 17.1.8 has none. `--replace-broker` forces that.

OAuth seats live in `~/.omp/agent/agent.db`. If you already `/login`'d in omp,
you do not need `auth-broker login` again. The 17.1.8 `auth-broker login`
paste prompt is broken; use `omp` TUI `/login anthropic` if a seat is missing.

Manual pieces, only if you are not using `start.sh`:

```bash
# render only, then run switchyard-server yourself:
routes=$(./deploy/quota-router/render-config.sh \
  --gateway-bind 127.0.0.1:4010 \
  --switchyard-bind 127.0.0.1:4001)
export OMP_AUTH_GATEWAY_TOKEN="$(tr -d '[:space:]' < ~/.omp/auth-gateway.token)"
switchyard-server --config "$routes" --host 127.0.0.1 --port 4001
```

`switchyard` from `uv tool install 'nemo-switchyard[cli]'` is the Claude/Codex
*launcher*, not the standalone proxy. You want `switchyard-server` on PATH
(`~/.cargo/bin`).

Env for the mux (read by `loadMuxPolicyFromEnv` when the gateway starts):

| var | default |
|---|---|
| `OMP_MUX_WEEKLY_CLOSE` | `0.70` |
| `OMP_MUX_FIVE_HOUR_CLOSE` | `0.60` |
| `OMP_MUX_CHEAP_MIN_USD` | `0.05` |
| `OMP_MUX_CHEAP` | `openrouter/deepseek/deepseek-v4-flash` |
| `OMP_MUX_CAPABLE` | `anthropic/claude-opus-5,openai-codex/gpt-5.6-sol,xai-oauth/grok-4.6` |
| `OMP_MUX_VISION` | `openrouter/qwen/qwen3.8-27b` |

`GET /v1/mux` (gateway bearer) shows the live policy, OpenRouter remaining
USD on `cheap`, and each capable seat. A $0 OpenRouter balance used to
come back as an empty `stop` (Flash never ran). The mux now 503s
`cheap-credits-exhausted` instead.

```bash
TOKEN="$(tr -d '[:space:]' < ~/.omp/auth-gateway.token)"
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4010/v1/mux
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4010/v1/usage
```

Responses carry `x-omp-mux-lane`, `x-omp-mux-target`, `x-omp-mux-reason`.

## What this is not

- Not a GPU co-op.
- Not a way to dump every campaign turn onto Max and hope.
- Not a Switchyard process that holds Max/Codex refresh tokens.
