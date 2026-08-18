/**
 * The typed boundary between Second Thought's session-side machinery and its
 * two TUI surfaces (the `second_thought` status-line segment and the transcript
 * card).
 *
 * Neither surface reaches into `AgentSession`, the coordinator, or the ledger.
 * They read one plain value object, {@link SecondThoughtStatusView}, built here
 * from the two things that are already public and reload-safe:
 *
 * - the {@link SecondThoughtFoldEntry} payload of a `custom` session entry
 *   (`customType: SECOND_THOUGHT_FOLD_CUSTOM_TYPE`), which 04 defines and 08
 *   writes, and
 * - a skip reason string, which the coordinator already hands the ledger.
 *
 * Ticket 08 implements `getSecondThoughtStatus()` on the session and feeds it
 * exactly this shape; until then the segment renders nothing, because a host
 * that does not implement the method is indistinguishable from a session with
 * the feature off.
 *
 * ## Why the entry and not the context messages
 *
 * There are none. The fold is injected per-request and retired (04); nothing
 * about it survives in `agent.state.messages`. The diagnostic entry is the only
 * durable record, so it is the only thing a renderer may read — rendering from
 * context would show an empty feature forever.
 *
 * ## Buckets, not reasons, in the status line
 *
 * The coordinator distinguishes fourteen skip reasons. A status-line segment has
 * room for one glyph, so reasons collapse into four
 * {@link SecondThoughtSkipBucket}s that answer the only question the glyph can
 * answer — *whose problem is it?* The verbatim reason is carried through on the
 * view and printed by the transcript card.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import { ATOM_NAMES } from "../../session/second-thought/atoms";
import type { FoldRetireReason, SecondThoughtFoldEntry } from "../../session/second-thought/fold";
import { SECOND_THOUGHT_FOLD_ENTRY_VERSION } from "../../session/second-thought/fold";
import type { SecondThoughtTokenSplit } from "../../session/second-thought/ledger";
import { splitUsage } from "../../session/second-thought/ledger";

/**
 * The four display buckets a skip reason collapses into.
 *
 * - `gated` — the feature is off, or this session/model may not run it. Nothing
 *   is wrong; nothing will change without a settings or model change.
 * - `window` — the turn was unsuitable: too little thinking to condition on,
 *   context too large, or the tool batch measured faster than a branch's
 *   time-to-first-token. Self-correcting.
 * - `provider` — the provider said no, or has no spare slot. Transient.
 * - `error` — the fork could not be built. Actionable, and rare.
 */
export type SecondThoughtSkipBucket = "gated" | "window" | "provider" | "error";

/**
 * Reason → bucket. Deliberately exhaustive over the union in `coordinator.ts`
 * and `gating.ts` rather than a prefix match: a reason added later falls into
 * `error`, which is visible, instead of into a bucket that quietly reads as
 * "expected".
 */
const SKIP_BUCKETS: Readonly<Record<string, SecondThoughtSkipBucket>> = {
	// gating.ts — SecondThoughtGateReason
	disabled: "gated",
	"sub-session": "gated",
	"no-primary-model": "gated",
	"primary-model-not-anthropic": "gated",
	"branch-model-not-anthropic": "gated",
	// coordinator.ts — SecondThoughtSkipReason
	disposed: "gated",
	"conditioning-too-short": "window",
	"context-too-large": "window",
	"adaptive-window": "window",
	"provider-cooldown": "provider",
	"in-flight-cap": "provider",
	"developer-tail": "error",
	"no-fork-context": "error",
	"snapshot-failed": "error",
};

/** Which bucket a skip reason displays as. Unknown reasons bucket as `error`. */
export function secondThoughtSkipBucket(reason: string): SecondThoughtSkipBucket {
	return SKIP_BUCKETS[reason] ?? "error";
}

/** Units one atom contributed, in canonical atom order. */
export interface SecondThoughtAtomUnits {
	readonly atom: string;
	readonly units: readonly string[];
}

/** One retired fold, flattened for display. */
export interface SecondThoughtFoldSummary {
	readonly generation: number;
	/** Per-atom units in canonical order; atoms that produced nothing are dropped. */
	readonly atoms: readonly SecondThoughtAtomUnits[];
	readonly unitCount: number;
	readonly branchCount: number;
	readonly settledCount: number;
	/** Fork → harvest, ms. The wall clock the branch actually had. */
	readonly windowMs: number;
	/** The fold reached at least one request. */
	readonly delivered: boolean;
	readonly retireReason: FoldRetireReason;
	/** Whole units were dropped at the byte cap. */
	readonly truncated: boolean;
	/** PRIMARY cost figure — summed across this fold's branches. */
	readonly tokens: SecondThoughtTokenSplit;
	/** Secondary figure, when the host can price it. */
	readonly costUsd?: number;
	/** The USD figure prices quota burn, not money (OAuth). */
	readonly costIsIndicative?: boolean;
	/** Skip counters snapshotted onto the entry, highest first. */
	readonly skips: readonly SecondThoughtSkipCount[];
}

/** One skip reason and how often the session has hit it. */
export interface SecondThoughtSkipCount {
	readonly reason: string;
	readonly bucket: SecondThoughtSkipBucket;
	readonly count: number;
}

/** The most recent skip, when the last turn did not fork. */
export interface SecondThoughtSkipView {
	readonly reason: string;
	readonly bucket: SecondThoughtSkipBucket;
}

/**
 * Everything both TUI surfaces read. Absent members mean "nothing to show",
 * never "zero" — a segment that cannot distinguish the two would report a
 * healthy session as a broken one.
 */
export interface SecondThoughtStatusView {
	/** `secondThought.enabled`. False renders nothing at all. */
	readonly enabled: boolean;
	/** The last fold that retired, harvested or not. */
	readonly lastFold?: SecondThoughtFoldSummary;
	/** Why the last turn did not fork. Set only when it did not. */
	readonly lastSkip?: SecondThoughtSkipView;
}

/**
 * The narrow host surface the status-line segment probes for.
 *
 * Implemented by `AgentSession` in ticket 08. Optional on purpose, exactly like
 * `getAdvisorStatusOverview`: a lightweight session double in a test, or a build
 * where 08 has not landed, skips the segment instead of throwing.
 */
export interface SecondThoughtStatusHost {
	getSecondThoughtStatus?(): SecondThoughtStatusView | undefined;
}

function addSplit(target: SecondThoughtTokenSplit, source: SecondThoughtTokenSplit): SecondThoughtTokenSplit {
	return {
		uncachedInput: target.uncachedInput + source.uncachedInput,
		cacheRead: target.cacheRead + source.cacheRead,
		cacheWrite: target.cacheWrite + source.cacheWrite,
		output: target.output + source.output,
		totalTokens: target.totalTokens + source.totalTokens,
	};
}

const ZERO_SPLIT: SecondThoughtTokenSplit = {
	uncachedInput: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	totalTokens: 0,
};

/**
 * Sum a fold's per-branch usage the same way the ledger does.
 *
 * Uses the ledger's own {@link splitUsage} rather than reading `Usage` fields
 * here: a second copy of the orchestration fold is how the transcript card and
 * `/cost` start disagreeing about the same call.
 */
export function secondThoughtFoldTokens(usage: readonly (Usage | undefined)[]): SecondThoughtTokenSplit {
	return usage.reduce<SecondThoughtTokenSplit>((total, entry) => addSplit(total, splitUsage(entry)), ZERO_SPLIT);
}

/** Extra figures 08 can attach that the entry itself cannot carry. */
export interface SecondThoughtFoldSummaryOptions {
	/** Branch spend for this fold, from the ledger's rollup. */
	costUsd?: number;
	/** The provider is served by an OAuth credential, so USD is an estimate. */
	costIsIndicative?: boolean;
}

/**
 * Flatten one diagnostic entry into the display shape.
 *
 * Returns `undefined` for a payload this build cannot read — a forward-version
 * entry from a newer session file must render nothing rather than half of
 * something.
 */
export function buildSecondThoughtFoldSummary(
	entry: SecondThoughtFoldEntry,
	options: SecondThoughtFoldSummaryOptions = {},
): SecondThoughtFoldSummary | undefined {
	if (entry.version !== SECOND_THOUGHT_FOLD_ENTRY_VERSION) return undefined;

	const seen = new Set<string>();
	const atoms: SecondThoughtAtomUnits[] = [];
	const pushAtom = (atom: string): void => {
		if (seen.has(atom)) return;
		seen.add(atom);
		const units = entry.unitsByAtom[atom];
		if (!units || units.length === 0) return;
		atoms.push({ atom, units: [...units] });
	};
	// Canonical order first, then anything the parser produced that this build
	// does not know about — an unknown atom is still something the user paid for.
	for (const atom of ATOM_NAMES) pushAtom(atom);
	for (const atom of Object.keys(entry.unitsByAtom)) pushAtom(atom);

	const skips: SecondThoughtSkipCount[] = Object.entries(entry.skips ?? {})
		.filter(([, count]) => count > 0)
		.map(([reason, count]) => ({ reason, bucket: secondThoughtSkipBucket(reason), count }))
		.sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));

	return {
		generation: entry.generation,
		atoms,
		unitCount: entry.unitCount,
		branchCount: entry.branchCount,
		settledCount: entry.settledCount,
		windowMs: entry.windowMs,
		delivered: entry.delivered,
		retireReason: entry.retireReason,
		truncated: entry.truncated,
		tokens: secondThoughtFoldTokens(entry.usage),
		costUsd: options.costUsd,
		costIsIndicative: options.costIsIndicative,
		skips,
	};
}

/** Inputs 08 assembles a view from. */
export interface SecondThoughtStatusViewInput {
	enabled: boolean;
	/** The newest fold entry on the current branch, if any. */
	entry?: SecondThoughtFoldEntry;
	/** Why the last turn did not fork. Omit when it did. */
	lastSkipReason?: string;
	summaryOptions?: SecondThoughtFoldSummaryOptions;
}

/**
 * Assemble the view. A disabled feature yields `{ enabled: false }` with nothing
 * else: the segment is omitted, and the transcript card has nothing to render.
 */
export function buildSecondThoughtStatusView(input: SecondThoughtStatusViewInput): SecondThoughtStatusView {
	if (!input.enabled) return { enabled: false };
	const lastFold = input.entry ? buildSecondThoughtFoldSummary(input.entry, input.summaryOptions) : undefined;
	const lastSkip: SecondThoughtSkipView | undefined = input.lastSkipReason
		? { reason: input.lastSkipReason, bucket: secondThoughtSkipBucket(input.lastSkipReason) }
		: undefined;
	return { enabled: true, ...(lastFold ? { lastFold } : {}), ...(lastSkip ? { lastSkip } : {}) };
}
