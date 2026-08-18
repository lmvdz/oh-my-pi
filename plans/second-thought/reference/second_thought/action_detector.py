"""Streaming action detector + reflect-unit utilities.

The model emits a single fenced bash block per turn. We detect the *first*
complete block in a growing token buffer so the orchestrator can fire the
tool the moment the closing fence arrives, before the model emits any
reflection units.

In `reflect` mode, after the action fires the harness spawns N branch
threads in parallel (one per reflect atom). Each branch streams
`<reflect type="X">...</reflect>` units (where X ∈ {check, rehearse,
recall, alternative} in the current design; some older runs used the
unattributed `<reflect>` form). Helpers here count complete units,
parse typed units, truncate at the last complete unit so an interrupted
tail doesn't contaminate the next turn's context, and round-robin
interleave per-atom unit streams into a single merged block.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Match a markdown bash block. Body is captured non-greedily so the first
# complete block wins. The trailing ``` must sit on its own line (the
# preceding \n is part of the closer) — this matches mini-swe-agent's
# parser and avoids matching backticks that appear inside the command body.
_BASH_BLOCK_RE = re.compile(r"```bash[ \t]*\n(.*?)\n```", re.DOTALL)

_REFLECT_OPEN = "<reflect"
_REFLECT_CLOSE = "</reflect>"
# Accept both `<reflect>...</reflect>` (legacy / untyped) and
# `<reflect type="check">...</reflect>` (current design with atom tag).
_REFLECT_UNIT_RE = re.compile(r"<reflect(?:\s+[^>]*)?>(.*?)</reflect>", re.DOTALL)
# Only typed units: capture (type, body).
_REFLECT_TYPED_RE = re.compile(r"<reflect\s+type=\"([^\"]+)\">(.*?)</reflect>", re.DOTALL)

# --- malformed-closer repair (added 2026-07-28) -------------------------
# Models intermittently terminate a unit with something that is not
# `</reflect>`. Measured over 292,778 opened units in the SWE-Pro corpus:
# 269,166 closed correctly and 5,249 (1.8%) closed with one of 73 other
# tags -- dominated by near-misses of the word ("</refresh>" 2939,
# "</reflection>" 701, "</ref>" 113, "</ref lect>" 61, "</refleect>" 31)
# and by DeepSeek's own special token "</｜｜DSML｜｜>" (793).
# With a non-greedy `.*?` body the affected unit does not simply vanish:
# it MERGES with the following unit, so one unit is lost from the count
# and syntactically unbalanced markup is spliced back into the model's
# context.
#
# Repair rule (deliberately conservative): for each opener, look only as
# far as the next opener. If a genuine `</reflect>` is in that window,
# change nothing -- a real closer always wins, so a body that merely
# quotes markup (`</span>`, `</iframe>`) is never truncated early. Only
# when the unit has NO genuine closer is the first other closing tag in
# the window promoted to `</reflect>`.
_REFLECT_OPEN_RE = re.compile(r"<reflect(?:\s+[^>]*)?>")
_ANY_CLOSER_RE = re.compile(r"</[^<>\n]{1,40}>")


def normalize_reflect_closers(text: str) -> str:
    """Rewrite malformed unit terminators to `</reflect>`.

    Idempotent, and a no-op on well-formed text. An unclosed trailing
    unit stays unclosed, so the streaming "is this unit complete yet"
    criterion is unchanged.
    """
    if not text or _REFLECT_OPEN not in text:
        return text
    out: list[str] = []
    i = 0
    while True:
        m = _REFLECT_OPEN_RE.search(text, i)
        if m is None:
            out.append(text[i:])
            return "".join(out)
        out.append(text[i:m.end()])
        nxt = _REFLECT_OPEN_RE.search(text, m.end())
        stop = nxt.start() if nxt else len(text)
        window = text[m.end():stop]
        if _REFLECT_CLOSE in window:
            i = m.end()  # genuine closer present -> leave the unit alone
            continue
        c = _ANY_CLOSER_RE.search(window)
        if c is None:
            i = m.end()  # in-flight tail / no closer at all
            continue
        out.append(window[:c.start()])
        out.append(_REFLECT_CLOSE)
        i = m.end() + c.end()


@dataclass(frozen=True)
class ActionMatch:
    command: str
    start: int  # inclusive index of the opening ```
    end: int    # exclusive index just past the closing ```


def detect_first_action(buffer: str) -> ActionMatch | None:
    """Return the first complete bash block in `buffer`, or None.

    Safe to call repeatedly as `buffer` grows; the result is stable once a
    complete block has been emitted.
    """
    m = _BASH_BLOCK_RE.search(buffer)
    if m is None:
        return None
    return ActionMatch(command=m.group(1), start=m.start(), end=m.end())


def count_reflect_units(text: str) -> int:
    """Number of complete `<reflect[ ...]>...</reflect>` units in text.

    Counts both typed (`type="..."`) and untyped forms. An unclosed
    `<reflect>` is NOT counted — this is the streaming criterion the
    branch loop uses to decide when to break at the per-turn cap.
    """
    if not text:
        return 0
    return len(_REFLECT_UNIT_RE.findall(normalize_reflect_closers(text)))


def reflect_units(text: str) -> list[str]:
    """Return the inner contents of every complete reflect unit, in order
    (typed or untyped). The inner content is whitespace-stripped."""
    return [
        m.group(1).strip()
        for m in _REFLECT_UNIT_RE.finditer(normalize_reflect_closers(text))
    ]


def parse_reflect_typed_units(text: str) -> list[tuple[str, str]]:
    """Return [(atom_type, body), ...] for every COMPLETE typed unit.

    Untyped `<reflect>...</reflect>` units are ignored by this parser
    (use `reflect_units()` for those). The body is whitespace-stripped.
    """
    return [
        (m.group(1), m.group(2).strip())
        for m in _REFLECT_TYPED_RE.finditer(normalize_reflect_closers(text or ""))
    ]


def truncate_at_last_complete_reflect(text: str) -> str:
    """Truncate `text` to end at the last `</reflect>` it contains.

    Drops any in-flight tail (an open `<reflect ...>partial...` with no
    closing tag) so partial units never leak into the next turn's
    prompt. Returns "" if no complete unit exists.
    """
    if not text:
        return ""
    text = normalize_reflect_closers(text)
    idx = text.rfind(_REFLECT_CLOSE)
    if idx == -1:
        return ""
    return text[: idx + len(_REFLECT_CLOSE)]


def interleave_typed_units_by_atom(
    units_per_atom: dict[str, list[str]],
    atom_order: list[str],
) -> str:
    """Round-robin merge of per-atom unit bodies into a single string of
    typed `<reflect type="X">body</reflect>` lines.

    Iteration order: position-0 of atom_order[0], position-0 of
    atom_order[1], ..., position-1 of atom_order[0], ... Atoms missing a
    unit at position i are skipped at that position. Returns the merged
    string (lines joined by `\n`), or "" if no units.
    """
    if not units_per_atom:
        return ""
    max_len = max((len(units_per_atom.get(a) or []) for a in atom_order), default=0)
    out: list[str] = []
    for i in range(max_len):
        for atom in atom_order:
            units = units_per_atom.get(atom) or []
            if i < len(units):
                body = units[i].strip()
                out.append(f'<reflect type="{atom}">{body}</reflect>')
    return "\n".join(out)
