/**
 * Second Thought's host wiring: one object AgentSession owns and calls.
 *
 * The seven gauntleted modules are deliberately host-agnostic — the coordinator
 * (03) never imports `AgentSession`, the fold store (04) never imports a session
 * manager, the ledger (06) never imports a model registry. That keeps them
 * unit-testable with stubs, but it leaves three objects and four callback
 * interfaces for the session to assemble. This module is that assembly, so
 * `agent-session.ts` gains one field and a handful of one-line call sites rather
 * than a hundred lines of glue.
 *
 * ## What is wired where
 *
 * | Session call site | Runtime method | Module reached |
 * |---|---|---|
 * | `setAssistantMessageEventInterceptor` | {@link SecondThoughtRuntime.onAssistantEvent} | coordinator fork trigger |
 * | `message_start` (session event) | {@link SecondThoughtRuntime.noteStreamStart} | coordinator stream arming |
 * | `agent.addBeforeModelCall` | {@link SecondThoughtRuntime.onProviderCall} | fold delivery + fork-context capture |
 * | `setOnTurnEnd` (BEFORE advisors) | {@link SecondThoughtRuntime.onPrimaryTurnEnd} | coordinator harvest |
 * | `abort()` / `dispose()` | {@link SecondThoughtRuntime.cancelActive} / {@link SecondThoughtRuntime.dispose} | coordinator teardown |
 * | session switch / branch / tree nav | {@link SecondThoughtRuntime.reset} | coordinator + fold reset |
 * | `agent.replaceMessages` (wrapped) | {@link SecondThoughtRuntime.bumpHistoryEpoch} | staleness guard |
 *
 * ## Provider-call identity, and where arming actually happens
 *
 * The coordinator's arming contract (see its module header) wants one arm per
 * NEW provider call, and explicitly permits the host to wire arming to raw
 * `message_start` events **provided it passes a token that is identical for the
 * resumed message**. That token is {@link SecondThoughtRuntime.providerCallSeq},
 * bumped in {@link SecondThoughtRuntime.onProviderCall} — a hook the agent loop
 * runs exactly once per `prepareProviderCall`, i.e. once per provider call and
 * never for `buildSideRequestContext`.
 *
 * The arm is issued from that hook rather than from the `message_start` event,
 * for an ordering reason worth stating plainly: the fork trigger arrives
 * SYNCHRONOUSLY (`onAssistantMessageEvent`, called from inside the loop), while
 * `message_start` arrives through the session's ASYNC event stream. Arming on
 * the event loses that race for a stream whose first tool call opens early, and
 * a late arm cancels the very fork it was meant to enable. The session still
 * calls {@link SecondThoughtRuntime.noteStreamStart} on `message_start` with the
 * same token, where it is a no-op by construction.
 *
 * The result is that each of the shapes the routed constraint calls out lands
 * correctly without the session having to classify events:
 *
 * - Harmony **abort-retry** `continue`s into a fresh provider call, so the seq
 *   moves and the replacement `message_start` re-arms (cancelling the stale
 *   fork, which belonged to a stream the provider abandoned).
 * - Harmony **truncate-and-resume** recovers the message without a new provider
 *   call. The seq does not move, so the synthetic `message_start` is a no-op and
 *   a healthy fork survives.
 * - The two **no-content `message_start` + `message_end` pairs** (agent-loop's
 *   `done`/`error`-without-partial branch and `emitAbortedAssistantMessage`)
 *   carry the seq the real stream already consumed, so they arm nothing.
 * - The discarded `message_end` emitted **before** a Harmony replacement is not
 *   observed at all: harvest is driven from `onTurnEnd`, never `message_end`.
 *
 * ## Why the fold is injected from `addBeforeModelCall`
 *
 * The routed constraint requires the fold to be the LAST thing added to the
 * request, because `extensionRunner.emitContext` and `wrapSteeringForModel` run
 * inside `transformContext` and would append after it. `addBeforeModelCall`
 * receives the fully prepared provider `Context` — after `transformContext`,
 * after `convertToLlm`, after `normalizeMessagesForProvider`, after
 * `transformProviderContext` (obfuscation, snapcompact, image clamping, the
 * date/cwd reminder) — and nothing runs between it and the wire.
 *
 * It is also strictly narrower than `transformProviderContext`, which the same
 * `Agent` reuses for `buildSideRequestContext` (handoff generation, `/btw`,
 * ephemeral turns). A fold injected there would ride a side request instead of
 * the main call. Delivery is spent per REQUEST, so that miss would be permanent.
 *
 * The trade is that the session mutates `context.messages` in place rather than
 * returning a new `Context`. The agent loop passes the same object straight to
 * the stream fn, so the assignment reaches the wire; {@link
 * SecondThoughtFoldStore.applyToRequest} itself stays pure (it returns a new
 * array; only the field assignment here is a mutation).
 *
 * ## Fork context capture
 *
 * `prepareFork` hands the coordinator the provider request the main call is
 * making RIGHT NOW — the same object graph, captured in the same hook, after
 * the fold was injected. Branch prefix parity is therefore true by
 * construction rather than by reconstruction: 02 deep-copies that context and
 * appends one user turn, so the encoded prefix is byte-identical to the main
 * call's (the acceptance gate asserts this end to end).
 */

import type { Agent, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, Context, Message, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { BranchCaller, type BranchStreamOptions } from "./branch-call";
import {
	type SecondThoughtCancelReason,
	SecondThoughtCoordinator,
	type SecondThoughtForkContext,
	type SecondThoughtHarvest,
	type SecondThoughtHost,
} from "./coordinator";
import {
	type FoldRetireReason,
	type SecondThoughtFoldEntry,
	type SecondThoughtFoldHost,
	SecondThoughtFoldStore,
} from "./fold";
import { SecondThoughtLedger, type SecondThoughtLedgerHost, type SecondThoughtLedgerReport } from "./ledger";

/** Everything the runtime borrows from `AgentSession`. */
export interface SecondThoughtWiringDeps {
	readonly settings: Settings;
	/** The session's agent; only `promptCacheKey` / `sessionId` are read. */
	agentKind(): "main" | "sub";
	primaryModel(): Model<Api> | undefined;
	availableModels(): Model<Api>[];
	/** Primary session id — the branch's side session id derives from it. */
	cacheSessionId(): string;
	/** `agent.promptCacheKey ?? agent.sessionId`. */
	promptCacheKey(): string | undefined;
	/**
	 * Base stream options for a branch, BEFORE host layering. Must mirror the
	 * main call's cache identity (reasoning, thinking-summary, cache retention,
	 * service tier); {@link buildBranchStreamOptions} strips the cache-hostile
	 * fields and `onResponse`.
	 */
	branchStreamOptions(model: Model<Api>): BranchStreamOptions | undefined;
	/**
	 * Settings-aware stream fn. NOT `AgentSession`'s `#sideStreamFn` default —
	 * that falls back to bare `streamSimple`, which drops provider routing,
	 * watchdog budgets, and in-flight caps.
	 */
	readonly streamFn: StreamFn;
	prepareStreamOptions(options: SimpleStreamOptions, provider?: string): SimpleStreamOptions;
	/** Inverse of the session's secret obfuscation, applied to harvested branch text. */
	deobfuscateText?(text: string): string;
	/** Estimated context tokens; `undefined` disables the context-size breaker. */
	estimateContextTokens?(): number | undefined;
	/** Non-context diagnostic entry sink (`sessionManager.appendCustomEntry`). */
	appendFoldEntry(entry: SecondThoughtFoldEntry): void;
	/** Broker attribution (`modelRegistry.authStorage.recordObservedUsage`). */
	recordObservedUsage?(entry: {
		provider: string;
		model: string;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
		costUsd?: number;
		at?: number;
	}): void;
	/** `authStorage.hasOAuth` — drives the indicative-cost flag only. */
	hasOAuth?(provider: string): boolean;
	/** Unique side-call id (production passes a Snowflake). */
	nextSideCallId?(): string;
	/**
	 * TICKET 07 SEAM. ST-07's transcript/footer surface consumes harvests here.
	 * The boundary had not landed on this branch at integration time, so the
	 * callback is optional and unwired; 07 supplies it without touching the
	 * coordinator or the fold store.
	 */
	onHarvest?(harvest: SecondThoughtHarvest): void;
	/** Injectable clock (tests). */
	now?(): number;
}

/**
 * Owns the coordinator, the ledger, and the fold store for one session.
 *
 * Every method is safe to call in any order, more than once, and after
 * {@link SecondThoughtRuntime.dispose}; none of them throw into the primary
 * loop.
 */
export class SecondThoughtRuntime {
	readonly #deps: SecondThoughtWiringDeps;
	readonly coordinator: SecondThoughtCoordinator;
	readonly ledger: SecondThoughtLedger;
	readonly folds: SecondThoughtFoldStore;

	/**
	 * Bumped by `replaceMessages` / rewind / compaction / reset.
	 *
	 * Host-owned on purpose: `#promptGeneration` does NOT move on a same-run
	 * rewind, which is exactly the staleness case this guards.
	 */
	#historyEpoch = 0;
	/** Monotonic provider-call sequence; the stream-arming token. */
	#providerCallSeq = 0;
	/** The provider context of the in-flight main call, captured at fork parity. */
	#forkContext: Context | undefined;
	/** Run abort signal of the in-flight main call. */
	#runSignal: AbortSignal | undefined;
	#disposed = false;

	constructor(deps: SecondThoughtWiringDeps) {
		this.#deps = deps;

		const ledgerHost: SecondThoughtLedgerHost = {
			modelFor: (provider, modelId) =>
				deps.availableModels().find(model => model.provider === provider && model.id === modelId),
			recordObservedUsage: deps.recordObservedUsage ? entry => deps.recordObservedUsage?.(entry) : undefined,
			hasOAuth: deps.hasOAuth ? provider => deps.hasOAuth?.(provider) ?? false : undefined,
			branchMaxTokens: () => deps.settings.get("secondThought.branchMaxTokens"),
			onProviderRateLimit: (provider, cooldownMs) => this.coordinator.noteProviderRateLimit(provider, cooldownMs),
			now: deps.now,
		};
		this.ledger = new SecondThoughtLedger(ledgerHost);

		const foldHost: SecondThoughtFoldHost = {
			settings: deps.settings,
			historyEpoch: () => this.#historyEpoch,
			diagnostics: { appendFoldEntry: entry => deps.appendFoldEntry(entry) },
			skipStats: () => this.ledger.skipCounts(),
			now: deps.now,
		};
		this.folds = new SecondThoughtFoldStore(foldHost);

		const coordinatorHost: SecondThoughtHost = {
			settings: deps.settings,
			agentKind: () => deps.agentKind(),
			primaryModel: () => deps.primaryModel(),
			availableModels: () => deps.availableModels(),
			historyEpoch: () => this.#historyEpoch,
			prepareFork: model => this.#prepareFork(model),
			estimateContextTokens: deps.estimateContextTokens ? () => deps.estimateContextTokens?.() : undefined,
			deliverHarvest: harvest => this.#deliverHarvest(harvest),
			ledger: this.ledger,
			now: deps.now,
		};
		this.coordinator = new SecondThoughtCoordinator(
			coordinatorHost,
			new BranchCaller({
				streamFn: deps.streamFn,
				prepareStreamOptions: (options, provider) => deps.prepareStreamOptions(options, provider),
				// The captured fork context is already obfuscated: it is the exact
				// object the main call sends, taken after `transformProviderContext`
				// ran `obfuscateProviderContext`. Obfuscating again would double-encode
				// placeholders, so only the inverse is wired.
				deobfuscateText: deps.deobfuscateText ? text => deps.deobfuscateText?.(text) ?? text : undefined,
				now: deps.now,
				nextSideCallId: deps.nextSideCallId,
			}),
		);
	}

	/** Monotonic history epoch. Moves on every history rewrite. */
	get historyEpoch(): number {
		return this.#historyEpoch;
	}

	/** Provider-call sequence; the token passed to {@link noteStreamStart}. */
	get providerCallSeq(): number {
		return this.#providerCallSeq;
	}

	/** Whether a fold is waiting to be injected into a request. */
	get hasPendingFold(): boolean {
		return this.folds.hasPending;
	}

	/** Branch spend and skip/drop reasons for this session. */
	report(): SecondThoughtLedgerReport {
		return this.ledger.report();
	}

	/**
	 * History was rewritten (`replaceMessages`, rewind, compaction).
	 *
	 * Both the coordinator and the fold store re-read the epoch at harvest and at
	 * injection, so a bump alone is enough to drop work that describes a
	 * conversation which no longer exists.
	 */
	bumpHistoryEpoch(): void {
		this.#historyEpoch++;
	}

	/**
	 * A new provider call is being assembled. Runs once per `prepareProviderCall`
	 * and never for a side request; see the module doc.
	 *
	 * Does four things, in this order:
	 * 1. moves the provider-call sequence and ARMS the coordinator,
	 * 2. captures the run abort signal so a fork chains to it,
	 * 3. injects the pending fold as the LAST message on the wire,
	 * 4. records the resulting context as the fork snapshot source.
	 *
	 * Arming here rather than from the `message_start` event is an ORDERING
	 * requirement, not a preference. The fork trigger reaches the coordinator
	 * synchronously through `onAssistantMessageEvent` inside the loop, while
	 * `message_start` reaches the session through an async event stream. Arming
	 * from the event would therefore routinely land AFTER the first
	 * `toolcall_start` of the same stream, and a late arm cancels the fork it was
	 * supposed to enable ("restream"). This hook runs before the stream opens, so
	 * the arm always precedes the trigger.
	 *
	 * The session still calls {@link noteStreamStart} on `message_start`; with the
	 * same token it is a proven no-op, and it keeps the coordinator armed if this
	 * gate ever fails to install (gates are sampled when a run starts).
	 */
	onProviderCall(context: Context, signal?: AbortSignal): void {
		if (this.#disposed) return;
		try {
			this.#providerCallSeq++;
			this.coordinator.noteStreamStart(this.#providerCallSeq);
			this.#runSignal = signal;
			const requestKey = this.#providerCallSeq;
			const messages = this.folds.applyToRequest<Message>(context.messages, requestKey);
			if (messages !== context.messages) context.messages = messages as Message[];
			this.#forkContext = context;
		} catch (error) {
			logger.debug("Second Thought provider-call hook failed", { error });
		}
	}

	/**
	 * Arm a fresh provider stream. Wire to the session's `message_start` for
	 * assistant messages, passing {@link providerCallSeq} as the token.
	 *
	 * Idempotent for an unchanged token, which is what makes the Harmony
	 * truncate-resume `message_start` and the two no-content
	 * `message_start`/`message_end` pairs harmless: none of them opened a new
	 * provider call, so none of them moved the seq.
	 */
	noteStreamStart(token: unknown = this.#providerCallSeq): void {
		this.coordinator.noteStreamStart(token);
	}

	/** Fork trigger. Wire into the assistant-message-event interceptor chain. */
	onAssistantEvent(event: Parameters<SecondThoughtCoordinator["onAssistantEvent"]>[0]): void {
		this.coordinator.onAssistantEvent(event);
	}

	/**
	 * Turn end: abort the branches, harvest what settled within the grace, detach
	 * the rest. Must be awaited BEFORE the advisors' backlog wait — a ≤300 ms
	 * harvest queued behind a 30 s advisor catch-up is a dead fork.
	 */
	async onPrimaryTurnEnd(): Promise<void> {
		await this.coordinator.onPrimaryTurnEnd();
	}

	/** Idempotent cancel for the exit paths turn end never reaches. */
	cancelActive(reason: SecondThoughtCancelReason): void {
		this.coordinator.cancelActive(reason);
	}

	/**
	 * Conversation-shaped state change: session switch, branch, tree navigation,
	 * model change. Drops the fork, retires the fold, and moves the epoch so a
	 * result already in flight cannot land in the new conversation.
	 */
	reset(reason: SecondThoughtCancelReason = "reset", foldReason: FoldRetireReason = "reset"): void {
		this.#historyEpoch++;
		this.#forkContext = undefined;
		this.coordinator.reset(reason);
		this.folds.reset(foldReason);
	}

	/** Run end: retire an undelivered fold. v1 never carries it across a prompt. */
	onRunEnd(): void {
		this.folds.onRunEnd();
	}

	/** Terminal teardown. Safe to call more than once. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#forkContext = undefined;
		this.#runSignal = undefined;
		this.coordinator.dispose();
		this.folds.reset("reset");
	}

	/** Test seam: wait for detached finalizers. */
	whenSettled(): Promise<void> {
		return this.coordinator.whenSettled();
	}

	#prepareFork(model: Model<Api>): SecondThoughtForkContext | undefined {
		const captured = this.#forkContext;
		if (!captured) return undefined;
		const streamOptions = this.#deps.branchStreamOptions(model);
		if (!streamOptions) return undefined;
		return {
			context: {
				systemPrompt: captured.systemPrompt,
				messages: captured.messages,
				tools: captured.tools?.map(toWireTool),
			},
			cacheSessionId: this.#deps.cacheSessionId(),
			promptCacheKey: this.#deps.promptCacheKey(),
			streamOptions,
			signal: this.#runSignal,
		};
	}

	#deliverHarvest(harvest: SecondThoughtHarvest): void {
		this.folds.accept(harvest);
		try {
			this.#deps.onHarvest?.(harvest);
		} catch (error) {
			logger.debug("Second Thought harvest observer threw", { error });
		}
	}
}

/**
 * Reduce a live context tool to its declared {@link Tool} fields.
 *
 * `agent-loop`'s `normalizeTools` builds the provider context's tools as
 * `{ ...agentTool, parameters, description }` — the spread carries the host's
 * `execute` callback (and anything else the `AgentTool` holds) straight into
 * `Context.tools`. Functions are not structured-cloneable, so a fork snapshot
 * taken from that object throws and every turn skips with `snapshot-failed`.
 *
 * None of the dropped members reach the wire: the Anthropic encoder reads
 * `name`, `description`, the schema, `strict`, and `native`, and `normalizeTools`
 * has already folded `examples` into `description`. So the branch's tool set is
 * wire-identical to the main call's, which is what the cache prefix depends on.
 */
function toWireTool(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.strict !== undefined && { strict: tool.strict }),
		...(tool.customFormat !== undefined && { customFormat: tool.customFormat }),
		...(tool.customWireName !== undefined && { customWireName: tool.customWireName }),
		...(tool.native !== undefined && { native: tool.native }),
	};
}

/**
 * Wrap `agent.replaceMessages` so every history rewrite bumps the epoch.
 *
 * There are 25+ `replaceMessages` call sites across prewalk, maintenance,
 * turn-recovery, the TTSR coordinator, handoff, and `agent-session.ts` itself.
 * Bumping at each of them is a rule nothing enforces — the next rewrite site
 * added elsewhere would silently reopen the staleness hole this guards. Wrapping
 * the single method the rewrites all go through is the enforceable version.
 *
 * Returns a disposer that restores the original method.
 */
export function instrumentHistoryEpoch(agent: Agent, onReplace: () => void): () => void {
	const original = agent.replaceMessages;
	if (typeof original !== "function") return () => {};
	const bound = original.bind(agent);
	const wrapper = (messages: Parameters<Agent["replaceMessages"]>[0]) => {
		try {
			onReplace();
		} catch (error) {
			logger.debug("Second Thought history-epoch bump failed", { error });
		}
		return bound(messages);
	};
	(agent as { replaceMessages: Agent["replaceMessages"] }).replaceMessages =
		wrapper as unknown as Agent["replaceMessages"];
	return () => {
		if ((agent as { replaceMessages: unknown }).replaceMessages === wrapper) {
			delete (agent as unknown as Record<string, unknown>).replaceMessages;
		}
	};
}
