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
 * thinking configuration byte-for-byte, and appends only a two-message
 * synthetic suffix. Anything that perturbs the prefix (a different model, a
 * `toolChoice` parameter, `disableReasoning`) costs a full-price uncached
 * input pass over the whole conversation, every turn.
 */

import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, Tool, Usage } from "@oh-my-pi/pi-ai";
import { ATOM_NAMES, COMBINED_BRANCH_PROMPT, type ReflectAtom } from "./atoms";
import { countReflectUnits, parseReflectTypedUnits, type ReflectTypedUnit } from "./parser";

/** `secondThought.branchMaxTokens` default. */
export const DEFAULT_BRANCH_MAX_TOKENS = 2048;

/** `secondThought.harvestCapPerAtom` default. */
export const DEFAULT_HARVEST_CAP_PER_ATOM = 20;

/** Side-channel session id segment identifying a Second Thought branch. */
export const BRANCH_SIDE_ROLE = "reflect";

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
	 * service tier, provider session state, websocket preference). Cache-hostile
	 * fields are stripped by {@link buildBranchStreamOptions}.
	 */
	readonly streamOptions?: SimpleStreamOptions;
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
	/** Usage as reported by the provider, when a terminal event carried it. */
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
	/** Resolves once the call has produced its first stream event or settled. */
	readonly firstToken: Promise<void>;
	/** Idempotent cancel. */
	abort(reason?: unknown): void;
}

function deepCopy<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return JSON.parse(JSON.stringify(value)) as T;
	}
}

/**
 * Capture a fork-time snapshot from a materialized provider context (the
 * output of `Agent.buildSideRequestContext`, which mirrors the main loop's
 * system prompt + normalized tools).
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

/** Canonicalize requested atoms: drop unknown names, restore declared order. */
export function normalizeBranchAtoms(atoms: readonly string[] | undefined): ReflectAtom[] {
	if (!atoms || atoms.length === 0) return [...ATOM_NAMES];
	const requested = new Set(atoms);
	const selected = ATOM_NAMES.filter(atom => requested.has(atom));
	return selected.length > 0 ? [...selected] : [...ATOM_NAMES];
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * The synthetic suffix appended to the snapshot: an assistant message carrying
 * the conditioning text, then a user message with the combined-atom prompt.
 *
 * These messages exist only inside the branch request — they are never appended
 * to `agent.state.messages` or persisted.
 */
export function buildBranchSuffix(
	model: Model,
	conditioningText: string,
	prompt: string = COMBINED_BRANCH_PROMPT,
	now = Date.now(),
): Message[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: conditioningText }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: now,
	};
	return [
		assistant,
		{
			role: "user",
			content: [{ type: "text", text: prompt }],
			synthetic: true,
			attribution: "agent",
			timestamp: now,
		},
	];
}

/**
 * Assemble the branch request context: the snapshot prefix verbatim, plus the
 * synthetic suffix. The prefix is byte-identical to the main call's, which is
 * what buys the cache read.
 */
export function buildBranchContext(
	snapshot: BranchSnapshot,
	args: { model: Model; conditioningText: string; prompt?: string; now?: number },
): Context {
	return {
		systemPrompt: snapshot.systemPrompt,
		messages: [
			...snapshot.messages,
			...buildBranchSuffix(args.model, args.conditioningText, args.prompt, args.now ?? Date.now()),
		],
		tools: snapshot.tools,
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
 * - `disableReasoning` invalidates the Anthropic messages-tier cache and is
 *   silently ignored on adaptive-only models — the branch inherits the main
 *   call's thinking configuration.
 * - `anthropicCacheRefresh` is an ownership flag for exactly one primary loop;
 *   side-channel requests must leave it unset.
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

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}

	#nextSideCallId(): string {
		return this.#host.nextSideCallId?.() ?? `${this.#now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
	}

	/** Start one branch call. Never throws once started; the result settles instead. */
	start(request: BranchCallRequest): BranchCallHandle {
		const sessionId = buildBranchSessionId(request.cacheSessionId, this.#nextSideCallId());
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

		const result = this.#execute(request, sessionId, controller, signalFirstToken).finally(() => {
			request.signal?.removeEventListener("abort", onCallerAbort);
			signalFirstToken();
		});

		return {
			sessionId,
			result,
			firstToken,
			abort: (reason?: unknown) => controller.abort(reason),
		};
	}

	/** Start one branch call and await its result. */
	run(request: BranchCallRequest): Promise<BranchCallResult> {
		return this.start(request).result;
	}

	/**
	 * Start `count` branch calls with a stagger: the first call is fired alone
	 * and the rest wait for its first streamed token.
	 *
	 * Concurrent requests sharing an identical prefix all pay full uncached
	 * price until the first response begins streaming and the cache entry
	 * exists, so a naive K-way fan-out costs K× the intended input spend.
	 */
	async startMany(count: number, request: BranchCallRequest): Promise<BranchCallHandle[]> {
		const total = Math.max(0, Math.trunc(count));
		if (total === 0) return [];
		const first = this.start(request);
		if (total === 1) return [first];
		await first.firstToken;
		const rest: BranchCallHandle[] = [];
		for (let index = 1; index < total; index++) rest.push(this.start(request));
		return [first, ...rest];
	}

	async #execute(
		request: BranchCallRequest,
		sessionId: string,
		controller: AbortController,
		signalFirstToken: () => void,
	): Promise<BranchCallResult> {
		const startedAt = this.#now();
		const atoms = normalizeBranchAtoms(request.atoms);
		const capPerAtom = request.harvestCapPerAtom ?? DEFAULT_HARVEST_CAP_PER_ATOM;
		const unitCap = capPerAtom > 0 ? capPerAtom * atoms.length : Number.POSITIVE_INFINITY;

		const context = buildBranchContext(request.snapshot, {
			model: request.model,
			conditioningText: request.conditioningText,
			prompt: request.prompt,
			now: startedAt,
		});
		const wireContext = this.#host.obfuscateContext?.(context) ?? context;
		const options = buildBranchStreamOptions(request, sessionId, controller.signal);
		const preparedOptions = this.#host.prepareStreamOptions?.(options, request.model.provider) ?? options;

		let raw = "";
		let unitCount = 0;
		let toolUseLeak = false;
		let ttftMs: number | undefined;
		const settled: SettledResult = { outcome: "completed" };

		try {
			const stream = await this.#host.streamFn(request.model, wireContext, preparedOptions);
			for await (const event of stream) {
				// The first streamed event means the provider has begun responding —
				// the point after which a second identical-prefix request can hit the
				// cache instead of racing for it.
				signalFirstToken();
				if (event.type === "text_delta") {
					ttftMs ??= this.#now() - startedAt;
					raw += event.delta;
					request.onTextDelta?.(event.delta);
					// Recount only when the delta could have closed a unit;
					// re-scanning the buffer on every fragment is quadratic.
					if (event.delta.includes(">")) {
						unitCount = countReflectUnits(raw);
						if (unitCount >= unitCap) {
							settled.outcome = "unitCap";
							controller.abort();
							break;
						}
					}
					continue;
				}
				// Thinking deltas are ignored: only harvested text matters.
				if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
					toolUseLeak = true;
					continue;
				}
				if (event.type === "done") {
					settled.usage = event.message.usage;
					settled.outcome = "completed";
					break;
				}
				if (event.type === "error") {
					settled.usage = event.error.usage;
					settled.outcome = event.reason === "aborted" ? "aborted" : "error";
					settled.error = event.error.errorMessage || undefined;
					break;
				}
			}
		} catch (error) {
			// A branch never throws into its caller, and never retries after an
			// abort: the provider has already been told to stop.
			if (controller.signal.aborted && settled.outcome === "completed") settled.outcome = "aborted";
			else if (settled.outcome === "completed") {
				settled.outcome = "error";
				settled.error = error instanceof Error ? error.message : String(error);
			}
		}

		if (settled.outcome === "completed" && controller.signal.aborted) settled.outcome = "aborted";

		const text = this.#host.deobfuscateText?.(raw) ?? raw;
		const allowed = new Set<string>(atoms);
		return {
			sessionId,
			text,
			units: parseReflectTypedUnits(text).filter(([atom]) => allowed.has(atom)),
			unitCount: countReflectUnits(text),
			outcome: settled.outcome,
			toolUseLeak,
			usage: settled.usage,
			ttftMs,
			durationMs: this.#now() - startedAt,
			error: settled.error,
		};
	}
}
