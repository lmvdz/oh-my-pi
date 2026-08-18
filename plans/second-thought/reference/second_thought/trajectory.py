from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class TurnRecord:
    turn_idx: int
    action_type: str  # "bash" | "submit" | "no-action" | "format-error"
    action_content: str
    tool_duration_sec: float
    reflect_count: int  # complete <reflect>...</reflect> units this turn
    stream_ended_naturally: bool
    context_token_len_before: int
    context_token_len_after: int
    observation_truncated: bool
    tool_returncode: int | None = None
    tool_timed_out: bool = False
    cancel_reason: str | None = None  # "action_emitted" | "stream_eos" | "no_action"
    # Main thread's raw assistant content (reasoning prose + bash block).
    # In the new branch design, the main thread does NOT emit reflects;
    # so this string ends at the closing ``` of the bash block.
    assistant_text: str = ""
    # Reasoning content from provider's `reasoning` field (DeepSeek V4 Pro etc.).
    assistant_reasoning: str = ""
    # Branch (reflection) output for this turn.
    # - `branch_text_raw`: concat of all atom branch buffers (debug only)
    # - `branch_text_kept`: the round-robin merged, typed reflect block
    #   that was spliced into the assistant message after the action
    # - `branch_per_atom`: dict[atom_name, {"raw": str, "kept": str,
    #   "n_units": int}] — per-atom breakdown for diagnose / ablation
    # - `branch_window_sec`: branch fork → cancellation wall time
    branch_text_raw: str = ""
    branch_text_kept: str = ""
    branch_per_atom: dict = field(default_factory=dict)
    branch_window_sec: float = 0.0


@dataclass
class TrajectoryRecord:
    task_id: str
    mode: str
    run_idx: int
    model: str
    started_at: float = field(default_factory=time.time)
    ended_at: float = 0.0
    turns: list[TurnRecord] = field(default_factory=list)
    final_success: bool | None = None
    total_turns: int = 0
    total_reflect_units: int = 0
    trajectory_path: str = ""
    raw_messages: list[dict] = field(default_factory=list)
    error: str | None = None

    def add_turn(self, t: TurnRecord) -> None:
        self.turns.append(t)
        self.total_turns = len(self.turns)
        self.total_reflect_units += t.reflect_count

    def to_dict(self) -> dict:
        return asdict(self)

    def write(self, log_dir: str | Path) -> str:
        log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        fname = f"{self.task_id}_{self.mode}_run{self.run_idx}.json"
        out = log_dir / fname
        self.trajectory_path = str(out)
        self.ended_at = time.time()
        with out.open("w") as f:
            json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)
        return str(out)
