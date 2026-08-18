"""Real-tokenizer accounting (RULE 0) — resolution, fallback, and recount."""
from dataclasses import dataclass

import pytest

from second_thought.token_count import (
    TokenCounter,
    get_token_counter,
    recount_context_lengths,
    resolve_tokenizer_repo,
    split_thought_action,
)


@dataclass
class _Rec:
    context_token_len_before: int = 0
    context_token_len_after: int = 0


class _WordCounter:
    """Stand-in tokenizer: 1 token per whitespace-separated word."""

    method = "tokenizer:test"

    def __call__(self, text):
        return len((text or "").split())


def test_repo_resolution_by_model_family():
    assert resolve_tokenizer_repo("deepseek/deepseek-v4-flash").startswith("deepseek-ai/")
    assert resolve_tokenizer_repo("openrouter/qwen/qwen3.6-plus").startswith("Qwen/")
    assert resolve_tokenizer_repo("minimax/minimax-m3").startswith("MiniMaxAI/")
    assert resolve_tokenizer_repo("acme/unknown-1") is None
    assert resolve_tokenizer_repo(None) is None


def test_env_override_and_map(monkeypatch):
    monkeypatch.setenv("SECOND_THOUGHT_TOKENIZER_REPO", "some/repo")
    assert resolve_tokenizer_repo("acme/unknown-1") == "some/repo"
    monkeypatch.delenv("SECOND_THOUGHT_TOKENIZER_REPO")
    monkeypatch.setenv("SECOND_THOUGHT_TOKENIZER_MAP", "acme=acme/tok")
    assert resolve_tokenizer_repo("acme/unknown-1") == "acme/tok"


def test_unknown_model_falls_back_and_says_so():
    tc = TokenCounter("acme/unknown-1")
    assert tc.method == "chars4"          # never silently passed off as real
    assert tc("abcdefgh") == 2            # chars//4
    assert tc(None) == 0 and tc("") == 0


def test_counter_is_cached_per_model():
    assert get_token_counter("acme/unknown-1") is get_token_counter("acme/unknown-1")


def test_recount_walks_append_only_conversation():
    msgs = [
        {"role": "system", "content": "a b"},          # 2
        {"role": "user", "content": "c d e"},          # 3
        {"role": "assistant", "content": "f g"},       # 2
        {"role": "user", "content": "h"},              # 1
        {"role": "assistant", "content": "i j k"},     # 3
        {"role": "user", "content": "l m"},            # 2
    ]
    recs = [_Rec(), _Rec()]
    total = recount_context_lengths(msgs, recs, _WordCounter())

    assert recs[0].context_token_len_before == 5    # system + first user
    assert recs[0].context_token_len_after == 8     # + assistant + observation
    assert recs[1].context_token_len_before == 8
    assert recs[1].context_token_len_after == 13
    assert total == 5 + 8


def test_recount_tolerates_truncated_records_and_dangling_turn():
    msgs = [
        {"role": "user", "content": "a b"},
        {"role": "assistant", "content": "c"},        # turn cut off mid-run:
    ]                                                 # no observation follows
    recs = [_Rec()]
    total = recount_context_lengths(msgs, recs, _WordCounter())
    assert (recs[0].context_token_len_before, recs[0].context_token_len_after) == (2, 3)
    assert total == 2

    # More assistant messages than records -> extra ones are ignored.
    msgs2 = msgs + [{"role": "user", "content": "d"}, {"role": "assistant", "content": "e"}]
    recs2 = [_Rec()]
    assert recount_context_lengths(msgs2, recs2, _WordCounter()) == 2


def test_split_thought_action():
    prose, action = split_thought_action("THOUGHT: look around\n```bash\nls -la\n```")
    assert "look around" in prose and "ls -la" not in prose
    assert action == "```bash\nls -la\n```"
    assert split_thought_action(None) == ("", "")


@pytest.mark.skipif(
    TokenCounter("deepseek/deepseek-v4-flash").method == "chars4",
    reason="HF tokenizer not available offline",
)
def test_real_tokenizer_differs_from_chars4():
    tc = get_token_counter("deepseek/deepseek-v4-flash")
    text = "THOUGHT: I will list the files.\n\n```bash\nls -la\n```"
    assert tc.method.startswith("tokenizer:")
    assert tc(text) > 0
    assert tc(text) != len(text) // 4     # the whole point of RULE 0
