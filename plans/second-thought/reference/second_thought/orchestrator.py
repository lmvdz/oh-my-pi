"""Per-task orchestrator (legacy / toy-task path).

Drives the turn loop for one task and one mode. In `reflect` mode the
mechanism is a two-thread split:

- MAIN thread streams the agent response. The instant the first content
  delta arrives (i.e. reasoning ends), a BRANCH task is forked. The
  main thread keeps streaming until the bash block is complete, then
  fires the tool asynchronously and waits for it.
- BRANCH thread runs an independent LLM call against the same model
  with thinking disabled and a reflect-only system prompt; it emits
  <reflect>...</reflect> units in parallel with action emission and
  tool execution. When the tool finishes, the branch is cancelled.
  Its accumulated text is truncated at the last </reflect>; complete
  units are spliced into the assistant message after the action.

The mini-swe-agent integration in `second_thought.mini_runner` is the path
used for SWE-bench Pro evaluation; this module remains the simpler
fixture used by toy-task tests.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .action_detector import (
    ActionMatch,
    count_reflect_units,
    detect_first_action,
    interleave_typed_units_by_atom,
    parse_reflect_typed_units,
    truncate_at_last_complete_reflect,
)
from .config import RunConfig
from .llm_client import LLMClient
from .prompts import (
    ATOM_NAMES,
    REFLECT_ATOMS,
    build_branch_atom_messages,
    build_system_prompt,
    build_user_task_prompt,
)
from .tool_runner import ToolResult, run_bash
from .trajectory import TrajectoryRecord, TurnRecord

logger = logging.getLogger(__name__)

# A tool runner takes (command, cwd, timeout_sec, done_event) and returns
# a ToolResult. Default is `run_bash` (local subprocess); SWE-bench Pro
# tasks plug in a docker-exec runner via Task.tool_runner.
ToolRunner = Callable[..., Awaitable[ToolResult]]


def _approx_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _msg_tokens(messages: list[dict]) -> int:
    return sum(_approx_tokens(m.get("content", "") or "") for m in messages)


@dataclass
class Task:
    task_id: str
    problem_statement: str
    repo_root: str
    success_check: Callable[[], Awaitable[bool] | bool] | None = None
    tool_runner: ToolRunner | None = None
    teardown: Callable[[], None] | None = None
    meta: dict = field(default_factory=dict)


@dataclass
class _TurnOutcome:
    record: TurnRecord
    finished: bool
    final_answer: str | None = None


class Orchestrator:
    def __init__(self, config: RunConfig, client: LLMClient):
        config.validate()
        self.cfg = config
        self.client = client

    async def run(self, task: Task, run_idx: int = 0) -> TrajectoryRecord:
        traj = TrajectoryRecord(
            task_id=task.task_id,
            mode=self.cfg.mode,
            run_idx=run_idx,
            model=self.client.model,
        )
        self._tool_runner: ToolRunner = task.tool_runner or run_bash
        try:
            messages: list[dict] = [
                {"role": "system", "content": build_system_prompt(self.cfg)},
                {
                    "role": "user",
                    "content": build_user_task_prompt(task.problem_statement, task.repo_root),
                },
            ]
            final_answer: str | None = None
            for turn_idx in range(self.cfg.max_turns):
                outcome = await self._run_turn(turn_idx, messages, task.repo_root)
                traj.add_turn(outcome.record)
                if outcome.finished:
                    final_answer = outcome.final_answer
                    break

            if task.success_check is not None:
                res = task.success_check()
                if asyncio.iscoroutine(res):
                    res = await res
                traj.final_success = bool(res)

            if final_answer is not None:
                messages.append({"role": "system", "content": f"<final_answer>\n{final_answer}\n</final_answer>"})

            traj.raw_messages = messages
            return traj
        except Exception as e:
            traj.error = f"{type(e).__name__}: {e}"
            traj.raw_messages = locals().get("messages", [])
            logger.exception("orchestrator failed")
            return traj
        finally:
            if task.teardown is not None:
                try:
                    task.teardown()
                except Exception:
                    logger.exception("task teardown failed")

    async def _run_turn(
        self, turn_idx: int, messages: list[dict], cwd: str
    ) -> _TurnOutcome:
        cfg = self.cfg
        ctx_before = _msg_tokens(messages)

        atoms: list[str] = []
        if cfg.mode == "reflect":
            atoms = list(cfg.reflect_atoms) if cfg.reflect_atoms is not None else list(ATOM_NAMES)
            bad = [a for a in atoms if a not in REFLECT_ATOMS]
            if bad:
                raise ValueError(f"unknown reflect atoms: {bad}")

        buffer = ""
        action: ActionMatch | None = None
        fired = False
        action_end = -1
        cancel_reason: str | None = None
        stream_ended_naturally = False
        branch_tasks: dict[str, asyncio.Task] = {}
        branch_states: dict[str, dict] = {}
        branch_started_at: float = 0.0
        branch_finished_at: float = 0.0
        turn_reasoning = ""

        async with self.client.stream(messages) as tokens:
            async for chunk in tokens:
                # Fork all atom branches at the first content delta.
                if atoms and not branch_tasks:
                    snapshot = list(messages)
                    turn_reasoning = getattr(self.client, "last_reasoning", "") or ""
                    branch_started_at = time.monotonic()
                    for atom in atoms:
                        state = {"text": ""}
                        branch_states[atom] = state
                        branch_tasks[atom] = asyncio.create_task(
                            self._run_branch_atom(snapshot, turn_reasoning, atom, state)
                        )
                buffer += chunk
                if not fired:
                    m = detect_first_action(buffer)
                    if m is not None:
                        fired = True
                        action = m
                        action_end = m.end
                        cancel_reason = "action_emitted"
                        break
            else:
                stream_ended_naturally = True
                cancel_reason = cancel_reason or "stream_eos"

        if cfg.mode == "baseline":
            turn_reasoning = getattr(self.client, "last_reasoning", "") or ""

        if not fired:
            await self._cancel_all_branches(branch_tasks)
            messages.append({"role": "assistant", "content": buffer})
            return _TurnOutcome(
                record=TurnRecord(
                    turn_idx=turn_idx,
                    action_type="no-action",
                    action_content="",
                    tool_duration_sec=0.0,
                    reflect_count=0,
                    stream_ended_naturally=stream_ended_naturally,
                    context_token_len_before=ctx_before,
                    context_token_len_after=_msg_tokens(messages),
                    observation_truncated=False,
                    cancel_reason="no_action",
                    assistant_text=buffer,
                    assistant_reasoning=turn_reasoning,
                ),
                finished=True,
            )

        assert action is not None
        is_submit = self._is_submit_command(action.command)

        tool_result: ToolResult | None = None
        if not is_submit:
            tool_result = await self._tool_runner(
                action.command,
                cwd=cwd,
                timeout_sec=cfg.tool_timeout_sec,
            )

        # Tool done → cancel all branches and harvest.
        if branch_tasks:
            await self._cancel_all_branches(branch_tasks)
            branch_finished_at = time.monotonic()

        units_per_atom: dict[str, list[str]] = {a: [] for a in atoms}
        per_atom_records: dict[str, dict] = {}
        for atom in atoms:
            raw = branch_states.get(atom, {}).get("text", "")
            kept = truncate_at_last_complete_reflect(raw)
            own = [body for (t, body) in parse_reflect_typed_units(kept) if t == atom]
            units_per_atom[atom] = own
            per_atom_records[atom] = {"raw": raw, "kept": kept, "n_units": len(own)}
        merged_reflect_block = (
            interleave_typed_units_by_atom(units_per_atom, atoms)
            if cfg.mode == "reflect" else ""
        )
        branch_text_raw_concat = "\n".join(branch_states.get(a, {}).get("text", "") for a in atoms)
        total_units = sum(len(v) for v in units_per_atom.values())

        # Build assistant content for history
        if is_submit:
            assistant_content = buffer[: action.end].rstrip()
            obs_text = ""
            final_answer = self._extract_final_answer(action.command, buffer[action.end :])
        elif cfg.mode == "baseline":
            assistant_content = buffer[: action.end].rstrip()
            obs_text = tool_result.render_observation(cfg.obs_truncate_chars) if tool_result else ""
            final_answer = None
        else:
            head = buffer[: action.end]
            assistant_content = head + (("\n" + merged_reflect_block) if merged_reflect_block else "")
            obs_text = tool_result.render_observation(cfg.obs_truncate_chars) if tool_result else ""
            final_answer = None

        messages.append({"role": "assistant", "content": assistant_content})
        if obs_text:
            messages.append({"role": "user", "content": obs_text})

        record = TurnRecord(
            turn_idx=turn_idx,
            action_type="submit" if is_submit else "bash",
            action_content=action.command,
            tool_duration_sec=tool_result.duration_sec if tool_result else 0.0,
            reflect_count=total_units,
            stream_ended_naturally=stream_ended_naturally,
            context_token_len_before=ctx_before,
            context_token_len_after=_msg_tokens(messages),
            observation_truncated=tool_result.truncated if tool_result else False,
            tool_returncode=tool_result.returncode if tool_result else None,
            tool_timed_out=tool_result.timed_out if tool_result else False,
            cancel_reason=cancel_reason,
            assistant_text=buffer,
            assistant_reasoning=turn_reasoning,
            branch_text_raw=branch_text_raw_concat,
            branch_text_kept=merged_reflect_block,
            branch_per_atom=per_atom_records,
            branch_window_sec=(
                branch_finished_at - branch_started_at
                if branch_started_at and branch_finished_at
                else 0.0
            ),
        )
        return _TurnOutcome(record=record, finished=is_submit, final_answer=final_answer)

    async def _run_branch_atom(
        self,
        snapshot: list[dict],
        reasoning_text: str,
        atom: str,
        state: dict,
    ) -> None:
        """One atom's branch call. Streams into state['text'] until
        cancelled or its per-atom unit cap is hit."""
        cfg = self.cfg
        branch_messages = build_branch_atom_messages(snapshot, reasoning_text, atom)
        try:
            async with self.client.stream(
                branch_messages,
                extra_body=cfg.branch_extra_body,
                count_call=False,
            ) as tokens:
                async for chunk in tokens:
                    state["text"] += chunk
                    if count_reflect_units(state["text"]) >= cfg.max_reflect_per_turn:
                        break
        except asyncio.CancelledError:
            pass
        except Exception as e:  # pragma: no cover
            logger.exception("branch atom %s failed: %s", atom, e)

    @staticmethod
    async def _cancel_all_branches(tasks: dict[str, asyncio.Task]) -> None:
        for t in tasks.values():
            if not t.done():
                t.cancel()
        for t in tasks.values():
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    # --- helpers ---

    def _is_submit_command(self, cmd: str) -> bool:
        if not cmd:
            return False
        first_line = cmd.strip().splitlines()[0].strip()
        return first_line.startswith(self.cfg.final_sentinel)

    def _strip_submit(self, cmd: str) -> str:
        if self._is_submit_command(cmd):
            return ":"
        return cmd

    def _extract_final_answer(self, sentinel_cmd: str, after_action_text: str) -> str | None:
        lines = sentinel_cmd.strip().splitlines()
        inline = "\n".join(lines[1:]).strip() if len(lines) > 1 else ""
        # Strip any in-flight reflect content from the trailing text.
        trailing = truncate_at_last_complete_reflect(after_action_text).strip()
        parts = [p for p in (inline, trailing) if p]
        return "\n".join(parts) if parts else None


async def run_task(
    task: Task,
    config: RunConfig,
    client: LLMClient,
    run_idx: int = 0,
    log_dir: str = "logs",
) -> TrajectoryRecord:
    orch = Orchestrator(config, client)
    traj = await orch.run(task, run_idx=run_idx)
    traj.write(log_dir)
    return traj
