# Second Thought

Parallel branch reflection for LLM agent loops: while the main call streams and its tools run,
the provider is idle, so the harness forks reflection branches into that window, cancels them the
moment the tool returns, and folds whatever finished into the next turn's history.

This README covers how to run it. The mechanism itself lives in
[`second_thought/mini_runner/streaming_agent.py`](second_thought/mini_runner/streaming_agent.py)
(`ReflectAgent`, `ReflectAgentConfig`).

## Install

```bash
pip install -e .[dev]
```

Requires Python ≥ 3.10. The import package is `second_thought`.

## Check the install

```bash
pytest
```

58 tests, all offline — unit tests plus a full-loop smoke against a scripted mock client. No API
key, no Docker, no network.

## Configure

```bash
cp .env.example .env      # then fill in OPENROUTER_API_KEY
```

```bash
export OPENROUTER_API_KEY=...
export PYTHONPATH=$PWD SECOND_THOUGHT_ROOT=$PWD
```

`SECOND_THOUGHT_ROOT` only matters when an adapter is imported from a harness running out of a different
checkout — otherwise each adapter resolves the repo root from its own file location.

## Modes

Every entry point takes a `mode` (the paper's three arms):

| `mode` | behaviour |
|---|---|
| `baseline` | main call only, no reflection |
| `reflect` | fork K=4 reflection branches at the first content delta, cancel on tool-done, fold survivors into history |
| `s1extend` | sequential control: keep the model reasoning with an unclosed `<think>` + "Wait," before it acts |

## Run a benchmark

Each benchmark is a separate harness that you install yourself; the files under `adapters/` plug
this mechanism into it.

### Terminal-Bench 2 — `harbor`

```bash
harbor run -d terminal-bench/terminal-bench-2 \
  -m <MODEL> \
  --agent-import-path adapters.harbor.second_thought_agent:HarborReflectAgent \
  --ak mode=<MODE> --ak step_limit=100 \
  --no-delete -o <OUTDIR> -n <CONCURRENCY> -r 1 -y
```

For `mode=s1extend` add `--ak s1extend_target_tokens=800 --ak s1extend_max_rounds=6` (this
adapter already defaults the target to 800, but rounds to 15). `mode=reflect` is the default and
can be omitted. The baseline arm uses
[`adapters/harbor/baseline_step_limit_100.yaml`](adapters/harbor/baseline_step_limit_100.yaml) —
a full clone of mini-swe-agent's `default.yaml`; read the warning at the top before editing it.

Per task, the adapter writes `<OUTDIR>/.../agent/reflect_trajectory.json` (or
`s1extend_trajectory.json`) with the per-turn records, and reports token counts in the Harbor
context metadata. `token_accounting` in that metadata says whether the counts came from the real
per-model tokenizer or the `chars//4` fallback.

### SWE-bench Pro

[`benchmarks/swe_bench_pro.py`](benchmarks/swe_bench_pro.py) is the harness; drive it from your
own loop:

```python
import asyncio
from benchmarks.swe_bench_pro import load_subset, build_mini_run

for meta in load_subset("tasks.jsonl"):          # rows in ScaleAI/SWE-bench_Pro schema
    agent, env, model, prompt, grade_fn, teardown_fn = build_mini_run(
        meta, mode="reflect", model_name="<MODEL>", step_limit=100,
    )
    try:
        exit_status, exit_message = asyncio.run(agent.run_async(prompt))
        result = grade_fn()                      # the agent loop is async-only
    finally:
        teardown_fn()
```

Needs Docker (task images) and a checkout of `SWE-bench_Pro-os` for grading — point
`SWEBENCH_PRO_RUN_SCRIPTS_DIR` at its `run_scripts/` directory. For `mode="s1extend"`, the
settings used in the paper are 300 target tokens / 6 rounds.

### τ²-bench

Register the agents from [`adapters/tau2/second_thought_agent.py`](adapters/tau2/second_thought_agent.py) in
your tau2-bench checkout, then:

```bash
tau2 run --domain banking \
  --agent <AGENT> \
  --agent-llm openrouter/<MODEL> --user-llm openrouter/<MODEL> \
  --num-trials 1 --max-steps 200 --seed 300 \
  --retrieval-config qwen_embeddings
```

`<AGENT>`: `llm_agent` (baseline), `reflect_llm_agent`, `s1_llm_agent`. Per-turn records are
appended to `$TAU2_REFLECT_LOG` (default `/tmp/tau2_reflect_records.jsonl`); `s1_error` there is
non-null if the s1extend side-channel call failed. s1extend budget: `S1_TARGET_TOKENS` (300),
`S1_MAX_ROUNDS` (6).

## Knobs

`ReflectAgentConfig`, on top of mini-swe-agent's `AgentConfig`:

| knob | default | what it does |
|---|---|---|
| `mode` | `"reflect"` | arm to run (see above) |
| `reflect_atoms` | `None` | which branches to fork; `None` = all four (`check`, `rehearse`, `recall`, `alternative`), `[]` = off |
| `max_reflect_per_turn` | `20` | cap on complete reflect units harvested **per atom** |
| `branch_extra_body` | `{"reasoning": {"enabled": False}}` | branches spend their window on content, not thinking |
| `s1extend_target_tokens` | `300` | extra reasoning tokens forced before `</think>` may close (TB2 runs use 800) |
| `s1extend_max_rounds` | `15` | max "Wait," injection rounds |

Harbor passes these through as `--ak <knob>=<value>`.

## Repo layout

```
second_thought/     the mechanism (streaming agent/model, atom prompts, reflect-unit parsing)
  mini_runner/      mini-swe-agent integration: ReflectAgent, SecondThoughtModel, docker env adapter
adapters/           per-harness integrations
benchmarks/         SWE-bench Pro harness + offline toy tasks
tests/              offline test suite
```
