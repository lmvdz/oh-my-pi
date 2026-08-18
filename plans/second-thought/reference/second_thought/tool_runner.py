"""Async bash tool runner.

Runs the agent's command in a subprocess. The orchestrator fires this off
with `asyncio.create_task` and watches `done_event` to know when to cut the
LLM stream. Output is captured combined (stdout+stderr interleaved is hard
to do robustly with asyncio; we keep them separate and concatenate on the
way out).
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass


@dataclass
class ToolResult:
    command: str
    stdout: str
    stderr: str
    returncode: int
    duration_sec: float
    timed_out: bool
    truncated: bool

    def render_observation(self, max_chars: int) -> str:
        body = ""
        if self.stdout:
            body += self.stdout
        if self.stderr:
            if body and not body.endswith("\n"):
                body += "\n"
            body += "[stderr]\n" + self.stderr
        if self.timed_out:
            body += f"\n[tool timed out after {self.duration_sec:.1f}s]"
        if len(body) > max_chars:
            head = body[: max_chars // 2]
            tail = body[-max_chars // 2 :]
            body = head + f"\n... [truncated {len(body) - max_chars} chars] ...\n" + tail
            object.__setattr__(self, "truncated", True)
        return f"<observation exit_code={self.returncode}>\n{body}\n</observation>"


async def run_bash(
    command: str,
    cwd: str | None,
    timeout_sec: float,
    done_event: asyncio.Event | None = None,
) -> ToolResult:
    """Run `command` in bash. Sets `done_event` (if given) when finished.

    Always returns a ToolResult — timeouts and non-zero exits are reported
    via fields, not raised, so the orchestrator can feed the failure back
    to the agent as an observation.
    """
    start = time.monotonic()
    timed_out = False
    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_sec
            )
        except asyncio.TimeoutError:
            timed_out = True
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            stdout_b, stderr_b = await proc.communicate()
        returncode = proc.returncode if proc.returncode is not None else -1
        return ToolResult(
            command=command,
            stdout=stdout_b.decode("utf-8", errors="replace"),
            stderr=stderr_b.decode("utf-8", errors="replace"),
            returncode=returncode,
            duration_sec=time.monotonic() - start,
            timed_out=timed_out,
            truncated=False,
        )
    finally:
        if done_event is not None:
            done_event.set()
