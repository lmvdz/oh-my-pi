"""Real per-model token counting (RULE 0: never report chars//4 as tokens).

The in-loop bookkeeping in `streaming_agent.py` deliberately uses a cheap
`chars//4` proxy: it runs on the critical path (`ctx_before` is computed
before the main call fires) and the paper's headline numbers are wall-clock
sensitive, so a real tokenizer pass per turn would both cost latency and
contaminate the very measurement it feeds.

This module is for the OTHER side of that trade: counting *after* a run
finishes (or offline over a saved trajectory), where the true per-model
tokenizer is affordable. Same tokenizer repos as the offline sidecar
re-tokenizer, so in-run and offline numbers agree.

Usage:
    tc = get_token_counter("deepseek/deepseek-v4-flash")
    n = tc("some text")
    tc.method  # "tokenizer:deepseek-ai/DeepSeek-V3.2-Exp" or "chars4"

If `transformers` is missing, the repo can't be resolved, or the download
fails, the counter degrades to the chars//4 proxy and says so in `.method`
— callers are expected to record that string next to the numbers so an
estimate is never mistaken for a real count.
"""
from __future__ import annotations

import logging
import os
import re

logger = logging.getLogger(__name__)

# model-name fragment -> HF tokenizer repo. Matched case-insensitively as a
# substring of the model name, longest fragment first.
TOKENIZER_REPOS: dict[str, str] = {
    "deepseek": "deepseek-ai/DeepSeek-V3.2-Exp",
    "qwen": "Qwen/Qwen3-235B-A22B",
    "minimax": "MiniMaxAI/MiniMax-M2",
}

CHARS_PER_TOKEN_FALLBACK = 4


def resolve_tokenizer_repo(model_name: str | None) -> str | None:
    """HF repo whose tokenizer to use for `model_name`, or None if unknown.

    `SECOND_THOUGHT_TOKENIZER_REPO` overrides everything (single-model runs);
    `SECOND_THOUGHT_TOKENIZER_MAP="frag=repo,frag=repo"` extends the table.
    """
    override = os.environ.get("SECOND_THOUGHT_TOKENIZER_REPO")
    if override:
        return override

    table = dict(TOKENIZER_REPOS)
    extra = os.environ.get("SECOND_THOUGHT_TOKENIZER_MAP", "")
    for item in extra.split(","):
        if "=" in item:
            frag, repo = item.split("=", 1)
            if frag.strip() and repo.strip():
                table[frag.strip().lower()] = repo.strip()

    name = (model_name or "").lower()
    for frag in sorted(table, key=len, reverse=True):
        if frag in name:
            return table[frag]
    return None


class TokenCounter:
    """Callable text -> token count, with a declared `method`.

    Loading is lazy (first call) so constructing a counter is free, and the
    loaded tokenizer is cached per repo across counters.
    """

    _CACHE: dict[str, object] = {}

    def __init__(self, model_name: str | None):
        self.model_name = model_name
        self.repo = resolve_tokenizer_repo(model_name)
        self._tok: object | None = None
        self._loaded = False
        self._fallback_reason: str | None = None if self.repo else "no tokenizer repo for model"

    @property
    def method(self) -> str:
        """What the numbers actually are — record this next to them."""
        self._load()
        if self._tok is not None:
            return f"tokenizer:{self.repo}"
        return "chars4"

    @property
    def fallback_reason(self) -> str | None:
        self._load()
        return self._fallback_reason

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if not self.repo:
            return
        cached = TokenCounter._CACHE.get(self.repo)
        if cached is not None:
            self._tok = cached
            return
        try:
            os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
            from transformers import AutoTokenizer  # noqa: PLC0415

            tok = AutoTokenizer.from_pretrained(self.repo, trust_remote_code=True)
            # Whole conversations exceed model_max_length; we only want the
            # count, not a usable input, so silence the length warning.
            tok.model_max_length = 10**9
            TokenCounter._CACHE[self.repo] = tok
            self._tok = tok
        except Exception as e:  # pragma: no cover - environment dependent
            self._fallback_reason = f"{type(e).__name__}: {e}"
            logger.warning(
                "tokenizer %s unavailable (%s); falling back to chars//%d",
                self.repo, e, CHARS_PER_TOKEN_FALLBACK,
            )

    def __call__(self, text: str | None) -> int:
        if not text:
            return 0
        self._load()
        if self._tok is None:
            return max(0, len(text) // CHARS_PER_TOKEN_FALLBACK)
        return len(self._tok(text, add_special_tokens=False)["input_ids"])


_COUNTERS: dict[str, TokenCounter] = {}


def get_token_counter(model_name: str | None) -> TokenCounter:
    """Cached TokenCounter for `model_name`."""
    key = model_name or ""
    if key not in _COUNTERS:
        _COUNTERS[key] = TokenCounter(model_name)
    return _COUNTERS[key]


def recount_context_lengths(messages, turn_records, counter: TokenCounter) -> int:
    """Recount per-turn context sizes from the final message list.

    The in-loop `context_token_len_before/after` are the chars//4 proxy. The
    conversation is append-only, so the context a turn actually saw is the
    token prefix up to its assistant message: walk the messages once,
    rewrite both fields on each record in order, and return the summed
    main-thread input (same semantics as summing `context_token_len_before`).
    """
    total_input = 0
    prefix = 0
    records = list(turn_records)
    next_idx = 0
    pending = None  # record whose closing (post-observation) count is due
    for m in messages or []:
        is_assistant = m.get("role") == "assistant"
        if is_assistant and next_idx < len(records):
            if pending is not None:
                pending.context_token_len_after = prefix
            pending = records[next_idx]
            next_idx += 1
            pending.context_token_len_before = prefix
            total_input += prefix
        prefix += counter(m.get("content"))
        if pending is not None and not is_assistant:
            pending.context_token_len_after = prefix
            pending = None
    if pending is not None:
        pending.context_token_len_after = prefix
    return total_input


_BASH_BLOCK = re.compile(r"```.*?```", re.DOTALL)
_THOUGHT_PREFIX = re.compile(r"^\s*THOUGHT:\s*", re.I)


def split_thought_action(content: str | None) -> tuple[str, str]:
    """Split a mini-swe-agent assistant message into (prose, bash blocks).

    Mirrors the offline sidecar re-tokenizer's split so the reasoning /
    action breakdown is computed the same way in both places.
    """
    if not content:
        return "", ""
    return _THOUGHT_PREFIX.sub("", _BASH_BLOCK.sub("", content)), "".join(
        _BASH_BLOCK.findall(content)
    )
