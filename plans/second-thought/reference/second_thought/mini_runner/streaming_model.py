"""LLM model that satisfies mini-swe-agent's Model protocol AND streams.

mini-swe-agent's `DefaultAgent` calls `model.query(messages) -> dict`
synchronously. Our ReflectAgent additionally calls
`model.stream(messages)` (async context manager yielding token chunks)
for the streaming path needed by the reflect/s1extend modes.

Reasoning content (DeepSeek V4 Pro and similar) is streamed via
OpenRouter's `include_reasoning` flag and stashed in `last_reasoning`
so the agent can record it per-turn.
"""
from __future__ import annotations

import contextlib
import logging
import os
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

logger = logging.getLogger(__name__)


@dataclass
class SecondThoughtModelConfig:
    model_name: str = "deepseek/deepseek-v4-pro"
    base_url: str = field(
        default_factory=lambda: os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    )
    api_key: str | None = field(default_factory=lambda: os.getenv("OPENROUTER_API_KEY"))
    temperature: float = 0.2
    max_tokens: int = 4096
    enable_reasoning: bool = True
    # forwarded extras (e.g. provider-specific params)
    model_kwargs: dict[str, Any] = field(default_factory=dict)


class SecondThoughtModel:
    """OpenAI-SDK-backed model targeting OpenRouter. Conforms to
    mini-swe-agent's Model protocol (sync `query`) and adds a streaming
    `stream()` async context manager."""

    def __init__(self, *, config_class: type = SecondThoughtModelConfig, **kwargs):
        from openai import AsyncOpenAI, OpenAI

        self.config = config_class(**kwargs)
        if not self.config.api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not set")
        self._sync = OpenAI(api_key=self.config.api_key, base_url=self.config.base_url)
        self._async = AsyncOpenAI(api_key=self.config.api_key, base_url=self.config.base_url)
        self.cost = 0.0
        self.n_calls = 0
        self.last_reasoning: str = ""

    @property
    def model_name(self) -> str:
        return self.config.model_name

    def get_template_vars(self) -> dict[str, Any]:
        return {"model_name": self.config.model_name}

    def _is_xiaomi_mimo(self) -> bool:
        """Xiaomi mimo models use Anthropic-style `thinking: {type: enabled/disabled}`
        instead of OpenRouter unified `reasoning: {enabled: bool}`."""
        return self.config.model_name.startswith("mimo-")

    def _translate_reasoning_to_thinking(self, eb: dict) -> dict:
        """Translate `reasoning.{enabled/effort}` → `thinking.{type/budget_tokens}`
        when the model is xiaomi mimo. Drops include_reasoning (mimo separate channel)."""
        if not self._is_xiaomi_mimo():
            return eb
        r = eb.pop("reasoning", None)
        eb.pop("include_reasoning", None)
        if r is None:
            return eb
        if r.get("enabled") is False or r.get("effort") in ("low", "minimal"):
            eb["thinking"] = {"type": "disabled"}
        else:
            eb["thinking"] = {"type": "enabled"}
        return eb

    def _request_params(self, messages: list[dict], **kwargs) -> dict:
        params = {
            "model": self.config.model_name,
            "messages": [self._normalize_msg(m) for m in messages],
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
        }
        # Build extra_body. For DeepSeek models, pin the provider so
        # OpenRouter routes consistently (shared prefix cache). For
        # other providers (e.g. tencent/hy3-preview), let OpenRouter
        # default-route — provider pinning by literal name is not
        # universally available.
        extra_body: dict = {}
        if self.config.model_name.startswith("deepseek/"):
            extra_body["provider"] = {
                "order": ["deepseek"], "allow_fallbacks": False,
            }
        elif self.config.model_name.startswith("minimax/"):
            # Pin the OFFICIAL MiniMax endpoint (minimax/fp8). Other OpenRouter
            # providers for minimax-m3 did NOT return reasoning text, badly
            # under-counting reasoning on SWE-Pro/TB2 (confirmed 2026-06-15:
            # only 3.5-9.9%% of turns had reasoning vs ~100%% on the pinned path).
            extra_body["provider"] = {
                "order": ["minimax/fp8"], "allow_fallbacks": False,
            }
        if self.config.enable_reasoning:
            extra_body["include_reasoning"] = True
        caller_extra = kwargs.pop("extra_body", None)
        if caller_extra:
            for k, v in caller_extra.items():
                extra_body[k] = v
            # If the caller disabled reasoning (branch path), don't also
            # ask for reasoning content.
            if caller_extra.get("reasoning", {}).get("enabled") is False:
                extra_body.pop("include_reasoning", None)
        # Xiaomi mimo translation (reasoning → thinking)
        extra_body = self._translate_reasoning_to_thinking(extra_body)
        params["extra_body"] = extra_body
        params.update(self.config.model_kwargs)
        params.update(kwargs)
        return params

    def _normalize_msg(self, m: dict) -> dict:
        # mini-swe-agent attaches our private extras (timestamp, reasoning,
        # cost, etc.). Strip back to the OpenAI-API shape before sending.
        out = {"role": m["role"], "content": m.get("content", "") or ""}
        # minimax interleaved-thinking contract: the model largely STOPS
        # emitting reasoning when prior assistant turns in history carry no
        # reasoning (probe 2026-07-15: multi-turn reasoning_len=0 without
        # pass-back vs restored with reasoning_details pass-back). Pass the
        # recorded reasoning back as an OpenRouter reasoning_details block.
        # Gated to minimax only — applied identically in ALL modes (baseline,
        # reflect, s1extend), so arms stay comparable.
        if (
            self.config.model_name.startswith("minimax/")
            and m["role"] == "assistant"
            and m.get("reasoning")
        ):
            out["reasoning_details"] = [{
                "type": "reasoning.text",
                "text": m["reasoning"],
                "format": "unknown",
                "index": 0,
            }]
        return out

    # ---- sync path (mini-swe-agent Model.query) -------------------------

    def query(self, messages: list[dict], **kwargs) -> dict:
        """Non-streaming query for cases where streaming isn't needed
        (e.g. format-error retries, or simple tests). The reflect/s1extend
        modes use `stream()` instead."""
        self.last_reasoning = ""
        params = self._request_params(messages, stream=False, **kwargs)
        resp = self._sync.chat.completions.create(**params)
        self.n_calls += 1
        choice = resp.choices[0]
        content = choice.message.content or ""
        reasoning = getattr(choice.message, "reasoning", None) or ""
        if reasoning:
            self.last_reasoning = reasoning
        # Cost tracking: OpenRouter returns usage; we don't have the cost
        # table for arbitrary providers, so we just track call count.
        return {"role": "assistant", "content": content, "reasoning": reasoning}

    # ---- DeepSeek prefix-continuation path (for s1-style Wait injection) ---

    async def acall_prefix(
        self,
        messages: list[dict],
        prefix_text: str,
        *,
        max_tokens: int = 300,
        stop: list[str] | None = None,
        enable_reasoning: bool = False,
        count_call: bool = True,
        **kwargs,
    ) -> dict:
        """Continue generation from a prefilled assistant message.

        Uses DeepSeek's ``prefix=True`` on the last assistant message.
        We empirically observed (s1extend probe) that:
          - When ``prefix_text`` starts with an UNCLOSED ``<think>...``
            envelope, DeepSeek routes the continuation into the
            ``reasoning_content`` channel (= we can extend the model's
            thinking).
          - When ``prefix_text`` contains ``</think>`` closing the
            envelope, the continuation goes to the regular ``content``
            channel (= we get the action commit).
        s1extend uses both: Phase 2 leaves ``<think>`` unclosed to
        accumulate forced "Wait" reasoning, then Phase 3 closes
        ``</think>`` to let the model commit.

        Caching note: provider is pinned to ``deepseek`` with
        ``allow_fallbacks=False``; each call's prefix grows
        monotonically so DeepSeek's context cache reuses prior tokens.

        Returns dict with ``content``, ``reasoning``, ``finish``.
        """
        base_params = self._request_params(messages, stream=False, **kwargs)
        base_params["messages"] = list(base_params["messages"]) + [
            {"role": "assistant", "content": prefix_text, "prefix": True}
        ]
        base_params["max_tokens"] = max_tokens
        if stop:
            base_params["stop"] = stop
        eb = dict(base_params.get("extra_body", {}))
        eb["reasoning"] = {"enabled": enable_reasoning}
        if not enable_reasoning:
            eb.pop("include_reasoning", None)
        # Provider pinning only for DeepSeek (see _request_params).
        if self.config.model_name.startswith("deepseek/"):
            eb.setdefault(
                "provider",
                {"order": ["deepseek"], "allow_fallbacks": False},
            )
        # Xiaomi mimo translation (reasoning → thinking)
        eb = self._translate_reasoning_to_thinking(eb)
        base_params["extra_body"] = eb
        resp = await self._async.chat.completions.create(**base_params)
        if count_call:
            self.n_calls += 1
        msg = resp.choices[0].message
        return {
            "content": msg.content or "",
            "reasoning": (
                getattr(msg, "reasoning", None)
                or getattr(msg, "reasoning_content", None)
                or ""
            ),
            "finish": resp.choices[0].finish_reason,
        }

    # ---- async streaming path ------------------------------------------

    @contextlib.asynccontextmanager
    async def stream(self, messages: list[dict], *, count_call: bool = True, **kwargs) -> AsyncIterator[str]:
        """Yield assistant content deltas. Reasoning deltas are accumulated
        per-call (attached to the yielded generator as ``.reasoning_buf``)
        AND mirrored to ``self.last_reasoning`` for backward compatibility.

        IMPORTANT: ``self.last_reasoning`` / ``self.last_usage`` /
        ``self.last_stream_chunks`` are SHARED model-instance state — when
        multiple concurrent stream() calls happen on the same model (e.g.
        branches running in parallel with main thread), they will overwrite
        each other. **Callers tracking reasoning across yields MUST use the
        per-call ``tokens.reasoning_buf`` instead of ``model.last_reasoning``**
        to avoid being stomped by a sibling stream's reset.

        ``count_call=False`` is used by the branch (reflection) stream so it
        does NOT consume the agent's step budget. The branch is a side
        process; only main-thread calls count toward step_limit."""
        self.last_reasoning = ""
        # Per-call reasoning buffer attached to the yielded generator so
        # the caller can track WITHOUT racing other concurrent streams on
        # the same model instance (critical for multi-fire reflect where
        # branches reset self.last_reasoning whenever they fire).
        per_call_reasoning_buf: list[str] = []
        # Raw stream archive: compact list of {r, c, fin, usage} dicts, one
        # entry per non-empty API delta. Stored as a side-effect so the
        # caller can copy it into the turn record AFTER stream ends.
        # Defensive against future capture-logic bugs (e.g. the 2026-05-23
        # reflect-mode early-capture issue).
        self.last_stream_chunks: list[dict] = []
        self.last_usage: dict | None = None
        per_call_stream_chunks: list[dict] = []  # per-call mirror, safe from siblings
        per_call_usage: dict | None = None
        params = self._request_params(messages, stream=True, **kwargs)
        # Request token usage in final stream chunk (OpenAI standard).
        # Most providers honor this; if not, last_usage stays None.
        if "stream_options" not in params:
            params["stream_options"] = {"include_usage": True}
        stream_obj = await self._async.chat.completions.create(**params)
        if count_call:
            self.n_calls += 1
        try:

            async def gen() -> AsyncIterator[str]:
                nonlocal per_call_usage
                async for event in stream_obj:
                    # Usage chunk (no choices, has usage field). Capture
                    # ground-truth token counts.
                    if not event.choices:
                        usage = getattr(event, "usage", None)
                        if usage is not None:
                            try:
                                dumped = (
                                    usage.model_dump()
                                    if hasattr(usage, "model_dump")
                                    else dict(usage)
                                )
                                self.last_usage = dumped
                                per_call_usage = dumped
                                self.last_stream_chunks.append({"usage": dumped})
                                per_call_stream_chunks.append({"usage": dumped})
                            except Exception:
                                pass
                        continue
                    delta = event.choices[0].delta
                    # Reasoning channel field name varies by provider:
                    #   OpenRouter unified / DeepSeek: delta.reasoning
                    #   Xiaomi mimo / some others: delta.reasoning_content
                    #     (or only accessible via pydantic model_extra)
                    reasoning = (
                        getattr(delta, "reasoning", None)
                        or getattr(delta, "reasoning_content", None)
                    )
                    if reasoning is None:
                        extra = getattr(delta, "model_extra", None) or {}
                        reasoning = extra.get("reasoning_content") or extra.get("reasoning")
                    text = getattr(delta, "content", None)
                    finish = event.choices[0].finish_reason
                    # Archive compact delta. Skip empty deltas to keep the
                    # list small (~100-500 entries per call typical).
                    if reasoning or text or finish:
                        rec: dict = {}
                        if reasoning: rec["r"] = reasoning
                        if text: rec["c"] = text
                        if finish: rec["fin"] = finish
                        self.last_stream_chunks.append(rec)
                        per_call_stream_chunks.append(rec)
                    if reasoning:
                        self.last_reasoning += reasoning      # legacy, may be stomped
                        per_call_reasoning_buf.append(reasoning)  # SAFE: per-call only
                    if text:
                        yield text

            class _StreamHandle:
                """Wrapper that exposes the async generator AND per-call
                buffers via attribute access. Used because async generator
                objects don't allow arbitrary attribute assignment."""
                __slots__ = ("_g", "reasoning_buf", "stream_chunks", "_get_usage")
                def __init__(self, g, rbuf, chunks, get_usage):
                    self._g = g
                    self.reasoning_buf = rbuf
                    self.stream_chunks = chunks
                    self._get_usage = get_usage
                def __aiter__(self):
                    return self._g.__aiter__()
                def get_usage(self):
                    return self._get_usage()
            yield _StreamHandle(
                gen(),
                per_call_reasoning_buf,
                per_call_stream_chunks,
                lambda: per_call_usage,
            )
        finally:
            close = getattr(stream_obj, "close", None) or getattr(stream_obj, "aclose", None)
            if close is not None:
                result = close()
                if hasattr(result, "__await__"):
                    await result
