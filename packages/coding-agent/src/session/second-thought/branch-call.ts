/**
 * Second Thought branch calls: fork-time snapshot, request construction, and
 * the streaming side-call executor.
 *
 * The module is deliberately host-agnostic — it takes plain options and a
 * small {@link BranchCallHost} of injected capabilities, never an
 * `AgentSession`. Wiring into the session (fork trigger, harvest, ledger)
 * belongs to the coordinator and integration concerns.
 *
 * Cache economics are the whole point of the request shape here: the branch
 * reuses the primary call's system prompt, normalized tool set, model, and
 * thinking configuration byte-for-byte, and appends only a one-message
 * synthetic suffix. Anything that perturbs the prefix (a different model, a
 * `toolChoice` parameter, `disableReasoning`/`forceReasoningOff`) costs a
 * full-price uncached input pass over the whole conversation, every turn.
 *
 * ## Why the suffix is a single USER message
 *
 * The reference implementation conditions a branch by prefilling a synthetic
 * ASSISTANT message with the just-emitted reasoning and then asking for a
 * continuation. That shape is unsafe here, and the golden test
 * (`test/second-thought/branch-prefix-golden.test.ts`) proves it against the
 * real Anthropic encoder rather than an in-memory `JSON.stringify`:
 * `transformMessages` resolves a single `latestSurvivingAssistantIndex`, and
 * several thinking-block policies key off it. Appending a synthetic assistant
 * moves that index off the conversation's real last assistant turn. For the
 * routine adaptive-model shape — an ABANDONED TOOL-USE turn (`stopReason !==
 * "toolUse"` while the content still carries `toolCall` blocks) with signed
 * thinking — the main call keeps those thinking blocks byte-for-byte
 * (`isLatestSurvivingAssistant && abandonedToolUse` short-circuit), while the
 * branch strips every signature and text-demotes or drops the blocks. The
 * wire prefix then diverges from the primary call's: the branch pays full
 * uncached input over the whole conversation and can trip Anthropic's
 * `400 Invalid signature in thinking block`.
 *
 * Carrying the conditioning text inside the combined-atom USER message leaves
 * the last assistant message exactly where the main call has it, so the
 * encoded prefix is byte-identical. Deviation and rationale are recorded in
 * `plans/second-thought/BUILD-NOTES-02.md`.
 *
 * ## maxTokens and budget thinking
 *
 * `branchMaxTokens` is a ceiling request, not a guarantee. On budget-style
 * thinking models (`thinking.mode` resolving to an `enabled` block with
 * `budget_tokens > 0`) the Anthropic provider's `ensureMaxTokensForThinking`
 * RAISES `max_tokens` to at least `budget_tokens + OUTPUT_FALLBACK_BUFFER`
 * (clamped to the model's output ceiling) so the thinking budget still fits.
 * A 2048-token branch cap on such a model is therefore silently widened. This
 * is deliberate — lowering the thinking budget instead would change the
 * thinking configuration and invalidate the messages-tier cache, which costs
 * far more than the extra decode. Current v1 gating is Anthropic adaptive
 * models, where no budget block is emitted and the cap holds exactly.
 */

import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { ATOM_NAMES, COMBINED_BRANCH_PROMPT, type ReflectAtom } from "./atoms";
import {
	countReflectUnits,
	parseReflectTypedUnits,
	type ReflectTypedUnit,
	truncateAtLastCompleteReflect,
} from "./parser";

/** `secondThought.branchMaxTokens` default. */
export const DEFAULT_BRANCH_MAX_TOKENS = 2048;

/** `secondThought.harvestCapPerAtom` default. */
export const DEFAULT_HARVEST_CAP_PER_ATOM = 20;

/** Side-channel session id segment identifying a Second Thought branch. */
export const BRANCH_SIDE_ROLE = "reflect";

/**
 * Fallback bound on the `startMany` stagger gate when the host options carry
 * no `streamFirstEventTimeoutMs`. Without a bound, a call 1 that never emits a
 * text delta (provider stall, thinking-only response, silent hang) deadlocks
 * every queued branch for the lifetime of the turn.
 */
export const DEFAULT_STAGGER_TIMEOUT_MS = 10_000;

/** Maximum events read after a unit-cap abort while looking for terminal usage. */
const MAX_USAGE_DRAIN_EVENTS = 32;

/**
 * A fully materialized, provider-facing request prefix captured at fork time.
 *
 * The messages are deep-copied: compaction pruning and context shake mutate
 * message content in place, so a branch waiting on an in-flight provider lease
 * would otherwise observe a context different from the one it forked from.
 */
export interface BranchSnapshot {
	/** System prompt blocks exactly as the main call sends them. */
	readonly systemPrompt: string[];
	/** Converted, normalized, provider-facing messages as of fork time. */
	readonly messages: Message[];
	/** Normalized tool set exactly as the main call sends it. */
	readonly tools: Tool[];
	/** Model id the snapshot was normalized for; a role override must re-normalize. */
	readonly modelId: string;
	/** Fork wall-clock time (ms since epoch). */
	readonly forkedAt: number;
}

/**
 * Host stream options a branch call must be handed.
 *
 * `reasoning`, `hideThinkingSummary`, and `cacheRetention` are REQUIRED KEYS
 * (their values may be `undefined`): all three participate in the primary
 * call's cache identity — reasoning effort and the adaptive `display` field
 * land in the request body, and `cacheRetention` decides the `cache_control`
 * TTL written into the prefix. A host that forgets one silently ships a branch
 * whose prefix cannot read the primary's cache entry, which is exactly the
 * failure this contract exists to make un-writable.
 */
export type BranchStreamOptions = SimpleStreamOptions & {
	[K in "reasoning" | "hideThinkingSummary" | "cacheRetention"]: SimpleStreamOptions[K];
};

/** Capabilities the branch executor borrows from its host. */
export interface BranchCallHost {
	/**
	 * Settings-aware stream fn. REQUIRED: `AgentSession`'s own `sideStreamFn`
	 * field falls back to bare `streamSimple`, which drops provider routing,
	 * watchdog budgets, and in-flight caps. Second Thought branches must be
	 * constructed with the settings-aware fn built in the SDK path.
	 */
	readonly streamFn: StreamFn;
	/** Host layering of per-provider stream options (`AgentSession.prepareSimpleStreamOptions`). */
	prepareStreamOptions?(options: SimpleStreamOptions, provider?: string): SimpleStreamOptions;
	/** Secret obfuscation applied to the outgoing provider context. */
	obfuscateContext?(context: Context): Context;
	/** Inverse of {@link BranchCallHost.obfuscateContext} for accumulated text. */
	deobfuscateText?(text: string): string;
	/** Injectable clock (tests). */
	now?(): number;
	/** Injectable unique side-call id (defaults to a random suffix; production passes a Snowflake). */
	nextSideCallId?(): string;
}

/** One branch call's inputs. */
export interface BranchCallRequest {
	/** Target model. Defaults to the primary model; an explicit `reflect` role override must pass a re-normalized snapshot. */
	readonly model: Model;
	readonly snapshot: BranchSnapshot;
	/** Just-finished thinking/assistant text the branch reflects on. */
	readonly conditioningText: string;
	/** Primary session id; the side session id is derived from it so the prompt cache key stays stable. */
	readonly cacheSessionId: string;
	/** Prompt cache key of the main call (`agent.promptCacheKey ?? agent.sessionId`). */
	readonly promptCacheKey?: string;
	/**
	 * Host-provided base stream options (api key resolver, reasoning effort,
	 * thinking-summary visibility, cache retention, service tier, provider
	 * session state, websocket preference). Cache-hostile fields are stripped
	 * by {@link buildBranchStreamOptions}.
	 */
	readonly streamOptions: BranchStreamOptions;
	/** `secondThought.branchMaxTokens`. */
	readonly maxTokens?: number;
	/** Atoms requested; unknown names are dropped and canonical order is restored. */
	readonly atoms?: readonly string[];
	/** `secondThought.harvestCapPerAtom`; `0` disables early stop. */
	readonly harvestCapPerAtom?: number;
	/** Override for the combined-atom prompt (defaults to `combined-branch.md`). */
	readonly prompt?: string;
	/** Caller run signal; the branch's own controller is chained to it. */
	readonly signal?: AbortSignal;
	/** Streaming observer for TUI/diagnostics. Receives raw provider deltas. */
	onTextDelta?(delta: string): void;
}

/** How a branch call ended. */
export type BranchCallOutcome = "completed" | "unitCap" | "aborted" | "error";

/** One branch call's accumulated output. */
export interface BranchCallResult {
	/** Side-channel session id used for this call. */
	readonly sessionId: string;
	/** Accumulated (deobfuscated) assistant text. */
	readonly text: string;
	/**
	 * Typed units filtered through {@link ATOM_NAMES}. Atom type strings are
	 * model-supplied, so nothing downstream may treat a parsed type as trusted;
	 * this is the filtering point inside this module.
	 */
	readonly units: ReflectTypedUnit[];
	/** Complete units (typed or untyped) seen in the accumulated text. */
	readonly unitCount: number;
	readonly outcome: BranchCallOutcome;
	/** The branch emitted a tool call despite the prompt's instruction not to. */
	readonly toolUseLeak: boolean;
	/**
	 * Usage as reported by the provider. A terminal event's usage wins; on
	 * abort/error without one, the last streamed `partial.usage` is surfaced so
	 * the ledger can still attribute the spend the branch already incurred.
	 */
	readonly usage?: Usage;
	/** Time to first streamed text delta, ms. */
	readonly ttftMs?: number;
	readonly durationMs: number;
	/** Provider error message when `outcome === "error"`. */
	readonly error?: string;
}

/** A started branch call. */
export interface BranchCallHandle {
	readonly sessionId: string;
	/** Settles with a result; never rejects. */
	readonly result: Promise<BranchCallResult>;
	/**
	 * Resolves on the call's first streamed TEXT delta, or when it settles.
	 *
	 * Deliberately not "first event": a `start` event fires before the provider
	 * has produced any output, so gating the stagger on it makes the stagger a
	 * no-op and every queued branch races for a cache entry that does not exist
	 * yet.
	 */
	readonly firstToken: Promise<void>;
	/** Settled result once available, without awaiting. */
	settledResult(): BranchCallResult | undefined;
	/** Idempotent cancel. */
	abort(reason?: unknown): void;
}

/**
 * An in-progress K-way fan-out whose FIRST handle is available synchronously.
 *
 * `startMany` cannot publish anything until the stagger gate lifts, which is by
 * design a multi-second wait. A caller that must be able to cancel or harvest
 * during that wait (ticket 03's coordinator: the primary tool batch can finish
 * long before branch 1 emits its first token) therefore has no handle to abort
 * and no settled units to collect — the fan-out is invisible for exactly the
 * window in which it is most likely to be torn down.
 *
 * This shape fixes that without changing the stagger economics:
 * {@link EagerBranchFanOut.handles} is a LIVE array holding call 1 from the
 * moment `startManyEager` returns, and it grows in place when the gate lifts.
 * Cancellation is expressed through {@link BranchCallRequest.signal}: an
 * already-aborted signal stops the queued branches from ever starting, so a
 * caller that aborts synchronously pays for one branch, not K.
 *
 * Module ownership stays with ticket 02 (issue #4); the shape was requested by
 * ticket 03's gauntlet round 1 (issue #5) and is the minimal change that closes
 * it — `startMany` is unchanged behaviourally and now delegates here.
 */
export interface EagerBranchFanOut {
	/**
	 * Live handle array. Index 0 exists on return; indices 1..K−1 are appended
	 * when the stagger gate lifts (and never appear at all if the fan-out was
	 * cancelled first). Callers that hold this array observe the growth.
	 */
	readonly handles: BranchCallHandle[];
	/**
	 * Resolves with the same array once the stagger has finished deciding.
	 * Never rejects.
	 */
	readonly settled: Promise<BranchCallHandle[]>;
}

/**
 * Deep copy with `structuredClone` ONLY.
 *
 * The former `JSON.parse(JSON.stringify(...))` fallback silently corrupted
 * anything JSON cannot round-trip: a `Uint8Array` image payload becomes
 * `{"0":137,"1":80,...}`, which the provider encoder then ships as a
 * meaningless object. A branch that cannot be snapshotted faithfully must fail
 * loudly (and settle as `error`) rather than send corrupted image bytes.
 */
function deepCopy<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch (error) {
		throw new Error(
			`Second Thought branch snapshot is not structured-cloneable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Capture a fork-time snapshot from a materialized provider context (the
 * output of `Agent.buildSideRequestContext`, which mirrors the main loop's
 * system prompt + normalized tools).
 *
 * Throws when the context cannot be structurally cloned; callers surface that
 * as a failed branch rather than forking on a lossy copy.
 */
export function snapshotBranchContext(context: Context, model: Model, now = Date.now()): BranchSnapshot {
	return {
		systemPrompt: deepCopy(context.systemPrompt ?? []),
		messages: deepCopy(context.messages ?? []),
		tools: deepCopy(context.tools ?? []),
		modelId: model.id,
		forkedAt: now,
	};
}

/**
 * Whether the captured provider-facing conversation ends in a developer turn.
 *
 * Anthropic may upgrade that trailing turn to a mid-conversation `system`
 * message. Appending the branch's synthetic user conditioning changes the
 * placement and suppresses that upgrade; ticket 03's coordinator policy uses
 * this signal to decide whether the branch shape is safe to send.
 */
export function snapshotTailIsDeveloper(messages: readonly Message[]): boolean {
	return messages.at(-1)?.role === "developer";
}

/** Canonicalize requested atoms: drop unknown names, restore declared order. */
export function normalizeBranchAtoms(atoms: readonly string[] | undefined): ReflectAtom[] {
	if (!atoms || atoms.length === 0) return [...ATOM_NAMES];
	const requested = new Set(atoms);
	const selected = ATOM_NAMES.filter(atom => requested.has(atom));
	return selected.length > 0 ? [...selected] : [...ATOM_NAMES];
}

/**
 * The combined-atom prompt body, with the conditioning text carried inline.
 *
 * The conditioning is quoted rather than replayed as an assistant turn — see
 * the module doc: a synthetic assistant suffix moves
 * `latestSurvivingAssistantIndex` and changes the thinking-block policy
 * applied to the PREFIX.
 */
export function buildBranchConditioningPrompt(
	conditioningText: string,
	prompt: string = COMBINED_BRANCH_PROMPT,
): string {
	const conditioning = conditioningText.trim();
	if (!conditioning) return prompt;
	return `Your reasoning so far in this turn:\n\n${conditioning}\n\n---\n\n${prompt}`;
}

/**
 * The synthetic suffix appended to the snapshot: a single user message holding
 * the conditioning text and the combined-atom prompt.
 *
 * It exists only inside the branch request — it is never appended to
 * `agent.state.messages` or persisted.
 */
export function buildBranchSuffix(conditioningText: string, prompt?: string, now = Date.now()): Message[] {
	const user: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildBranchConditioningPrompt(conditioningText, prompt) }],
		synthetic: true,
		attribution: "agent",
		timestamp: now,
	};
	return [user];
}

/**
 * Assemble the branch request context: the snapshot prefix, plus the synthetic
 * suffix. The prefix is byte-identical to the main call's once encoded, which
 * is what buys the cache read.
 *
 * Every call deep-copies the snapshot. `startMany` fans out K contexts from
 * one snapshot and a host `obfuscateContext` hook may mutate what it is
 * handed; sharing object refs would let one call's rewrite reach the queued
 * ones (and the host's own snapshot).
 */
export function buildBranchContext(
	snapshot: BranchSnapshot,
	args: { conditioningText: string; prompt?: string; now?: number },
): Context {
	return {
		systemPrompt: deepCopy(snapshot.systemPrompt),
		messages: [
			...deepCopy(snapshot.messages),
			...buildBranchSuffix(args.conditioningText, args.prompt, args.now ?? Date.now()),
		],
		tools: deepCopy(snapshot.tools),
	};
}

/** Side session id: stable primary prefix + role + a unique per-call suffix. */
export function buildBranchSessionId(cacheSessionId: string, uniqueId: string): string {
	return `${cacheSessionId}:side:${BRANCH_SIDE_ROLE}:${uniqueId}`;
}

/**
 * Build the branch's stream options.
 *
 * Cache-hostile fields are stripped rather than trusted from the host's base
 * options:
 * - `toolChoice` is a request-shape difference; tool avoidance is steered by the
 *   combined-branch prompt text instead.
 * - `disableReasoning` and `forceReasoningOff` both invalidate the Anthropic
 *   messages-tier cache (they collapse the `thinking` block) and are silently
 *   ignored on adaptive-only models — the branch inherits the main call's
 *   thinking configuration. They are two separate fields on the same axis:
 *   stripping one and trusting the other reopens the hole.
 * - `anthropicCacheRefresh` is an ownership flag for exactly one primary loop;
 *   side-channel requests must leave it unset.
 *
 * `reasoning`, `hideThinkingSummary`, and `cacheRetention` are passed through
 * untouched — they are part of the primary call's cache identity.
 *
 * `statefulResponses`-style provider conversation isolation is not needed in
 * v1 (Anthropic-only gating); it is a follow-up for OpenAI-family parity. The
 * unique side session id already gives provider routing its own lineage.
 */
export function buildBranchStreamOptions(
	request: BranchCallRequest,
	sessionId: string,
	signal: AbortSignal,
): SimpleStreamOptions {
	const {
		toolChoice: _toolChoice,
		disableReasoning: _disableReasoning,
		forceReasoningOff: _forceReasoningOff,
		anthropicCacheRefresh: _anthropicCacheRefresh,
		...base
	} = request.streamOptions ?? {};
	return {
		...base,
		sessionId,
		promptCacheKey: request.promptCacheKey ?? request.cacheSessionId,
		maxTokens: request.maxTokens ?? DEFAULT_BRANCH_MAX_TOKENS,
		initiatorOverride: "agent",
		signal,
	};
}

interface SettledResult {
	outcome: BranchCallOutcome;
	usage?: Usage;
	error?: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function partialUsageOf(event: AssistantMessageEvent): Usage | undefined {
	const partial = (event as { partial?: { usage?: Usage } }).partial;
	return partial?.usage;
}

/**
 * Drop complete reflect units from the tail until at most `cap` remain.
 *
 * A single delta can close several units at once, so the early-stop check can
 * observe `unitCount > cap`; harvesting the overshoot would silently exceed
 * the configured budget. Slicing one character off the tail invalidates the
 * final `</reflect>` so the next truncation lands on the previous one.
 */
export function truncateToUnitCap(text: string, cap: number): string {
	if (!Number.isFinite(cap) || cap < 0) return text;
	let candidate = truncateAtLastCompleteReflect(text);
	let guard = 0;
	while (candidate.length > 0 && countReflectUnits(candidate) > cap && guard++ < 1000) {
		candidate = truncateAtLastCompleteReflect(candidate.slice(0, -1));
	}
	return candidate;
}

/**
 * Constructs and runs Second Thought branch calls.
 *
 * The settings-aware stream fn is a constructor precondition: there is no
 * `streamSimple` fallback, because a bare fallback silently drops the provider
 * routing and guard settings the main turn runs with.
 */
export class BranchCaller {
	readonly #host: BranchCallHost;

	constructor(host: BranchCallHost) {
		if (typeof host?.streamFn !== "function") {
			throw new Error(
				"BranchCaller requires an explicit settings-aware stream fn; bare streamSimple is not a valid default",
			);
		}
		this.#host = host;
	}

	/** Host clocks are injected; a throwing one must not escape into the caller. */
	#now(): number {
		try {
			return this.#host.now?.() ?? Date.now();
		} catch {
			return Date.now();
		}
	}

	#nextSideCallId(): string {
		try {
			const id = this.#host.nextSideCallId?.();
			if (id !== undefined) return id;
		} catch {
			// fall through to the random suffix
		}
		return `${this.#now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
	}

	/**
	 * Start one branch call.
	 *
	 * NEVER throws — not from the id source, not from the caller signal's
	 * `addEventListener`, not from the executor. A synchronous failure comes
	 * back as a settled `error` handle so a fan-out cannot be torn down by one
	 * bad branch.
	 */
	start(request: BranchCallRequest): BranchCallHandle {
		const startedAt = this.#now();
		let sessionId = "";
		try {
			sessionId = buildBranchSessionId(request.cacheSessionId, this.#nextSideCallId());
		} catch (error) {
			return settledHandle(`${request.cacheSessionId}:side:${BRANCH_SIDE_ROLE}:unknown`, {
				outcome: "error",
				error: errorText(error),
				durationMs: this.#now() - startedAt,
			});
		}

		try {
			const controller = new AbortController();
			let signalFirstToken: () => void = () => {};
			const firstToken = new Promise<void>(resolve => {
				signalFirstToken = resolve;
			});

			const onCallerAbort = () => controller.abort(request.signal?.reason);
			if (request.signal) {
				if (request.signal.aborted) controller.abort(request.signal.reason);
				else request.signal.addEventListener("abort", onCallerAbort, { once: true });
			}

			let settled: BranchCallResult | undefined;
			// Deliberately `.then`, not `.finally`: a `finally` callback that
			// throws REPLACES the settled result with a rejection, turning the
			// module's never-throws contract into a rejected promise nobody
			// awaits. Cleanup runs inside the same guarded step and the original
			// result is returned unchanged.
			const result = this.#execute(request, sessionId, controller, signalFirstToken).then(value => {
				settled = value;
				try {
					request.signal?.removeEventListener("abort", onCallerAbort);
				} catch {
					// listener teardown must never mask a settled result
				}
				signalFirstToken();
				return value;
			});

			return {
				sessionId,
				result,
				firstToken,
				settledResult: () => settled,
				abort: (reason?: unknown) => {
					try {
						controller.abort(reason);
					} catch {
						// idempotent cancel never throws
					}
				},
			};
		} catch (error) {
			return settledHandle(sessionId, {
				outcome: "error",
				error: errorText(error),
				durationMs: this.#now() - startedAt,
			});
		}
	}

	/** Start one branch call and await its result. */
	run(request: BranchCallRequest): Promise<BranchCallResult> {
		return this.start(request).result;
	}

	/**
	 * Start `count` branch calls with a stagger: the first call is fired alone
	 * and the rest wait for its first streamed TEXT delta.
	 *
	 * Concurrent requests sharing an identical prefix all pay full uncached
	 * price until the first response begins streaming and the cache entry
	 * exists, so a naive K-way fan-out costs K× the intended input spend.
	 *
	 * The gate is bounded three ways, because a gate that can only wait is a
	 * deadlock waiting for a slow provider:
	 * - a timeout (`streamOptions.streamFirstEventTimeoutMs`, else
	 *   {@link DEFAULT_STAGGER_TIMEOUT_MS}),
	 * - the caller's abort signal,
	 * - call 1 settling.
	 *
	 * After the gate, the fan-out is CANCELLED (not merely un-staggered) when
	 * the caller aborted or call 1 settled `aborted`/`error`: firing K−1 more
	 * calls into a turn that is being torn down, or against a provider that
	 * just failed, spends real money for output nobody will harvest.
	 *
	 * Identity, post-delegation: this now awaits {@link startManyEager}, so the
	 * array it resolves to is that fan-out's LIVE array — the same object as
	 * {@link EagerBranchFanOut.handles}, not a fresh copy. By the time the promise
	 * resolves the stagger has decided, so the array no longer grows and a caller
	 * that only awaits `startMany` cannot observe the difference. A caller that
	 * holds both must not assume they are distinct arrays: mutating the result
	 * mutates the fan-out's view, and vice versa. Copy at the use site if you need
	 * a stable snapshot.
	 */
	async startMany(count: number, request: BranchCallRequest): Promise<BranchCallHandle[]> {
		return await this.startManyEager(count, request).settled;
	}

	/**
	 * {@link BranchCaller.startMany} with the first handle published
	 * SYNCHRONOUSLY — see {@link EagerBranchFanOut} for why that matters.
	 *
	 * Identical stagger semantics: call 1 fires alone, calls 2..K wait on its
	 * first streamed text delta (bounded by the configured first-event timeout,
	 * the caller signal, and call 1 settling), and the queued calls are dropped
	 * rather than merely un-staggered when the caller aborted or call 1 failed.
	 * `startMany` delegates here, so there is one implementation of the gate.
	 */
	startManyEager(count: number, request: BranchCallRequest): EagerBranchFanOut {
		const total = Math.max(0, Math.trunc(count));
		const handles: BranchCallHandle[] = [];
		if (total === 0) return { handles, settled: Promise.resolve(handles) };

		const first = this.start(request);
		handles.push(first);
		if (total === 1) return { handles, settled: Promise.resolve(handles) };

		const settled = (async () => {
			try {
				await this.#awaitStaggerGate(first, request);
				// Re-checked AFTER the gate, on the live signal: a caller that
				// aborted during the wait must never be charged for calls 2..K.
				if (request.signal?.aborted) return handles;
				const firstResult = first.settledResult();
				if (firstResult && (firstResult.outcome === "aborted" || firstResult.outcome === "error")) return handles;
				for (let index = 1; index < total; index++) handles.push(this.start(request));
			} catch {
				// The fan-out contract is never-throws; a gate failure degrades to
				// the single un-staggered branch already published.
			}
			return handles;
		})();
		return { handles, settled };
	}

	async #awaitStaggerGate(first: BranchCallHandle, request: BranchCallRequest): Promise<void> {
		const configuredTimeoutMs = request.streamOptions?.streamFirstEventTimeoutMs;
		const timeoutMs =
			typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
				? configuredTimeoutMs
				: DEFAULT_STAGGER_TIMEOUT_MS;
		const gates: Promise<unknown>[] = [first.firstToken];

		let timer: Timer | undefined;
		const timerGate = Promise.withResolvers<void>();
		timer = setTimeout(timerGate.resolve, timeoutMs);
		// Never hold the process open for a stagger gate.
		timer.unref?.();
		gates.push(timerGate.promise);

		const signal = request.signal;
		let onAbort: (() => void) | undefined;
		if (signal && !signal.aborted) {
			gates.push(
				new Promise<void>(resolve => {
					onAbort = () => resolve();
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			);
		} else if (signal?.aborted) {
			return;
		}

		try {
			await Promise.race(gates);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	async #execute(
		request: BranchCallRequest,
		sessionId: string,
		controller: AbortController,
		signalFirstToken: () => void,
	): Promise<BranchCallResult> {
		const startedAt = this.#now();
		let atoms: ReflectAtom[] = [...ATOM_NAMES];
		let raw = "";
		let unitCount = 0;
		let toolUseLeak = false;
		let ttftMs: number | undefined;
		let finishedNaturally = false;
		let unitCap = Number.POSITIVE_INFINITY;
		let lastPartialUsage: Usage | undefined;
		const settled: SettledResult = { outcome: "completed" };

		// The whole body is guarded: normalizeBranchAtoms, the snapshot deep
		// copy, and every host hook (obfuscateContext, prepareStreamOptions) run
		// inside it. A host hook that throws settles the branch as `error`; it
		// never propagates into the fan-out or the caller's turn.
		try {
			atoms = normalizeBranchAtoms(request.atoms);
			const capPerAtom = request.harvestCapPerAtom ?? DEFAULT_HARVEST_CAP_PER_ATOM;
			unitCap = capPerAtom > 0 ? capPerAtom * atoms.length : Number.POSITIVE_INFINITY;

			const context = buildBranchContext(request.snapshot, {
				conditioningText: request.conditioningText,
				prompt: request.prompt,
				now: startedAt,
			});
			const wireContext = this.#host.obfuscateContext?.(context) ?? context;
			const options = buildBranchStreamOptions(request, sessionId, controller.signal);
			const preparedOptions = this.#host.prepareStreamOptions?.(options, request.model.provider) ?? options;

			const stream = await this.#host.streamFn(request.model, wireContext, preparedOptions);
			// After a unit-cap abort the loop keeps reading, ignoring content, so
			// the provider's terminal event (which carries the only authoritative
			// usage) is not thrown away by an immediate `break`.
			let draining = 0;
			for await (const event of stream) {
				lastPartialUsage = partialUsageOf(event) ?? lastPartialUsage;

				if (event.type === "done") {
					settled.usage = event.message.usage;
					if (settled.outcome === "completed") finishedNaturally = true;
					break;
				}
				if (event.type === "error") {
					settled.usage = event.error.usage ?? settled.usage;
					if (settled.outcome === "completed") {
						settled.outcome = event.reason === "aborted" ? "aborted" : "error";
						settled.error = event.error.errorMessage || undefined;
					}
					break;
				}

				if (draining > 0) {
					if (++draining > MAX_USAGE_DRAIN_EVENTS) break;
					continue;
				}

				if (event.type === "text_delta") {
					// Only a text delta means the provider has actually begun
					// producing output — the point after which a second
					// identical-prefix request can hit the cache instead of racing
					// for it. A `start` event fires before that.
					signalFirstToken();
					ttftMs ??= this.#now() - startedAt;
					raw += event.delta;
					try {
						request.onTextDelta?.(event.delta);
					} catch {
						// a diagnostics observer must never fail the branch
					}
					// Recount only when the delta could have closed a unit;
					// re-scanning the buffer on every fragment is quadratic.
					if (event.delta.includes(">")) {
						unitCount = countReflectUnits(raw);
						if (unitCount >= unitCap) {
							settled.outcome = "unitCap";
							controller.abort();
							draining = 1;
						}
					}
					continue;
				}
				// Thinking deltas are ignored: only harvested text matters.
				if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
					toolUseLeak = true;
				}
			}
		} catch (error) {
			// A branch never throws into its caller, and never retries after an
			// abort: the provider has already been told to stop.
			if (settled.outcome === "completed") {
				if (controller.signal.aborted) settled.outcome = "aborted";
				else {
					settled.outcome = "error";
					settled.error = errorText(error);
				}
			}
		}

		// An abort that lands AFTER the provider finished naturally does not
		// retroactively make the call aborted — the output is complete and
		// harvestable.
		if (settled.outcome === "completed" && !finishedNaturally && controller.signal.aborted) {
			settled.outcome = "aborted";
		}

		if (settled.outcome === "unitCap") raw = truncateToUnitCap(raw, unitCap);

		let text = raw;
		try {
			text = this.#host.deobfuscateText?.(raw) ?? raw;
		} catch (error) {
			text = raw;
			if (settled.outcome === "completed") {
				settled.outcome = "error";
				settled.error = errorText(error);
			}
		}

		const allowed = new Set<string>(atoms);
		let units: ReflectTypedUnit[] = [];
		let finalUnitCount = unitCount;
		try {
			units = parseReflectTypedUnits(text).filter(([atom]) => allowed.has(atom));
			finalUnitCount = countReflectUnits(text);
		} catch (error) {
			if (settled.outcome === "completed") {
				settled.outcome = "error";
				settled.error = errorText(error);
			}
		}

		return {
			sessionId,
			text,
			units,
			unitCount: finalUnitCount,
			outcome: settled.outcome,
			toolUseLeak,
			usage: settled.usage ?? lastPartialUsage,
			ttftMs,
			durationMs: this.#now() - startedAt,
			error: settled.error,
		};
	}
}

/** A handle for a call that failed before it could stream anything. */
function settledHandle(
	sessionId: string,
	partial: { outcome: BranchCallOutcome; error?: string; durationMs: number },
): BranchCallHandle {
	const result: BranchCallResult = {
		sessionId,
		text: "",
		units: [],
		unitCount: 0,
		outcome: partial.outcome,
		toolUseLeak: false,
		durationMs: partial.durationMs,
		error: partial.error,
	};
	return {
		sessionId,
		result: Promise.resolve(result),
		firstToken: Promise.resolve(),
		settledResult: () => result,
		abort: () => {},
	};
}
