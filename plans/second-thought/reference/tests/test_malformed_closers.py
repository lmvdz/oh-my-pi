"""Regression tests for the malformed-unit-closer repair (2026-07-28).

Models intermittently terminate a reflect unit with something other than
`</reflect>` -- measured over 292,778 opened units in the SWE-Pro corpus:
5,249 (1.8%) closed with one of 73 other tags, dominated by near-misses
("</refresh>", "</reflection>", "</ref>") and by DeepSeek's own special
token "</｜｜DSML｜｜>". With a non-greedy body the affected unit merged with
the following one, so a unit was lost from every count and unbalanced
markup was spliced back into the model's context.
"""
from second_thought.action_detector import (
    count_reflect_units,
    normalize_reflect_closers,
    parse_reflect_typed_units,
    truncate_at_last_complete_reflect,
)


def test_wellformed_text_is_untouched():
    s = '<reflect type="check">a</reflect><reflect type="recall">b</reflect>'
    assert normalize_reflect_closers(s) == s
    assert count_reflect_units(s) == 2


def test_malformed_closer_no_longer_swallows_the_next_unit():
    s = ('<reflect type="check">a</refresh>'
         '<reflect type="recall">b</reflect>')
    # Before the fix the non-greedy body ran from the first opener to the
    # only real closer, merging both units into one.
    assert count_reflect_units(s) == 2
    assert parse_reflect_typed_units(s) == [("check", "a"), ("recall", "b")]


def test_deepseek_special_token_closer():
    s = '<reflect type="alternative">x</｜｜DSML｜｜>\n<reflect type="check">y</reflect>'
    assert [t for t, _ in parse_reflect_typed_units(s)] == ["alternative", "check"]


def test_genuine_closer_wins_over_quoted_markup():
    # A body that merely quotes markup must NOT be truncated at that markup.
    s = '<reflect type="check">the template emits </span> here</reflect>'
    units = parse_reflect_typed_units(s)
    assert units == [("check", "the template emits </span> here")]


def test_unclosed_tail_stays_incomplete():
    # The streaming criterion must be unchanged: an in-flight unit does not
    # count, and truncation still drops it.
    s = '<reflect type="check">done</reflect><reflect type="recall">in flig'
    assert count_reflect_units(s) == 1
    assert truncate_at_last_complete_reflect(s) == '<reflect type="check">done</reflect>'


def test_truncate_keeps_repaired_unit_and_balances_markup():
    s = '<reflect type="check">a</refresh> trailing junk'
    kept = truncate_at_last_complete_reflect(s)
    assert kept == '<reflect type="check">a</reflect>'
    assert "</refresh>" not in kept


def test_normalization_is_idempotent():
    s = '<reflect type="check">a</reflection><reflect type="recall">b</ref>'
    once = normalize_reflect_closers(s)
    assert normalize_reflect_closers(once) == once
    assert count_reflect_units(once) == 2


def test_no_closer_before_next_opener_leaves_unit_open():
    s = '<reflect type="check">a<reflect type="recall">b</reflect>'
    # The first unit never closed; only the second is complete.
    assert count_reflect_units(s) == 1
