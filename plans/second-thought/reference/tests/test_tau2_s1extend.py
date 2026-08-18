"""Regression tests for the tau2 s1extend arm.

The prefix-continuation call used to pin OpenRouter to the `deepseek`
provider unconditionally. On any non-deepseek model the request was
rejected, the loop fell through to its `except`, and the arm silently
returned the plain main output — in the data that is indistinguishable
from "the model declined to extend", which is how the banking s1 cells
came to be flagged *suspect*.

What is under test:
  1. the pin follows the model family (and qwen is left unpinned);
  2. a failure is recorded (`s1_error`), not swallowed;
  3. the side-channel prefix tokens are recorded (`s1_ext_tokens`) —
     tau2's own usage accounting never sees that call.
"""
import json
import os
import sys
import types

import pytest

from tests.test_tau2_pending_lifecycle import _install_tau2_stubs


@pytest.fixture()
def mod(tmp_path, monkeypatch):
    monkeypatch.setenv("TAU2_REFLECT_LOG", str(tmp_path / "rec.jsonl"))
    _install_tau2_stubs()
    sys.modules.pop("adapters.tau2.second_thought_agent", None)
    import adapters.tau2.second_thought_agent as m
    return m


class _FakeCompletions:
    """OpenRouter stub: records calls, replies with a fixed continuation."""

    def __init__(self, text=" and then check the balance.", tokens=120, error=None):
        self.calls = []
        self._text, self._tokens, self._error = text, tokens, error

    def create(self, **kw):
        self.calls.append(kw)
        if self._error:
            raise self._error
        msg = types.SimpleNamespace(content=self._text)
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=msg)],
            usage=types.SimpleNamespace(completion_tokens=self._tokens),
        )


def _fake_client(completions):
    return types.SimpleNamespace(
        chat=types.SimpleNamespace(completions=completions)
    )


def _run_turn(mod, monkeypatch, llm, completions):
    """Drive one S1LLMAgent turn against the stubs; return (record, agent)."""
    monkeypatch.setattr(mod, "_openrouter_client", lambda: _fake_client(completions))
    monkeypatch.setattr(
        mod, "generate",
        lambda **kw: types.SimpleNamespace(
            role="assistant", content="I should look up the account.", tool_calls=None),
    )
    agent = mod.S1LLMAgent.__new__(mod.S1LLMAgent)
    agent.llm, agent.llm_args, agent.tools = llm, {}, []
    agent._turn, agent._aid = 0, "atest"

    state = types.SimpleNamespace(
        system_messages=[types.SimpleNamespace(role="system", content="policy")],
        messages=[],
    )
    incoming = types.SimpleNamespace(role="user", content="what is my balance?")
    agent._generate_next_message(incoming, state)

    records = [json.loads(ln) for ln in open(os.environ["TAU2_REFLECT_LOG"])]
    return records[-1], agent


def test_provider_pin_follows_the_model_family(mod):
    assert mod._provider_pin("deepseek/deepseek-v4-flash") == {
        "provider": {"order": ["deepseek"], "allow_fallbacks": False}}
    assert mod._provider_pin("minimax/minimax-m3") == {
        "provider": {"order": ["minimax/fp8"], "allow_fallbacks": False}}
    assert mod._provider_pin("qwen/qwen3.6-plus") == {}


def test_qwen_prefix_call_is_not_pinned_to_deepseek(mod, monkeypatch):
    comp = _FakeCompletions()
    rec, _ = _run_turn(mod, monkeypatch, "openrouter/qwen/qwen3.6-plus", comp)

    assert comp.calls, "the prefix-continuation round never fired"
    assert comp.calls[0]["model"] == "qwen/qwen3.6-plus"
    assert comp.calls[0]["extra_body"] == {}     # the bug: a deepseek-only pin
    assert rec["s1_error"] is None
    assert rec["s1_rounds"] > 0 and rec["s1_ext_chars"] > 0


def test_deepseek_and_minimax_keep_their_pins(mod, monkeypatch):
    comp = _FakeCompletions()
    _run_turn(mod, monkeypatch, "openrouter/deepseek/deepseek-v4-flash", comp)
    assert comp.calls[0]["extra_body"]["provider"]["order"] == ["deepseek"]

    comp2 = _FakeCompletions()
    _run_turn(mod, monkeypatch, "openrouter/minimax/minimax-m3", comp2)
    assert comp2.calls[0]["extra_body"]["provider"]["order"] == ["minimax/fp8"]


def test_side_channel_tokens_are_recorded(mod, monkeypatch):
    # 120 tokens/round against a 300-token target -> 3 rounds, 360 tokens.
    comp = _FakeCompletions(tokens=120)
    rec, _ = _run_turn(mod, monkeypatch, "openrouter/qwen/qwen3.6-plus", comp)

    assert rec["s1_ext_tokens"] == 120 * rec["s1_rounds"]
    assert rec["s1_ext_tokens"] >= 300           # budget honoured in real tokens
    assert rec["s1_ext_tokens_exact"] is True
    # tau2's own usage accounting cannot see that call at all:
    assert not rec["usage"].get("completion_tokens")


def test_budget_falls_back_to_chars_when_usage_is_absent(mod, monkeypatch):
    comp = _FakeCompletions(text="x" * 600, tokens=0)
    rec, _ = _run_turn(mod, monkeypatch, "openrouter/qwen/qwen3.6-plus", comp)

    assert rec["s1_ext_tokens"] == 0
    assert rec["s1_ext_tokens_exact"] is False
    assert rec["s1_rounds"] == 2                 # 600 chars//4 = 150 < 300 -> 2 rounds
    assert rec["s1_error"] is None


def test_a_broken_prefix_call_is_recorded_not_swallowed(mod, monkeypatch):
    comp = _FakeCompletions(error=RuntimeError("404 no provider for model"))
    rec, _ = _run_turn(mod, monkeypatch, "openrouter/qwen/qwen3.6-plus", comp)

    assert rec["s1_rounds"] == 0 and rec["s1_ext_chars"] == 0
    assert rec["s1_error"] and "404" in rec["s1_error"]
