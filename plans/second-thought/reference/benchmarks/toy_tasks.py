"""Tiny self-contained tasks for offline / local smoke tests.

Each task materializes a fresh sandbox directory with a buggy Python file
and a pytest. The success_check re-runs pytest and returns True iff it
passes. Cheap enough to run in CI; lets us exercise the orchestrator's
end-to-end mechanics without SWE-bench Pro's docker / dataset machinery.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from second_thought.orchestrator import Task

_CALC_BUGGY = """\
def add(a, b):
    return a - b  # bug: should be a + b


def mul(a, b):
    return a * b
"""

_CALC_TEST = """\
from calc import add, mul


def test_add():
    assert add(2, 3) == 5
    assert add(-1, 1) == 0


def test_mul():
    assert mul(2, 3) == 6
"""


def _make_calc_task() -> tuple[str, Task]:
    workdir = Path(tempfile.mkdtemp(prefix="second_thought_toy_calc_"))
    (workdir / "calc.py").write_text(_CALC_BUGGY)
    (workdir / "test_calc.py").write_text(_CALC_TEST)
    # Some environments auto-load a broken pytest_httpbin plugin. Ship a
    # local pytest.ini that disables it so any pytest invocation in this
    # sandbox doesn't trip on it.
    (workdir / "pytest.ini").write_text("[pytest]\naddopts = -p no:httpbin\n")

    def check() -> bool:
        try:
            r = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", "test_calc.py"],
                cwd=workdir,
                capture_output=True,
                timeout=30,
            )
            return r.returncode == 0
        except Exception:
            return False

    task = Task(
        task_id="toy-calc-add-bug",
        problem_statement=(
            "There is a bug in calc.py: add() returns the wrong value. "
            "Fix calc.py so that `python -m pytest -q test_calc.py` passes. "
            "Use the bash environment to inspect, edit, and run the tests."
        ),
        repo_root=str(workdir),
        success_check=check,
    )
    return str(workdir), task


_BUILDERS = {"calc": _make_calc_task}


def list_toy_tasks() -> list[str]:
    return list(_BUILDERS.keys())


def build_toy_task(name: str) -> Task:
    if name not in _BUILDERS:
        raise KeyError(f"unknown toy task {name!r}; pick from {list_toy_tasks()}")
    _, task = _BUILDERS[name]()
    return task


def cleanup_toy_task(task: Task) -> None:
    shutil.rmtree(task.repo_root, ignore_errors=True)
