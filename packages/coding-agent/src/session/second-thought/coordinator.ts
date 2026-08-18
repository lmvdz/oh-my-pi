/**
 * Second Thought coordinator: the fork / cancel / harvest lifecycle.
 *
 * The coordinator owns exactly one question — *when* a branch call exists —
 * and it composes the modules that answer the others: `gating` decides whether
 * the feature may run at all, {@link BranchCaller} (02) builds and executes the
 * side call, and `parser` (01) turns accumulated branch text into typed units.
 * Delivery of the harvest (04), the cost ledger (06), and the AgentSession
 * wiring (08) live behind narrow host callbacks; nothing here imports
 * `AgentSession`, so every exit path is drivable from a stub host with no
 * network.
 *
 * ## Stream identity: a host-armed token, never object identity
 *
 * The loop can replace a streaming assistant message inside one turn (the
 * Harmony leak retry streams a SECOND full sequence under the same
 * `turn_start`/`turn_end` pair). Keying fork state on `message.timestamp`
 * cannot distinguish the replacement from the original when both land in the
 * same millisecond, and keying single-fire on the identity of `event.partial`
 * is simply WRONG against the live surface: `agent-loop.ts` reassigns
 * `partialMessage = event.partial` on every stream event, so consecutive
 * `toolcall_start`s in one multi-tool message carry different objects and an
 * identity key re-forks (and cancels the previous fork) on each of them.
 *
 * The interceptor surface makes the obvious repair unavailable too. Agent's
 * `onAssistantMessageEvent` is invoked ONLY from the content-event branch of
 * `agent-loop.ts` (`text_*` / `thinking_*` / `image_end` / `toolcall_*`); the
 * `start` case never calls it — it pushes `message_start` to the session event
 * stream instead. So a `start`-typed `AssistantMessageEvent` never reaches this
 * class and cannot arm anything.
 *
 * Stream identity is therefore HOST-ARMED. The wiring (ticket 08) calls
 * {@link SecondThoughtCoordinator.noteStreamStart} once per fresh provider
 * stream, and the coordinator keys single-fire on an internal monotonic stream
 * sequence rather than on any object it was handed. The contract, stated so 08
 * can be checked against it:
 *
 * - **Call it** when a NEW provider stream begins for the primary agent — the
 *   `message_start` the loop pushes when it first appends a streaming partial
 *   (`agent-loop.ts`, the `case "start"` `addedPartial === false` branch).
 * - **Call it again** for the Harmony abort-retry: that path `continue`s into a
 *   whole new provider call, which appends a new partial and pushes a new
 *   `message_start`. A new token with a live fork means *this fork is stale* —
 *   the coordinator cancels it and re-arms, so the retry's own first tool call
 *   forks fresh.
 * - **Do NOT call it** for the Harmony truncate-and-resume path. That path
 *   recovers the message without re-streaming and pushes a synthetic
 *   `message_start` + `message_end` pair with no assistant content events at
 *   all; re-arming there would cancel a healthy fork on the strength of an
 *   event that represents no new provider work. If 08 wires arming to raw
 *   `message_start` events it MUST pass a token, and pass the SAME token for
 *   the resumed message — {@link SecondThoughtCoordinator.noteStreamStart} is a
 *   no-op when the token is unchanged.
 * - The token may be any value (a request id, the provider stream object, a
 *   counter). It is compared with `===` and never retained beyond the
 *   comparison. Passing `undefined` means "unconditionally a new stream".
 *
 * Turn end re-arms unconditionally, so a host that never calls
 * `noteStreamStart` still forks once per turn rather than once per session.
 *
 * A monotonic fork generation identifies a fork across its async start, cancel
 * and harvest; a late result from a superseded generation is discarded by
 * generation id even if its abort never settled.
 *
 * ## Why the coordinator owns the branch abort controller
 *
 * The branches are started through {@link BranchStarter.startManyEager}, which
 * publishes handle 0 synchronously and appends the rest when the stagger gate
 * lifts. Handles alone are not enough: the queued branches do not exist yet, so
 * there is nothing to abort. The coordinator therefore owns a per-fork
 * `AbortController`, chains it to the run signal, and passes ITS signal as
 * `request.signal`. Every teardown path (`cancelActive`, `onPrimaryTurnEnd`,
 * `reset`, `dispose`) aborts that controller SYNCHRONOUSLY, before any `await`,
 * which both tears down the started branches and stops the staggered ones from
 * ever starting.
 *
 * ## Why cancel is not the same call as harvest
 *
 * `onPrimaryTurnEnd` is only reached on the clean path. Every abort-shaped exit
 * (user Esc, compaction abort, deadline, dispose, session switch) skips it, so
 * cancellation is registered THREE ways at fork time: on the run's abort
 * signal, via the idempotent {@link SecondThoughtCoordinator.cancelActive}
 * called from `abort()`/`dispose()`, and via {@link
 * SecondThoughtCoordinator.reset} for navigation-shaped state changes. Any one
 * of them alone tears the branch down; all three are idempotent.
 *
 * ## Why harvest is bounded at ~300ms
 *
 * A branch wedged in provider stream teardown must never sit on the primary
 * loop's critical path. Turn end aborts every handle synchronously, waits at
 * most {@link HARVEST_GRACE_MS} for results to settle, harvests whatever
 * settled, and DETACHES the rest to a background finalizer with a 10s bound so
 * the ledger still sees the usage the branch already incurred. The loop never
 * awaits the finalizer.
 *
 * There is deliberately no pause-engage action: a turn that is in flight when
 * the pause gate engages still reaches `turn_end` (the gate parks at a turn
 * boundary), so normal harvest already covers it. Cancelling on pause would
 * destroy a valid harvest for no benefit.
 */

import type { AssistantMessage, AssistantMessageEvent, Context, Message, Model, Usage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import {
	type BranchCallHandle,
	type BranchCallRequest,
	type BranchCallResult,
	type BranchSnapshot,
	type BranchStreamOptions,
	DEFAULT_BRANCH_MAX_TOKENS,
	DEFAULT_HARVEST_CAP_PER_ATOM,
	type EagerBranchFanOut,
	normalizeBranchAtoms,
	snapshotBranchContext,
	snapshotTailIsDeveloper,
} from "./branch-call";
import { evaluateSecondThoughtGate, type SecondThoughtGateReason } from "./gating";
import { interleaveTypedUnitsByAtom, type ReflectTypedUnit } from "./parser";

/** Wall-clock budget the primary loop may spend collecting settled branches at turn end. */
export const HARVEST_GRACE_MS = 300;

/** Bound on the detached finalizer that drains branches which missed the grace. */
export const FINALIZER_TIMEOUT_MS = 10_000;

/** Default cooldown applied after a provider 429 is reported. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Smoothing factor for the adaptive-window EMAs. */
export const ADAPTIVE_EMA_ALPHA = 0.3;

/**
 * Forks anyway every Nth adaptive skip.
 *
 * Both EMAs only advance when a fork actually happened, so an adaptive skip
 * that suppressed forking forever would freeze the very measurement it decides
 * on. The probe keeps the estimate alive when tool batches speed up again.
 */
export const ADAPTIVE_PROBE_INTERVAL = 20;

/** Why a turn did not fork. Every value is recorded on the ledger. */
export type SecondThoughtSkipReason =
	| SecondThoughtGateReason
	| "disposed"
	| "conditioning-too-short"
	| "context-too-large"
	| "provider-cooldown"
	| "in-flight-cap"
	| "adaptive-window"
	| "developer-tail"
	| "no-fork-context"
	| "snapshot-failed";

/** Why a fork produced no fold. */
export type SecondThoughtDropReason =
	| "history-epoch"
	/** `reset()`/`dispose()` landed while the harvest was in flight. */
	| "coordinator-epoch"
	| "cancelled"
	| "superseded"
	| "no-units"
	| "no-settled-branches";

/** Why an active fork was cancelled. */
export type SecondThoughtCancelReason = "run-abort" | "session-abort" | "dispose" | "reset" | "restream" | "turn-end";

/** Everything the coordinator knows about one fork attempt. */
export interface SecondThoughtForkInfo {
	readonly generation: number;
	readonly epoch: number;
	readonly forkedAt: number;
	readonly branchCount: number;
	readonly model: string;
	readonly provider: string;
	readonly conditioningChars: number;
}

/**
 * The narrow ledger surface the coordinator writes to.
 *
 * Ticket 06 implements it for real; every method is optional so a host can
 * adopt it incrementally and so the coordinator never depends on ledger
 * behaviour for correctness.
 */
export interface SecondThoughtLedgerSink {
	recordSkip?(reason: SecondThoughtSkipReason, info?: Record<string, unknown>): void;
	recordFork?(info: SecondThoughtForkInfo): void;
	recordBranchResult?(result: BranchCallResult, info: SecondThoughtForkInfo): void;
	recordDrop?(reason: SecondThoughtDropReason, info?: Record<string, unknown>): void;
	recordHarvest?(harvest: SecondThoughtHarvest): void;
}

/** A fork-time request context materialized by the host for a specific model. */
export interface SecondThoughtForkContext {
	/** Provider-facing context the main call would send (system prompt, messages, tools). */
	readonly context: Context;
	/** Primary session id; the branch's side session id derives from it. */
	readonly cacheSessionId: string;
	/** `agent.promptCacheKey ?? agent.sessionId`. */
	readonly promptCacheKey?: string;
	/** Host-layered stream options for the main call (cache-hostile fields are stripped by 02). */
	readonly streamOptions: BranchStreamOptions;
	/** Run abort signal; the branch chains to it so an abort-shaped exit tears it down. */
	readonly signal?: AbortSignal;
}

/** Capabilities the coordinator borrows from its owning session. */
export interface SecondThoughtHost {
	readonly settings: Settings;
	/** `"main" | "sub"` — the feature is primary-session only. */
	agentKind(): "main" | "sub";
	primaryModel(): Model | undefined;
	availableModels(): Model[];
	/**
	 * Monotonic history epoch, bumped by `replaceMessages` / rewind / compaction.
	 *
	 * Deliberately a host-owned counter rather than a read of AgentSession
	 * internals: `#promptGeneration` does NOT move on a same-run rewind, which
	 * is exactly the staleness case this guards. Ticket 08 wires the real bumps.
	 */
	historyEpoch(): number;
	/** Materialize the fork-time request context for `model`, or `undefined` when unavailable. */
	prepareFork(model: Model): SecondThoughtForkContext | undefined;
	/** Estimated context tokens; `undefined` disables the context-size circuit breaker. */
	estimateContextTokens?(): number | undefined;
	/** Harvested units for ticket 04's fold store. Never awaited by the loop. */
	deliverHarvest?(harvest: SecondThoughtHarvest): void;
	readonly ledger?: SecondThoughtLedgerSink;
	/** Injectable clock (tests). */
	now?(): number;
	/** Test seam: harvest grace budget. */
	harvestGraceMs?(): number;
	/** Test seam: detached finalizer bound. */
	finalizerTimeoutMs?(): number;
	/** Test seam: how many adaptive skips pass before a forced probe fork. */
	adaptiveProbeInterval?(): number;
}

/** What one settled fork yielded. */
export interface SecondThoughtHarvest {
	readonly generation: number;
	readonly epoch: number;
	readonly forkedAt: number;
	readonly harvestedAt: number;
	/** Wall-clock the branch had to work in (fork → turn end). */
	readonly windowMs: number;
	/** Typed units in branch order, filtered to the configured atoms and capped per atom. */
	readonly units: ReflectTypedUnit[];
	/** The same units grouped by atom, in canonical atom order. */
	readonly unitsByAtom: Record<string, string[]>;
	/** Round-robin interleaved `<reflect type=…>` markup — 04 wraps this, it does not re-parse. */
	readonly fold: string;
	readonly branchCount: number;
	readonly settledCount: number;
	readonly usage: readonly (Usage | undefined)[];
}

/**
 * The subset of {@link BranchCaller} the coordinator needs (test seam).
 *
 * Deliberately the EAGER shape: `startMany` cannot publish a handle until the
 * stagger gate lifts, which leaves the coordinator with nothing to cancel and
 * nothing to harvest for the whole window in which the primary tool batch
 * typically finishes.
 */
export interface BranchStarter {
	startManyEager(count: number, request: BranchCallRequest): EagerBranchFanOut;
}

interface ActiveFork {
	readonly generation: number;
	/** Host history epoch at fork time. */
	readonly epoch: number;
	/** Coordinator epoch at fork time; bumped by `reset()`/`dispose()`. */
	readonly coordEpoch: number;
	readonly forkedAt: number;
	readonly info: SecondThoughtForkInfo;
	/**
	 * LIVE handle array from {@link EagerBranchFanOut}: index 0 is present the
	 * moment the fork is created and the staggered branches append themselves.
	 */
	readonly handles: BranchCallHandle[];
	/** Per-fork controller chained to the run signal; aborting it stops queued branches. */
	readonly controller: AbortController;
	/**
	 * Handles whose result has already been collected (harvested or drained).
	 *
	 * With an eager fan-out the same handle can be reachable from both the cancel
	 * path and the stagger tail; without this, one branch would be attributed to
	 * the ledger twice.
	 */
	readonly observed: Set<BranchCallHandle>;
	cancelled: boolean;
	signal?: AbortSignal;
	onSignalAbort?: () => void;
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
	let timer: Timer | undefined;
	const promise = new Promise<void>(resolve => {
		timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

/** Thinking text of the in-flight message, falling back to emitted prose. */
export function buildConditioningText(partial: AssistantMessage | undefined): string {
	if (!partial?.content) return "";
	const thinking: string[] = [];
	const text: string[] = [];
	for (const block of partial.content) {
		// Redacted thinking carries no readable text: it contributes nothing and
		// falls through to the min-length skip rather than conditioning on noise.
		if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
		else if (block.type === "text" && typeof block.text === "string") text.push(block.text);
	}
	const reasoning = thinking.join("\n").trim();
	// Prose fallback: omp models routinely write before their first tool call,
	// and an Anthropic turn with thinking hidden would otherwise never fork.
	return reasoning || text.join("\n").trim();
}

/**
 * Coordinates Second Thought's fork/cancel/harvest lifecycle for one session.
 *
 * All public methods are safe to call in any order, more than once, and after
 * {@link SecondThoughtCoordinator.dispose}; none of them throw into the
 * primary loop.
 */
export class SecondThoughtCoordinator {
	readonly #host: SecondThoughtHost;
	readonly #caller: BranchStarter;
	/** Monotonic; identifies a fork across its async start, cancel, and harvest. */
	#generation = 0;
	#active: ActiveFork | undefined;
	/**
	 * Monotonic provider-stream sequence. Bumped by
	 * {@link SecondThoughtCoordinator.noteStreamStart} and by turn end; single-fire
	 * compares against {@link SecondThoughtCoordinator.#armedStreamSeq}.
	 */
	#streamSeq = 0;
	/** The last token the host armed with, compared by identity for idempotence. */
	#streamToken: unknown;
	/** Stream sequence a fork attempt was already made for. `-1` = none. */
	#armedStreamSeq = -1;
	/**
	 * Bumped by `reset()`/`dispose()`. Every adaptive/EMA write and the harvest
	 * delivery are gated on it, so state belonging to a torn-down conversation
	 * can never leak into the next one.
	 */
	#coordEpoch = 0;
	#disposed = false;
	/** provider → wall-clock ms until which forking is suppressed after a 429. */
	#cooldownUntil = new Map<string, number>();
	#toolBatchEmaMs: number | undefined;
	#branchTtftEmaMs: number | undefined;
	#adaptiveSkips = 0;
	#finalizers = new Set<Promise<void>>();

	constructor(host: SecondThoughtHost, caller: BranchStarter) {
		this.#host = host;
		this.#caller = caller;
	}

	/** Generation id of the fork currently in flight, if any. */
	get activeGeneration(): number | undefined {
		return this.#active?.generation;
	}

	/** Branch handles currently held by the coordinator. Zero outside a forked turn. */
	get activeBranchCount(): number {
		return this.#active?.handles.length ?? 0;
	}

	/** Number of forks started in this session. */
	get forkCount(): number {
		return this.#generation;
	}

	/**
	 * The adaptive-window EMAs, for diagnostics and for tests that pin the
	 * generation/epoch guards on the state writes. Never used for control flow
	 * outside {@link SecondThoughtCoordinator.#adaptiveWindowSkips}.
	 */
	get adaptiveEmas(): { readonly toolBatchMs: number | undefined; readonly branchTtftMs: number | undefined } {
		return { toolBatchMs: this.#toolBatchEmaMs, branchTtftMs: this.#branchTtftEmaMs };
	}

	#now(): number {
		try {
			return this.#host.now?.() ?? Date.now();
		} catch {
			return Date.now();
		}
	}

	#ledger(): SecondThoughtLedgerSink | undefined {
		return this.#host.ledger;
	}

	#skip(reason: SecondThoughtSkipReason, info?: Record<string, unknown>): void {
		try {
			this.#ledger()?.recordSkip?.(reason, info);
		} catch (error) {
			logger.debug("Second Thought ledger skip sink threw", { reason, error });
		}
	}

	#drop(reason: SecondThoughtDropReason, info?: Record<string, unknown>): void {
		try {
			this.#ledger()?.recordDrop?.(reason, info);
		} catch (error) {
			logger.debug("Second Thought ledger drop sink threw", { reason, error });
		}
	}

	/**
	 * Arm a fresh provider stream. See the module doc for the exact host
	 * contract — in short: once per new provider stream (including the Harmony
	 * abort-retry's replacement call), never for truncate-and-resume.
	 *
	 * Idempotent for a repeated `token`; `undefined` always counts as new.
	 * A new stream while a fork is live means that fork belongs to a stream the
	 * provider abandoned, so it is cancelled here and the next `toolcall_start`
	 * forks fresh.
	 */
	noteStreamStart(token?: unknown): void {
		try {
			if (this.#disposed) return;
			if (token !== undefined && this.#streamToken === token) return;
			this.#streamToken = token;
			this.#streamSeq++;
			if (this.#active) this.cancelActive("restream");
		} catch (error) {
			logger.debug("Second Thought stream arm failed", { error });
		}
	}

	/**
	 * Stream-event hook. Forks on the FIRST `toolcall_start` of an armed stream.
	 *
	 * Not text events: a text-only turn has no idle window and no next call to
	 * sharpen. Not `toolcall_delta`: a no-argument tool call may never emit one.
	 * Not `start`: the live interceptor is never invoked for it (module doc).
	 *
	 * Single-fire is per STREAM, not per `event.partial` object: agent-loop hands
	 * a different partial to every event, so a later `toolcall_start` in the same
	 * multi-tool message must be ignored rather than treated as a new stream.
	 * A skipped attempt consumes the arm too — re-evaluating the gate on every
	 * tool call of a batch would spray duplicate skips at the ledger for a
	 * decision that cannot change inside one stream.
	 *
	 * Never throws — a fork failure is not a turn failure.
	 */
	onAssistantEvent(event: AssistantMessageEvent): void {
		try {
			if (event.type !== "toolcall_start") return;
			if (this.#armedStreamSeq === this.#streamSeq) return;
			this.#armedStreamSeq = this.#streamSeq;
			if (this.#disposed) {
				this.#skip("disposed");
				return;
			}
			// Defensive: a host that never arms must still not leave two live forks.
			if (this.#active) this.cancelActive("restream");
			this.#tryFork(event.partial);
		} catch (error) {
			logger.debug("Second Thought fork trigger failed", { error });
		}
	}

	/** Report a provider 429 so forking is suppressed for a cooldown window. */
	noteProviderRateLimit(provider: string, cooldownMs: number = RATE_LIMIT_COOLDOWN_MS): void {
		if (!provider) return;
		this.#cooldownUntil.set(provider, this.#now() + Math.max(0, cooldownMs));
	}

	#tryFork(partial: AssistantMessage | undefined): void {
		const settings = this.#host.settings;
		const gate = evaluateSecondThoughtGate({
			settings,
			agentKind: this.#host.agentKind(),
			primaryModel: this.#host.primaryModel(),
			availableModels: this.#host.availableModels(),
		});
		if (!gate.allowed || !gate.branchModel) {
			this.#skip(gate.reason ?? "no-primary-model");
			return;
		}
		const model = gate.branchModel;

		const conditioningText = buildConditioningText(partial);
		const minChars = settings.get("secondThought.minConditioningChars");
		if (conditioningText.length < minChars) {
			this.#skip("conditioning-too-short", { chars: conditioningText.length, minChars });
			return;
		}

		const maxContextTokens = settings.get("secondThought.maxContextTokens");
		const contextTokens = this.#estimateContextTokens();
		if (contextTokens !== undefined && maxContextTokens > 0 && contextTokens > maxContextTokens) {
			this.#skip("context-too-large", { contextTokens, maxContextTokens });
			return;
		}

		const cooldownUntil = this.#cooldownUntil.get(model.provider);
		if (cooldownUntil !== undefined) {
			if (cooldownUntil > this.#now()) {
				this.#skip("provider-cooldown", { provider: model.provider, until: cooldownUntil });
				return;
			}
			this.#cooldownUntil.delete(model.provider);
		}

		const branchCount = Math.max(1, Math.trunc(settings.get("secondThought.branchCount")));
		// A configured cap that cannot seat the main call plus every branch would
		// serialize the fan-out behind a cross-process lease — the branch would
		// then start after the window it was supposed to ride in.
		//
		// The cap must SEAT `branchCount + 1` calls, so the skip is `limit <
		// branchCount + 1`, not `<=`. With the old `<=` an Anthropic cap of 2
		// (main + one branch: exactly what the feature needs) never forked at all.
		const inFlightLimit = this.#providerInFlightLimit(model.provider);
		if (inFlightLimit !== undefined && inFlightLimit < branchCount + 1) {
			this.#skip("in-flight-cap", { provider: model.provider, limit: inFlightLimit, branchCount });
			return;
		}

		if (this.#adaptiveWindowSkips()) {
			this.#skip("adaptive-window", {
				toolBatchEmaMs: this.#toolBatchEmaMs,
				branchTtftEmaMs: this.#branchTtftEmaMs,
			});
			return;
		}

		let fork: SecondThoughtForkContext | undefined;
		try {
			fork = this.#host.prepareFork(model);
		} catch (error) {
			this.#skip("no-fork-context", { error: String(error) });
			return;
		}
		if (!fork) {
			this.#skip("no-fork-context");
			return;
		}

		const messages: readonly Message[] = fork.context.messages ?? [];
		// A developer-role tail is upgraded to mid-conversation `system` by the
		// main call; the branch's appended user conditioning suppresses that
		// upgrade, so the branch prefix cannot match and the call would be fully
		// uncached. Policy: skip (routed gauntlet finding, issue #5).
		if (snapshotTailIsDeveloper(messages)) {
			this.#skip("developer-tail");
			return;
		}

		const forkedAt = this.#now();
		let snapshot: BranchSnapshot;
		try {
			snapshot = snapshotBranchContext(fork.context, model, forkedAt);
		} catch (error) {
			// A context that cannot be structurally cloned must never be forked on
			// a lossy copy (02 throws rather than corrupting image payloads).
			this.#skip("snapshot-failed", { error: String(error) });
			return;
		}

		const generation = ++this.#generation;
		const info: SecondThoughtForkInfo = {
			generation,
			epoch: this.#host.historyEpoch(),
			forkedAt,
			branchCount,
			model: model.id,
			provider: model.provider,
			conditioningChars: conditioningText.length,
		};
		// The coordinator owns the branch abort controller so every teardown path
		// can stop the fan-out SYNCHRONOUSLY, including the branches the stagger
		// has not started yet (they check this signal before firing).
		const controller = new AbortController();
		const active: ActiveFork = {
			generation,
			epoch: info.epoch,
			coordEpoch: this.#coordEpoch,
			forkedAt,
			info,
			handles: [],
			controller,
			observed: new Set<BranchCallHandle>(),
			cancelled: false,
			signal: fork.signal,
		};
		this.#active = active;

		// Unconditional cleanup path #1: the run signal. Registered BEFORE the
		// branches start, so an abort that lands during the stagger still tears
		// the fan-out down.
		if (fork.signal) {
			if (fork.signal.aborted) {
				this.cancelActive("run-abort");
				return;
			}
			const onAbort = () => {
				if (this.#active?.generation === generation) this.cancelActive("run-abort");
				else {
					active.cancelled = true;
					abortController(controller, "second-thought:run-abort");
				}
			};
			active.onSignalAbort = onAbort;
			try {
				fork.signal.addEventListener("abort", onAbort, { once: true });
			} catch {
				active.onSignalAbort = undefined;
			}
		}

		try {
			this.#ledger()?.recordFork?.(info);
		} catch (error) {
			logger.debug("Second Thought ledger fork sink threw", { error });
		}

		const request: BranchCallRequest = {
			model,
			snapshot,
			conditioningText,
			cacheSessionId: fork.cacheSessionId,
			promptCacheKey: fork.promptCacheKey,
			streamOptions: fork.streamOptions,
			maxTokens: settings.get("secondThought.branchMaxTokens") || DEFAULT_BRANCH_MAX_TOKENS,
			atoms: normalizeBranchAtoms(settings.get("secondThought.atoms")),
			harvestCapPerAtom: settings.get("secondThought.harvestCapPerAtom") ?? DEFAULT_HARVEST_CAP_PER_ATOM,
			// NOT `fork.signal`: the coordinator's own controller is chained to it
			// and adds turn-end / reset / dispose / re-arm as abort sources.
			signal: controller.signal,
		};

		this.#startBranches(active, branchCount, request);
	}

	/**
	 * Start the fan-out and adopt its LIVE handle array.
	 *
	 * Handle 0 exists before this returns, so a `cancelActive` or
	 * `onPrimaryTurnEnd` on the very next line already has something to abort and
	 * something to harvest. The staggered handles append themselves into the same
	 * array; the tail below only exists to catch the ordering where a handle is
	 * appended after a cancel already walked the array.
	 */
	#startBranches(active: ActiveFork, count: number, request: BranchCallRequest): void {
		let fanOut: EagerBranchFanOut;
		try {
			fanOut = this.#caller.startManyEager(count, request);
		} catch (error) {
			// startManyEager is contracted never to throw; treat a violation as a
			// dead fork rather than an exception in the interceptor chain.
			logger.debug("Second Thought branch start failed", { error });
			if (this.#active?.generation === active.generation) this.#active = undefined;
			this.#detachSignalListener(active);
			return;
		}
		// `active.handles` IS the fan-out's array: growth is observed, not polled.
		(active as { handles: BranchCallHandle[] }).handles = fanOut.handles;

		void fanOut.settled
			.then(handles => {
				if (!active.cancelled && this.#active?.generation === active.generation) return;
				// Cancelled mid-stagger: abort anything that arrived late and drain
				// it for the ledger. Nothing here can produce a fold.
				//
				// This tail runs at the FIRST AWAIT of whichever teardown path
				// resolved the gate, so it must never adopt a handle the teardown
				// already published — `#observeResults` claims through the fork's
				// `observed` set, which `cancelActive`/`#harvest` fill synchronously,
				// so only handles APPENDED after teardown are drained here. Stealing
				// an already-published handle would sink its units into this
				// ledger-only finalizer instead of the grace harvest.
				for (const handle of handles) handle.abort("second-thought-cancelled");
				this.#observeResults(active, handles);
			})
			.catch(error => logger.debug("Second Thought branch fan-out failed", { error }));
	}

	#detachSignalListener(fork: ActiveFork): void {
		if (!fork.onSignalAbort || !fork.signal) return;
		try {
			fork.signal.removeEventListener("abort", fork.onSignalAbort);
		} catch {
			// listener teardown must never mask a lifecycle transition
		}
		fork.onSignalAbort = undefined;
	}

	/**
	 * Idempotent cancel of whatever fork is active.
	 *
	 * Called from the run signal, `abort()`, `dispose()`, session switch, and
	 * the re-arm path. Never harvests: a cancelled turn produces no fold.
	 */
	cancelActive(reason: SecondThoughtCancelReason = "reset"): void {
		const fork = this.#active;
		if (!fork) return;
		this.#active = undefined;
		fork.cancelled = true;
		// SYNCHRONOUS and first: this both tears down the started branches and
		// stops the ones the stagger has queued from ever being started.
		abortController(fork.controller, `second-thought:${reason}`);
		this.#detachSignalListener(fork);
		for (const handle of fork.handles) handle.abort(`second-thought:${reason}`);
		this.#drop(reason === "restream" ? "superseded" : "cancelled", {
			reason,
			generation: fork.generation,
		});
		this.#observeResults(fork, fork.handles);
	}

	/**
	 * Reset all per-conversation state.
	 *
	 * Wired by 08 to: new session, session switch, branch/tree navigation,
	 * rewind, model change, and config reload. The adaptive EMAs are cleared
	 * with the rest — they describe a specific conversation and model pairing,
	 * and carrying them across a switch would make the first turns of the new
	 * session skip on the old one's measurements.
	 */
	reset(reason: SecondThoughtCancelReason = "reset"): void {
		this.cancelActive(reason);
		// Bumped BEFORE the state is cleared: a finalizer or harvest still in
		// flight for the old conversation captured the previous value and its
		// writes are refused from here on. Model change resets without moving the
		// HISTORY epoch, so the history check alone cannot cover this.
		this.#coordEpoch++;
		this.#streamSeq++;
		this.#streamToken = undefined;
		this.#armedStreamSeq = -1;
		this.#toolBatchEmaMs = undefined;
		this.#branchTtftEmaMs = undefined;
		this.#adaptiveSkips = 0;
		this.#cooldownUntil.clear();
	}

	/** Cancel everything and refuse further forks. Idempotent. */
	dispose(): void {
		this.cancelActive("dispose");
		this.#coordEpoch++;
		this.#disposed = true;
	}

	/**
	 * Turn-end hook: abort, collect what settles inside the grace, hand the
	 * harvest to the host, detach the rest.
	 *
	 * Wired BEFORE the advisor catch-up wait in 08 — the ≤300ms harvest must
	 * never queue behind a multi-second advisor backlog.
	 */
	async onPrimaryTurnEnd(): Promise<void> {
		const fork = this.#active;
		// Unconditional cleanup: the coordinator holds no branch after turn end,
		// whatever happens below.
		this.#active = undefined;
		// A turn boundary always re-arms, so a host that never calls
		// `noteStreamStart` degrades to one fork per turn rather than one per
		// session — and the next turn's first tool call is never swallowed by the
		// previous turn's arm.
		this.#streamSeq++;
		this.#streamToken = undefined;
		this.#armedStreamSeq = -1;
		if (!fork) return;
		// SYNCHRONOUS, before the first await: the fan-out has had its window, and
		// the branches the stagger has not started yet must never start now.
		fork.cancelled = true;
		abortController(fork.controller, "second-thought:turn-end");
		for (const handle of fork.handles) handle.abort("second-thought:turn-end");
		try {
			await this.#harvest(fork);
		} catch (error) {
			logger.debug("Second Thought harvest failed", { error });
		}
	}

	async #harvest(fork: ActiveFork): Promise<void> {
		this.#detachSignalListener(fork);
		// Snapshotted here: the stagger tail can still append to the live array,
		// and a handle that appears after the abort has nothing to contribute.
		const handles = [...fork.handles];
		// CLAIMED SYNCHRONOUSLY, before the first await. The turn-end abort
		// resolves `startManyEager`'s stagger gate, so the fan-out's settled tail
		// runs at the very next await below; it sees `cancelled === true` and would
		// otherwise claim these same handles into the ledger-only finalizer, and
		// the grace claim would then find nothing — dropping, as
		// `no-settled-branches`, every unit that settles inside the grace. Claiming
		// first leaves the tail only the handles it appends AFTER teardown, which
		// by construction can never contribute a fold.
		const claimed = this.#claimUnobserved(fork, handles);

		const harvestedAt = this.#now();
		const windowMs = Math.max(0, harvestedAt - fork.forkedAt);

		if (handles.length > 0) await this.#awaitGrace(handles);

		const settled: BranchCallResult[] = [];
		const pending: BranchCallHandle[] = [];
		for (const handle of claimed) {
			const result = handle.settledResult();
			if (result) settled.push(result);
			else pending.push(handle);
		}
		this.#recordResults(fork, settled);
		// Whatever missed the grace is drained off the critical path.
		this.#detachFinalizerFor(fork, pending);

		// Every state write below is gated: a fork whose conversation was torn
		// down under it may still pay the ledger, but it may not steer the next
		// conversation's adaptive decisions and it may not deliver a fold.
		if (!this.#stateWritable(fork)) {
			this.#drop("coordinator-epoch", { generation: fork.generation, coordEpoch: fork.coordEpoch });
			return;
		}
		if (fork.epoch !== this.#host.historyEpoch()) {
			// rewind / replaceMessages / compaction moved history under the fork:
			// the reflections describe a conversation that no longer exists.
			this.#drop("history-epoch", { generation: fork.generation, epoch: fork.epoch });
			return;
		}
		// Only a fork that survived to a real harvest measures a real tool-batch
		// window; writing this before the guards fed the adaptive skip with
		// windows from turns that were rewound or reset out from under it.
		this.#toolBatchEmaMs = ema(this.#toolBatchEmaMs, windowMs);
		if (settled.length === 0) {
			this.#drop("no-settled-branches", { generation: fork.generation, branches: handles.length });
			return;
		}

		const harvest = this.#buildHarvest(fork, settled, handles.length, harvestedAt, windowMs);
		if (harvest.units.length === 0) {
			this.#drop("no-units", { generation: fork.generation });
			return;
		}
		try {
			this.#ledger()?.recordHarvest?.(harvest);
		} catch (error) {
			logger.debug("Second Thought ledger harvest sink threw", { error });
		}
		try {
			this.#host.deliverHarvest?.(harvest);
		} catch (error) {
			logger.debug("Second Thought harvest delivery threw", { error });
		}
	}

	/** Race the branch results against the grace budget; the budget always wins eventually. */
	async #awaitGrace(handles: readonly BranchCallHandle[]): Promise<void> {
		const graceMs = this.#graceMs();
		if (graceMs <= 0) return;
		const timer = delay(graceMs);
		try {
			await Promise.race([
				Promise.allSettled(handles.map(handle => handle.result)).then(() => undefined),
				timer.promise,
			]);
		} finally {
			timer.cancel();
		}
	}

	#buildHarvest(
		fork: ActiveFork,
		settled: readonly BranchCallResult[],
		branchCount: number,
		harvestedAt: number,
		windowMs: number,
	): SecondThoughtHarvest {
		const atomOrder = normalizeBranchAtoms(this.#host.settings.get("secondThought.atoms"));
		const capPerAtom = this.#host.settings.get("secondThought.harvestCapPerAtom") ?? DEFAULT_HARVEST_CAP_PER_ATOM;
		const allowed = new Set<string>(atomOrder);
		const unitsByAtom: Record<string, string[]> = {};
		for (const atom of atomOrder) unitsByAtom[atom] = [];

		const units: ReflectTypedUnit[] = [];
		for (const result of settled) {
			for (const [atom, body] of result.units) {
				// `atom` is model-supplied; 02 already filtered to ATOM_NAMES and
				// this re-filters against the CONFIGURED subset.
				if (!allowed.has(atom)) continue;
				const bucket = unitsByAtom[atom];
				if (capPerAtom > 0 && bucket.length >= capPerAtom) continue;
				bucket.push(body);
				units.push([atom, body]);
			}
		}

		return {
			generation: fork.generation,
			epoch: fork.epoch,
			forkedAt: fork.forkedAt,
			harvestedAt,
			windowMs,
			units,
			unitsByAtom,
			fold: interleaveTypedUnitsByAtom(unitsByAtom, atomOrder),
			branchCount,
			settledCount: settled.length,
			usage: settled.map(result => result.usage),
		};
	}

	/**
	 * Attribute branch results to the ledger, and feed the TTFT EMA only when
	 * the fork still belongs to the live conversation.
	 *
	 * The split is intentional and is the ledger's documented policy: usage the
	 * provider already billed is recorded for EVERY fork, including cancelled,
	 * superseded, rewound and post-reset ones — the money was spent and hiding it
	 * would make the ledger a liar. The adaptive state is the opposite: it steers
	 * future decisions, so a fork from a torn-down conversation must not touch it
	 * (a detached finalizer routinely lands after `reset()`).
	 *
	 * "Torn down" is BOTH epochs. The coordinator epoch covers reset/dispose
	 * (model change, session switch); the history epoch covers rewind /
	 * `replaceMessages` / compaction, which move the conversation without
	 * resetting the coordinator. A rewound fork's TTFT describes a branch off a
	 * conversation that no longer exists, and its fold is already dropped as
	 * `history-epoch` — letting it steer the adaptive window would be the same
	 * measurement leak by another door.
	 */
	#recordResults(fork: ActiveFork, results: readonly BranchCallResult[]): void {
		const writable = this.#stateWritable(fork) && fork.epoch === this.#historyEpoch();
		for (const result of results) {
			if (writable && typeof result.ttftMs === "number" && result.ttftMs >= 0) {
				this.#branchTtftEmaMs = ema(this.#branchTtftEmaMs, result.ttftMs);
			}
			try {
				this.#ledger()?.recordBranchResult?.(result, fork.info);
			} catch (error) {
				logger.debug("Second Thought ledger result sink threw", { error });
			}
		}
	}

	/**
	 * Drain branches that missed the grace, off the primary loop.
	 *
	 * Bounded at {@link FINALIZER_TIMEOUT_MS}: a branch wedged in stream teardown
	 * is abandoned rather than kept alive, and whatever usage did land is still
	 * attributed. Nothing here can deliver a fold — a late result is discarded
	 * by generation, since the fold for that generation was already decided.
	 */
	#detachFinalizerFor(fork: ActiveFork, pending: readonly BranchCallHandle[]): void {
		if (pending.length === 0) return;
		const timeoutMs = this.#finalizerTimeoutMs();
		const task = (async () => {
			const timer = delay(timeoutMs);
			try {
				await Promise.race([
					Promise.allSettled(pending.map(handle => handle.result)).then(() => undefined),
					timer.promise,
				]);
			} catch (error) {
				logger.debug("Second Thought finalizer failed", { error });
			} finally {
				timer.cancel();
			}
			const late: BranchCallResult[] = [];
			for (const handle of pending) {
				const result = handle.settledResult();
				if (result) late.push(result);
			}
			this.#recordResults(fork, late);
		})();
		const tracked = task.finally(() => {
			this.#finalizers.delete(tracked);
		});
		this.#finalizers.add(tracked);
		void tracked;
	}

	/** Observe results of a cancelled fan-out for the ledger, never for a fold. */
	#observeResults(fork: ActiveFork, handles: readonly BranchCallHandle[]): void {
		if (handles.length === 0) return;
		this.#detachFinalizerFor(fork, this.#claimUnobserved(fork, handles));
	}

	/**
	 * Take ownership of the handles this fork has not accounted for yet.
	 *
	 * With an eager fan-out the cancel path and the stagger tail can both reach
	 * the same handle; claiming makes ledger attribution exactly-once.
	 */
	#claimUnobserved(fork: ActiveFork, handles: readonly BranchCallHandle[]): BranchCallHandle[] {
		const fresh: BranchCallHandle[] = [];
		for (const handle of handles) {
			if (fork.observed.has(handle)) continue;
			fork.observed.add(handle);
			fresh.push(handle);
		}
		return fresh;
	}

	/** Whether adaptive/delivery state may still be written on this fork's behalf. */
	#stateWritable(fork: ActiveFork): boolean {
		return !this.#disposed && fork.coordEpoch === this.#coordEpoch;
	}

	/**
	 * The host's history epoch, guarded.
	 *
	 * Read from the detached finalizer as well as the harvest, and the finalizer
	 * is not inside anyone's `try` — a host that throws here must cost a state
	 * write, never an unhandled rejection. `NaN` never equals a fork's epoch, so
	 * the failure mode is "refuse the adaptive write", which is the safe side.
	 */
	#historyEpoch(): number {
		try {
			return this.#host.historyEpoch();
		} catch {
			return Number.NaN;
		}
	}

	/** Await every detached finalizer. Tests only — the loop must never call this. */
	async whenSettled(): Promise<void> {
		while (this.#finalizers.size > 0) await Promise.all([...this.#finalizers]);
	}

	#graceMs(): number {
		try {
			return this.#host.harvestGraceMs?.() ?? HARVEST_GRACE_MS;
		} catch {
			return HARVEST_GRACE_MS;
		}
	}

	#finalizerTimeoutMs(): number {
		try {
			return this.#host.finalizerTimeoutMs?.() ?? FINALIZER_TIMEOUT_MS;
		} catch {
			return FINALIZER_TIMEOUT_MS;
		}
	}

	#estimateContextTokens(): number | undefined {
		try {
			return this.#host.estimateContextTokens?.();
		} catch {
			return undefined;
		}
	}

	#providerInFlightLimit(provider: string): number | undefined {
		try {
			const limits = this.#host.settings.get("providers.maxInFlightRequests") as Record<string, number> | undefined;
			const limit = limits?.[provider];
			return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Suppress the fork when this session's recent tool batches finish faster
	 * than a branch takes to produce its first token — the branch would be
	 * cancelled before it said anything, and be billed for it.
	 */
	#adaptiveWindowSkips(): boolean {
		if (this.#toolBatchEmaMs === undefined || this.#branchTtftEmaMs === undefined) return false;
		if (this.#toolBatchEmaMs >= this.#branchTtftEmaMs) return false;
		// Every Nth qualifying turn forks anyway, so a stale estimate cannot pin
		// the feature off forever. `<= 1` disables the skip entirely.
		const interval = this.#adaptiveProbeInterval();
		if (interval <= 1) return false;
		return ++this.#adaptiveSkips % interval !== 0;
	}

	#adaptiveProbeInterval(): number {
		try {
			const configured = this.#host.adaptiveProbeInterval?.();
			if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1) {
				return Math.trunc(configured);
			}
		} catch {
			// a throwing seam falls back to the constant
		}
		return ADAPTIVE_PROBE_INTERVAL;
	}
}

/** Abort a controller without ever letting a listener's throw escape. */
function abortController(controller: AbortController, reason: unknown): void {
	try {
		if (!controller.signal.aborted) controller.abort(reason);
	} catch {
		// idempotent cancel never throws
	}
}

function ema(previous: number | undefined, sample: number): number {
	if (previous === undefined) return sample;
	return previous + ADAPTIVE_EMA_ALPHA * (sample - previous);
}
