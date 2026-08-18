"""tau2 (τ³-bench) adapter — parallel multi-atom branch reflection + s1extend.

Implements the branch-reflection mechanics on tau2's half-duplex
`generate_next_message` agent API.

ReflectLLMAgent ("reflect_llm_agent"):
  On each agent turn: fire one branch per atom (check/rehearse/recall/
  alternative) on a snapshot of the conversation + atom continuation prompt,
  via tau2's own `generate` (tools=None), on a ThreadPoolExecutor, while the
  main tool-calling generation runs inline. When main returns: ZERO-GRACE
  harvest (wait-zero, same policy as the core streaming_agent), parse typed
  reflect units, interleave, and append the merged block to the assistant
  message's `content` — tau2 preserves content across turns, so the model
  sees its own reflections on later turns (true in-history fold-in; no
  engine-level synthetic messages needed).

S1LLMAgent ("s1_llm_agent"):
  Serial "Wait" budget forcing adapted to tool-calling: (1) normal main call;
  (2) extend its textual deliberation via prefix-continuation rounds
  (OpenRouter, provider pinned per model family like the main call; target
  300 tok / max 6 rounds, SWE-Pro parity); (3) commit: re-generate with tools,
  with the extended deliberation injected as a one-shot private-scratchpad
  user message (NOT persisted to state). Falls back to the plain main output
  on any error, recording `s1_error` so a broken arm is distinguishable from
  a model that simply did not extend.

  The prefix rounds are a side-channel call, so their tokens never reach
  tau2's usage accounting — `s1_ext_tokens` in the record carries them.

RECORDING: one JSONL line per turn to $TAU2_REFLECT_LOG
(default /tmp/tau2_reflect_records.jsonl): agent_id groups turns of one
simulation; ctx/main/branch raw+kept/merged or s1 rounds/ext chars; native
usage (prompt/completion tokens) when tau2 attaches it to the message.
"""
from __future__ import annotations

import atexit
import itertools
import json
import logging
import os
import sys
import threading
import time
import weakref
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FutTimeout
from typing import List, Optional

# Repo root: defaults to this checkout (adapters/<name>/<file>.py -> ../../).
_SECOND_THOUGHT_ROOT = os.environ.get("SECOND_THOUGHT_ROOT") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
if _SECOND_THOUGHT_ROOT not in sys.path:
    sys.path.insert(0, _SECOND_THOUGHT_ROOT)

from second_thought.action_detector import (  # noqa: E402
    interleave_typed_units_by_atom,
    parse_reflect_typed_units,
    truncate_at_last_complete_reflect,
)
from second_thought.prompts import ATOM_NAMES, REFLECT_ATOMS  # noqa: E402

from tau2.agent.llm_agent import LLMAgent, LLMAgentState  # noqa: E402
from tau2.data_model.message import (  # noqa: E402
    AssistantMessage,
    MultiToolMessage,
    UserMessage,
)
from tau2.utils.llm_utils import generate  # noqa: E402

logger = logging.getLogger(__name__)

_BRANCH_PROMPT_PREFIX = (
    "Before you commit to your next tool call or reply, take one short reflective pass. "
)
_ATOM_PROMPTS = {a: _BRANCH_PROMPT_PREFIX + info["prompt"] for a, info in REFLECT_ATOMS.items()}

# Per-atom kept-unit cap at harvest (the banking analogue of TB2's
# max_reflect_per_turn). Default 20 = historical behavior; the minimax
# over-production diagnosis (6.8 units/harvest vs qwen 1.9) motivates
# small caps on dialog benches.
_UNIT_CAP = int(os.environ.get("TAU2_REFLECT_UNIT_CAP", "20"))

# Per-TURN total kept-unit cap — the exact analogue of TB2's
# max_reflect_per_turn (a budget over the whole turn, not per atom and not per
# harvest). 0 = unlimited = historical behavior. Applied after _UNIT_CAP, in the
# same round-robin order interleave_typed_units_by_atom() traverses, so capping
# to N keeps the first N units of the merged block unchanged.
_TURN_CAP = int(os.environ.get("TAU2_REFLECT_TURN_CAP", "0"))


def _turn_budget(content: Optional[str]) -> int:
    """Units still allowed on the message being folded into (-1 = uncapped).

    The streaming path can harvest into the SAME assistant message more than
    once per turn, so the budget must be measured against what is already
    folded in — applying the cap per harvest lets a turn accumulate 2N, 3N…
    """
    if _TURN_CAP <= 0:
        return -1
    from second_thought.action_detector import count_reflect_units
    return max(0, _TURN_CAP - count_reflect_units(content or ""))


def _cap_turn_total(units: dict[str, list[str]], atom_order: list[str],
                    cap: int) -> dict[str, list[str]]:
    """Truncate per-atom unit lists so the round-robin merge yields <= cap units.

    cap < 0 disables the cap; cap == 0 keeps nothing.
    """
    if cap < 0:
        return units
    if cap == 0:
        return {a: [] for a in units}
    keep = {a: 0 for a in units}
    n = 0
    max_len = max((len(units.get(a) or []) for a in atom_order), default=0)
    for i in range(max_len):
        for a in atom_order:
            if n >= cap:
                break
            if i < len(units.get(a) or []):
                keep[a] += 1
                n += 1
        if n >= cap:
            break
    return {a: (v or [])[:keep.get(a, 0)] for a, v in units.items()}

_REC_PATH = os.environ.get("TAU2_REFLECT_LOG", "/tmp/tau2_reflect_records.jsonl")
_REC_LOCK = threading.Lock()

# Stall forensics: `kill -USR1 <pid>` dumps all Python thread stacks.
try:
    import faulthandler as _fh
    import signal as _sig
    _fh.register(_sig.SIGUSR1, file=open(
        os.environ.get("TAU2_STACKDUMP", "/tmp/tau2_reflect_stacks.txt"), "a"),
        all_threads=True)
except Exception:
    pass

S1_TARGET_TOKENS = int(os.environ.get("S1_TARGET_TOKENS", "300"))
S1_MAX_ROUNDS = int(os.environ.get("S1_MAX_ROUNDS", "6"))


def _record(obj: dict) -> None:
    try:
        with _REC_LOCK:
            with open(_REC_PATH, "a") as f:
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _usage_of(msg) -> dict:
    u = getattr(msg, "usage", None)
    if u is None:
        return {}
    if hasattr(u, "model_dump"):
        u = u.model_dump()
    if isinstance(u, dict):
        return {k: u.get(k) for k in ("prompt_tokens", "completion_tokens") if u.get(k)}
    return {}


def _ctx_chars(messages) -> int:
    tot = 0
    for m in messages:
        c = getattr(m, "content", None)
        if isinstance(c, str):
            tot += len(c)
    return tot


def _call_branch(model: str, messages, llm_args: dict, atom: str) -> str:
    try:
        msg = generate(
            model=model,
            tools=None,
            messages=list(messages) + [UserMessage(role="user", content=_ATOM_PROMPTS[atom])],
            call_name="reflect_branch",
            **{k: v for k, v in (llm_args or {}).items() if k != "tool_choice"},
        )
        return getattr(msg, "content", "") or ""
    except Exception as e:
        logger.debug("branch %s failed: %s", atom, e)
        return ""


_STREAM_CLIENT = None
_STREAM_CLIENT_LOCK = threading.Lock()


def _stream_client():
    """Dedicated OpenAI-SDK client for the reflect agent's streaming calls.

    litellm's SYNC streaming path proved unable to enforce timeouts at the
    request phase (2026-07-16 stack dump: worker wedged inside
    llm_http_handler.make_sync_call despite per-call timeout + tenacity), and
    it shares tau2's bounded global httpx session. The OpenAI SDK enforces
    connect/read/pool timeouts reliably (the mini-swe path runs on it with
    zero hangs) and owns a separate, generous connection pool.
    """
    global _STREAM_CLIENT
    with _STREAM_CLIENT_LOCK:
        if _STREAM_CLIENT is None:
            import httpx
            from openai import OpenAI
            _STREAM_CLIENT = OpenAI(
                base_url=os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
                api_key=os.environ["OPENROUTER_API_KEY"],
                timeout=httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=60.0),
                max_retries=0,  # attempt loop / fallback handled by callers
            )
        return _STREAM_CLIENT


def _sdk_kwargs(llm_args: Optional[dict]) -> dict:
    """llm_args -> safe SDK kwargs (drop transport keys we manage ourselves)."""
    out = {}
    for k in ("temperature", "max_tokens", "top_p"):
        if llm_args and llm_args.get(k) is not None:
            out[k] = llm_args[k]
    return out


_AGENT_SEQ = itertools.count(1)
# Every live streaming agent, so process exit can stop forks that no turn
# will ever harvest (the last turn of every episode forks one).
_LIVE_AGENTS: "weakref.WeakSet" = weakref.WeakSet()


def _shutdown_shared_executor() -> None:
    """atexit hook: stop any branch thread still running at process exit.

    Order matters. Closing the sockets first is what actually unblocks the
    workers: `shutdown(wait=False)` does not stop a thread already blocked
    on an SSE read, and concurrent.futures' own atexit handler then JOINS
    those workers -- which is why runs were observed hanging for up to an
    hour after their last episode finished.
    """
    for ag in list(_LIVE_AGENTS):
        try:
            ag._abort_pending("process_exit")
        except Exception:
            pass
    for cls in (StreamingReflectLLMAgent,):
        ex = getattr(cls, "_SHARED_EXECUTOR", None)
        if ex is not None:
            try:
                ex.shutdown(wait=False, cancel_futures=True)
            except TypeError:  # py<3.9
                ex.shutdown(wait=False)
            except Exception:
                pass
            cls._SHARED_EXECUTOR = None


atexit.register(_shutdown_shared_executor)


def _close_stream(stream) -> None:
    """Best-effort close of a litellm streaming wrapper + its transport."""
    if stream is None:
        return
    for obj in (stream, getattr(stream, "completion_stream", None)):
        try:
            close = getattr(obj, "close", None)
            if callable(close):
                close()
        except Exception:
            pass


def _openrouter_client():
    from openai import OpenAI
    return OpenAI(
        base_url=os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        api_key=os.environ["OPENROUTER_API_KEY"],
        timeout=120.0,
    )


def _plain_msgs(messages) -> list[dict]:
    out = []
    for m in messages:
        role = getattr(m, "role", "user")
        if role not in ("system", "user", "assistant"):
            role = "user"
        c = getattr(m, "content", None) or ""
        if not isinstance(c, str):
            c = str(c)
        out.append({"role": role, "content": c})
    return out


def _or_model(model: str) -> str:
    return model.split("openrouter/", 1)[1] if model.startswith("openrouter/") else model


def _provider_pin(bare_model: str) -> dict:
    """OpenRouter provider pin for a model family; {} when the model is unpinned.

    Single source of truth for every OpenRouter call in this module. S1LLMAgent
    used to hardcode the deepseek pin unconditionally, so on any non-deepseek
    model OpenRouter rejected the prefix-continuation request, the s1extend
    loop fell straight through to its `except`, and the arm silently degraded
    to plain baseline output — indistinguishable in the data from "the model
    refused to extend".
    """
    if bare_model.startswith("deepseek/"):
        return {"provider": {"order": ["deepseek"], "allow_fallbacks": False}}
    if bare_model.startswith("minimax/"):
        return {"provider": {"order": ["minimax/fp8"], "allow_fallbacks": False}}
    return {}


def _completion_tokens(response) -> int:
    """Completion tokens the provider reports, 0 if it reports none."""
    try:
        return int(getattr(getattr(response, "usage", None), "completion_tokens", 0) or 0)
    except Exception:
        return 0


class ReflectLLMAgent(LLMAgent):
    """LLMAgent + parallel multi-atom branch reflection (wait-zero)."""

    def __init__(self, tools, domain_policy, llm=None, llm_args=None,
                 reflect_atoms: Optional[List[str]] = None):
        super().__init__(tools=tools, domain_policy=domain_policy, llm=llm, llm_args=llm_args)
        atoms = reflect_atoms or list(ATOM_NAMES)
        self.reflect_atoms = list(atoms)
        self._executor = ThreadPoolExecutor(max_workers=2 * len(atoms))
        self._turn = 0
        self._aid = f"a{next(_AGENT_SEQ)}"  # see StreamingReflectLLMAgent.__init__

    def _generate_next_message(self, message, state: LLMAgentState) -> AssistantMessage:
        if isinstance(message, MultiToolMessage):
            state.messages.extend(message.tool_messages)
        else:
            state.messages.append(message)
        convo = state.system_messages + state.messages
        self._turn += 1
        futs = {
            a: self._executor.submit(_call_branch, self.llm, convo, self.llm_args, a)
            for a in self.reflect_atoms
        }
        t0 = time.time()
        assistant_message = generate(
            model=self.llm, tools=self.tools, messages=convo,
            call_name="agent_response", **self.llm_args,
        )
        main_ms = int(1000 * (time.time() - t0))
        units: dict[str, list[str]] = {a: [] for a in self.reflect_atoms}
        raw: dict[str, int] = {}
        for a, fut in futs.items():
            try:
                text = fut.result(timeout=0)  # wait-zero
            except (_FutTimeout, Exception):
                fut.cancel()
                text = ""
            raw[a] = len(text)
            kept = truncate_at_last_complete_reflect(text)
            units[a] = [b for (t, b) in parse_reflect_typed_units(kept) if t == a][:_UNIT_CAP]
        units = _cap_turn_total(units, self.reflect_atoms,
                                _turn_budget(assistant_message.content))
        merged = interleave_typed_units_by_atom(units, self.reflect_atoms)
        if merged and os.environ.get("TAU2_SUBST_HINT") == "1":
            # reflect-v2 ablation: substitution hint — frame reflections as
            # COMPLETED deliberation so the model acts on them instead of
            # re-deliberating (targets the short-task +43% output overhead).
            merged += ("\n(Reflection pass complete. These checks are my own finished "
                       "deliberation for this step: if they flag no problem, I will act "
                       "directly now without re-deliberating.)")
        if merged:
            existing = assistant_message.content or ""
            assistant_message.content = (existing.rstrip() + "\n\n" + merged) if existing.strip() else merged
        _record({
            "mode": "reflect", "agent_id": self._aid, "turn": self._turn, "ts": time.time(),
            "ctx_chars": _ctx_chars(convo), "main_ms": main_ms,
            "main_chars": len(assistant_message.content or ""),
            "has_tool_calls": bool(getattr(assistant_message, "tool_calls", None)),
            "branch_raw_chars": raw, "branch_kept_units": {a: len(v) for a, v in units.items()},
            "merged_chars": len(merged), "usage": _usage_of(assistant_message),
        })
        return assistant_message


class S1LLMAgent(LLMAgent):
    """LLMAgent + serial 'Wait' budget forcing (s1extend, tool-calling form)."""

    def __init__(self, tools, domain_policy, llm=None, llm_args=None):
        super().__init__(tools=tools, domain_policy=domain_policy, llm=llm, llm_args=llm_args)
        self._turn = 0
        self._aid = f"a{next(_AGENT_SEQ)}"  # see StreamingReflectLLMAgent.__init__

    def _generate_next_message(self, message, state: LLMAgentState) -> AssistantMessage:
        if isinstance(message, MultiToolMessage):
            state.messages.extend(message.tool_messages)
        else:
            state.messages.append(message)
        convo = state.system_messages + state.messages
        self._turn += 1
        t0 = time.time()
        main = generate(model=self.llm, tools=self.tools, messages=convo,
                        call_name="agent_response", **self.llm_args)
        main_ms = int(1000 * (time.time() - t0))
        rounds = 0
        ext_chars = 0
        ext_tokens = 0        # provider-reported completion tokens of the prefix rounds
        ext_tokens_exact = True
        s1_error = None
        final = main
        model = _or_model(self.llm)
        try:
            client = _openrouter_client()
            plain = _plain_msgs(convo)
            thought = (main.content or "Let me think about the right next step.").strip()
            # Budget on the provider's own completion_tokens when it reports
            # them; chars//4 is only the fallback (RULE 0).
            while rounds < S1_MAX_ROUNDS and self._spent(ext_tokens, ext_chars) < S1_TARGET_TOKENS:
                r = client.chat.completions.create(
                    model=model,
                    messages=plain + [{"role": "assistant", "content": thought + "\nWait,", "prefix": True}],
                    max_tokens=400, temperature=0.2,
                    extra_body=_provider_pin(model),
                )
                cont = r.choices[0].message.content or ""
                rounds += 1
                n_tok = _completion_tokens(r)
                if not n_tok:
                    ext_tokens_exact = False
                ext_tokens += n_tok
                if not cont.strip():
                    break
                thought = thought + "\nWait," + cont.rstrip()
                ext_chars += len(cont)
            if ext_chars > 0:
                scratch = UserMessage(role="user", content=(
                    "(Private scratchpad — this is your OWN extended deliberation, "
                    "not a customer message. Re-read it, then produce your final "
                    "reply or tool call now.)\n\n" + thought
                ))
                final = generate(model=self.llm, tools=self.tools,
                                 messages=convo + [scratch],
                                 call_name="agent_response", **self.llm_args)
        except Exception as e:
            # A dead arm must not look like "the model declined to extend":
            # the failure is recorded below so zero-extension turns can be
            # told apart from broken ones when the runs are analysed.
            s1_error = f"{type(e).__name__}: {e}"
            logger.warning("s1extend failed (fallback to plain): %s", e)
            final = main
            rounds = rounds or 0
        _record({
            "mode": "s1extend", "agent_id": self._aid, "turn": self._turn, "ts": time.time(),
            "ctx_chars": _ctx_chars(convo), "main_ms": main_ms,
            "main_chars": len(main.content or ""), "s1_rounds": rounds,
            "s1_ext_chars": ext_chars, "final_chars": len(final.content or ""),
            # Prefix rounds are billed on a side-channel OpenRouter call that
            # tau2's own usage accounting never sees; carry their tokens here
            # so the arm's real output can be added back downstream.
            "s1_ext_tokens": ext_tokens,
            "s1_ext_tokens_exact": ext_tokens_exact,
            "s1_provider_pin": _provider_pin(model) or None,
            "s1_error": s1_error,
            "has_tool_calls": bool(getattr(final, "tool_calls", None)),
            "usage": _usage_of(final),
        })
        return final

    @staticmethod
    def _spent(ext_tokens: int, ext_chars: int) -> int:
        """Extension budget spent so far, in tokens."""
        return ext_tokens if ext_tokens else ext_chars // 4


class StreamingReflectLLMAgent(LLMAgent):
    """Streaming reflect agent — TARGET DESIGN on the tau2 protocol.

    Replaces the blocking `generate()` for the AGENT's own call with a
    litellm streaming call so the fork point is observable:
      1. While reasoning deltas flow, wait.
      2. On the first content/tool_call delta (= first reasoning segment
         just ended) fork one branch per atom; each branch sees the
         conversation snapshot + a synthetic assistant message carrying the
         JUST-FINISHED REASONING + the atom prompt.
      3. Branches keep running while the main stream finishes AND while the
         tool/user-simulator produces the observation. CROSS-BOUNDARY
         wait-zero harvest at the START of the NEXT agent call (= the
         moment the observation is available) — the tau2 analog of
         mini-swe's tool-done cancel.
      4. Fold the merged reflect block into the AGENT'S OWN history copy of
         the previous assistant message (state.messages holds the same
         object) — the user simulator never sees reflections (matches
         mini-swe fold-in semantics; the old blocking agent leaked them).

    minimax adaptation (probe 2026-07-15): the model stops thinking when
    history lacks reasoning → pass recorded reasoning back into the MAIN
    call's history as OpenRouter `reasoning_details` blocks (minimax only,
    identical in all arms).
    """

    # ONE pool per process (tau2 builds a NEW agent per simulation; per-instance
    # pools leaked ~8 threads/sim and amplified the connection-pool deadlock).
    _SHARED_EXECUTOR: Optional[ThreadPoolExecutor] = None

    def __init__(self, tools, domain_policy, llm=None, llm_args=None,
                 reflect_atoms: Optional[List[str]] = None):
        super().__init__(tools=tools, domain_policy=domain_policy, llm=llm, llm_args=llm_args)
        atoms = reflect_atoms or list(ATOM_NAMES)
        self.reflect_atoms = list(atoms)
        cls = type(self)
        if cls._SHARED_EXECUTOR is None:
            cls._SHARED_EXECUTOR = ThreadPoolExecutor(max_workers=16)
        self._executor = cls._SHARED_EXECUTOR
        self._turn = 0
        # Process-unique agent id. `id(self)` was used until 2026-07-28; CPython
        # recycles addresses, so freed agents collided with live ones (measured:
        # 16 collisions in one banking run) and inflated n_tasks by 11-32%.
        self._aid = f"a{next(_AGENT_SEQ)}"
        _LIVE_AGENTS.add(self)
        self._pending: Optional[dict] = None      # branches awaiting next-call harvest
        self._last_assistant: Optional[AssistantMessage] = None
        self._rsn_of: dict[int, str] = {}         # id(AssistantMessage) -> reasoning text

    # -- helpers ---------------------------------------------------------
    def _bare_model(self) -> str:
        return _or_model(self.llm)

    def _main_extra_body(self) -> dict:
        return {"include_reasoning": True} | _provider_pin(self._bare_model())

    def _litellm_messages(self, convo) -> list[dict]:
        from tau2.utils.llm_utils import to_litellm_messages
        msgs = to_litellm_messages(convo)
        if not self._bare_model().startswith("minimax/"):
            return msgs
        # minimax interleaved-thinking pass-back: attach reasoning_details to
        # prior assistant messages (order-matched queue).
        rsn_queue = [self._rsn_of.get(id(m), "") for m in convo
                     if isinstance(m, AssistantMessage)]
        qi = 0
        for d in msgs:
            if d.get("role") == "assistant":
                rsn = rsn_queue[qi] if qi < len(rsn_queue) else ""
                qi += 1
                if rsn:
                    d["reasoning_details"] = [{
                        "type": "reasoning.text", "text": rsn,
                        "format": "unknown", "index": 0,
                    }]
        return msgs

    def _stream_branch(self, msgs_lite: list[dict], atom: str,
                       state: dict, stop) -> None:
        """One branch call, STREAMED so wait-zero harvest keeps whatever
        units have already arrived (blocking generate() is all-or-nothing
        and yields nothing inside short idle windows)."""
        from second_thought.action_detector import count_reflect_units
        stream = None
        try:
            eb = self._main_extra_body() | {"include_reasoning": False}
            stream = _stream_client().chat.completions.create(
                model=self._bare_model(),
                messages=msgs_lite + [{"role": "user", "content": _ATOM_PROMPTS[atom]}],
                stream=True,
                extra_body=eb,
                **_sdk_kwargs(self.llm_args))
            # Expose the live stream so the HARVEST thread can force-close it.
            # stop-event alone is passive: a reader blocked on a stalled SSE
            # never re-checks it. SDK read-timeout (120s) is the hard bound.
            state["_stream"] = stream
            for chunk in stream:
                if stop.is_set():
                    break
                try:
                    delta = chunk.choices[0].delta
                except (IndexError, AttributeError):
                    continue
                c = getattr(delta, "content", None)
                if c:
                    state["text"] += c
                    if count_reflect_units(state["text"]) >= 20:
                        break
        except Exception as e:
            logger.debug("stream branch %s failed: %s", atom, e)
        finally:
            # CRITICAL: release the pooled connection. Breaking out of the
            # iterator without closing leaks the checked-out connection of
            # tau2's SHARED bounded httpx.Client -> pool exhaustion ->
            # process-wide deadlock (2026-07-16: 108 threads all futex_wait,
            # 106 leaked TCP conns).
            _close_stream(stream)

    def _fork_branches(self, convo, reasoning_text: str) -> dict:
        base_lite = self._litellm_messages(convo)
        if reasoning_text.strip():
            base_lite = base_lite + [{"role": "assistant", "content": reasoning_text}]
        import threading as _th
        stop = _th.Event()
        states = {a: {"text": ""} for a in self.reflect_atoms}
        futs = {}
        for a in self.reflect_atoms:
            futs[a] = self._executor.submit(
                self._stream_branch, list(base_lite), a, states[a], stop)
        return {"futs": futs, "states": states, "stop": stop}

    def _abort_pending(self, why: str) -> None:
        """Stop a fork we are never going to harvest.

        Added 2026-07-28. Two paths used to drop the reference to a live
        fork without stopping it: the retry loop in `_stream_main` (which
        re-forks and overwrites `self._pending`) and its fallback (which
        set `self._pending = None`). The abandoned threads then streamed on
        until natural EOS or the 120 s read timeout, each holding one of
        the 16 shared workers and one pooled connection -- the same
        exhaustion mode that deadlocked the process on 2026-07-16.
        Also records the event, so a fork that never reached a harvest is
        visible in the JSONL instead of silently leaving the denominator.
        """
        p, self._pending = self._pending, None
        if not p:
            return
        try:
            p["stop"].set()
        except Exception:
            pass
        for st in (p.get("states") or {}).values():
            _close_stream(st.get("_stream"))
        for fut in (p.get("futs") or {}).values():
            try:
                fut.cancel()
            except Exception:
                pass
        _record({
            "mode": "reflect_stream_abort", "agent_id": self._aid,
            "turn": p.get("turn"), "ts": time.time(), "why": why,
            "cond_chars": p.get("cond_chars"),
            "branch_raw_chars": {
                a: len((p.get("states") or {}).get(a, {}).get("text", ""))
                for a in self.reflect_atoms
            },
        })

    def close(self) -> None:
        """Release anything the last turn left running.

        The last turn of an episode forks branches that no later
        `_generate_next_message` ever harvests, so without this they leak.
        Safe to call more than once.
        """
        self._abort_pending("episode_end")

    def _harvest_pending(self) -> None:
        """Cross-boundary wait-zero harvest into the agent's own history."""
        p, self._pending = self._pending, None
        if not p:
            return
        p["stop"].set()  # wait-zero: stop branch streams NOW, keep what arrived
        # ACTIVE close: unblock readers stuck awaiting a stalled SSE chunk and
        # force the pooled connections back (passive stop-event is not enough).
        for st in p["states"].values():
            _close_stream(st.get("_stream"))
        units: dict[str, list[str]] = {a: [] for a in self.reflect_atoms}
        raw: dict[str, int] = {}
        for a in self.reflect_atoms:
            text = p["states"].get(a, {}).get("text", "")
            fut = p["futs"].get(a)
            if fut is not None:
                fut.cancel()
            raw[a] = len(text)
            kept = truncate_at_last_complete_reflect(text)
            units[a] = [b for (t, b) in parse_reflect_typed_units(kept) if t == a][:_UNIT_CAP]
        tgt = self._last_assistant
        units = _cap_turn_total(units, self.reflect_atoms,
                                _turn_budget(tgt.content if tgt is not None else ""))
        merged = interleave_typed_units_by_atom(units, self.reflect_atoms)
        if merged and tgt is not None:
            existing = tgt.content or ""
            tgt.content = (existing.rstrip() + "\n\n" + merged) if existing.strip() else merged
        _record({
            "mode": "reflect_stream_harvest", "agent_id": self._aid, "turn": p["turn"],
            "ts": time.time(), "window_s": round(time.time() - p["fork_ts"], 3),
            "cond_chars": p["cond_chars"],
            "branch_raw_chars": raw,
            "branch_kept_units": {a: len(v) for a, v in units.items()},
            "merged_chars": len(merged),
            # full branch raw text (parity with mini-swe branch_text_raw):
            # needed for RULE-0 branch-decode tokenization + unit audits.
            "branch_texts": {a: p["states"].get(a, {}).get("text", "")[:20000]
                             for a in self.reflect_atoms},
        })

    def _stream_main(self, convo) -> AssistantMessage:
        lite_msgs = self._litellm_messages(convo)
        tools_schema = [t.openai_schema for t in self.tools] if self.tools else None
        fork_info = {"fired": False, "rsn_chars": 0, "ttfr_s": None}
        t0 = time.time()
        last_exc: Optional[Exception] = None
        for attempt in range(3):  # OpenRouter occasionally truncates right after reasoning
            rsn_buf: list[str] = []
            content_parts: list[str] = []
            tc_acc: dict[int, dict] = {}   # index -> {id, name, args parts}
            usage_obj = None
            fired = False
            stream = None
            try:
                create_kwargs = dict(
                    model=self._bare_model(), messages=lite_msgs,
                    stream=True, stream_options={"include_usage": True},
                    extra_body=self._main_extra_body(), **_sdk_kwargs(self.llm_args))
                if tools_schema:
                    create_kwargs["tools"] = tools_schema
                    create_kwargs["tool_choice"] = "auto"
                stream = _stream_client().chat.completions.create(**create_kwargs)
                for chunk in stream:
                    if getattr(chunk, "usage", None):
                        usage_obj = chunk.usage
                    try:
                        delta = chunk.choices[0].delta
                    except (IndexError, AttributeError):
                        continue
                    rsn_now = (getattr(delta, "reasoning", None)
                               or getattr(delta, "reasoning_content", None))
                    if rsn_now:
                        rsn_buf.append(rsn_now)
                    content_now = getattr(delta, "content", None)
                    if content_now:
                        content_parts.append(content_now)
                    tools_now = getattr(delta, "tool_calls", None)
                    for tc in (tools_now or []):
                        slot = tc_acc.setdefault(tc.index, {"id": None, "name": None, "args": []})
                        if getattr(tc, "id", None):
                            slot["id"] = tc.id
                        fn = getattr(tc, "function", None)
                        if fn is not None and getattr(fn, "name", None):
                            slot["name"] = fn.name
                        if fn is not None and getattr(fn, "arguments", None):
                            slot["args"].append(fn.arguments)
                    if self.reflect_atoms and (content_now or tools_now) and not rsn_now and not fired:
                        fired = True
                        reasoning_text = "".join(rsn_buf)
                        # A previous attempt of THIS turn may have forked
                        # already; stop it before we lose the reference.
                        if self._pending is not None:
                            self._abort_pending("refork_after_retry")
                        fork = self._fork_branches(convo, reasoning_text)
                        self._pending = {**fork, "turn": self._turn,
                                         "fork_ts": time.time(),
                                         "cond_chars": len(reasoning_text)}
                        fork_info.update(fired=True, rsn_chars=len(reasoning_text),
                                         ttfr_s=round(time.time() - t0, 3))
            except Exception as e:  # stream transport error / read timeout -> retry
                last_exc = e
                continue
            finally:
                _close_stream(stream)  # release the connection on every path
            content = "".join(content_parts) or None
            if not (content and content.strip()) and not tc_acc:
                continue  # truncated-after-reasoning: retry
            try:
                from tau2.data_model.message import ToolCall
                tool_calls = [ToolCall(id=slot["id"] or f"call_{i}",
                                       name=slot["name"],
                                       arguments=json.loads("".join(slot["args"]) or "{}"))
                              for i, slot in sorted(tc_acc.items())] or None
            except Exception:
                continue  # malformed tool args -> retry stream
            usage = None
            if usage_obj is not None:
                usage = {"prompt_tokens": getattr(usage_obj, "prompt_tokens", None),
                         "completion_tokens": getattr(usage_obj, "completion_tokens", None),
                         "total_tokens": getattr(usage_obj, "total_tokens", None)}
            msg = AssistantMessage(
                role="assistant", content=content, tool_calls=tool_calls,
                cost=0.0, usage=usage,
                raw_data={"transport": "openai-sdk-direct", "attempt": attempt},
                generation_time_seconds=time.time() - t0)
            reasoning_text = "".join(rsn_buf)
            self._rsn_of[id(msg)] = reasoning_text
            _record({
                "mode": getattr(self, "_rec_mode", "reflect_stream_main"),
                "agent_id": self._aid, "turn": self._turn,
                "ts": time.time(), "attempt": attempt,
                "rsn_chars": len(reasoning_text), "fired": fork_info["fired"],
                "cond_chars": fork_info["rsn_chars"], "ttfr_s": fork_info["ttfr_s"],
                "main_ms": int(1000 * (time.time() - t0)),
                "main_chars": len(content or ""),
                "has_tool_calls": bool(tool_calls),
                "usage": {k: (usage or {}).get(k) for k in ("prompt_tokens", "completion_tokens")} if usage else {},
                # full reasoning text (results.json only stores content):
                # enables conditioning audits + reasoning-level tokenization.
                "rsn_text": reasoning_text[:20000],
            })
            return msg
        # all retries failed -> blocking fallback (no branches this turn)
        logger.warning("stream main failed after retries (%s); falling back to blocking generate", last_exc)
        self._abort_pending("main_stream_failed")  # was: self._pending = None (leaked)
        return generate(model=self.llm, tools=self.tools, messages=convo,
                        call_name="agent_response", **self.llm_args)

    def _generate_next_message(self, message, state: LLMAgentState) -> AssistantMessage:
        # (1) observation has arrived -> harvest last turn's branches first
        self._harvest_pending()
        # (2) standard history append
        if isinstance(message, MultiToolMessage):
            state.messages.extend(message.tool_messages)
        else:
            state.messages.append(message)
        convo = state.system_messages + state.messages
        self._turn += 1
        # (3) streaming main call with reasoning-end fork
        assistant_message = self._stream_main(convo)
        self._last_assistant = assistant_message
        return assistant_message


class StreamingBaselineLLMAgent(StreamingReflectLLMAgent):
    """BASELINE twin of the streaming reflect agent: identical transport
    (OpenAI-SDK direct), provider pin, reasoning capture and pass-back —
    but ZERO branches. Gives the reflect arm a serving-matched pair."""

    def __init__(self, tools, domain_policy, llm=None, llm_args=None, **_):
        super().__init__(tools=tools, domain_policy=domain_policy, llm=llm, llm_args=llm_args)
        self.reflect_atoms = []          # never fork
        self._rec_mode = "baseline_stream_main"


def create_reflect_llm_agent(tools, domain_policy, **kwargs):
    return StreamingReflectLLMAgent(tools=tools, domain_policy=domain_policy,
                                    llm=kwargs.get("llm"), llm_args=kwargs.get("llm_args"))


def create_baseline_llm_agent_stream(tools, domain_policy, **kwargs):
    return StreamingBaselineLLMAgent(tools=tools, domain_policy=domain_policy,
                                     llm=kwargs.get("llm"), llm_args=kwargs.get("llm_args"))


def create_reflect_llm_agent_blocking(tools, domain_policy, **kwargs):
    return ReflectLLMAgent(tools=tools, domain_policy=domain_policy,
                           llm=kwargs.get("llm"), llm_args=kwargs.get("llm_args"))


def create_s1_llm_agent(tools, domain_policy, **kwargs):
    return S1LLMAgent(tools=tools, domain_policy=domain_policy,
                      llm=kwargs.get("llm"), llm_args=kwargs.get("llm_args"))


def register() -> None:
    from tau2.registry import registry
    registry.register_agent_factory(create_reflect_llm_agent, "reflect_llm_agent")
    registry.register_agent_factory(create_reflect_llm_agent_blocking, "reflect_llm_agent_blocking")
    registry.register_agent_factory(create_baseline_llm_agent_stream, "baseline_llm_agent_stream")
    registry.register_agent_factory(create_s1_llm_agent, "s1_llm_agent")
    logger.warning("Registered reflect_llm_agent (STREAMING) + reflect_llm_agent_blocking + s1_llm_agent")


if __name__ == "__main__":
    # Launcher: python second_thought_agent.py run --agent reflect_llm_agent ...
    register()
    from tau2.cli import main
    sys.argv = ["tau2"] + sys.argv[1:]
    sys.exit(main())
