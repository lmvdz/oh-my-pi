/**
 * Second Thought cost ledger: what every branch call cost, and why turns did not fork.
 *
 * The coordinator (03) writes here through {@link SecondThoughtLedgerSink}, the
 * narrow optional-method interface it already declares. This module is the real
 * implementation of that interface; it imports nothing session-shaped, so it is
 * constructible in tests from plain stubs and wired to the live session by 08.
 *
 * ## Why the ledger is coordinator-owned and not a session stat
 *
 * `SessionStats` sums usage over `agent.state.messages` — assistant messages and
 * `task` tool results only (`session-stats.ts`). A branch call never produces a
 * message in that array, so branch spend cannot enter the session totals by
 * accident, and it must not be pushed there on purpose either: the session
 * counters are what the user reads as "this conversation's cost", and folding an
 * invisible side call into them makes the number unexplainable. The precedent is
 * `SessionAdvisors`, which keeps advisor spend in its own private
 * `#advisorCosts` map (`session-advisors.ts` `#recordAdvisorCost`) and surfaces
 * it as a separately labelled figure. This ledger is the same pattern with a
 * finer breakdown.
 *
 * ## Tokens are the primary denomination
 *
 * On an OAuth credential the user does not pay dollars at all — they pay
 * quota-window burn, and the USD figure is a list-price estimate for a request
 * that was never invoiced. Every report therefore leads with the token split
 * (uncached input / cache read / cache write / output) and carries USD as a
 * secondary field, flagged {@link SecondThoughtLedgerReport.costIsIndicative}
 * when any recorded provider is OAuth-served.
 *
 * ## Broker attribution
 *
 * {@link SecondThoughtLedger.recordBranchResult} calls the host's
 * `recordObservedUsage` (wired by 08 to `authStorage.recordObservedUsage`)
 * directly, once per branch result that observed usage. That is the same hook
 * `agent-session.ts` uses for the primary turn, and it is deliberately NOT the
 * provider-header ingest path. There are two separate hazards here:
 *
 * - An unstripped branch `onResponse` would call
 *   `SessionStats.ingestProviderUsageHeaders`, whose
 *   `authStorage.ingestUsageHeaders(..., { sessionId: agent.sessionId })` uses
 *   the PRIMARY session id. That pollutes the primary OAuth quota window even
 *   though the branch streamed under a side session id. `branch-call` now
 *   strips `onResponse` before and after host option preparation.
 * - Broker usage is double-booked only if a caller also invokes
 *   `recordObservedUsage` for this same branch. The branch wiring must leave
 *   that call to this ledger alone.
 *
 * The second `onResponse` strip matters because
 * `SessionProviderBoundary.prepareSimpleStreamOptions` injects the primary
 * session's header-ingest hook when it sees none. Branch usage therefore only
 * reaches the broker through this ledger, under the record's side session id.
 * This ledger forwards orchestration-folded `uncachedInput`, whereas the
 * primary session path forwards raw `usage.input`; that is acceptable because
 * the broker has one input bucket and folding keeps billed orchestration input
 * from being silently omitted.
 *
 * ## The undercount is bounded, not observed
 *
 * When a branch is aborted mid-stream the provider keeps decoding for a short
 * while before the disconnect lands, and it bills that decode. Nothing on the
 * wire reports it: the last usage the client saw is the last delta before the
 * socket closed. The honest statement is an upper bound, not a number —
 * `branchMaxTokens − observedOutput`, floored at zero, because `max_tokens` caps
 * what the server could possibly have produced. It is recorded per record
 * ({@link SecondThoughtBranchRecord.undercountBoundTokens}) and aggregated
 * ({@link SecondThoughtLedgerReport.undercountBoundTokens}) so a reader can see
 * the width of the error bar rather than a total that quietly understates.
 */

import type { Api, Model, Usage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import type { BranchCallOutcome, BranchCallResult } from "./branch-call";
import { DEFAULT_BRANCH_MAX_TOKENS } from "./branch-call";
import type {
	SecondThoughtDropReason,
	SecondThoughtForkInfo,
	SecondThoughtHarvest,
	SecondThoughtLedgerSink,
	SecondThoughtSkipReason,
} from "./coordinator";

/** How many per-branch records are retained for inspection. Totals stay exact. */
export const DEFAULT_LEDGER_RECORD_CAP = 200;

/** Cooldown the 429 hook requests when the caller does not name one. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * How a branch call ended, in the ledger's vocabulary.
 *
 * Derived from {@link BranchCallResult} rather than stored by it, with a fixed
 * precedence so one result maps to exactly one bucket: `error` > `tool-use-leak`
 * > `cancelled` > `unit-cap` > `completed`. `toolUseLeak` outranks a clean
 * completion because a branch that called a tool violated the branch prompt and
 * its output is not trustworthy reflection; the raw `outcome` and `toolUseLeak`
 * fields are kept on the record so nothing is lost to the collapse.
 */
export type SecondThoughtTermination = "completed" | "unit-cap" | "cancelled" | "error" | "tool-use-leak";

/** Every termination bucket, in report order. */
export const SECOND_THOUGHT_TERMINATIONS: readonly SecondThoughtTermination[] = [
	"completed",
	"unit-cap",
	"cancelled",
	"error",
	"tool-use-leak",
];

/** Token split as the ledger denominates it. Cache buckets are never folded into input. */
export interface SecondThoughtTokenSplit {
	/** Uncached, newly-billed input tokens. */
	readonly uncachedInput: number;
	/** Tokens served from the prompt cache — the metric R2's acceptance gate reads. */
	readonly cacheRead: number;
	/** Tokens written into the prompt cache. */
	readonly cacheWrite: number;
	readonly output: number;
	/** Provider-reported total, including orchestration tokens it bills outside the four buckets. */
	readonly totalTokens: number;
}

const ZERO_SPLIT: SecondThoughtTokenSplit = {
	uncachedInput: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	totalTokens: 0,
};

/** USD breakdown, secondary to {@link SecondThoughtTokenSplit}. */
export interface SecondThoughtCostSplit {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

const ZERO_COST: SecondThoughtCostSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** One branch call's accounting row. */
export interface SecondThoughtBranchRecord {
	/** Fork generation this branch belonged to. One fork per turn at most. */
	readonly generation: number;
	/** Host history epoch at fork time. */
	readonly epoch: number;
	/** Side-channel session id the branch streamed under (`…:side:reflect:…`). */
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly forkedAt: number;
	readonly recordedAt: number;
	/** fork → first streamed text delta, ms. `undefined` when the branch never spoke. */
	readonly ttftMs?: number;
	/** fork → settle (natural end or cancel), ms. */
	readonly durationMs: number;
	readonly termination: SecondThoughtTermination;
	/** Raw outcome from 02, preserved through the termination collapse. */
	readonly outcome: BranchCallOutcome;
	readonly toolUseLeak: boolean;
	/** Typed units this branch contributed (pre-harvest filtering). */
	readonly unitsHarvested: number;
	readonly tokens: SecondThoughtTokenSplit;
	readonly costUsd: SecondThoughtCostSplit;
	/** The provider reported usage at all. `false` means the row is tokens-unknown, not zero-cost. */
	readonly usageObserved: boolean;
	/** USD came from a resolved model cost table rather than a provider-supplied figure or nothing. */
	readonly costFromCostTable: boolean;
	/**
	 * Upper bound on output tokens billed but never observed, for a call whose
	 * stream did not end naturally. Zero for `completed`. See the module doc.
	 */
	readonly undercountBoundTokens: number;
	readonly error?: string;
}

/** Per-fork rollup — with one fork per turn this is also the per-turn rollup. */
export interface SecondThoughtForkRollup {
	readonly generation: number;
	readonly epoch: number;
	readonly forkedAt: number;
	readonly model: string;
	readonly provider: string;
	/** Branches the fork intended to start. */
	readonly branchCount: number;
	/** Branch results actually recorded, including ones drained after the grace. */
	readonly recordedBranches: number;
	readonly tokens: SecondThoughtTokenSplit;
	readonly costUsd: SecondThoughtCostSplit;
	readonly undercountBoundTokens: number;
	/** Units the harvest kept for this fork; `undefined` until the fork harvests (or never, if dropped). */
	readonly harvestedUnits?: number;
	/** fork → harvest wall clock, when the fork reached a harvest. */
	readonly windowMs?: number;
	readonly terminations: Readonly<Record<SecondThoughtTermination, number>>;
}

/** The whole session's Second Thought accounting. Tokens first, USD second. */
export interface SecondThoughtLedgerReport {
	readonly forks: number;
	readonly branches: number;
	readonly harvests: number;
	readonly unitsHarvested: number;
	/** PRIMARY figure. */
	readonly tokens: SecondThoughtTokenSplit;
	/** Secondary figure; see {@link SecondThoughtLedgerReport.costIsIndicative}. */
	readonly costUsd: SecondThoughtCostSplit;
	/**
	 * At least one recorded provider is served by an OAuth credential, so the USD
	 * total is a list-price estimate of a request that burns quota, not money.
	 */
	readonly costIsIndicative: boolean;
	/** Sum of the per-record undercount bounds; the width of the error bar on `tokens.output`. */
	readonly undercountBoundTokens: number;
	/** Branch results that reported no usage at all. Their tokens are unknown, not zero. */
	readonly branchesWithoutUsage: number;
	readonly skips: Readonly<Record<string, number>>;
	readonly drops: Readonly<Record<string, number>>;
	readonly terminations: Readonly<Record<SecondThoughtTermination, number>>;
	/** provider → observed 429 count. */
	readonly rateLimits: Readonly<Record<string, number>>;
	/** Retained rows, oldest first, capped at {@link SecondThoughtLedgerOptions.recordCap}. */
	readonly records: readonly SecondThoughtBranchRecord[];
	/** Per-fork rollups, oldest first, capped alongside the records. */
	readonly rollups: readonly SecondThoughtForkRollup[];
}

/** Everything the ledger borrows from its owning session. All optional: tests pass none. */
export interface SecondThoughtLedgerHost {
	/**
	 * Resolve the model a branch ran on so its cost table can price the usage.
	 * 08 wires this to the model registry; without it USD falls back to whatever
	 * the provider itself reported and {@link SecondThoughtBranchRecord.costFromCostTable}
	 * is `false`.
	 */
	modelFor?(provider: string, modelId: string): Model<Api> | undefined;
	/**
	 * Broker attribution sink. 08 wires this to
	 * `modelRegistry.authStorage.recordObservedUsage`; the shape is that method's
	 * parameter exactly.
	 */
	recordObservedUsage?(entry: {
		provider: string;
		model: string;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
		costUsd?: number;
		at?: number;
	}): void;
	/**
	 * Whether `provider` is served by an OAuth credential (`authStorage.hasOAuth`).
	 * Drives {@link SecondThoughtLedgerReport.costIsIndicative} only.
	 */
	hasOAuth?(provider: string): boolean;
	/** `secondThought.branchMaxTokens`; the ceiling in the undercount bound. */
	branchMaxTokens?(): number;
	/**
	 * Forwarded on every observed 429 — 08 wires it to
	 * `SecondThoughtCoordinator.noteProviderRateLimit`, which is 03's cooldown
	 * circuit breaker. The ledger owns the observation, the coordinator owns the
	 * policy.
	 */
	onProviderRateLimit?(provider: string, cooldownMs: number): void;
	/** Injectable clock (tests). */
	now?(): number;
}

export interface SecondThoughtLedgerOptions {
	/** Retained per-branch rows and per-fork rollups. Defaults to {@link DEFAULT_LEDGER_RECORD_CAP}. */
	recordCap?: number;
	/** Cooldown requested when {@link SecondThoughtLedger.noteRateLimit} is called without one. */
	rateLimitCooldownMs?: number;
}

interface MutableSplit {
	uncachedInput: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	totalTokens: number;
}

interface MutableCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

interface MutableRollup {
	generation: number;
	epoch: number;
	/** Ledger-local reset epoch captured when this fork was recorded. */
	ledgerEpoch: number;
	forkedAt: number;
	model: string;
	provider: string;
	branchCount: number;
	/** Snapshot at fork time; a drained branch must not see a later settings edit. */
	branchMaxTokens: number;
	recordedBranches: number;
	tokens: MutableSplit;
	costUsd: MutableCost;
	undercountBoundTokens: number;
	harvestedUnits?: number;
	windowMs?: number;
	terminations: Record<SecondThoughtTermination, number>;
}

function emptySplit(): MutableSplit {
	return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 };
}

function emptyCost(): MutableCost {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function emptyTerminations(): Record<SecondThoughtTermination, number> {
	return { completed: 0, "unit-cap": 0, cancelled: 0, error: 0, "tool-use-leak": 0 };
}

/** Non-finite provider numbers must never poison a running total. */
function finite(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addSplit(target: MutableSplit, source: SecondThoughtTokenSplit): void {
	target.uncachedInput += source.uncachedInput;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.output += source.output;
	target.totalTokens += source.totalTokens;
}

function addCost(target: MutableCost, source: SecondThoughtCostSplit): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.total += source.total;
}

function freezeSplit(split: MutableSplit): SecondThoughtTokenSplit {
	return { ...split };
}

function freezeCost(cost: MutableCost): SecondThoughtCostSplit {
	return { ...cost };
}

/**
 * Collapse a branch result to one termination bucket.
 *
 * Exported because 07's TUI and 04's diagnostic entry must label a result the
 * same way the ledger counts it; a second copy of this precedence elsewhere is
 * how two surfaces start disagreeing about the same call.
 */
export function terminationOf(result: Pick<BranchCallResult, "outcome" | "toolUseLeak">): SecondThoughtTermination {
	if (result.outcome === "error") return "error";
	if (result.toolUseLeak) return "tool-use-leak";
	if (result.outcome === "aborted") return "cancelled";
	if (result.outcome === "unitCap") return "unit-cap";
	return "completed";
}

/**
 * Split provider usage into the ledger's four buckets.
 *
 * Orchestration tokens are billed but sit outside the conversation buckets, so
 * they are folded into the bucket they are billed as (the same fold
 * `calculateCost` applies) rather than being silently dropped.
 */
export function splitUsage(usage: Usage | undefined): SecondThoughtTokenSplit {
	if (!usage) return ZERO_SPLIT;
	const orchestration = usage.orchestration;
	return {
		uncachedInput: finite(usage.input) + finite(orchestration?.input),
		cacheRead: finite(usage.cacheRead) + finite(orchestration?.cacheRead),
		cacheWrite: finite(usage.cacheWrite),
		output: finite(usage.output) + finite(orchestration?.output),
		totalTokens: finite(usage.totalTokens),
	};
}

/**
 * Does this provider error look like a rate limit?
 *
 * Deliberately shallow — 02 surfaces the provider error as a string, so this is
 * pattern matching on prose. A false positive costs one cooldown window (the
 * feature skips forking and says so in the skip counters); a false negative just
 * means the breaker is armed by the next real 429. Neither is worth a parser.
 */
export function looksLikeRateLimit(error: string | undefined): boolean {
	if (!error) return false;
	if (/\b429\b/.test(error)) return true;
	return /rate[\s_-]?limit|too many requests|overloaded|quota exceeded/i.test(error);
}

/**
 * Records what Second Thought spent and why it sometimes did not spend it.
 *
 * Implements {@link SecondThoughtLedgerSink}, so an instance is passed straight
 * to the coordinator as `host.ledger`. Nothing here throws into the coordinator:
 * every public method swallows its own failures, matching the coordinator's
 * assumption that a ledger sink is never load-bearing for correctness.
 */
export class SecondThoughtLedger implements SecondThoughtLedgerSink {
	readonly #host: SecondThoughtLedgerHost;
	readonly #recordCap: number;
	readonly #rateLimitCooldownMs: number;

	#forks = 0;
	#branches = 0;
	#harvests = 0;
	#unitsHarvested = 0;
	#branchesWithoutUsage = 0;
	#undercountBoundTokens = 0;
	#tokens = emptySplit();
	#costUsd = emptyCost();
	#terminations = emptyTerminations();
	#skips = new Map<string, number>();
	#drops = new Map<string, number>();
	#rateLimits = new Map<string, number>();
	#oauthProviders = new Set<string>();
	#records: SecondThoughtBranchRecord[] = [];
	#rollups = new Map<number, MutableRollup>();
	#rollupOrder: number[] = [];
	/** Increments on reset so late results cannot cross conversation boundaries. */
	#ledgerEpoch = 0;
	/** Fork generation → ledger epoch. Retained across reset to fence late finalizers. */
	#forkLedgerEpochs = new Map<number, number>();

	constructor(host: SecondThoughtLedgerHost = {}, options: SecondThoughtLedgerOptions = {}) {
		this.#host = host;
		const cap = options.recordCap;
		this.#recordCap =
			typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? Math.trunc(cap) : DEFAULT_LEDGER_RECORD_CAP;
		const cooldown = options.rateLimitCooldownMs;
		this.#rateLimitCooldownMs =
			typeof cooldown === "number" && Number.isFinite(cooldown) && cooldown >= 0
				? cooldown
				: DEFAULT_RATE_LIMIT_COOLDOWN_MS;
	}

	// ── sink surface (SecondThoughtLedgerSink) ─────────────────────────────────

	/** Count a turn that did not fork. `reason` is 03's closed skip-reason set. */
	recordSkip(reason: SecondThoughtSkipReason, _info?: Record<string, unknown>): void {
		bump(this.#skips, reason);
	}

	/** Count a fork and open its rollup. */
	recordFork(info: SecondThoughtForkInfo): void {
		this.#forks++;
		this.#forkLedgerEpochs.set(info.generation, this.#ledgerEpoch);
		this.#rollupFor(info);
	}

	/** Count a fork that produced no fold. Drop reasons and skip reasons are disjoint sets. */
	recordDrop(reason: SecondThoughtDropReason, _info?: Record<string, unknown>): void {
		bump(this.#drops, reason);
	}

	/**
	 * Attribute one settled branch call.
	 *
	 * Called for every branch the coordinator observes in the current ledger
	 * epoch — completed, cancelled, superseded, rewound, and
	 * drained-by-the-background-finalizer alike. A result for a fork from before a
	 * ledger reset is deliberately ignored: its spend belongs to the closed old
	 * conversation, never the new one.
	 */
	recordBranchResult(result: BranchCallResult, info: SecondThoughtForkInfo): void {
		try {
			if (!this.#belongsToCurrentEpoch(info.generation)) return;
			const rollup = this.#rollupFor(info);
			const record = this.#buildRecord(result, info, rollup?.branchMaxTokens ?? this.#branchMaxTokens());
			this.#branches++;
			this.#terminations[record.termination]++;
			addSplit(this.#tokens, record.tokens);
			addCost(this.#costUsd, record.costUsd);
			this.#undercountBoundTokens += record.undercountBoundTokens;
			if (!record.usageObserved) this.#branchesWithoutUsage++;

			if (rollup) {
				rollup.recordedBranches++;
				rollup.terminations[record.termination]++;
				addSplit(rollup.tokens, record.tokens);
				addCost(rollup.costUsd, record.costUsd);
				rollup.undercountBoundTokens += record.undercountBoundTokens;
			}

			this.#push(record);
			this.#noteOAuth(record.provider);
			this.#reportObservedUsage(record);
			// A branch that died on a 429 is the earliest signal the provider is
			// shedding load; arming 03's breaker from here means the next turn skips
			// instead of forking into the same wall.
			if (record.termination === "error" && looksLikeRateLimit(record.error)) {
				this.noteRateLimit(record.provider);
			}
		} catch (error) {
			logger.debug("Second Thought ledger failed to record a branch result", { error });
		}
	}

	/** Record what a fork's harvest actually kept. */
	recordHarvest(harvest: SecondThoughtHarvest): void {
		try {
			if (!this.#belongsToCurrentEpoch(harvest.generation)) return;
			this.#harvests++;
			this.#unitsHarvested += harvest.units.length;
			const rollup = this.#rollups.get(harvest.generation);
			if (rollup) {
				rollup.harvestedUnits = (rollup.harvestedUnits ?? 0) + harvest.units.length;
				rollup.windowMs = harvest.windowMs;
			}
		} catch (error) {
			logger.debug("Second Thought ledger failed to record a harvest", { error });
		}
	}

	// ── observation hooks ──────────────────────────────────────────────────────

	/**
	 * Observe a provider 429 and forward it to 03's cooldown breaker.
	 *
	 * The ledger is the observation point because it is the only module that sees
	 * every branch outcome, including the ones drained off the critical path by
	 * the coordinator's background finalizer. The cooldown POLICY stays in the
	 * coordinator; this only tells it that a limit was hit.
	 */
	noteRateLimit(provider: string, cooldownMs: number = this.#rateLimitCooldownMs): void {
		if (!provider) return;
		bump(this.#rateLimits, provider);
		try {
			this.#host.onProviderRateLimit?.(provider, Math.max(0, cooldownMs));
		} catch (error) {
			logger.debug("Second Thought rate-limit hook threw", { provider, error });
		}
	}

	/**
	 * Classify an arbitrary provider error and arm the breaker when it reads as a
	 * rate limit. Returns whether it did — 08 wires this to the primary session's
	 * provider-error path so a 429 on the MAIN call also suppresses forking.
	 */
	observeProviderError(provider: string, error: unknown): boolean {
		const text = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
		if (!looksLikeRateLimit(text)) return false;
		this.noteRateLimit(provider);
		return true;
	}

	// ── reporting ──────────────────────────────────────────────────────────────

	/** Total branch calls attributed. */
	get branchCount(): number {
		return this.#branches;
	}

	/** PRIMARY session figure: the token split across every branch call. */
	get tokens(): SecondThoughtTokenSplit {
		return freezeSplit(this.#tokens);
	}

	/** Secondary session figure. Indicative on OAuth — see {@link SecondThoughtLedger.costIsIndicative}. */
	get costUsd(): SecondThoughtCostSplit {
		return freezeCost(this.#costUsd);
	}

	/** Whether any recorded provider is OAuth-served, making USD a list-price estimate. */
	get costIsIndicative(): boolean {
		return this.#oauthProviders.size > 0;
	}

	/** Session-wide upper bound on output tokens billed but never observed. */
	get undercountBoundTokens(): number {
		return this.#undercountBoundTokens;
	}

	/** Skip-reason counters — the data that says whether the circuit breakers are tuned right. */
	skipCounts(): Record<string, number> {
		return Object.fromEntries(this.#skips);
	}

	/** Drop-reason counters. */
	dropCounts(): Record<string, number> {
		return Object.fromEntries(this.#drops);
	}

	/** Per-fork (== per-turn) rollups, oldest first. */
	rollups(): SecondThoughtForkRollup[] {
		return this.#rollupOrder
			.map(generation => this.#rollups.get(generation))
			.filter((rollup): rollup is MutableRollup => rollup !== undefined)
			.map(freezeRollup);
	}

	/** One fork's rollup, or `undefined` if it was never recorded or has aged out. */
	rollup(generation: number): SecondThoughtForkRollup | undefined {
		const rollup = this.#rollups.get(generation);
		return rollup ? freezeRollup(rollup) : undefined;
	}

	/** Retained per-branch rows, oldest first. */
	records(): readonly SecondThoughtBranchRecord[] {
		return this.#records.map(freezeRecord);
	}

	/** The whole picture, for 04's diagnostic entry and 07's TUI. */
	report(): SecondThoughtLedgerReport {
		return {
			forks: this.#forks,
			branches: this.#branches,
			harvests: this.#harvests,
			unitsHarvested: this.#unitsHarvested,
			tokens: freezeSplit(this.#tokens),
			costUsd: freezeCost(this.#costUsd),
			costIsIndicative: this.costIsIndicative,
			undercountBoundTokens: this.#undercountBoundTokens,
			branchesWithoutUsage: this.#branchesWithoutUsage,
			skips: this.skipCounts(),
			drops: this.dropCounts(),
			terminations: { ...this.#terminations },
			rateLimits: Object.fromEntries(this.#rateLimits),
			records: this.records(),
			rollups: this.rollups(),
		};
	}

	/**
	 * Clear every counter.
	 *
	 * Wired by 08 to the same conversation-scoped transitions that call
	 * `SecondThoughtCoordinator.reset` (session switch, new session), for the same
	 * reason the coordinator clears its EMAs there: the figures describe one
	 * conversation and carrying them across a switch misattributes spend. The
	 * previous epoch's totals, including its undercount bound, close here; late
	 * old-epoch results and harvests cannot be attributed to the new conversation.
	 */
	reset(): void {
		this.#ledgerEpoch++;
		this.#forks = 0;
		this.#branches = 0;
		this.#harvests = 0;
		this.#unitsHarvested = 0;
		this.#branchesWithoutUsage = 0;
		this.#undercountBoundTokens = 0;
		this.#tokens = emptySplit();
		this.#costUsd = emptyCost();
		this.#terminations = emptyTerminations();
		this.#skips.clear();
		this.#drops.clear();
		this.#rateLimits.clear();
		this.#oauthProviders.clear();
		this.#records = [];
		this.#rollups.clear();
		this.#rollupOrder = [];
	}

	// ── internals ──────────────────────────────────────────────────────────────

	#now(): number {
		try {
			return this.#host.now?.() ?? Date.now();
		} catch {
			return Date.now();
		}
	}

	#buildRecord(
		result: BranchCallResult,
		info: SecondThoughtForkInfo,
		branchMaxTokens: number,
	): SecondThoughtBranchRecord {
		const termination = terminationOf(result);
		const tokens = splitUsage(result.usage);
		const { cost, fromCostTable } = this.#priceUsage(info, result.usage);
		return {
			generation: info.generation,
			epoch: info.epoch,
			sessionId: result.sessionId,
			provider: info.provider,
			model: info.model,
			forkedAt: info.forkedAt,
			recordedAt: this.#now(),
			ttftMs: typeof result.ttftMs === "number" && result.ttftMs >= 0 ? result.ttftMs : undefined,
			durationMs: Math.max(0, finite(result.durationMs)),
			termination,
			outcome: result.outcome,
			toolUseLeak: result.toolUseLeak,
			unitsHarvested: result.units.length,
			tokens,
			costUsd: cost,
			usageObserved: result.usage !== undefined,
			costFromCostTable: fromCostTable,
			undercountBoundTokens: this.#undercountBound(result.outcome, tokens.output, branchMaxTokens),
			error: result.error,
		};
	}

	/**
	 * The bound applies to every stream that did NOT end naturally — cancelled,
	 * unit-capped, and errored alike. The raw stream outcome, rather than the
	 * ledger's display termination, decides this: a naturally completed call can
	 * still be labelled `tool-use-leak`, but it received terminal usage and has no
	 * unobserved tail. A unit-cap abort drains a few more events looking for that
	 * terminal usage (02), so its bound is often the loosest part of a tight
	 * estimate — which is the correct failure direction for an upper bound.
	 */
	#undercountBound(outcome: BranchCallOutcome, observedOutput: number, branchMaxTokens: number): number {
		if (outcome === "completed") return 0;
		return Math.max(0, branchMaxTokens - observedOutput);
	}

	#branchMaxTokens(): number {
		try {
			const configured = this.#host.branchMaxTokens?.();
			if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
				return Math.trunc(configured);
			}
		} catch {
			// a throwing seam falls back to the documented default
		}
		return DEFAULT_BRANCH_MAX_TOKENS;
	}

	/**
	 * Price usage through the model's own cost table.
	 *
	 * `calculateCost` MUTATES the usage object it is handed, so it is only ever
	 * called on a clone — a branch result's usage is shared with the harvest the
	 * coordinator already published, and repricing it in place would rewrite a
	 * value someone else is reading.
	 */
	#priceUsage(
		info: SecondThoughtForkInfo,
		usage: Usage | undefined,
	): { cost: SecondThoughtCostSplit; fromCostTable: boolean } {
		if (!usage) return { cost: ZERO_COST, fromCostTable: false };
		let model: Model<Api> | undefined;
		try {
			model = this.#host.modelFor?.(info.provider, info.model);
		} catch {
			model = undefined;
		}
		if (model) {
			try {
				const clone = cloneUsage(usage);
				const cost = calculateCost(model, clone);
				return {
					cost: {
						input: finite(cost.input),
						output: finite(cost.output),
						cacheRead: finite(cost.cacheRead),
						cacheWrite: finite(cost.cacheWrite),
						total: finite(cost.total),
					},
					fromCostTable: true,
				};
			} catch (error) {
				logger.debug("Second Thought ledger cost table pricing failed", { model: info.model, error });
			}
		}
		// No resolvable cost table: fall back to whatever the provider priced, and
		// say so, rather than reporting a confident zero.
		const reported = usage.cost;
		if (!reported) return { cost: ZERO_COST, fromCostTable: false };
		return {
			cost: {
				input: finite(reported.input),
				output: finite(reported.output),
				cacheRead: finite(reported.cacheRead),
				cacheWrite: finite(reported.cacheWrite),
				total: finite(reported.total),
			},
			fromCostTable: false,
		};
	}

	/**
	 * Forward one branch's burn to the broker.
	 *
	 * Skipped when the provider reported no usage: `recordObservedUsage` counts a
	 * request per call, and reporting an all-zero row would inflate the broker's
	 * request count with a call whose tokens are unknown.
	 */
	#reportObservedUsage(record: SecondThoughtBranchRecord): void {
		if (!record.usageObserved) return;
		try {
			this.#host.recordObservedUsage?.({
				provider: record.provider,
				model: record.model,
				at: record.recordedAt,
				usage: {
					input: record.tokens.uncachedInput,
					output: record.tokens.output,
					cacheRead: record.tokens.cacheRead,
					cacheWrite: record.tokens.cacheWrite,
				},
				costUsd: record.costUsd.total,
			});
		} catch (error) {
			logger.debug("Second Thought observed-usage report failed", { provider: record.provider, error });
		}
	}

	#noteOAuth(provider: string): void {
		try {
			if (this.#host.hasOAuth?.(provider)) this.#oauthProviders.add(provider);
		} catch {
			// an unavailable auth store simply leaves USD un-flagged
		}
	}

	#belongsToCurrentEpoch(generation: number): boolean {
		const rollup = this.#rollups.get(generation);
		if (rollup && rollup.ledgerEpoch !== this.#ledgerEpoch) return false;
		const forkLedgerEpoch = this.#forkLedgerEpochs.get(generation);
		return forkLedgerEpoch === undefined || forkLedgerEpoch === this.#ledgerEpoch;
	}

	#rollupFor(info: SecondThoughtForkInfo): MutableRollup | undefined {
		const existing = this.#rollups.get(info.generation);
		if (existing) return existing.ledgerEpoch === this.#ledgerEpoch ? existing : undefined;
		// A drained result for an aged-out generation still belongs in the session
		// totals, but recreating its rollup would evict a newer, complete one.
		if (this.#isOlderThanRetainedWindow(info.generation)) return undefined;
		const rollup: MutableRollup = {
			generation: info.generation,
			epoch: info.epoch,
			ledgerEpoch: this.#ledgerEpoch,
			forkedAt: info.forkedAt,
			model: info.model,
			provider: info.provider,
			branchCount: info.branchCount,
			branchMaxTokens: this.#branchMaxTokens(),
			recordedBranches: 0,
			tokens: emptySplit(),
			costUsd: emptyCost(),
			undercountBoundTokens: 0,
			terminations: emptyTerminations(),
		};
		this.#forkLedgerEpochs.set(info.generation, this.#ledgerEpoch);
		this.#rollups.set(info.generation, rollup);
		this.#rollupOrder.push(info.generation);
		this.#trimRollups();
		return rollup;
	}

	#isOlderThanRetainedWindow(generation: number): boolean {
		const oldestRetained = this.#rollupOrder[0];
		return oldestRetained !== undefined && generation < oldestRetained;
	}

	#push(record: SecondThoughtBranchRecord): void {
		if (this.#recordCap === 0) return;
		this.#records.push(record);
		if (this.#records.length > this.#recordCap) {
			this.#records.splice(0, this.#records.length - this.#recordCap);
		}
	}

	/**
	 * Rollups age out with the records, but a rollup is dropped only from the
	 * FRONT and never while its fork can still be written to: the coordinator's
	 * background finalizer can land a late branch result long after the fork
	 * harvested, so trimming is capped generously and the totals above are the
	 * authoritative figures either way.
	 */
	#trimRollups(): void {
		const cap = this.#recordCap;
		while (this.#rollupOrder.length > cap) {
			const oldest = this.#rollupOrder.shift();
			if (oldest !== undefined) this.#rollups.delete(oldest);
		}
	}
}

function freezeRollup(rollup: MutableRollup): SecondThoughtForkRollup {
	return {
		generation: rollup.generation,
		epoch: rollup.epoch,
		forkedAt: rollup.forkedAt,
		model: rollup.model,
		provider: rollup.provider,
		branchCount: rollup.branchCount,
		recordedBranches: rollup.recordedBranches,
		tokens: freezeSplit(rollup.tokens),
		costUsd: freezeCost(rollup.costUsd),
		undercountBoundTokens: rollup.undercountBoundTokens,
		harvestedUnits: rollup.harvestedUnits,
		windowMs: rollup.windowMs,
		terminations: { ...rollup.terminations },
	};
}

function freezeRecord(record: SecondThoughtBranchRecord): SecondThoughtBranchRecord {
	return {
		...record,
		tokens: freezeSplit(record.tokens),
		costUsd: freezeCost(record.costUsd),
	};
}

function bump(counter: Map<string, number>, key: string): void {
	counter.set(key, (counter.get(key) ?? 0) + 1);
}

/**
 * Copy a usage record deeply enough for `calculateCost` to write into.
 *
 * `structuredClone` would also work but throws on anything a provider attached
 * that is not structured-cloneable; usage is a flat numeric record with two
 * known nested objects, so an explicit copy is both cheaper and total.
 */
function cloneUsage(usage: Usage): Usage {
	return {
		...usage,
		orchestration: usage.orchestration ? { ...usage.orchestration } : undefined,
		cttl: usage.cttl ? { ...usage.cttl } : undefined,
		server: usage.server ? { ...usage.server } : undefined,
		cost: usage.cost ? { ...usage.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
