"""Regression tests for the tau2 adapter's fork lifecycle (2026-07-28).

tau2 itself is not installed in this environment (it is provided by the
benchmark harness), so the module is imported against minimal stubs. What
is under test is our own code: a fork that will never be harvested must be
STOPPED, not merely dereferenced.

B2: `_stream_main`'s retry loop re-forked and overwrote `self._pending`,
    and its fallback set `self._pending = None` -- both dropped the
    reference to 4 live threads without setting their stop event or
    closing their streams.
B3: the last turn of every episode forks branches that no later turn ever
    harvests, and the shared 16-worker pool was never shut down.
"""
import json
import os
import sys
import types

import pytest


def _install_tau2_stubs():
    if "tau2" in sys.modules:
        return

    class _Msg:
        def __init__(self, **kw):
            self.__dict__.update(kw)
            self.__dict__.setdefault("content", None)

    def _mod(name, **attrs):
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        sys.modules[name] = m
        return m

    class LLMAgent:
        def __init__(self, tools=None, domain_policy=None, llm=None, llm_args=None):
            self.tools, self.domain_policy = tools, domain_policy
            self.llm, self.llm_args = llm, llm_args or {}

    _mod("tau2")
    _mod("tau2.agent")
    _mod("tau2.agent.llm_agent", LLMAgent=LLMAgent, LLMAgentState=object)
    _mod("tau2.data_model")
    _mod("tau2.data_model.message",
         AssistantMessage=_Msg, MultiToolMessage=_Msg, UserMessage=_Msg, ToolCall=_Msg)
    _mod("tau2.utils")
    _mod("tau2.utils.llm_utils", generate=lambda **kw: _Msg(role="assistant", content=""))
    _mod("tau2.registry", registry=types.SimpleNamespace(
        register_agent_factory=lambda *a, **k: None))
    _mod("tau2.cli", main=lambda: 0)


@pytest.fixture()
def mod(tmp_path, monkeypatch):
    monkeypatch.setenv("TAU2_REFLECT_LOG", str(tmp_path / "rec.jsonl"))
    _install_tau2_stubs()
    sys.modules.pop("adapters.tau2.second_thought_agent", None)
    import adapters.tau2.second_thought_agent as m
    return m


class _FakeStream:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class _FakeFuture:
    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True
        return True


def _agent_with_pending(m):
    ag = m.StreamingReflectLLMAgent.__new__(m.StreamingReflectLLMAgent)
    ag.reflect_atoms = ["check", "rehearse", "recall", "alternative"]
    ag._aid = "atest"
    import threading
    streams = {a: _FakeStream() for a in ag.reflect_atoms}
    futs = {a: _FakeFuture() for a in ag.reflect_atoms}
    ag._pending = {
        "stop": threading.Event(),
        "states": {a: {"text": "partial", "_stream": streams[a]} for a in ag.reflect_atoms},
        "futs": futs,
        "turn": 3,
        "fork_ts": 0.0,
        "cond_chars": 42,
    }
    return ag, streams, futs


def test_abort_pending_stops_every_branch(mod):
    ag, streams, futs = _agent_with_pending(mod)
    stop = ag._pending["stop"]
    ag._abort_pending("unit_test")
    assert stop.is_set(), "stop event was not set"
    assert all(s.closed for s in streams.values()), "a branch stream was left open"
    assert all(f.cancelled for f in futs.values())
    assert ag._pending is None


def test_abort_pending_is_recorded_so_the_fork_is_not_invisible(mod, tmp_path):
    ag, _, _ = _agent_with_pending(mod)
    ag._abort_pending("refork_after_retry")
    lines = [json.loads(ln) for ln in open(os.environ["TAU2_REFLECT_LOG"])]
    aborts = [r for r in lines if r.get("mode") == "reflect_stream_abort"]
    assert len(aborts) == 1
    assert aborts[0]["why"] == "refork_after_retry"
    assert aborts[0]["turn"] == 3
    assert aborts[0]["branch_raw_chars"]["check"] == len("partial")


def test_abort_pending_is_idempotent_and_safe_when_empty(mod):
    ag, _, _ = _agent_with_pending(mod)
    ag._abort_pending("once")
    ag._abort_pending("twice")  # must not raise
    assert ag._pending is None


def test_close_releases_the_last_turns_fork(mod):
    ag, streams, _ = _agent_with_pending(mod)
    ag.close()
    assert all(s.closed for s in streams.values())
    assert ag._pending is None


def test_agent_ids_are_unique_across_instances(mod):
    seen = {f"a{next(mod._AGENT_SEQ)}" for _ in range(1000)}
    assert len(seen) == 1000, "agent ids collided"


def test_atexit_hook_aborts_live_agents_and_drops_the_pool(mod):
    ag, streams, _ = _agent_with_pending(mod)
    mod._LIVE_AGENTS.add(ag)

    class _Pool:
        def __init__(self):
            self.down = False

        def shutdown(self, wait=True, cancel_futures=False):
            self.down = True

    pool = _Pool()
    mod.StreamingReflectLLMAgent._SHARED_EXECUTOR = pool
    mod._shutdown_shared_executor()
    assert all(s.closed for s in streams.values()), "exit did not close branch streams"
    assert pool.down
    assert mod.StreamingReflectLLMAgent._SHARED_EXECUTOR is None
