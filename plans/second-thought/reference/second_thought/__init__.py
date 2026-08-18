"""Second Thought: structured reflection-unit experiment.

Two experimental conditions:
- baseline: stream stops at the first action; tool runs synchronously
- reflect:  the moment the main thread finishes its private reasoning
  (first content delta), a BRANCH thread is forked. The branch is an
  independent LLM call against the same model with thinking DISABLED;
  it streams <reflect>...</reflect> units (predict/expect/contingency/
  retrospect) in parallel with the main thread's action emission and
  tool execution. When the tool finishes, the branch is cancelled and
  its accumulated text is truncated at the last </reflect>; complete
  units are spliced into the assistant message after the action.
"""
from .config import Mode, RunConfig
from .orchestrator import Orchestrator, Task, run_task
from .trajectory import TrajectoryRecord, TurnRecord

__all__ = [
    "RunConfig",
    "Mode",
    "Orchestrator",
    "Task",
    "run_task",
    "TurnRecord",
    "TrajectoryRecord",
]
