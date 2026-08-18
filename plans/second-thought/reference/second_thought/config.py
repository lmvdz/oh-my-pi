from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

# Two experimental conditions:
#   baseline — synchronous tool execution; no wait-time generation
#   reflect  — async branch-thread reflection: the moment the main
#              thread's reasoning phase ends, the harness forks a
#              second LLM call (same model, thinking disabled) that
#              emits <reflect>...</reflect> units in parallel with
#              the main thread's action + tool execution. When the
#              tool finishes, the branch is cancelled and its
#              accumulated text is truncated at the last
#              </reflect>; complete units are spliced into chat
#              history between action and observation.
Mode = Literal["baseline", "reflect"]
VALID_MODES: tuple[Mode, ...] = ("baseline", "reflect")


@dataclass
class RunConfig:
    mode: Mode = "baseline"
    model: str = field(default_factory=lambda: os.getenv("SECOND_THOUGHT_MODEL", "deepseek/deepseek-v4-pro"))
    base_url: str = field(default_factory=lambda: os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"))
    api_key: str | None = field(default_factory=lambda: os.getenv("OPENROUTER_API_KEY"))

    max_turns: int = 30
    tool_timeout_sec: float = 60.0
    obs_truncate_chars: int = 16_000

    # Per-turn cap on complete <reflect>...</reflect> units harvested
    # from the branch thread. Branch is cancelled once this many full
    # units have been collected, even if the tool is still running.
    max_reflect_per_turn: int = 20

    # Which reflect atoms to fork branch threads for. None = all 4
    # (check, rehearse, recall, alternative). A single-element list
    # selects just that atom for ablation; an empty list disables the
    # branch entirely (equivalent to baseline behaviour). The atoms
    # share the same conversation prefix and run concurrently.
    reflect_atoms: list[str] | None = None

    # extra_body to merge into the branch LLM call. Disables reasoning
    # so the branch goes straight to content emission and uses the
    # whole reflect window for reflect tokens (no thinking overhead).
    # OpenRouter's unified `reasoning` knob controls thinking across
    # providers; the Anthropic-style `thinking: {type: disabled}` is
    # silently ignored on OpenRouter, which is why we use this form.
    branch_extra_body: dict = field(
        default_factory=lambda: {"reasoning": {"enabled": False}}
    )

    # Sampling controls. Temperature is set low because we want stable
    # action emission rather than creative reasoning.
    temperature: float = 0.2
    max_completion_tokens: int = 4096

    enable_reasoning: bool = True

    # Sentinel that ends the trajectory when the model "submits".
    final_sentinel: str = "MINI_SWE_AGENT_FINAL_OUTPUT"

    def validate(self) -> None:
        if self.mode not in VALID_MODES:
            raise ValueError(f"mode must be one of {VALID_MODES}, got {self.mode!r}")
        if self.max_reflect_per_turn < 1:
            raise ValueError("max_reflect_per_turn must be >= 1")
