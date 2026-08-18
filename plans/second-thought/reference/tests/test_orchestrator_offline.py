"""Offline smoke tests for the parallel-multi-atom branch reflect mechanism.

Each turn now fires 1 MAIN call + up to N BRANCH calls (one per
reflect atom). MockClient dispatches by reading the LAST user message
content for an atom marker (see `prompts.REFLECT_ATOMS`).

Pass criteria:
- baseline: no branch calls; trajectory completes; success_check passes.
- reflect (all 4 atoms): each non-submit turn aggregates units from the
  per-atom branches. Complete typed units survive into chat history,
  in-flight tails are dropped, and the merged block is round-robin
  interleaved by atom.
- per-atom cap: each branch stops at `max_reflect_per_turn` units.
"""
from __future__ import annotations

import shutil

import pytest

from benchmarks.toy_tasks import build_toy_task
from second_thought.action_detector import count_reflect_units, parse_reflect_typed_units
from second_thought.config import RunConfig
from second_thought.llm_client import MockClient
from second_thought.orchestrator import run_task


def _main_scripts() -> list[list[str]]:
    """Main-thread (THOUGHT + bash) scripts, one per turn."""
    inspect = [
        "THOUGHT: I'll inspect calc.py first.\n",
        "```bash\n",
        "sleep 0.3 && cat calc.py\n",
        "```\n",
    ]
    fix = [
        "THOUGHT: Fix the bug.\n",
        "```bash\n",
        "sleep 0.2 && cat > calc.py << 'EOF'\n",
        "def add(a, b):\n    return a + b\n\n\n",
        "def mul(a, b):\n    return a * b\nEOF\n",
        "```\n",
    ]
    test = [
        "THOUGHT: Run tests.\n",
        "```bash\n",
        "python3 -m pytest -q test_calc.py 2>&1 | tail -20\n",
        "```\n",
    ]
    submit = [
        "THOUGHT: Submitting.\n",
        "```bash\n",
        "MINI_SWE_AGENT_FINAL_OUTPUT\nfix verified\n",
        "```\n",
    ]
    return [inspect, fix, test, submit]


def _atom_scripts() -> dict[str, list[list[str]]]:
    """Per-atom branch scripts. Each list has one entry per turn.

    Each turn we mix: some complete typed units + one in-flight unit
    at the end (to verify truncation drops it).
    """
    check = [
        # turn 0 (inspect): 3 complete + in-flight
        [
            '<reflect type="check">Did I assume the file is in cwd?</reflect>\n',
            '<reflect type="check">Did I assume Python 3 is the interpreter?</reflect>\n',
            '<reflect type="check">Implicit assumption: UTF-8 encoding.</reflect>\n',
            '<reflect type="check">partial — never closed',
        ],
        # turn 1 (fix): 2 complete
        [
            '<reflect type="check">Did I assume heredoc binds to bash, not sh?</reflect>\n',
            '<reflect type="check">Did the previous cat output show the bug clearly?</reflect>\n',
        ],
        # turn 2 (test): 1 complete
        [
            '<reflect type="check">Did I assume pytest is installed?</reflect>\n',
        ],
        # turn 3 (submit): empty (submit happens fast)
        [],
    ]
    rehearse = [
        [
            '<reflect type="rehearse">If file is missing, fall back to find .</reflect>\n',
            '<reflect type="rehearse">If output is huge, head it.</reflect>\n',
        ],
        [
            '<reflect type="rehearse">If heredoc errors, retry with printf.</reflect>\n',
        ],
        [
            '<reflect type="rehearse">If tests fail, re-read assertion message first.</reflect>\n',
            '<reflect type="rehearse">If pytest is missing, try unittest.</reflect>\n',
        ],
        [],
    ]
    recall = [
        [
            '<reflect type="recall">Issue says add() returns wrong value.</reflect>\n',
        ],
        [
            '<reflect type="recall">Earlier cat showed the bug was in add().</reflect>\n',
            '<reflect type="recall">User asked for both add and mul to remain.</reflect>\n',
        ],
        [],
        [],
    ]
    alternative = [
        [
            '<reflect type="alternative">Could use head -50 calc.py if file is large.</reflect>\n',
        ],
        [],
        [
            '<reflect type="alternative">Could run only the add test for speed.</reflect>\n',
        ],
        [],
    ]
    return {"check": check, "rehearse": rehearse, "recall": recall, "alternative": alternative}


@pytest.mark.asyncio
async def test_baseline_mode_no_branch(tmp_path):
    task = build_toy_task("calc")
    cfg = RunConfig(mode="baseline", api_key="not-needed")
    client = MockClient(_main_scripts(), chunk_delay=0.05)
    traj = await run_task(task, cfg, client, run_idx=0, log_dir=tmp_path)
    try:
        assert traj.error is None, traj.error
        assert traj.total_turns == 4
        assert traj.total_reflect_units == 0
        for msg in traj.raw_messages:
            if msg.get("role") == "assistant":
                assert count_reflect_units(msg["content"]) == 0
        assert traj.final_success is True
        # Branch should NOT be invoked in baseline.
        for atom, idx in client._atom_idx.items():
            assert idx == 0, f"branch[{atom}] was invoked {idx} times in baseline"
    finally:
        shutil.rmtree(task.repo_root, ignore_errors=True)


@pytest.mark.asyncio
async def test_reflect_all_atoms_interleaved(tmp_path):
    task = build_toy_task("calc")
    cfg = RunConfig(mode="reflect", api_key="not-needed")
    client = MockClient(
        _main_scripts(), chunk_delay=0.05, atom_scripts=_atom_scripts()
    )
    traj = await run_task(task, cfg, client, run_idx=0, log_dir=tmp_path)
    try:
        assert traj.error is None, traj.error
        assert traj.total_turns == 4

        # All 4 atoms must have been invoked once per non-submit turn (3),
        # plus the submit turn fires them too but its branch scripts are empty.
        # Submit turn doesn't trigger branch fork because it ends fast — but
        # the orchestrator DOES fork on first content delta; submit's branch
        # is just immediately cancelled and produces 0 units. So expect 4 calls
        # per atom (one per turn including submit).
        for atom in ("check", "rehearse", "recall", "alternative"):
            assert client._atom_idx[atom] == 4, (
                f"branch[{atom}] called {client._atom_idx[atom]} times, expected 4"
            )

        # Total complete units must equal the sum of complete units across
        # all atom scripts (in-flight dropped). From the scripts:
        # check:        3 + 2 + 1 + 0 = 6 (dropped 1 in-flight in turn 0)
        # rehearse:     2 + 1 + 2 + 0 = 5
        # recall:       1 + 2 + 0 + 0 = 3
        # alternative:  1 + 0 + 1 + 0 = 2
        # total complete = 16
        assistant_text = "\n".join(
            m["content"] for m in traj.raw_messages if m.get("role") == "assistant"
        )
        typed = parse_reflect_typed_units(assistant_text)
        # Atom-type histogram
        from collections import Counter
        atom_count = Counter(t for t, _ in typed)
        assert atom_count.get("check", 0) == 6
        assert atom_count.get("rehearse", 0) == 5
        assert atom_count.get("recall", 0) == 3
        assert atom_count.get("alternative", 0) == 2
        assert sum(atom_count.values()) == 16

        # In-flight unit must NOT have leaked.
        assert "partial — never closed" not in assistant_text

        # Round-robin order: in turn 0, the FIRST reflect block should
        # follow check, rehearse, recall, alternative, check, rehearse, ...
        # (atoms with no remaining units skip their slot).
        # Walk the typed units of the FIRST executing turn's assistant
        # message and verify the order matches that expectation.
        first_exec = [
            m["content"] for m in traj.raw_messages
            if m.get("role") == "assistant" and "cat calc.py" in m["content"]
        ][0]
        order = [t for t, _ in parse_reflect_typed_units(first_exec)]
        # turn 0 has: check x3, rehearse x2, recall x1, alternative x1
        # Round-robin yields: check, rehearse, recall, alternative,
        #                    check, rehearse, check.
        assert order == [
            "check", "rehearse", "recall", "alternative",
            "check", "rehearse",
            "check",
        ], f"unexpected interleave order: {order}"

        assert traj.final_success is True
    finally:
        shutil.rmtree(task.repo_root, ignore_errors=True)


@pytest.mark.asyncio
async def test_reflect_per_atom_cap(tmp_path):
    """Each branch breaks out once its own buffer has `max_reflect_per_turn`
    complete units. With cap=1, every atom should contribute at most 1
    unit per turn (regardless of how many its script emits)."""
    task = build_toy_task("calc")
    cfg = RunConfig(mode="reflect", api_key="not-needed", max_reflect_per_turn=1)
    client = MockClient(
        _main_scripts(), chunk_delay=0.02, atom_scripts=_atom_scripts()
    )
    traj = await run_task(task, cfg, client, run_idx=0, log_dir=tmp_path)
    try:
        assert traj.error is None, traj.error
        # Each turn's assistant message has at most 4 reflect units (one
        # per atom, since cap=1).
        for m in traj.raw_messages:
            if m.get("role") != "assistant":
                continue
            n = count_reflect_units(m["content"])
            assert n <= 4, f"turn produced {n} units, cap=1 should bound to 4"
    finally:
        shutil.rmtree(task.repo_root, ignore_errors=True)


@pytest.mark.asyncio
async def test_single_atom_ablation(tmp_path):
    """If config.reflect_atoms = ['check'], only the check branch fires."""
    task = build_toy_task("calc")
    cfg = RunConfig(mode="reflect", api_key="not-needed", reflect_atoms=["check"])
    client = MockClient(
        _main_scripts(), chunk_delay=0.02, atom_scripts=_atom_scripts()
    )
    traj = await run_task(task, cfg, client, run_idx=0, log_dir=tmp_path)
    try:
        assert traj.error is None, traj.error
        # Only check branch should have been invoked.
        assert client._atom_idx["check"] == 4
        for other in ("rehearse", "recall", "alternative"):
            assert client._atom_idx[other] == 0, f"{other} was invoked unexpectedly"
        # All kept units must be type=check.
        assistant_text = "\n".join(
            m["content"] for m in traj.raw_messages if m.get("role") == "assistant"
        )
        typed = parse_reflect_typed_units(assistant_text)
        assert all(t == "check" for t, _ in typed), f"non-check units leaked: {typed}"
    finally:
        shutil.rmtree(task.repo_root, ignore_errors=True)
