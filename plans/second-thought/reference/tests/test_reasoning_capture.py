"""Regression guard for the May reasoning-capture defect (audited 2026-07-28).

In the May revision `turn_reasoning` was assigned only inside the fork
branch -- which runs on the first CONTENT delta -- and the recovery line
below the stream covered baseline/s1extend only. A reflect turn that
emitted reasoning but never any content therefore recorded
`assistant_reasoning == ""`. Measured on the published SWE-Pro cell: 438
of 438 zero-content turns lost their reasoning (0 of 662 on baseline, 0 of
587 on s1extend), and those are the longest turns -- that cell has no turn
at the reasoning cap while every comparison arm does. It is the reason the
headline token saving has to be re-run rather than recomputed.

The property that must hold: reasoning is captured per call, from the
stream handle, independently of whether any content delta ever arrives.
"""
import asyncio

import pytest

from second_thought.mini_runner.streaming_model import SecondThoughtModel


class _Delta:
    def __init__(self, reasoning=None, content=None):
        self.reasoning = reasoning
        self.content = content
        self.model_extra = {}


class _Choice:
    def __init__(self, delta, finish=None):
        self.delta = delta
        self.finish_reason = finish


class _Event:
    def __init__(self, choices=(), usage=None):
        self.choices = list(choices)
        self.usage = usage


class _FakeStream:
    def __init__(self, events):
        self._events = events
        self.closed = False

    def __aiter__(self):
        async def gen():
            for e in self._events:
                yield e
        return gen()

    async def close(self):
        self.closed = True


def _model_with(events, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    m = SecondThoughtModel(model_name="deepseek/deepseek-v4-flash")
    stream = _FakeStream(events)

    async def _create(**kwargs):
        return stream

    class _Completions:
        create = staticmethod(_create)

    class _Chat:
        completions = _Completions()

    class _Async:
        chat = _Chat()

    m._async = _Async()
    return m, stream


def test_reasoning_is_captured_on_a_zero_content_turn(monkeypatch):
    """The exact shape that was silently dropped: reasoning, then EOS."""
    events = [
        _Event([_Choice(_Delta(reasoning="thinking "))]),
        _Event([_Choice(_Delta(reasoning="hard"))]),
        _Event([_Choice(_Delta(), finish="length")]),
    ]
    m, stream = _model_with(events, monkeypatch)

    async def run():
        async with m.stream([{"role": "user", "content": "hi"}]) as tokens:
            chunks = [c async for c in tokens]
            buf = tokens.reasoning_buf
        return chunks, "".join(buf)

    chunks, reasoning = asyncio.run(run())
    assert chunks == [], "this turn is supposed to emit no content"
    assert reasoning == "thinking hard", (
        "reasoning was lost on a zero-content turn -- the May defect is back"
    )
    assert stream.closed, "the stream was not closed"


def test_reasoning_and_content_both_captured(monkeypatch):
    events = [
        _Event([_Choice(_Delta(reasoning="plan"))]),
        _Event([_Choice(_Delta(content="```bash\nls\n```"))]),
        _Event([_Choice(_Delta(), finish="stop")]),
    ]
    m, _ = _model_with(events, monkeypatch)

    async def run():
        async with m.stream([{"role": "user", "content": "hi"}]) as tokens:
            chunks = [c async for c in tokens]
            return chunks, "".join(tokens.reasoning_buf)

    chunks, reasoning = asyncio.run(run())
    assert chunks == ["```bash\nls\n```"]
    assert reasoning == "plan"


def test_reasoning_buffer_is_per_call_not_shared(monkeypatch):
    """Concurrent branch streams must not be able to stomp the main turn's
    reasoning -- the per-call buffer is what makes that safe."""
    m, _ = _model_with([_Event([_Choice(_Delta(reasoning="main"))])], monkeypatch)

    async def run():
        async with m.stream([{"role": "user", "content": "a"}]) as t1:
            buf1 = t1.reasoning_buf
            [c async for c in t1]
            # a sibling stream on the SAME model instance resets shared state
            m._async.chat.completions.create = _mk_create(
                [_Event([_Choice(_Delta(reasoning="branch"))])])
            async with m.stream([{"role": "user", "content": "b"}]) as t2:
                [c async for c in t2]
            return "".join(buf1), m.last_reasoning

    def _mk_create(events):
        stream = _FakeStream(events)

        async def _create(**kwargs):
            return stream
        return staticmethod(_create)

    own, shared = asyncio.run(run())
    assert own == "main", "the per-call buffer was overwritten by a sibling stream"
    assert shared == "branch"  # documents that the shared field IS unsafe
