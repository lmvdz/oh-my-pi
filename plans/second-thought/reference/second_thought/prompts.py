"""System prompts and branch atom prompts for Second Thought.

Branch mechanism (current design — "continuation prompting"):

- The MAIN thread runs the agent loop using mini-swe-agent's stock system /
  instance templates (unchanged). At the instant the main thread's reasoning
  phase ends (first content delta), the harness FORKS N branch threads in
  parallel, one per requested atom (default: all 4 — check, rehearse,
  recall, alternative).

- Each branch is an LLM call against the same model whose input is the
  EXACT main conversation snapshot at the fork instant, with two extra
  messages appended:

    1. {role: "assistant", content: <just-completed reasoning text>}
    2. {role: "user",      content: <atom-specific continuation prompt>}

  i.e. the branch continues the main thread's own conversation — it sees
  itself as the agent that just reasoned and is now being asked one
  reflective question. This is intentionally NOT a fresh role-played
  reflection process. Three motivations:

    (a) The 4 branches share the same prefix, so OpenRouter implicit
        caching can serve them at fraction of the prompt cost.
    (b) The model stays in its original "agent" role; no role switch.
    (c) The continuation framing exploits the model's recent reasoning
        memory; reflection is more grounded.

- Branch thinking is disabled (extra_body.reasoning.enabled=False) so
  the branch goes straight to content emission — its whole window is
  spent producing structured reflect units.

- When the tool finishes, the branches are cancelled. Each branch's
  accumulated text is truncated at the last </reflect>, the surviving
  units are parsed by type, and the 4 streams are interleaved in
  round-robin order before being spliced into the assistant message
  after the action.

The four atoms (intentionally renamed from the earlier
predict/expect/contingency/retrospect set):

  check        — Audit your own reasoning for assumptions the upcoming
                 observation could disprove. Phrased as questions or
                 flagged assumptions, NOT corrections.
  rehearse     — Conditional plans: "If X happens, do Y." Pre-stage
                 reactions to outcomes the tool might return.
  recall       — Surface earlier trajectory items (files, errors,
                 constraints) that are relevant now but weren't used
                 in the recent reasoning.
  alternative  — Name approaches NOT taken that could reach the same
                 goal, with a brief indication of when each would be
                 preferable. Purely exploratory.
"""
from __future__ import annotations

from .config import RunConfig

# Mini-swe-agent's own system_template + instance_template are loaded
# from its default.yaml on the SWE-bench Pro path. The BASE_SYSTEM_PROMPT
# below is only used by the legacy toy-task `Orchestrator` path.
BASE_SYSTEM_PROMPT = """\
You are an autonomous software engineering agent. You are given a problem
statement and a sandboxed bash environment. Solve the task step by step.

OUTPUT FORMAT — every assistant turn MUST follow this exact shape:

  <reasoning paragraph: 2-5 sentences>

  ```bash
  <one shell command>
  ```

That is: first reason briefly about what you will do and why, then emit
exactly one fenced bash block. Never skip the reasoning. Never emit more
than one bash block per turn. The harness executes the block and
returns its stdout/stderr as the next user message.

When you are confident the task is solved, submit by running:
  ```bash
  {sentinel}
  ```

HARD RULES
- Never ask the user clarifying questions; act on your best interpretation.
- Never invent shell output. Wait for the real observation.
- Keep commands non-interactive (no editors, no pagers).
- One bash block per turn. After the closing ``` of the bash block, the
  turn is over.
"""


# Atom prompts: each is a "continuation" user message. The branch input is
# the main conversation snapshot + an assistant message containing the
# reasoning text + ONE of these user messages. The model continues its
# own role and answers a focused reflective question.
#
# `marker`: a short substring unique to this prompt; used by the offline
# MockClient to identify which atom is being requested without depending
# on a side-channel kwarg.
REFLECT_ATOMS: dict[str, dict[str, str]] = {
    "check": {
        "description": "Audit reasoning for assumptions the upcoming result could disprove.",
        "marker": "audit your own reasoning",
        "prompt": """\
Your reasoning above identifies the next step well. Before the tool
returns, briefly audit your own reasoning for assumptions that could be
disproved by the upcoming result.

Output requirements:
- Format: <reflect type="check">...</reflect>
- Each unit ≤ 25 words, complete sentence, self-contained
- Phrase as questions or flagged assumptions, NOT corrections
- Each unit names ONE specific assumption from your reasoning
- Generate multiple units, one assumption per unit, until interrupted

Forbidden:
- Do NOT restate or summarize your reasoning
- Do NOT claim what the tool will return
- Do NOT say your reasoning was wrong (no correction)

Examples of good check units:
<reflect type="check">Did I assume pytest? If unittest, the test invocation syntax differs.</reflect>
<reflect type="check">My plan assumed imports resolve from project root; may fail in monorepo.</reflect>
<reflect type="check">Implicit assumption: file uses UTF-8 encoding; may break on legacy encodings.</reflect>

Begin emitting check units now.""",
    },
    "rehearse": {
        "description": "Conditional plans for possible outcomes (If X, then Y).",
        "marker": "rehearse possible outcomes",
        "prompt": """\
Your reasoning above sets up the next action. Before the result arrives,
rehearse possible outcomes and pre-stage your response to each.

Output requirements:
- Format: <reflect type="rehearse">...</reflect>
- Each unit ≤ 25 words, structured as "If [outcome], [next step]."
- Cover positive, negative, and surprising cases across multiple units
- Generate as many as possible until interrupted

Forbidden:
- Do NOT make standalone predictions without follow-up
- Do NOT say what the tool WILL return; only conditional "if X, then Y"
- Do NOT restate your plan

Examples of good rehearse units:
<reflect type="rehearse">If grep returns nothing, fallback is searching by symbol name in adjacent modules.</reflect>
<reflect type="rehearse">If the file is empty, that suggests the bug is elsewhere; widen the search.</reflect>
<reflect type="rehearse">If output is paginated, append --no-pager and re-run before continuing analysis.</reflect>

Begin emitting rehearse units now.""",
    },
    "recall": {
        "description": "Surface earlier trajectory items relevant now but not used recently.",
        "marker": "recall earlier trajectory",
        "prompt": """\
Your reasoning above focuses on the immediate next step. Before the
result arrives, recall earlier trajectory details that may matter now
but were not explicitly used in your recent reasoning.

Output requirements:
- Format: <reflect type="recall">...</reflect>
- Each unit ≤ 25 words, names a specific earlier item (file, error,
  constraint) and briefly explains its current relevance
- May also restate one critical aspect of the original user goal
- Generate as many as possible until interrupted

Forbidden:
- Do NOT invent context that wasn't in the trajectory
- Do NOT recall something you just used in the recent reasoning
- Do NOT be vague ("some earlier turn mentioned something")

Examples of good recall units:
<reflect type="recall">Turn 3 mentioned config.yaml but it was never inspected; may contain target settings.</reflect>
<reflect type="recall">User specified "without breaking existing tests"; current changes need regression check.</reflect>
<reflect type="recall">Earlier observation showed a deprecation warning in module X; possibly the root cause.</reflect>

Begin emitting recall units now.""",
    },
    "alternative": {
        "description": "Name approaches not taken that could reach the same goal.",
        "marker": "name alternative paths",
        "prompt": """\
Your reasoning above commits to one approach for the next step. Before
the result arrives, name alternative paths to the same goal that you did
NOT take. This is purely exploratory — you are not changing your plan.

Output requirements:
- Format: <reflect type="alternative">...</reflect>
- Each unit ≤ 25 words, names ONE specific alternative
- Briefly indicate when the alternative would be preferable
- Generate multiple alternatives until interrupted

Forbidden:
- Do NOT criticize your chosen approach
- Do NOT propose alternatives functionally identical to current approach
- Do NOT be vague ("could use a different command")

Examples of good alternative units:
<reflect type="alternative">Could use ast-grep instead of grep for precise structural matching of Python syntax.</reflect>
<reflect type="alternative">Reading the test file directly may reveal expected behavior faster than running tests.</reflect>
<reflect type="alternative">Inspecting git blame on the failing line could identify the responsible commit directly.</reflect>

Begin emitting alternative units now.""",
    },
}

ATOM_NAMES = tuple(REFLECT_ATOMS.keys())


# ---------------------------------------------------------------------------
# `reflect_inprompt` arm (added 2026-07-29)
# ---------------------------------------------------------------------------
# The four atom prompts above, merged into ONE standing instruction that is
# appended to the MAIN thread's system prompt. No branches are forked and
# nothing is harvested: the main thread emits the reflect units itself, at
# the tail of its THOUGHT, before the bash block.
#
# This is the prompt-engineering control for the reflect arm — "does simply
# ASKING for the four reflections inline buy the same thing as forking them
# into the idle window?". Three things about it are NOT free choices:
#
#  1. Placement is at the end of THOUGHT, before the bash block, because the
#     main stream is early-stopped at the first detected bash block
#     (streaming_agent.py `cancel_reason = "action_emitted"`). Nothing after
#     the block is ever generated. Consequence: unlike `reflect` — where the
#     merged block is spliced AFTER the action and only reaches the NEXT turn
#     — these units are causally upstream of this turn's command. The arm is
#     therefore "inline reflection prompting", not a pure schedule-only
#     control, and must be described as such.
#
#  2. The wording anchors on "THOUGHT section" (mini-swe-agent's own word for
#     the visible content-channel prose), never on "reasoning". Units emitted
#     into the provider `<think>` channel would be counted in OUT_own but
#     silently dropped from history: `SecondThoughtModel._normalize_msg` only
#     passes `reasoning_details` back for minimax/*, so on dsv4 the reasoning
#     channel does not survive into the next turn.
#
#  3. "until interrupted" (meaningless without wait-zero on the main thread)
#     becomes a fixed 2 units per atom = 8 per turn, matched to the MEASURED
#     mean harvest of the dsv4 SWE-Pro reflect cell over 7916 turns:
#     check 1.79 / rehearse 1.89 / recall 1.89 / alternative 2.03 = 7.12.
#     `max_reflect_per_turn` (20) is that cell's cap, not its mean, and would
#     over-spend this arm by ~2.8k tokens/turn.
#
# This block ASKS; it does not police. Compliance-forcing scaffolding was built
# and then deliberately dropped (decision 2026-07-29) — the arm is meant to
# answer "what do you get if you just put the four instructions in the main
# system prompt", and a bespoke format-enforcement apparatus is not part of
# that question. What was tried and rejected, measured on dsv4 (scratch probe,
# stock system+instance templates, ~40 samples per candidate; the count is
# turns emitting ZERO units):
#
#   candidate                       turn-1   history-with-units   history-without
#   this block (asks only)           7/12          9/12               12/12
#   + <format_example> w/ units      2/12          2/12               10/12
#   + "earlier turns are no          2/16          2/16               15/16
#     precedent" line
#
# So the expected behaviour of the shipped arm is PARTIAL compliance: the model
# imitates concrete exemplars, and both stock templates demonstrate
# THOUGHT->bash with nothing between them, so it often just does that. Two
# consequences for reporting:
#
#   - Non-compliance is an ABSORBING state: once a turn omits the units the
#     model copies its own lapse and later turns omit them too. Report
#     units/turn against turn_idx, not just the episode mean, and report the
#     fraction of turns that reflected at all.
#   - A null result on this cell is therefore under-determined between "inline
#     reflection does not help" and "the model largely did not do it". Say
#     which, with the compliance number, rather than letting the pass-rate
#     delta carry the claim alone.
#
# Content mass is preserved: 912 tokens (dsv4 tokenizer) vs 874 for the four
# branch prompts summed.
INPROMPT_REFLECT_BLOCK = """\
## Reflection at the end of your THOUGHT

Your THOUGHT section ends once you have decided which command to run. At that
point, before you write the bash block, reflect on the reasoning you just
finished. Write the reflection as typed units, one per line:

<reflect type="check|rehearse|recall|alternative">...</reflect>

Emit 2 units of each of the four types below. Each unit is ≤ 25 words and a
complete, self-contained sentence. The units belong at the end of your THOUGHT
text — not in a separate section, and not after the bash block.

### check — assumptions the upcoming result could disprove

Briefly audit the reasoning you just finished for assumptions that could be
disproved by the result of the command you are about to run.

- Each unit names ONE specific assumption from that reasoning
- Phrase as questions or flagged assumptions, NOT corrections

Forbidden:
- Do NOT restate or summarize your reasoning
- Do NOT claim what the command will return
- Do NOT say your reasoning was wrong (no correction)

Examples of good check units:
<reflect type="check">Did I assume pytest? If unittest, the test invocation syntax differs.</reflect>
<reflect type="check">My plan assumed imports resolve from project root; may fail in monorepo.</reflect>
<reflect type="check">Implicit assumption: file uses UTF-8 encoding; may break on legacy encodings.</reflect>

### rehearse — conditional plans for the possible outcomes

The reasoning you just finished sets up the command. Before the result arrives,
rehearse possible outcomes and pre-stage your response to each.

- Each unit is structured as "If [outcome], [next step]."
- Cover positive, negative, and surprising cases across the units

Forbidden:
- Do NOT make standalone predictions without follow-up
- Do NOT say what the command WILL return; only conditional "if X, then Y"
- Do NOT restate your plan

Examples of good rehearse units:
<reflect type="rehearse">If grep returns nothing, fallback is searching by symbol name in adjacent modules.</reflect>
<reflect type="rehearse">If the file is empty, that suggests the bug is elsewhere; widen the search.</reflect>
<reflect type="rehearse">If output is paginated, append --no-pager and re-run before continuing analysis.</reflect>

### recall — earlier-trajectory items that matter now

The reasoning you just finished focuses on the immediate next step. Recall
earlier trajectory details that may matter now but were not explicitly used in
it.

- Each unit names a specific earlier item (file, error, constraint) and briefly
  explains its current relevance
- One unit may instead restate one critical aspect of the original user goal

Forbidden:
- Do NOT invent context that wasn't in the trajectory
- Do NOT recall something you just used in that reasoning
- Do NOT be vague ("some earlier turn mentioned something")

Examples of good recall units:
<reflect type="recall">Turn 3 mentioned config.yaml but it was never inspected; may contain target settings.</reflect>
<reflect type="recall">User specified "without breaking existing tests"; current changes need regression check.</reflect>
<reflect type="recall">Earlier observation showed a deprecation warning in module X; possibly the root cause.</reflect>

### alternative — approaches not taken

The reasoning you just finished commits to one approach. Name alternative paths
to the same goal that you did NOT take. This is purely exploratory — you are not
changing the command you have decided on.

- Each unit names ONE specific alternative
- Briefly indicate when the alternative would be preferable

Forbidden:
- Do NOT criticize your chosen approach
- Do NOT propose alternatives functionally identical to your current approach
- Do NOT be vague ("could use a different command")

Examples of good alternative units:
<reflect type="alternative">Could use ast-grep instead of grep for precise structural matching of Python syntax.</reflect>
<reflect type="alternative">Reading the test file directly may reveal expected behavior faster than running tests.</reflect>
<reflect type="alternative">Inspecting git blame on the failing line could identify the responsible commit directly.</reflect>

The units do not replace your THOUGHT, and your response still contains exactly
one bash code block."""


def build_system_prompt(config: RunConfig) -> str:
    """Build the MAIN-thread system prompt for the legacy/toy path.
    SWE-bench Pro uses mini-swe-agent's own system_template via the
    config YAML; this prompt is only used by `second_thought.orchestrator`."""
    return BASE_SYSTEM_PROMPT.format(sentinel=config.final_sentinel)


def build_branch_atom_messages(
    snapshot: list[dict],
    reasoning_text: str,
    atom: str,
) -> list[dict]:
    """Build the messages list for ONE branch atom call.

    The branch sees the entire main conversation snapshot (system +
    instance prompt + all prior turns), then a synthetic assistant
    message containing the just-completed reasoning, then a user
    message with the atom's continuation prompt. From the model's
    perspective it has just finished reasoning and is being asked one
    short reflective follow-up question.

    The same `snapshot` (and same `reasoning_text`) is reused across
    all 4 atom branches in a turn — only the trailing user prompt
    differs. This is the cache-friendly structure: OpenRouter's
    implicit prefix cache can serve the 2nd-4th branches at the
    cache-read price.
    """
    if atom not in REFLECT_ATOMS:
        raise ValueError(f"unknown reflect atom: {atom!r}")
    body = list(snapshot)
    body.append({"role": "assistant", "content": reasoning_text or ""})
    body.append({"role": "user", "content": REFLECT_ATOMS[atom]["prompt"]})
    return body


def render_atoms_pool(pool: dict) -> str:
    """Render an atoms_pool dict (atom_name → list[unit_str]) to text:
    a sequence of `<reflect type=X>unit</reflect>` lines.

    Used to embed prior bursts' refined atoms into the user message of
    subsequent bursts' branches (multi-fire refined reflect)."""
    if not pool:
        return ""
    parts = []
    for atom in ATOM_NAMES:
        for unit in pool.get(atom, []):
            parts.append(f"<reflect type={atom}>{unit}</reflect>")
    return "\n".join(parts)


def build_refine_branch_messages(
    snapshot: list[dict],
    main_so_far_text: str,
    atom: str,
    prior_atoms_pool: dict | None = None,
) -> list[dict]:
    """Build messages for a refined multi-fire reflect branch.

    Differences from build_branch_atom_messages:
      - assistant message holds the MAIN-THREAD CONTENT EMITTED SO FAR
        in the current turn (not the reasoning channel), so branches
        across bursts see an evolving snapshot.
      - user message is prefixed with prior bursts' refined atoms (when
        non-empty), then the standard atom prompt. The model implicitly
        refines (keep/remove/modify/add) by seeing prior reflections.

    For burst 1 (prior_atoms_pool empty / None), this collapses to the
    standard single-fire reflect prompt (a user message containing just
    the atom prompt), preserving backward-compatible behavior on
    non-interleaving models that emit only one burst.
    """
    if atom not in REFLECT_ATOMS:
        raise ValueError(f"unknown reflect atom: {atom!r}")
    body = list(snapshot)
    body.append({"role": "assistant", "content": main_so_far_text or ""})
    prior_rendered = render_atoms_pool(prior_atoms_pool or {})
    user_content = (
        (prior_rendered + "\n\n" if prior_rendered else "")
        + REFLECT_ATOMS[atom]["prompt"]
    )
    body.append({"role": "user", "content": user_content})
    return body


def build_user_task_prompt(problem_statement: str, repo_root: str) -> str:
    return (
        f"Repository root: {repo_root}\n"
        f"Working directory is already set to the repo root.\n\n"
        f"Problem statement:\n{problem_statement}\n"
    )
