"""HarborReflectAgent — Harbor BaseAgent adapter for our reflect mechanism.

Wraps the existing `second_thought.mini_runner.streaming_agent.ReflectAgent`
(used unmodified for SWE-bench Pro) into Harbor's `BaseAgent` interface.

The adapter exposes the host-side asyncio event loop to a synchronous
env shim that the inner ReflectAgent calls (via `asyncio.to_thread`).
The shim translates a sync `env.execute(cmd)` into Harbor's
`await env.exec(cmd, ...)` using `run_coroutine_threadsafe`.

Run via:

  PYTHONPATH=/path/to/second-thought harbor run \\
    -d terminal-bench/terminal-bench-2 \\
    -m deepseek/deepseek-v4-flash \\
    --agent-import-path adapters.harbor.second_thought_agent:HarborReflectAgent \\
    [-t terminal-bench/<task>]
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

# Make the parent Second Thought repo importable.
# Repo root: defaults to this checkout (adapters/<name>/<file>.py -> ../../).
_SECOND_THOUGHT_ROOT = os.environ.get("SECOND_THOUGHT_ROOT") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
if _SECOND_THOUGHT_ROOT and _SECOND_THOUGHT_ROOT not in sys.path:
    sys.path.insert(0, _SECOND_THOUGHT_ROOT)

from second_thought.mini_runner.streaming_agent import ReflectAgent  # noqa: E402
from second_thought.mini_runner.streaming_model import SecondThoughtModel  # noqa: E402
from second_thought.token_count import (  # noqa: E402
    get_token_counter,
    recount_context_lengths,
)


class _HarborEnvShim:
    """Sync-looking env that bridges to Harbor's async BaseEnvironment.

    The inner ReflectAgent calls `await asyncio.to_thread(self.env.execute, cmd)`.
    From the worker thread we use `asyncio.run_coroutine_threadsafe` to
    submit `env.exec(cmd)` onto the agent's running event loop and block
    until it returns. The ExecResult is normalised to the dict shape the
    inner agent expects (`{"output": str, "returncode": int}`).
    """

    def __init__(self, env: BaseEnvironment, loop: asyncio.AbstractEventLoop, timeout_sec: int = 600):
        self._env = env
        self._loop = loop
        self._timeout_sec = timeout_sec

    def execute(self, command: str) -> dict:
        fut = asyncio.run_coroutine_threadsafe(
            self._env.exec(command, timeout_sec=self._timeout_sec),
            self._loop,
        )
        try:
            result: ExecResult = fut.result()
        except Exception as e:  # pragma: no cover
            return {"output": f"env.exec error: {e}", "returncode": -1}
        # Harbor's ExecResult uses (stdout, stderr, return_code). mini-swe-agent
        # expects (output, returncode). Concatenate stdout+stderr so the agent
        # sees errors too.
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        merged = stdout
        if stderr:
            merged = (stdout + ("\n" if stdout else "") + stderr) if stdout else stderr
        return {
            "output": merged,
            "returncode": result.return_code if result.return_code is not None else -1,
        }

    def get_template_vars(self) -> dict:
        """mini-swe-agent's DefaultAgent renders prompt templates with the
        union of env / config / model template vars. We provide a minimal
        set so render_template doesn't blow up; values can be referenced
        in default.yaml's `{{system}}` etc."""
        import platform
        info: dict[str, Any] = {
            "cwd": "/",
            "task_timeout_sec": self._timeout_sec,
        }
        try:
            info.update(platform.uname()._asdict())
        except Exception:
            pass
        return info


class HarborReflectAgent(BaseAgent):
    """Harbor adapter for our parallel-multi-atom reflect mechanism.

    CLI kwargs (via `--ak key=value`):
      * `mode`: one of "reflect" (default), "baseline", "s1extend".
        - "reflect": parallel 4-atom branches (default).
        - "baseline": no branches, plain mini-swe-agent behavior.
        - "s1extend": s1-style budget forcing (Wait injection into
          reasoning channel before action commit; matched compute
          baseline used for paper).
      * `reflect_atoms`: comma-separated atom list, reflect mode only
        (e.g. `--ak reflect_atoms=check,rehearse`). Default = all 4.
        Empty string (`--ak reflect_atoms=`) is deprecated; prefer
        `--ak mode=baseline`.
      * `step_limit`: int, agent step limit. Default 100.
      * `s1extend_target_tokens`: int, target extra reasoning tokens
        per turn (s1extend mode). Default 800 for Terminal Bench.
      * `s1extend_max_rounds`: int, max forced-Wait rounds per turn
        (s1extend mode). Default 6.
    """

    SUPPORTS_ATIF: bool = False  # we don't emit Harbor's ATIF trajectory yet
    SUPPORTS_WINDOWS: bool = False

    def __init__(
        self,
        *args,
        mode: str = "reflect",
        reflect_atoms: str | list | None = None,
        step_limit: int | str = 100,
        s1extend_target_tokens: int | str = 800,
        s1extend_max_rounds: int | str = 15,
        max_reflect_per_turn: int | str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._max_reflect_per_turn = int(max_reflect_per_turn) if max_reflect_per_turn is not None else None
        if mode not in ("reflect", "baseline", "s1extend"):
            raise ValueError(f"unknown mode: {mode!r}; expected reflect|baseline|s1extend")
        self._mode = mode
        # Harbor's --ak passes everything as strings; coerce.
        if isinstance(reflect_atoms, str):
            atoms = [a.strip() for a in reflect_atoms.split(",") if a.strip()]
            self._reflect_atoms = atoms  # empty list = disable branches (legacy baseline)
        else:
            self._reflect_atoms = reflect_atoms  # None = default (all 4)
        self._step_limit = int(step_limit)
        self._s1extend_target_tokens = int(s1extend_target_tokens)
        self._s1extend_max_rounds = int(s1extend_max_rounds)

    @staticmethod
    def name() -> str:
        return "reflect-agent"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        # Nothing to install — we drive the env via env.exec from outside.
        return None

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        loop = asyncio.get_running_loop()
        env_shim = _HarborEnvShim(environment, loop, timeout_sec=600)

        # Configure the inner model.
        model = SecondThoughtModel(
            model_name=self.model_name or "deepseek/deepseek-v4-flash",
        )

        # Load mini-swe-agent's default templates from its YAML.
        import yaml
        from minisweagent.config import get_config_path

        default_yaml = yaml.safe_load(get_config_path("default").read_text()) or {}
        agent_cfg = dict(default_yaml.get("agent") or {})
        # Three-way mode dispatch. `mode` takes priority over the
        # legacy `reflect_atoms=` baseline trigger.
        if self._mode == "baseline" or (
            self._mode == "reflect"
            and self._reflect_atoms is not None
            and len(self._reflect_atoms) == 0
        ):
            agent_cfg["mode"] = "baseline"
        elif self._mode == "s1extend":
            agent_cfg["mode"] = "s1extend"
            agent_cfg["s1extend_target_tokens"] = self._s1extend_target_tokens
            agent_cfg["s1extend_max_rounds"] = self._s1extend_max_rounds
        else:
            agent_cfg["mode"] = "reflect"
            if self._reflect_atoms is not None:
                agent_cfg["reflect_atoms"] = self._reflect_atoms
            if self._max_reflect_per_turn is not None:
                agent_cfg["max_reflect_per_turn"] = self._max_reflect_per_turn
        # mini-swe-agent's default.yaml ships step_limit=0 (disabled).
        # We always FORCE override so runaway agents are bounded; user
        # can override via `--ak step_limit=50`.
        agent_cfg["step_limit"] = self._step_limit
        agent_cfg["cost_limit"] = 0

        agent = ReflectAgent(model=model, env=env_shim, **agent_cfg)

        exit_status: str = "Unknown"
        exit_message: str = ""
        try:
            try:
                exit_status, exit_message = await agent.run_async(instruction)
            except Exception as e:  # pragma: no cover
                exit_status = type(e).__name__
                exit_message = str(e)
        finally:
            # IMPORTANT: also runs on `asyncio.CancelledError` (Harbor's
            # AgentTimeoutError cancels this coroutine), so partial
            # trajectory is preserved even when the trial times out.
            # CancelledError is a BaseException and bypasses
            # `except Exception` above, but `finally` still fires.
            # Token accounting, RULE 0: real per-model tokenizer, never
            # chars//4. This block runs AFTER the agent loop has finished, so
            # tokenizing here costs nothing on the critical path and cannot
            # perturb the wall-clock numbers (that is why the in-loop
            # bookkeeping in streaming_agent.py keeps its cheap proxy).
            # `TokenCounter` degrades to chars//4 if the tokenizer can't be
            # loaded and reports which one it used in `.method` — recorded
            # below as `token_accounting` so an estimate is never read as a
            # real count.
            #
            # OUTPUT is reasoning + content: an earlier version summed only
            # assistant_text (content) and silently dropped the reasoning
            # channel, badly under-counting reasoning models (e.g. one task
            # recorded 688 vs an actual ~6.7k main tokens).
            tc = get_token_counter(model.config.model_name)
            n_reasoning = 0
            n_content = 0
            n_branch = 0  # parallel branch output — hidden, not on critical path
            n_turns = len(agent.turn_records)
            n_reflect = 0
            for t in agent.turn_records:
                n_reasoning += tc(t.assistant_reasoning)
                n_content += tc(t.assistant_text)
                n_branch += tc(getattr(t, "branch_text_raw", "") or "")
                n_reflect += t.reflect_count or 0
            n_main = n_reasoning + n_content  # main-thread output (critical path)

            # Main-thread INPUT: the per-turn `context_token_len_before` in the
            # records is the in-loop chars//4 proxy, so recount from the final
            # message list instead — the conversation is append-only, so the
            # context a turn saw is the token prefix up to its assistant
            # message. Also writes the real numbers back into the records so
            # the saved trajectory carries them.
            n_input = recount_context_lengths(
                getattr(agent, "messages", []) or [], agent.turn_records, tc
            )

            context.n_input_tokens = n_input
            context.n_output_tokens = n_main
            context.metadata = {
                "agent": "reflect-agent",
                "model": model.config.model_name,
                "exit_status": exit_status,
                "exit_message": exit_message,
                "n_turns": n_turns,
                "n_reflect_units": n_reflect,
                "n_main_tokens": n_main,
                "n_reasoning_tokens": n_reasoning,
                "n_content_tokens": n_content,
                "n_branch_tokens": n_branch,
                "token_accounting": tc.method,
            }

            try:
                import json
                from dataclasses import asdict

                traj = {
                    "exit_status": exit_status,
                    "exit_message": exit_message,
                    "mode": self._mode,
                    "turns": [asdict(t) for t in agent.turn_records],
                    "messages": [
                        {"role": m.get("role"), "content": m.get("content")}
                        for m in (getattr(agent, "messages", []) or [])
                    ],
                }
                fname = (
                    "s1extend_trajectory.json" if self._mode == "s1extend"
                    else "reflect_trajectory.json"
                )
                out = Path(self.logs_dir) / fname
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(json.dumps(traj, indent=2, ensure_ascii=False))
            except Exception as e:  # pragma: no cover
                self.logger.warning("failed to write trajectory: %s", e)
