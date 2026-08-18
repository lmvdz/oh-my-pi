"""Regression tests for branch-task lifecycle (2026-07-28).

B1: the 4 branch tasks are forked from inside the main stream's
`async with` block while both normal cancel sites sit after it, so an
exception raised while iterating the main stream left them running. The
driver then retried the whole instance and the orphans kept decoding.

Also covers the cancel bound: a branch stuck in its own stream teardown
must not be able to wedge the run forever.
"""
import asyncio

import pytest

from second_thought.mini_runner.streaming_agent import ReflectAgent


def _bare_agent() -> ReflectAgent:
    """A ReflectAgent with no model/env -- enough for the lifecycle logic,
    which only touches `self._inflight_branches` and `_cancel_all_branches`."""
    return ReflectAgent.__new__(ReflectAgent)


def test_step_leaves_no_pending_task_behind():
    async def main():
        agent = _bare_agent()
        created = []

        async def branch():
            await asyncio.sleep(3600)

        async def impl():
            for atom in ("check", "rehearse"):
                t = asyncio.create_task(branch())
                created.append(t)
                agent._inflight_branches[atom] = t
            await asyncio.sleep(0)  # let them start
            raise RuntimeError("transport died after the fork")

        agent._async_step_impl = impl
        with pytest.raises(RuntimeError):
            await agent._async_step()
        assert created, "test did not fork anything"
        assert all(t.done() for t in created), "a branch task outlived the step"
        assert agent._inflight_branches == {}

    asyncio.run(main())


def test_normal_exit_also_leaves_nothing_running():
    async def main():
        agent = _bare_agent()
        created = []

        async def branch():
            await asyncio.sleep(3600)

        async def impl():
            t = asyncio.create_task(branch())
            created.append(t)
            agent._inflight_branches["check"] = t
            await asyncio.sleep(0)
            return {"output": "ok", "returncode": 0}

        agent._async_step_impl = impl
        out = await agent._async_step()
        assert out["returncode"] == 0
        assert all(t.done() for t in created)

    asyncio.run(main())


def test_cancel_is_bounded_when_a_branch_ignores_cancellation():
    """A branch wedged in its stream teardown must not hang the run."""
    async def main():
        release = asyncio.Event()

        async def stubborn():
            while True:
                try:
                    await asyncio.sleep(3600)
                except asyncio.CancelledError:
                    # Simulates an await inside the stream's `finally` that
                    # never completes: swallow the cancel and keep going.
                    if release.is_set():
                        raise
                    continue

        t = asyncio.create_task(stubborn())
        await asyncio.sleep(0)
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        await ReflectAgent._cancel_all_branches({"check": t}, timeout=0.2)
        elapsed = loop.time() - t0
        assert elapsed < 2.0, f"cancellation was not bounded ({elapsed:.1f}s)"
        assert not t.done(), "the stubborn task should still be running"
        release.set()  # let the loop shut down cleanly
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass

    asyncio.run(main())


def test_cancel_of_empty_dict_is_a_noop():
    asyncio.run(ReflectAgent._cancel_all_branches({}))


def test_branch_max_tokens_defaults_to_inherit():
    agent = _bare_agent()

    class _Cfg:
        branch_max_tokens = None

    agent.config = _Cfg()
    assert agent._branch_token_kwargs() == {}
    agent.config.branch_max_tokens = 2048
    assert agent._branch_token_kwargs() == {"max_tokens": 2048}
