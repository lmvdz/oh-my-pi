from second_thought.action_detector import (
    count_reflect_units,
    detect_first_action,
    reflect_units,
    truncate_at_last_complete_reflect,
)


# --- bash-block detector ---

def test_detects_complete_block():
    s = "let me see\n```bash\nls /tmp\n```\n<reflect>predict: ok.</reflect>"
    m = detect_first_action(s)
    assert m is not None
    assert m.command == "ls /tmp"
    assert s[m.start:m.end] == "```bash\nls /tmp\n```"


def test_returns_none_until_close_fence():
    s = "```bash\nls /tmp"
    assert detect_first_action(s) is None
    s2 = s + "\n```"
    assert detect_first_action(s2) is not None


def test_only_returns_first_block():
    s = "```bash\nfoo\n```\n```bash\nbar\n```"
    m = detect_first_action(s)
    assert m is not None and m.command == "foo"


def test_action_with_multiline_body():
    s = "```bash\ncd /tmp\nls\necho done\n```"
    m = detect_first_action(s)
    assert m is not None
    assert m.command == "cd /tmp\nls\necho done"


# --- reflect-unit helpers ---

def test_count_reflect_basic():
    s = ("<reflect>predict: a.</reflect> "
         "<reflect>expect: b.</reflect> "
         "<reflect>contingency: c.</reflect>")
    assert count_reflect_units(s) == 3


def test_count_reflect_ignores_unclosed():
    s = "<reflect>predict: a.</reflect> <reflect>expect: incomplete..."
    assert count_reflect_units(s) == 1


def test_count_reflect_empty_string():
    assert count_reflect_units("") == 0
    assert count_reflect_units(None or "") == 0


def test_reflect_units_returns_inner_strings():
    s = "<reflect>predict: a.</reflect>\n<reflect>expect: b.</reflect>"
    assert reflect_units(s) == ["predict: a.", "expect: b."]


def test_truncate_keeps_complete_drops_inflight():
    s = ("Hmm <reflect>predict: a.</reflect>\n"
         "<reflect>expect: b.</reflect>\n"
         "<reflect>contingency: ")  # in-flight unit
    out = truncate_at_last_complete_reflect(s)
    # Last complete unit is the expect one. Keep up to and including its </reflect>.
    assert out.endswith("</reflect>")
    assert "<reflect>contingency:" not in out
    assert count_reflect_units(out) == 2


def test_truncate_returns_empty_when_no_complete_unit():
    s = "<reflect>predict: half-done"
    assert truncate_at_last_complete_reflect(s) == ""


def test_truncate_handles_no_unit_at_all():
    s = "no reflect tags here at all"
    assert truncate_at_last_complete_reflect(s) == ""
