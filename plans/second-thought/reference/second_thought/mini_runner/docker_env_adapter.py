"""Adapter that exposes mini-swe-agent's `Environment` protocol on top of
our `DockerContainer`. Synchronous `execute()` so DefaultAgent can call it
directly; the streaming agent path wraps this in `asyncio.to_thread`.
"""
from __future__ import annotations

import platform
from dataclasses import asdict, dataclass, field
from typing import Any

from ..docker_env import DockerContainer


@dataclass
class MiniDockerEnvironmentConfig:
    image: str
    cwd: str = "/app"
    env: dict[str, str] = field(default_factory=dict)
    timeout: int = 300
    keep_alive: str = "6h"


class MiniDockerEnvironment:
    """mini-swe-agent Environment-protocol wrapper around DockerContainer.

    The container is started in __init__ so it's reusable across the agent's
    turns. Tear down explicitly with `stop()`.
    """

    def __init__(self, *, config_class: type = MiniDockerEnvironmentConfig, **kwargs):
        self.config = config_class(**kwargs)
        self._cont = DockerContainer(
            image=self.config.image,
            cwd=self.config.cwd,
            keep_alive=self.config.keep_alive,
        )
        self._cont.start()

    @property
    def container(self) -> DockerContainer:
        return self._cont

    def execute(self, command: str, cwd: str = "", *, timeout: int | None = None) -> dict[str, str]:
        # mini-swe-agent's contract: return {"output": str, "returncode": int}.
        # Their action_observation_template references both keys.
        result = self._cont.exec_sync(
            command=command,
            cwd=cwd or self.config.cwd,
            timeout=timeout or self.config.timeout,
        )
        # Combine stdout + stderr like LocalEnvironment does (subprocess.STDOUT)
        output = result.stdout
        if result.stderr:
            if output and not output.endswith("\n"):
                output += "\n"
            output += result.stderr
        if result.timed_out:
            output += f"\n[command timed out after {result.duration_sec:.1f}s]"
        return {"output": output, "returncode": result.returncode}

    def get_template_vars(self) -> dict[str, Any]:
        # mini-swe-agent's default instance_template references {{system}}
        # {{release}} {{version}} {{machine}} from uname. The container is
        # always a Linux-amd64 box, so report that statically rather than
        # the host's uname (which would be wrong on a Mac dev box).
        return asdict(self.config) | {
            "system": "Linux",
            "release": "container",
            "version": "container",
            "machine": "x86_64",
            "node": "container",
        }

    def stop(self) -> None:
        self._cont.stop()
