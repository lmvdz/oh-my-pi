"""Docker container helpers for sandbox-based tasks (SWE-bench Pro).

Each task gets its own long-running container started from the task's
image. The agent's bash actions become `docker exec` calls; grading uses
the same container after the agent finishes.
"""
from __future__ import annotations

import asyncio
import logging
import shlex
import subprocess
import time
import uuid
from dataclasses import dataclass

from .tool_runner import ToolResult

logger = logging.getLogger(__name__)


@dataclass
class DockerContainer:
    image: str
    name: str | None = None
    container_id: str | None = None
    cwd: str = "/app"
    keep_alive: str = "6h"
    pull_timeout: int = 600

    def __post_init__(self):
        if self.name is None:
            self.name = f"second-thought-{uuid.uuid4().hex[:10]}"

    def start(self) -> None:
        """Pull image if needed and start the container.

        We override the entrypoint to /bin/sleep because some SWE-bench Pro
        images have ENTRYPOINT=[/bin/bash], which causes our `sleep` arg to
        be interpreted as a bash script name and the container to exit
        immediately.
        """
        cmd = [
            "docker", "run", "-d", "--rm",
            "--name", self.name,
            "-w", self.cwd,
            "--entrypoint", "/bin/sleep",
            self.image,
            self.keep_alive,
        ]
        logger.info("docker start: %s", " ".join(cmd))
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=self.pull_timeout)
        if r.returncode != 0:
            raise RuntimeError(f"docker run failed:\nSTDOUT: {r.stdout}\nSTDERR: {r.stderr}")
        self.container_id = r.stdout.strip()

    def stop(self) -> None:
        if self.container_id is None:
            return
        try:
            subprocess.run(
                ["docker", "rm", "-f", self.container_id],
                capture_output=True, text=True, timeout=30,
            )
        except Exception:
            logger.exception("docker rm failed for %s", self.container_id)
        finally:
            self.container_id = None

    def exec_sync(self, command: str, cwd: str | None = None, timeout: float = 120.0) -> ToolResult:
        """Synchronous exec — used for setup/teardown."""
        if self.container_id is None:
            raise RuntimeError("container not started")
        full = [
            "docker", "exec",
            "-w", cwd or self.cwd,
            self.container_id,
            "bash", "-lc", command,
        ]
        start = time.monotonic()
        timed_out = False
        try:
            r = subprocess.run(full, capture_output=True, text=True, timeout=timeout)
            stdout, stderr, rc = r.stdout, r.stderr, r.returncode
        except subprocess.TimeoutExpired as e:
            timed_out = True
            stdout = (e.stdout or b"").decode("utf-8", errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            stderr = (e.stderr or b"").decode("utf-8", errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
            rc = -1
        return ToolResult(
            command=command,
            stdout=stdout,
            stderr=stderr,
            returncode=rc,
            duration_sec=time.monotonic() - start,
            timed_out=timed_out,
            truncated=False,
        )

    async def exec_async(
        self,
        command: str,
        cwd: str | None = None,
        timeout_sec: float = 120.0,
        done_event: asyncio.Event | None = None,
    ) -> ToolResult:
        """Async exec, plug-in compatible with second_thought.tool_runner.run_bash."""
        if self.container_id is None:
            raise RuntimeError("container not started")
        argv = [
            "docker", "exec",
            "-w", cwd or self.cwd,
            self.container_id,
            "bash", "-lc", command,
        ]
        start = time.monotonic()
        timed_out = False
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
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
            rc = proc.returncode if proc.returncode is not None else -1
            return ToolResult(
                command=command,
                stdout=stdout_b.decode("utf-8", errors="replace"),
                stderr=stderr_b.decode("utf-8", errors="replace"),
                returncode=rc,
                duration_sec=time.monotonic() - start,
                timed_out=timed_out,
                truncated=False,
            )
        finally:
            if done_event is not None:
                done_event.set()

    def copy_in(self, host_path: str, container_path: str) -> None:
        if self.container_id is None:
            raise RuntimeError("container not started")
        r = subprocess.run(
            ["docker", "cp", host_path, f"{self.container_id}:{container_path}"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            raise RuntimeError(f"docker cp failed: {r.stderr}")
