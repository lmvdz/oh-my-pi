"""LLM streaming client.

We rely on OpenAI's SDK (which OpenRouter is wire-compatible with). The
orchestrator opens a stream as an async context manager and breaks out of
the inner `async for` loop the moment the tool finishes — at that point
the underlying httpx response is closed via `__aexit__`.
"""
from __future__ import annotations

import contextlib
from typing import AsyncIterator, Protocol

from .config import RunConfig


class LLMClient(Protocol):
    model: str

    def stream(
        self, messages: list[dict], **kwargs
    ) -> "contextlib.AbstractAsyncContextManager[AsyncIterator[str]]":
        ...


class OpenRouterClient:
    """OpenAI-SDK-backed client pointed at OpenRouter (or any OAI-compatible
    endpoint). Yields the raw text deltas of the assistant message.

    Reasoning models that emit `reasoning` / `<think>` blocks: this client
    only yields the final-answer text deltas (`choice.delta.content`).
    Reasoning deltas are exposed by some providers as `delta.reasoning` —
    we capture them into `last_reasoning` for inspection but they do not
    enter the action-detection buffer.
    """

    def __init__(self, config: RunConfig):
        # Lazy-import so offline tests can use MockClient without openai.
        from openai import AsyncOpenAI

        if not config.api_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set. Either export it or use a "
                "MockClient (tests/offline use)."
            )
        self._client = AsyncOpenAI(api_key=config.api_key, base_url=config.base_url)
        self.model = config.model
        self._config = config
        self.last_reasoning: str = ""

    @contextlib.asynccontextmanager
    async def stream(self, messages: list[dict], *, count_call: bool = True, **kwargs) -> AsyncIterator[str]:
        """`count_call=False` skips the n_calls increment (used by the
        branch reflection stream so it doesn't consume the agent's step
        budget)."""
        params = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "temperature": self._config.temperature,
            "max_tokens": self._config.max_completion_tokens,
        }
        # Pin provider to deepseek and disable fallbacks so OpenRouter
        # doesn't silently route to a different provider mid-experiment.
        extra_body: dict = {
            "provider": {"order": ["deepseek"], "allow_fallbacks": False},
        }
        if self._config.enable_reasoning:
            extra_body["include_reasoning"] = True
        caller_extra = kwargs.pop("extra_body", None)
        if caller_extra:
            for k, v in caller_extra.items():
                extra_body[k] = v
            if caller_extra.get("reasoning", {}).get("enabled") is False:
                extra_body.pop("include_reasoning", None)
        params["extra_body"] = extra_body
        params.update(kwargs)
        self.last_reasoning = ""
        stream_cm = await self._client.chat.completions.create(**params)
        if count_call:
            self.n_calls = getattr(self, "n_calls", 0) + 1
        try:

            async def gen() -> AsyncIterator[str]:
                async for event in stream_cm:
                    if not event.choices:
                        continue
                    delta = event.choices[0].delta
                    # Some providers expose reasoning as a separate field.
                    reasoning = getattr(delta, "reasoning", None)
                    if reasoning:
                        self.last_reasoning += reasoning
                    text = getattr(delta, "content", None)
                    if text:
                        yield text

            yield gen()
        finally:
            close = getattr(stream_cm, "close", None) or getattr(stream_cm, "aclose", None)
            if close is not None:
                result = close()
                if hasattr(result, "__await__"):
                    await result


class MockClient:
    """Drives the orchestrator with scripted token streams.

    Multi-atom branch design: each turn now fires 1 main call + up to N
    branch calls (one per reflect atom). The mock dispatches as follows:

    - `main_scripts[i]`: chunks for the i-th MAIN-thread call (one per turn).
    - `atom_scripts[atom][i]`: chunks for the i-th BRANCH call of atom
      `atom`. Missing entries default to an empty script.

    Branch calls are recognised by either marker in the `extra_body`
    kwarg passed to `stream()`:
      - `reasoning: {enabled: False}` (OpenRouter unified)
      - `thinking: {type: "disabled"}` (Anthropic-native, kept as legacy)
    The specific atom is inferred from the LAST user message's content,
    matched against each atom's `marker` substring (defined in
    `prompts.REFLECT_ATOMS`).

    Optionally sleep between chunks to exercise the async tool/branch
    race.
    """

    def __init__(
        self,
        scripts: list[list[str]],
        chunk_delay: float = 0.0,
        model: str = "mock",
        atom_scripts: dict[str, list[list[str]]] | None = None,
        branch_scripts: list[list[str]] | None = None,  # backwards-compat
    ):
        from .prompts import REFLECT_ATOMS  # local import to avoid cycle

        self._main_scripts = scripts
        # New: per-atom scripts. Backwards-compat: if `branch_scripts` is
        # given (old single-branch tests), apply it to every atom.
        self._atom_scripts: dict[str, list[list[str]]] = {}
        if atom_scripts:
            self._atom_scripts = {a: list(v) for a, v in atom_scripts.items()}
        elif branch_scripts is not None:
            for atom in REFLECT_ATOMS:
                self._atom_scripts[atom] = list(branch_scripts)
        for atom in REFLECT_ATOMS:
            self._atom_scripts.setdefault(atom, [[] for _ in scripts])
        self._chunk_delay = chunk_delay
        self._main_idx = 0
        self._atom_idx: dict[str, int] = {atom: 0 for atom in REFLECT_ATOMS}
        self.model = model
        self.last_reasoning = ""
        self._atom_markers = {a: info["marker"] for a, info in REFLECT_ATOMS.items()}

    @staticmethod
    def _is_branch_call(kwargs: dict) -> bool:
        eb = kwargs.get("extra_body") or {}
        if eb.get("reasoning", {}).get("enabled") is False:
            return True
        if eb.get("thinking", {}).get("type") == "disabled":
            return True
        return False

    def _detect_atom(self, messages: list[dict]) -> str | None:
        if not messages:
            return None
        last = messages[-1]
        if last.get("role") != "user":
            return None
        content = last.get("content") or ""
        for atom, marker in self._atom_markers.items():
            if marker and marker in content:
                return atom
        return None

    @contextlib.asynccontextmanager
    async def stream(self, messages: list[dict], **kwargs) -> AsyncIterator[str]:
        import asyncio

        if self._is_branch_call(kwargs):
            atom = self._detect_atom(messages)
            if atom is None:
                raise RuntimeError(
                    "MockClient: branch call but could not detect atom from "
                    "last user message (markers not found)"
                )
            scripts = self._atom_scripts[atom]
            idx = self._atom_idx[atom]
            self._atom_idx[atom] += 1
            label = f"branch[{atom}]"
        else:
            scripts = self._main_scripts
            idx = self._main_idx
            self._main_idx += 1
            label = "main"

        if idx >= len(scripts):
            raise RuntimeError(
                f"MockClient exhausted ({label}): {idx} streams requested but "
                f"only {len(scripts)} scripts provided"
            )
        script = scripts[idx]
        self.last_reasoning = ""

        async def gen() -> AsyncIterator[str]:
            for chunk in script:
                if self._chunk_delay:
                    await asyncio.sleep(self._chunk_delay)
                yield chunk

        try:
            yield gen()
        finally:
            pass
