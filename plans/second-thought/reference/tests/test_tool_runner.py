import asyncio

import pytest

from second_thought.tool_runner import run_bash


@pytest.mark.asyncio
async def test_basic_command():
    r = await run_bash("echo hello", cwd=None, timeout_sec=5)
    assert r.returncode == 0
    assert r.stdout.strip() == "hello"
    assert not r.timed_out


@pytest.mark.asyncio
async def test_done_event_set():
    ev = asyncio.Event()
    r = await run_bash("echo bye", cwd=None, timeout_sec=5, done_event=ev)
    assert ev.is_set()
    assert r.returncode == 0


@pytest.mark.asyncio
async def test_timeout():
    r = await run_bash("sleep 5", cwd=None, timeout_sec=0.5)
    assert r.timed_out
    # exit code is whatever the killed process produced (often -SIGKILL); we
    # don't assert a specific value, just that we got a result back.


@pytest.mark.asyncio
async def test_observation_truncation():
    # Generate the big string in-process via `yes` so we don't pass 200KB
    # through argv (Linux ARG_MAX caps that around 128KB → E2BIG on the
    # server).
    r = await run_bash("yes hello | head -c 200000", cwd=None, timeout_sec=5)
    obs = r.render_observation(max_chars=2000)
    assert "[truncated" in obs
    assert len(obs) < 4000  # roughly capped
