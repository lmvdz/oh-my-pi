"""reflect_sync — the blocking cell of the {content} x {schedule} 2x2.

The arm's whole claim is an ordering one: the 4 branches are awaited to
completion BEFORE the tool runs, so their decode sits on the critical
path instead of inside the idle window. If a refactor ever lets the tool
start first, the cell silently degenerates back into `reflect` and the
measured latency price becomes meaningless -- hence these tests.

Covered:
  - tool starts only after every branch task is done (reflect_sync)
  - `reflect` still overlaps: the tool starts while branches run
  - a branch that never stops is bounded by sync_branch_timeout_sec and
    its partial output is still harvested
"""
import asyncio
import time

import pytest

from second_thought.mini_runner.streaming_agent import ReflectAgent


class _FakeStream:
    """Async CM + async iterator matching SecondThoughtModel.stream's contract."""

    def __init__(self, chunks, delay=0.0, yield_log=None):
        self._chunks = list(chunks)
        self._delay = delay
        self._yield_log = yield_log
        self.reasoning_buf: list[str] = []
        self.stream_chunks: list[dict] = []

    def get_usage(self):
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for c in self._chunks:
            if self._delay:
                await asyncio.sleep(self._delay)
            if self._yield_log is not None:
                self._yield_log.append(time.monotonic())
            yield c


_UNIT = '<reflect type="{a}">unit {i} for {a}.</reflect>\n'


class _FakeModel:
    """Main stream emits one reasoning delta then an action. Branch streams
    emit reflect units at `branch_delay` seconds apiece, `branch_units` of
    them, then end (unless `branch_forever`)."""

    class _Cfg:
        model_name = "fake/model"

    def __init__(self, *, branch_units=8, branch_delay=0.05, branch_forever=False):
        self.config = self._Cfg()
        self.n_calls = 0
        self.cost = 0.0
        self.branch_units = branch_units
        self.branch_delay = branch_delay
        self.branch_forever = branch_forever
        self.branch_calls = 0
        # monotonic timestamp of every chunk any branch emitted
        self.branch_yields: list[float] = []

    def get_template_vars(self):
        return {}

    def stream(self, messages, *, count_call=True, **kwargs):
        if not count_call:  # branch call
            self.branch_calls += 1
            atom = _atom_of(messages)
            n = 10**6 if self.branch_forever else self.branch_units
            chunks = (_UNIT.format(a=atom, i=i) for i in range(n))
            return _FakeStream(
                chunks, delay=self.branch_delay, yield_log=self.branch_yields
            )
        self.n_calls += 1
        return _FakeStream(["THOUGHT: go.\n", "```bash\n", "echo hi\n", "```\n"])


def _atom_of(messages) -> str:
    last = messages[-1]["content"]
    for atom in ("check", "rehearse", "recall", "alternative"):
        if f'type="{atom}"' in last:
            return atom
    return "check"


class _FakeEnv:
    """`tool_delay` is the idle window the async arm gets to hide branches
    in; it runs on a worker thread (env.execute is called via to_thread),
    so a blocking sleep here does not stall the branches."""

    def __init__(self, tool_delay=0.06):
        self.exec_times: list[float] = []
        self._tool_delay = tool_delay

    def execute(self, command, **kw):
        self.exec_times.append(time.monotonic())
        time.sleep(self._tool_delay)
        return {"output": "hi\n", "returncode": 0}

    def get_template_vars(self):
        return {}


def _agent(model, env, **cfg):
    a = ReflectAgent(model, env, step_limit=1, cost_limit=0.0, **cfg)
    a.messages = [{"role": "user", "content": "task"}]
    return a


def _run_one_turn(agent):
    async def main():
        # step_limit=1 with n_calls already at 1 after the turn -> the
        # second step raises LimitsExceeded, which ends run_async cleanly.
        try:
            await agent._async_step()
        except Exception:  # noqa: BLE001 - Submitted/LimitsExceeded etc.
            pass

    asyncio.run(main())


def test_sync_blocks_tool_until_every_branch_is_done():
    model = _FakeModel(branch_units=6, branch_delay=0.02)
    env = _FakeEnv()
    agent = _agent(model, env, mode="reflect_sync", max_reflect_per_turn=5)
    _run_one_turn(agent)

    assert model.branch_calls == 4, "all four atoms must fork"
    assert env.exec_times, "tool never ran"
    # THE invariant: no branch was still producing when the tool started.
    assert env.exec_times[0] > max(model.branch_yields), (
        "tool started while a branch was still decoding — this arm is "
        "supposed to put that decode on the critical path"
    )
    rec = agent.turn_records[-1]
    assert rec.phase_times["branch_block_sec"] > 0.0
    assert not rec.phase_times["branch_block_timed_out"]
    # 4 atoms x cap 5 units, harvested in full because nothing cancelled them.
    assert rec.reflect_count == 20, rec.reflect_count
    # The block is charged to the critical path: it ended before the tool
    # started, and it is a real, non-trivial share of the step.
    assert rec.phase_times["branch_block_sec"] >= 5 * 0.02


def test_async_reflect_still_overlaps_the_tool():
    """Guard against the ordering change leaking into the async arm."""
    model = _FakeModel(branch_units=6, branch_delay=0.02)
    env = _FakeEnv()
    agent = _agent(model, env, mode="reflect", max_reflect_per_turn=5)
    _run_one_turn(agent)

    rec = agent.turn_records[-1]
    assert rec.phase_times["branch_block_sec"] == 0.0
    # Mirror image of the sync invariant: the tool started while branches
    # were still decoding.
    assert env.exec_times[0] < max(model.branch_yields)
    # Cut at wait-zero, so the harvest is partial rather than the full 4x5.
    assert rec.reflect_count < 20


def test_a_branch_that_never_stops_is_bounded_and_still_harvested():
    model = _FakeModel(branch_delay=0.01, branch_forever=True)
    env = _FakeEnv()
    agent = _agent(
        model, env, mode="reflect_sync",
        max_reflect_per_turn=10**9,   # cap can never fire
        sync_branch_timeout_sec=0.3,
    )
    t0 = time.monotonic()
    _run_one_turn(agent)
    elapsed = time.monotonic() - t0

    rec = agent.turn_records[-1]
    assert rec.phase_times["branch_block_timed_out"] is True
    assert elapsed < 5.0, f"timeout did not bound the turn ({elapsed:.1f}s)"
    assert rec.reflect_count > 0, "partial branch output must still be folded"


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-q"])
