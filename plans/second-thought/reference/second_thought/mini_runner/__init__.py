"""mini-swe-agent integration for Second Thought.

This subpackage subclasses mini-swe-agent's DefaultAgent and adds a
streaming/async path so the model can emit structured
`<reflect>...</reflect>` units while a tool runs in the background.
mini-swe-agent's prompt templates, format-error handling, submit
protocol, and cost/step limits are inherited unchanged.
"""
from .docker_env_adapter import MiniDockerEnvironment
from .streaming_agent import (
    ReflectAgent,
    ReflectAgentConfig,
)
from .streaming_model import SecondThoughtModel

__all__ = [
    "ReflectAgent",
    "ReflectAgentConfig",
    "SecondThoughtModel",
    "MiniDockerEnvironment",
]
