"""ReflectAgent — mini-swe-agent's DefaultAgent with parallel multi-atom branch reflection.

Mechanism (current design — "continuation prompting"):

- MAIN thread runs unchanged on mini-swe-agent's stock prompts.

- On the first content delta (= main's reasoning just ended), the harness
  forks N branch tasks IN PARALLEL — one per requested reflect atom
  (default: all 4 — check, rehearse, recall, alternative). Each branch
  is an independent LLM call against the same model with thinking
  disabled (`extra_body={"reasoning": {"enabled": False}}`).

- Each branch's input is the exact main conversation snapshot, with two
  extra messages appended:
    1. {role: "assistant", content: <just-completed reasoning>}
    2. {role: "user",      content: <atom-specific continuation prompt>}
  The model continues its own role and answers ONE focused reflective
  question. This (a) maximises OpenRouter prefix-cache hit across the
  4 branches and (b) keeps the model in its native agent role rather
  than asking it to switch into a meta "reflection process" role.

- When the tool finishes, all branches are cancelled. Each branch
  buffer is truncated at the last `</reflect>` (in-flight tail
  discarded), typed units are parsed by atom, and the 4 streams are
  round-robin interleaved before being spliced into the assistant
  message between the action and the observation.

What we inherit unchanged from mini-swe-agent:
- system_template / instance_template (from default.yaml)
- parse_action's "exactly one bash block" rule
- action_observation_template (10 KB elision)
- has_finished sentinel detection
- step_limit / cost_limit terminating exceptions
- The whole control-flow loop in `run()` (we mirror it async)
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field

from minisweagent.agents.default import (
    AgentConfig,
    DefaultAgent,
    FormatError,
    LimitsExceeded,
    NonTerminatingException,
    Submitted,
    TerminatingException,
)

from ..action_detector import (
    count_reflect_units,
    detect_first_action,
    interleave_typed_units_by_atom,
    parse_reflect_typed_units,
    truncate_at_last_complete_reflect,
)
from ..prompts import (
    ATOM_NAMES,
    INPROMPT_REFLECT_BLOCK,
    REFLECT_ATOMS,
    build_branch_atom_messages,
    build_refine_branch_messages,
    render_atoms_pool,
)

try:
    from minisweagent.agents.default import ExecutionTimeoutError  # type: ignore
except ImportError:  # pragma: no cover
    class ExecutionTimeoutError(NonTerminatingException):  # type: ignore[no-redef]
        pass


logger = logging.getLogger(__name__)


@dataclass
class ReflectAgentConfig(AgentConfig):
    """Inherits all mini-swe-agent AgentConfig fields. Adds reflect knobs."""
    # "baseline" | "reflect" | "reflect_sync" | "reflect_early"
    # | "reflect_oracle" | "s1extend" | "reflect_inprompt"
    mode: str = "baseline"
    # Per-turn cap on complete reflect units harvested PER ATOM. Each
    # branch breaks out of its stream once it has emitted this many
    # complete units of its own type.
    max_reflect_per_turn: int = 20
    # Which atoms to fork. None = all 4 (check/rehearse/recall/alternative).
    # Empty list disables the branch entirely.
    reflect_atoms: list[str] | None = None
    # extra_body merged into the branch LLM call. Disables reasoning so
    # the branch's whole window is spent on content tokens.
    branch_extra_body: dict = field(
        default_factory=lambda: {"reasoning": {"enabled": False}}
    )
    # Per-branch output cap. None = inherit the model config's max_tokens
    # (4096), which is what every run up to 2026-07-28 used. A branch is
    # almost always cancelled long before it reaches the cap, so the cap
    # only bounds what the SERVER keeps decoding after we disconnect --
    # relevant when serving is self-hosted (vLLM does not always honour a
    # client disconnect) or when the provider bills the full request
    # budget. Measured branch output (SWE-Pro, 57k branch slots): p99.9 =
    # ~890 tok late-fork / ~1190 tok early-fork, max ~3.1-4.4k. So 2048 is
    # a safe operational value and 512 is NOT (it would truncate real
    # output above p99). Left at None by default so this knob never
    # silently changes generation semantics mid-study; set it explicitly
    # per run.
    branch_max_tokens: int | None = None
    # ---- s1extend (s1-style budget forcing) ----
    # Target extra reasoning tokens that MUST be injected after the
    # natural pass before allowing </think> to close thinking. Chosen
    # to compute-match the 4-branch decode total in reflect mode for
    # the same benchmark.
    s1extend_target_tokens: int = 300
    # Max number of "Wait, " injection rounds. Set high so the loop
    # can keep going until the per-turn budget is hit even when the
    # model emits short responses per round (typical 200-400 chars).
    # s1 paper uses up to 6 because their per-round generation is
    # longer; we observed 200-500 chars per round at TB/SWE-Pro target
    # sizes, so allow up to 15 to ensure budget compliance.
    s1extend_max_rounds: int = 15
    # ---- reflect_sync (blocking schedule control) ----
    # Hard bound on how long the turn may block waiting for the branches
    # to finish on their own. A branch normally ends by itself at
    # `max_reflect_per_turn` complete units (or `branch_max_tokens`); this
    # only exists so one stalled branch cannot wedge a turn. On timeout the
    # branches are cancelled and whatever completed is harvested, exactly
    # as in the async arm.
    sync_branch_timeout_sec: float = 90.0


@dataclass
class ReflectTurnRecord:
    turn_idx: int
    action_type: str  # "bash" | "submit" | "format-error" | "limits"
    action_content: str
    tool_duration_sec: float
    reflect_count: int  # total complete units kept across atoms
    stream_ended_naturally: bool
    cancel_reason: str | None
    tool_returncode: int | None
    tool_timed_out: bool
    assistant_text: str        # main thread's raw output (reasoning prose + bash block)
    assistant_text_kept: str   # head + merged-reflect block spliced into history
    assistant_reasoning: str
    context_token_len_before: int
    context_token_len_after: int
    branch_text_raw: str = ""        # concat of per-atom raw buffers (debug)
    branch_text_kept: str = ""       # merged round-robin block (what enters history)
    branch_per_atom: dict = field(default_factory=dict)  # {atom: {raw, kept, n_units}}
    branch_window_sec: float = 0.0
    # ---- s1extend fields (mode='s1extend' only) ----
    s1extend_natural_action: str | None = None      # action produced by natural pass
    s1extend_extended_action: str | None = None     # final action after Wait extension
    s1extend_extension_text: str = ""               # raw text appended after natural
    s1extend_extension_chars: int = 0               # length of extension (approx token / 4)
    s1extend_rounds: int = 0                        # how many Wait rounds fired
    # ---- raw API archive (defense against future capture-logic bugs) ----
    raw_main_stream: list = field(default_factory=list)  # compact deltas {r,c,fin,usage}
    main_usage: dict | None = None                       # ground-truth API usage
    # ---- multi-fire refined reflect (mode='reflect' only) ----
    burst_count: int = 0                                 # # of content bursts (= # of branch fires)
    branch_cond_chars: int = 0                           # chars of just-finished reasoning handed to branches at fork
    atoms_pool_evolution: list = field(default_factory=list)  # snapshot of pool after each cancel
    # ---- per-phase wall timing (seconds) ----
    # Decompose turn wall into observable phases. All durations relative
    # to t_step_start; zero if phase didn't occur this turn.
    phase_times: dict = field(default_factory=dict)


def _approx_tokens(messages: list[dict]) -> int:
    return sum(max(1, len(m.get("content") or "") // 4) for m in messages)


# s1extend uses this to find the model's FINAL bash commitment across
# (natural pass + all Wait rounds). Mirrors mini-swe-agent's action
# parser (one-shot ```bash ... ``` fenced block) but returns the LAST
# match in the string instead of the first.
import re as _re_s1
_BASH_BLOCK_RE = _re_s1.compile(r"```bash\n(.*?)\n```", _re_s1.DOTALL)


def _find_last_bash_in(text: str):
    matches = list(_BASH_BLOCK_RE.finditer(text))
    if not matches:
        return None
    m = matches[-1]
    return m.group(1), m.end()


def _resolve_atoms(cfg: ReflectAgentConfig) -> list[str]:
    if cfg.reflect_atoms is None:
        return list(ATOM_NAMES)
    bad = [a for a in cfg.reflect_atoms if a not in REFLECT_ATOMS]
    if bad:
        raise ValueError(f"unknown reflect atoms: {bad}")
    return list(cfg.reflect_atoms)


class ReflectAgent(DefaultAgent):
    """Streaming + parallel-multi-atom-branch subclass of DefaultAgent."""

    def __init__(self, model, env, *, config_class: type = ReflectAgentConfig, **kwargs):
        super().__init__(model, env, config_class=config_class, **kwargs)
        self.turn_records: list[ReflectTurnRecord] = []
        # Branch tasks in flight for the current step; _async_step's finally
        # guarantees none of them outlives it.
        self._inflight_branches: dict[str, asyncio.Task] = {}
        # Some providers reject `reasoning: {enabled: False}` outright or
        # silently ignore it. Override branch_extra_body so branches stay
        # cheap. xiaomi/mimo uses a different param name (thinking instead
        # of reasoning) and is handled by streaming_model.py's translation
        # layer — leave its branch_extra_body as default here.
        mname = getattr(getattr(model, "config", None), "model_name", "") or ""
        if mname.startswith(("minimax/", "stepfun/")):
            self.config.branch_extra_body = {"reasoning": {"effort": "low"}}

    async def run_async(self, task: str, **kwargs) -> tuple[str, str]:
        self.extra_template_vars |= {"task": task, **kwargs}
        self.messages = []
        self.turn_records = []
        system_text = self.render_template(self.config.system_template)
        # reflect_inprompt: the four atom prompts, merged and appended to the
        # stock system prompt. The main thread emits the reflect units itself
        # at the tail of its THOUGHT; no branch is forked and nothing is
        # harvested (see prompts.INPROMPT_REFLECT_BLOCK for why the placement
        # and the 2-units-per-atom cap are forced rather than chosen).
        if self.config.mode == "reflect_inprompt":
            system_text = system_text.rstrip() + "\n\n" + INPROMPT_REFLECT_BLOCK
        self.add_message("system", system_text)
        self.add_message("user", self.render_template(self.config.instance_template))
        while True:
            try:
                await self._async_step()
            except NonTerminatingException as e:
                self.add_message("user", str(e))
            except TerminatingException as e:
                self.add_message("user", str(e))
                return type(e).__name__, str(e)

    async def _async_step(self) -> dict:
        """Run one turn, guaranteeing no branch task outlives it.

        The branch tasks are forked from INSIDE the main stream's
        ``async with`` block, while both normal cancel sites sit after it.
        Any exception raised while iterating the main stream (429, read
        timeout, transport drop, SSE-level provider error) therefore used
        to escape with 4 branch tasks still streaming; ``run_one`` would
        then retry the whole instance while the orphans kept decoding.
        This wrapper makes the cancel unconditional. The normal paths
        still cancel + harvest at the right instant (harvesting needs to
        happen at wait-zero, not here) -- by the time the finally runs on
        a healthy turn every task is already done, so it is a no-op.
        """
        self._inflight_branches: dict[str, asyncio.Task] = {}
        try:
            return await self._async_step_impl()
        finally:
            leftover = {a: t for a, t in self._inflight_branches.items() if not t.done()}
            if leftover:
                logger.warning(
                    "step aborted with %d branch task(s) still live (%s); cancelling",
                    len(leftover), ",".join(sorted(leftover)),
                )
                await self._cancel_all_branches(leftover)
            self._inflight_branches = {}

    async def _async_step_impl(self) -> dict:
        cfg: ReflectAgentConfig = self.config  # type: ignore[assignment]

        if 0 < cfg.step_limit <= self.model.n_calls:
            raise LimitsExceeded()
        if 0 < cfg.cost_limit <= self.model.cost:
            raise LimitsExceeded()

        ctx_before = _approx_tokens(self.messages)
        atoms = _resolve_atoms(cfg) if cfg.mode in (
            "reflect", "reflect_sync", "reflect_early", "reflect_oracle"
        ) else []

        buffer = ""
        action_command: str | None = None
        action_start = -1
        action_end = -1
        fired = False
        cancel_reason: str | None = None
        stream_eos = False

        # Shared with _async_step's finally-guard: every task registered
        # here is cancelled no matter how this turn exits.
        branch_tasks: dict[str, asyncio.Task] = self._inflight_branches
        branch_states: dict[str, dict] = {}  # atom -> {"text": str}
        branch_started_at: float = 0.0
        branch_finished_at: float = 0.0
        turn_reasoning = ""

        # Single-fire reflect (rolled back from multi-fire on 2026-05-24).
        atoms_pool: dict[str, list[str]] = {a: [] for a in atoms}
        atoms_pool_evolution: list[dict] = []
        burst_count = 0
        branch_cond_chars = 0
        oracle_cond: str | None = None  # reflect_oracle: captured at fork point, fired later
        snapshot_messages_const = list(self.messages)

        # Per-call buffers (safe from concurrent branch stream resets).
        main_rsn_buf: list[str] = []
        main_stream_chunks_ref: list[dict] = []
        main_usage_getter = lambda: None

        # ---- timing instrumentation (per-phase wall) ----
        t_step_start = time.monotonic()
        t_stream_open = 0.0
        t_first_chunk = 0.0
        t_main_end = 0.0
        t_branches_fired = 0.0
        t_branches_cancelled = 0.0

        async with self.model.stream(self.messages) as tokens:
            t_stream_open = time.monotonic()
            main_rsn_buf = getattr(tokens, "reasoning_buf", [])
            main_stream_chunks_ref = getattr(tokens, "stream_chunks", [])
            main_usage_getter = getattr(tokens, "get_usage", lambda: None)
            # reflect_early control: fire branches NOW (at stream open, before
            # the main thread's reasoning streams) so they overlap the ENTIRE
            # main call (reasoning + content) + tool — the maximal idle window.
            # Branch construction is identical to reflect (main_so_far == ""
            # here, exactly as at reflect's first-content-delta fork), so this
            # isolates fork TIMING only (no conditioning/prompt confound).
            if atoms and cfg.mode == "reflect_early" and not branch_tasks:
                burst_count += 1
                t_branches_fired = time.monotonic()
                branch_started_at = t_branches_fired
                for atom in atoms:
                    state = {"text": ""}
                    branch_states[atom] = state
                    branch_tasks[atom] = asyncio.create_task(
                        self._run_refine_branch(
                            snapshot_messages_const, "", atom, {}, state,
                        )
                    )
            async for chunk in tokens:
                if t_first_chunk == 0.0:
                    t_first_chunk = time.monotonic()
                # Single-fire: fire branches once on first content delta
                # (= the turn's first reasoning segment just ended). The
                # branch's synthetic assistant message carries that
                # JUST-FINISHED REASONING (target design, restored
                # 2026-07-14; the 2026-05-24 refactor had silently switched
                # this to the then-empty content buffer). main_rsn_buf is
                # the per-call reasoning buffer — at this instant it holds
                # exactly the completed first segment. Empty for models
                # whose provider returns no reasoning channel.
                # Exp-4 ④ oracle arm (reflect_oracle): capture the SAME first
                # reasoning segment arm ① conditions on, but do NOT fire here.
                # Branches fire after the main stream (below) so the arm can be
                # given an EARLY-fork WINDOW while carrying LATE-fork
                # CONDITIONING CONTENT — the 4th cell of the timing×conditioning
                # 2x2, which is unreachable online (at stream open this text
                # does not exist yet). Exact coupling: same call's reasoning,
                # not an independent resample.
                if atoms and cfg.mode == "reflect_oracle" and oracle_cond is None:
                    oracle_cond = "".join(main_rsn_buf)
                elif atoms and not branch_tasks:
                    burst_count += 1
                    t_branches_fired = time.monotonic()
                    branch_started_at = t_branches_fired
                    # Exp-4 ② ablation: SECOND_THOUGHT_BRANCH_COND_EMPTY=1 reverts the
                    # synthetic assistant to the empty buffer (late fork, NO
                    # conditioning) — isolates conditioning vs the target
                    # design at the SAME fork timing. Default = target design.
                    if os.environ.get("SECOND_THOUGHT_BRANCH_COND_EMPTY") == "1":
                        main_so_far = ""
                    else:
                        main_so_far = "".join(main_rsn_buf)
                    branch_cond_chars = len(main_so_far)
                    for atom in atoms:
                        state = {"text": ""}
                        branch_states[atom] = state
                        branch_tasks[atom] = asyncio.create_task(
                            self._run_refine_branch(
                                snapshot_messages_const, main_so_far,
                                atom, {}, state,
                            )
                        )

                buffer += chunk
                if not fired:
                    m = detect_first_action(buffer)
                    if m is not None:
                        fired = True
                        action_command = m.command
                        action_start = m.start
                        action_end = m.end
                        cancel_reason = "action_emitted"
                        break
            else:
                stream_eos = True
                cancel_reason = cancel_reason or "stream_eos"
        t_main_end = time.monotonic()

        # Use per-call buffers (safe from concurrent branch streams that
        # reset model.last_reasoning). main_rsn_buf was bound to the
        # main stream's generator inside the `async with` block above.
        turn_reasoning = "".join(main_rsn_buf)

        # Raw stream archive — also per-call to avoid being stomped.
        raw_main = list(main_stream_chunks_ref)
        main_usage = main_usage_getter()

        # No bash block at all → defer to mini-swe-agent's format-error path.
        if not fired:
            await self._cancel_all_branches(branch_tasks)
            t_branches_cancelled = time.monotonic()
            self.add_message("assistant", buffer, reasoning=turn_reasoning)
            self.turn_records.append(ReflectTurnRecord(
                turn_idx=len(self.turn_records),
                action_type="format-error",
                action_content="",
                tool_duration_sec=0.0,
                reflect_count=0,
                stream_ended_naturally=stream_eos,
                cancel_reason=cancel_reason,
                tool_returncode=None,
                tool_timed_out=False,
                assistant_text=buffer,
                assistant_text_kept=buffer,
                assistant_reasoning=turn_reasoning,
                context_token_len_before=ctx_before,
                context_token_len_after=_approx_tokens(self.messages),
                raw_main_stream=raw_main,
                main_usage=main_usage,
                phase_times={
                    "step_total": t_branches_cancelled - t_step_start,
                    "ttft": (t_first_chunk - t_stream_open) if t_first_chunk else 0.0,
                    "main_decode": (t_main_end - t_first_chunk) if t_first_chunk else 0.0,
                    "main_stream_total": t_main_end - t_stream_open,
                    "tool_exec": 0.0,
                    "format_error": True,
                },
            ))
            raise FormatError(self.render_template(self.config.format_error_template, actions=[]))

        assert action_command is not None

        # === s1extend: forced multi-round Wait IN REASONING CHANNEL ====
        # Faithful replica of s1 paper §3.1 at the API level.
        #
        # Mechanism: DeepSeek-v4-flash routes ``prefix=True`` continuations
        # with an UNCLOSED ``<think>...`` envelope into the reasoning
        # channel (we verified this empirically — see probe_think_envelope).
        # That lets us inject "Wait," at the END of the reasoning trace
        # (the equivalent of right before the </think> token) and have the
        # model continue THINKING (not committing). We repeat K times.
        # Then we close </think> and let the model emit the final action.
        #
        # Phase 1 above produced ``turn_reasoning`` (natural reasoning
        # text via delta.reasoning) and ``buffer`` (content with a bash
        # block). Phase 1's bash is DISCARDED for s1extend; the
        # committed action comes from Phase 3 below.
        #
        # Provider is pinned to deepseek with allow_fallbacks=False so
        # each round's prefix benefits from DeepSeek's automatic context
        # cache (each round only adds ~target_chars/K new tokens).
        s1ext_natural_action: str | None = None
        s1ext_extension_text: str = ""
        s1ext_rounds: int = 0
        s1ext_final_action_end: int = -1
        s1ext_commit_content: str = ""
        if cfg.mode == "s1extend":
            s1ext_natural_action = action_command
            target_chars = cfg.s1extend_target_tokens * 4
            r_accum_extension = ""  # reasoning we forcibly accumulate via Wait

            # --- Phase 2: forced Wait in reasoning channel (<think> unclosed)
            # Strictly enforce ≥ target_chars of extra reasoning per turn.
            # s1 paper §3.1: "suppress the generation of the end-of-thinking
            # token delimiter and append Wait." We implement this at the
            # API level by: (a) passing ``stop=["</think>"]`` so generation
            # truncates whenever the model tries to close thinking, (b)
            # string-stripping any </think> that slips through (belt and
            # suspenders), and (c) looping with another "Wait," prefix
            # until the per-turn budget is satisfied — model-attempted
            # </think> closures are effectively REPLACED by the next
            # round's Wait. Only after budget is met does Phase 3 below
            # close </think> and let the model commit to an action.
            MAX_NAT_CHARS_IN_PREFIX = 12000  # ~3K tokens; truncate if longer
            STOP_SEQUENCES = ["</think>"]

            def _strip_think_close(text: str) -> str:
                """Drop any </think> (and what follows) from the output."""
                if not text:
                    return text
                idx = text.find("</think>")
                return text[:idx].rstrip() if idx >= 0 else text

            for round_i in range(cfg.s1extend_max_rounds):
                if len(r_accum_extension) >= target_chars:
                    break
                # Strategy 1: full natural + accumulated waits + new Wait,
                # reasoning channel enabled. Stop at any </think> attempt.
                nat = turn_reasoning
                prefix_full = f"<think>\n{nat}{r_accum_extension}\nWait,"
                remaining_chars = target_chars - len(r_accum_extension)
                round_max_tokens = max(100, remaining_chars // 4 + 200)

                new_thinking = ""
                try:
                    resp = await self.model.acall_prefix(
                        self.messages,
                        prefix_full,
                        max_tokens=round_max_tokens,
                        stop=STOP_SEQUENCES,
                        enable_reasoning=True,
                        count_call=False,
                    )
                    new_thinking = _strip_think_close(
                        resp.get("reasoning", "") or resp.get("content", "")
                    )
                except Exception as e:
                    logger.warning("s1extend round %d strategy 1 failed: %s", round_i, e)

                # Strategy 2: force content channel (some long-natural
                # cases cause the model to skip the reasoning channel
                # entirely; we still want the tokens to count toward the
                # forced-thinking budget).
                if not new_thinking:
                    try:
                        resp = await self.model.acall_prefix(
                            self.messages,
                            prefix_full,
                            max_tokens=round_max_tokens,
                            stop=STOP_SEQUENCES,
                            enable_reasoning=False,
                            count_call=False,
                        )
                        new_thinking = _strip_think_close(
                            resp.get("content", "") or resp.get("reasoning", "")
                        )
                    except Exception as e:
                        logger.warning("s1extend round %d strategy 2 failed: %s", round_i, e)

                # Strategy 3: truncate natural reasoning to keep prefix
                # short, in case the long history made the model close
                # thinking immediately.
                if not new_thinking and len(nat) > MAX_NAT_CHARS_IN_PREFIX:
                    half = MAX_NAT_CHARS_IN_PREFIX // 2
                    nat_short = nat[:half] + "\n...[truncated for budget]...\n" + nat[-half:]
                    prefix_short = f"<think>\n{nat_short}{r_accum_extension}\nWait,"
                    try:
                        resp = await self.model.acall_prefix(
                            self.messages,
                            prefix_short,
                            max_tokens=round_max_tokens,
                            stop=STOP_SEQUENCES,
                            enable_reasoning=True,
                            count_call=False,
                        )
                        new_thinking = _strip_think_close(
                            resp.get("reasoning", "") or resp.get("content", "")
                        )
                    except Exception as e:
                        logger.warning("s1extend round %d strategy 3 failed: %s", round_i, e)

                new_thinking = new_thinking.strip()  # whitespace-degenerate output != real thinking
                if not new_thinking:
                    logger.warning(
                        "s1extend round %d: all strategies returned empty/whitespace; "
                        "stopping at %d/%d chars",
                        round_i, len(r_accum_extension), target_chars,
                    )
                    break
                r_accum_extension += "\nWait," + new_thinking
                s1ext_rounds = round_i + 1
            s1ext_extension_text = r_accum_extension

            # --- Phase 3: close </think> and let model commit to action
            commit_prefix = (
                f"<think>\n{turn_reasoning}{r_accum_extension}\n</think>\n"
            )
            try:
                commit_resp = await self.model.acall_prefix(
                    self.messages,
                    commit_prefix,
                    max_tokens=2000,
                    enable_reasoning=False,
                    count_call=False,  # Commit is part of the same turn, not extra
                )
                s1ext_commit_content = commit_resp.get("content", "")
            except Exception as e:
                logger.warning("s1extend commit failed: %s", e)
                s1ext_commit_content = ""

            new_match = detect_first_action(s1ext_commit_content)
            if new_match is not None:
                action_command = new_match.command
                s1ext_final_action_end = new_match.end
            else:
                # Commit failed to emit a bash — fall back to the natural
                # action so the agent loop can still execute something.
                logger.warning("s1extend commit produced no bash; using natural action")
                s1ext_final_action_end = -1
            # Replace ``turn_reasoning`` with the FULL extended reasoning
            # so the trajectory records reflect what was thought.
            turn_reasoning = turn_reasoning + r_accum_extension

        # Exp-4 ④ oracle arm: fire branches NOW, carrying the first reasoning
        # segment captured at the first content delta. They are granted a
        # window of (main-stream wall + tool wall) below — the window an EARLY
        # fork would have had. Token and pass metrics therefore match a true
        # early+conditioned fork; only wall-clock differs (branches run after
        # the main call instead of overlapping it), which is acceptable
        # because this arm is an oracle control and is not deployable.
        if atoms and cfg.mode == "reflect_oracle" and not branch_tasks:
            burst_count += 1
            t_branches_fired = time.monotonic()
            branch_started_at = t_branches_fired
            main_so_far = oracle_cond or ""
            branch_cond_chars = len(main_so_far)
            for atom in atoms:
                state = {"text": ""}
                branch_states[atom] = state
                branch_tasks[atom] = asyncio.create_task(
                    self._run_refine_branch(
                        snapshot_messages_const, main_so_far, atom, {}, state,
                    )
                )

        # --- reflect_sync: the BLOCKING cell of the {content} x {schedule}
        # 2x2. Identical to `reflect` in every respect that touches content
        # -- same atoms, same fork instant (first content delta), same
        # conditioning text, same fold position (after the action, so the
        # reflections reach the NEXT turn, not this turn's action) -- and
        # differs in exactly one thing: the branches are awaited to their
        # own completion HERE, before the tool runs, instead of being
        # cancelled at wait-zero. Their decode therefore sits on the
        # critical path rather than inside the idle window. A branch ends
        # by itself at `max_reflect_per_turn` complete units or at
        # `branch_max_tokens`; `sync_branch_timeout_sec` is a wedge guard.
        #
        # The fork instant is deliberately left where `reflect` puts it, so
        # the only variable between the two arms is the cancel policy. The
        # small tail that still overlaps main content decode is reported
        # honestly: `branch_block_sec` is the wall actually spent blocked.
        sync_blocked = False
        sync_block_sec = 0.0
        sync_block_timed_out = False
        if branch_tasks and cfg.mode == "reflect_sync":
            t0_block = time.monotonic()
            _, pending = await asyncio.wait(
                set(branch_tasks.values()), timeout=cfg.sync_branch_timeout_sec
            )
            if pending:
                sync_block_timed_out = True
                logger.warning(
                    "reflect_sync: %d branch(es) still live after %.0fs; "
                    "cancelling and harvesting partial",
                    len(pending), cfg.sync_branch_timeout_sec,
                )
                await self._cancel_all_branches(branch_tasks)
            sync_block_sec = time.monotonic() - t0_block
            branch_finished_at = time.monotonic()
            atoms_pool = self._harvest_branches_to_pool(branch_states, atoms)
            atoms_pool_evolution.append({k: list(v) for k, v in atoms_pool.items()})
            sync_blocked = True

        t_action_fired = time.monotonic()
        # Run tool synchronously. Branches keep running in parallel.
        try:
            output = await asyncio.to_thread(self.env.execute, action_command)
            tool_duration = time.monotonic() - t_action_fired
            tool_timed_out = False
        except Exception as e:
            output = {"output": str(e), "returncode": -1}
            tool_duration = time.monotonic() - t_action_fired
            tool_timed_out = "timeout" in type(e).__name__.lower()

        # Tool exec done — the last burst's branches' working window
        # ends here. Cancel and harvest into the FINAL atoms_pool.
        t_before_cancel = time.monotonic()
        # Oracle arm: branches started at t_main_end instead of at stream open,
        # so by now they have only had the TOOL window. Grant the remaining
        # (t_main_end - t_stream_open) so the total equals an early fork's
        # window: main-stream wall + tool wall.
        if branch_tasks and cfg.mode == "reflect_oracle":
            deadline = t_branches_fired + (t_main_end - t_stream_open) + tool_duration
            extra = deadline - time.monotonic()
            if extra > 0:
                await asyncio.sleep(extra)
        if branch_tasks and not sync_blocked:
            await self._cancel_all_branches(branch_tasks)
            branch_finished_at = time.monotonic()
            atoms_pool = self._harvest_branches_to_pool(branch_states, atoms)
            atoms_pool_evolution.append({k: list(v) for k, v in atoms_pool.items()})
        t_branches_cancelled = time.monotonic()

        # Per-atom records reflect the LAST burst's raw text (for debug);
        # n_units / final pool comes from the refined atoms_pool which
        # represents the synthesis across all bursts.
        per_atom_records: dict[str, dict] = {}
        for atom in atoms:
            raw = branch_states.get(atom, {}).get("text", "")
            kept = truncate_at_last_complete_reflect(raw)
            per_atom_records[atom] = {
                "raw": raw,
                "kept": kept,
                "n_units": len(atoms_pool.get(atom, [])),
            }
        merged_reflect_block = interleave_typed_units_by_atom(atoms_pool, atoms)
        total_units = sum(len(v) for v in atoms_pool.values())
        branch_text_raw_concat = "\n".join(
            branch_states.get(a, {}).get("text", "") for a in atoms
        )

        head = buffer[: action_end]
        if cfg.mode == "reflect_inprompt":
            # No branches were forked: the units are in the main thread's own
            # output, already inside `head`. Count them off what actually
            # enters history so reflect_count stays comparable with the
            # branch arms. branch_* fields stay empty on purpose — there was
            # no branch. The unit TEXT is recoverable downstream with
            # parse_reflect_typed_units(assistant_text_kept).
            total_units = count_reflect_units(head)
        if cfg.mode in ("baseline", "reflect_inprompt"):
            assistant_kept = head.rstrip()
        elif cfg.mode == "s1extend":
            # History records the Phase-3 commit content (text + bash),
            # truncated at the end of the first bash. The extended
            # reasoning is preserved in turn_record.assistant_reasoning,
            # not in messages history (matches baseline/mini-swe-agent).
            if s1ext_final_action_end > 0:
                assistant_kept = s1ext_commit_content[: s1ext_final_action_end].rstrip()
            else:
                # Fallback: use natural buffer (no extension committed)
                assistant_kept = buffer[: action_end].rstrip()
        else:
            assistant_kept = head + (("\n" + merged_reflect_block) if merged_reflect_block else "")

        self.add_message("assistant", assistant_kept, reasoning=turn_reasoning)
        observation_text = self.render_template(
            self.config.action_observation_template, output=output
        )
        self.add_message("user", observation_text)

        is_submit_pending = self._will_submit(output)
        self.turn_records.append(ReflectTurnRecord(
            turn_idx=len(self.turn_records),
            action_type="submit" if is_submit_pending else "bash",
            action_content=action_command,
            tool_duration_sec=tool_duration,
            reflect_count=total_units,
            stream_ended_naturally=stream_eos,
            cancel_reason=cancel_reason,
            tool_returncode=output.get("returncode"),
            tool_timed_out=tool_timed_out,
            assistant_text=buffer,
            assistant_text_kept=assistant_kept,
            assistant_reasoning=turn_reasoning,
            context_token_len_before=ctx_before,
            context_token_len_after=_approx_tokens(self.messages),
            branch_text_raw=branch_text_raw_concat,
            branch_text_kept=merged_reflect_block,
            branch_per_atom=per_atom_records,
            branch_window_sec=(
                branch_finished_at - branch_started_at
                if branch_started_at and branch_finished_at
                else 0.0
            ),
            s1extend_natural_action=s1ext_natural_action,
            s1extend_extended_action=action_command if cfg.mode == "s1extend" else None,
            s1extend_extension_text=s1ext_extension_text,
            s1extend_extension_chars=len(s1ext_extension_text),
            s1extend_rounds=s1ext_rounds,
            raw_main_stream=raw_main,
            main_usage=main_usage,
            burst_count=burst_count,
            branch_cond_chars=branch_cond_chars,
            atoms_pool_evolution=atoms_pool_evolution,
            phase_times={
                # All values are seconds (durations or relative to t_step_start).
                "step_total": t_branches_cancelled - t_step_start,
                "ttft": (t_first_chunk - t_stream_open) if t_first_chunk else 0.0,
                "main_decode": (t_main_end - t_first_chunk) if t_first_chunk else 0.0,
                "main_stream_total": t_main_end - t_stream_open,
                "tool_exec": tool_duration,
                "post_main_to_tool_start": t_action_fired - t_main_end,
                "branch_cancel_wait": t_branches_cancelled - t_before_cancel,
                "branches_total_window": (
                    branch_finished_at - branch_started_at
                    if branch_started_at and branch_finished_at else 0.0
                ),
                # Branches were active during this window (parallel with
                # main+tool). If branches_total_window > main_stream_total
                # + tool_exec, branches were the bottleneck.
                "main_plus_tool": (t_main_end - t_stream_open) + tool_duration,
                # reflect_sync only: wall actually spent BLOCKED on the
                # branches before the tool could start. This is the arm's
                # latency price -- the quantity the async arm hides.
                "branch_block_sec": sync_block_sec,
                "branch_block_timed_out": sync_block_timed_out,
            },
        ))

        if tool_timed_out:
            raise ExecutionTimeoutError(
                self.render_template(
                    self.config.timeout_template,
                    action={"action": action_command},
                    output=output.get("output", ""),
                )
            )
        self.has_finished(output)
        return output

    async def _run_branch_atom(
        self,
        snapshot: list[dict],
        reasoning_text: str,
        atom: str,
        state: dict,
    ) -> None:
        """One atom's branch call. Streams into state['text'] until
        cancelled or its per-atom unit cap is hit."""
        cfg: ReflectAgentConfig = self.config  # type: ignore[assignment]
        branch_messages = build_branch_atom_messages(snapshot, reasoning_text, atom)
        try:
            async with self.model.stream(
                branch_messages,
                extra_body=cfg.branch_extra_body,
                count_call=False,
                **self._branch_token_kwargs(),
            ) as tokens:
                async for chunk in tokens:
                    state["text"] += chunk
                    if count_reflect_units(state["text"]) >= cfg.max_reflect_per_turn:
                        break
        except asyncio.CancelledError:
            # Re-raise: swallowing it marks the task "completed" and hides a
            # branch that is actually stuck in its own stream teardown.
            raise
        except Exception as e:  # pragma: no cover
            logger.exception("branch atom %s failed: %s", atom, e)

    @staticmethod
    async def _cancel_all_branches(
        tasks: dict[str, asyncio.Task], timeout: float = 10.0
    ) -> None:
        """Cancel every branch and wait for it to actually settle.

        Bounded: a branch that hangs inside its own cleanup (the stream's
        ``finally`` awaits ``AsyncStream.close()``, which does network I/O)
        must not be able to wedge the whole run. On timeout we abandon it
        and log -- the connection still gets reaped when the client's read
        timeout fires.
        """
        if not tasks:
            return
        for t in tasks.values():
            if not t.done():
                t.cancel()
        # asyncio.wait, NOT wait_for(gather(...)): wait_for waits for the
        # cancellation it requested to COMPLETE, so a task that stalls in its
        # own cleanup would hang here forever -- the exact failure this bound
        # exists to prevent. asyncio.wait just returns what is still pending.
        _, pending = await asyncio.wait(set(tasks.values()), timeout=timeout)
        if pending:
            stuck = sorted(a for a, t in tasks.items() if t in pending)
            logger.warning(
                "branch cancellation did not settle within %.1fs; abandoning %s",
                timeout, ",".join(stuck) or "?",
            )

    async def _run_refine_branch(
        self,
        snapshot: list[dict],
        main_so_far_text: str,
        atom: str,
        prior_atoms_pool: dict,
        state: dict,
    ) -> None:
        """Branch call for refined multi-fire reflect.

        Sees:
          - assistant message with main-thread content emitted so far in
            this turn (evolves across bursts)
          - user message with prior bursts' atoms (if any) + standard
            atom prompt — model implicitly refines them by emitting
            updated reflections.
        """
        cfg: ReflectAgentConfig = self.config  # type: ignore[assignment]
        branch_messages = build_refine_branch_messages(
            snapshot, main_so_far_text, atom, prior_atoms_pool
        )
        try:
            async with self.model.stream(
                branch_messages,
                extra_body=cfg.branch_extra_body,
                count_call=False,
                **self._branch_token_kwargs(),
            ) as tokens:
                async for chunk in tokens:
                    state["text"] += chunk
                    if count_reflect_units(state["text"]) >= cfg.max_reflect_per_turn:
                        break
        except asyncio.CancelledError:
            raise  # see _run_branch_atom
        except Exception as e:  # pragma: no cover
            logger.exception("refine branch atom %s failed: %s", atom, e)

    def _branch_token_kwargs(self) -> dict:
        """``max_tokens`` override for branch calls, or {} to inherit."""
        cap = getattr(self.config, "branch_max_tokens", None)
        return {"max_tokens": cap} if cap else {}

    @staticmethod
    def _harvest_branches_to_pool(
        branch_states: dict[str, dict],
        atoms: list[str],
    ) -> dict[str, list[str]]:
        """Parse each branch's accumulated text into its atom's units;
        return a fresh pool dict {atom: [unit_str, ...]}.

        Called after _cancel_all_branches to extract partial atoms."""
        pool: dict[str, list[str]] = {}
        for atom in atoms:
            raw = branch_states.get(atom, {}).get("text", "")
            kept = truncate_at_last_complete_reflect(raw)
            typed = parse_reflect_typed_units(kept)
            pool[atom] = [body for (t, body) in typed if t == atom]
        return pool

    def _will_submit(self, output: dict[str, str]) -> bool:
        text = (output.get("output") or "").lstrip()
        first = text.splitlines()[0].strip() if text else ""
        return first in ("MINI_SWE_AGENT_FINAL_OUTPUT", "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT")
