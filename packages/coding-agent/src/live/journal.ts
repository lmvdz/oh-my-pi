import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { LiveTranscript } from "./controller";

/**
 * The durable write-ahead record of a live session.
 *
 * A WebSocket frame is not history — a browser tab can close, the loopback
 * bridge can drop, and neither erases anything because neither was ever the
 * record. This is. Every decision state change, retained transcript turn,
 * artifact status transition, and the final terminal state land here, in
 * order, before anything downstream is allowed to treat them as real.
 *
 * One append at a time: `#chain` serializes writes so `seq` assignment and
 * on-disk order always agree, even though `append()` can be called from
 * several unrelated code paths (voice events, bridge controls, tool results)
 * without any of them coordinating with each other.
 */

export interface JournalDecisionOption {
	index: number;
	label: string;
	consequence: string;
}

export interface JournalDecisionResolution {
	optionIndex: number;
	label: string;
	source: "voice" | "ui";
}

/**
 * The recorded operating policy for who may resolve a decision by voice — see
 * concern 05's Decisions in `plans/voice-orchestrated-room-integration`.
 * `"destructive"` is the merge/publish/spend/delete class the product owner
 * chose as UI-only for V1; `"routine"` (or an absent class, for a decision
 * minted before a caller declares one) is voice-resolvable through the normal
 * confirmation state machine. Set once, at `mint()` — never inferred here.
 */
export type JournalDecisionClass = "destructive" | "routine";

/** A structural clone of one decision's state at the moment it was written. */
export interface JournalDecisionSnapshot {
	id: string;
	prompt: string;
	options: JournalDecisionOption[];
	requiresConfirmation: boolean;
	/** Absent means unclassified — a voice resolution is allowed, same as `"routine"`. */
	decisionClass?: JournalDecisionClass;
	state: "open" | "awaiting-confirmation" | "answered" | "expired" | "cancelled" | "failed";
	createdAt: number;
	updatedAt: number;
	resolution?: JournalDecisionResolution;
}

export interface JournalArtifact {
	path: string;
	status: "ready" | "failed";
}

/**
 * Lifecycle phase of one fleet-affecting action taken through the live
 * session's fleet tool surface (`fleet-tools.ts`):
 *  - `requested`          — journaled BEFORE the action is relayed anywhere
 *                            (write-before-act, same contract as decisions).
 *  - `relayed`            — the daemon executed the action and said so.
 *  - `failed`             — the relay failed, timed out, or the daemon refused.
 *  - `deferred-decision`  — the action is destructive-class: instead of
 *                            executing, the tool minted an arbiter decision
 *                            (`decisionId`) the human must resolve in the room
 *                            UI. The daemon keeps the queued action under its
 *                            own `deferredActionId` until that decision lands.
 */
export type JournalFleetActionPhase = "requested" | "relayed" | "failed" | "deferred-decision";

/** One fleet-affecting act (steer/spawn/answer — reads are never journaled), as the fleet tool
 *  surface recorded it. `requestId` correlates a `requested` record with the one outcome record
 *  that follows it. All strings are OMP- or daemon-authored and bounded at the tool layer. */
export interface JournalFleetAction {
	tool: string;
	phase: JournalFleetActionPhase;
	/** Correlates the `requested` record with its outcome record. */
	requestId: string;
	/** Bounded, tool-authored one-line description of the action. */
	summary: string;
	unitId?: string;
	/** Daemon-authored outcome detail (`relayed`/`failed`). */
	detail?: string;
	/** `deferred-decision` only: the arbiter decision minted for the human to resolve in the UI. */
	decisionId?: string;
	/** `deferred-decision` only: the daemon's own key for the queued, not-yet-approved action. */
	deferredActionId?: string;
}

export type JournalRecord =
	| { type: "decision"; decision: JournalDecisionSnapshot }
	| { type: "transcript"; transcript: LiveTranscript }
	| { type: "artifact"; artifact: JournalArtifact }
	/** One fleet-affecting action's lifecycle record — see `JournalFleetAction`. Additive: a reader
	 *  that predates it skips the unknown type exactly as it skips any other future record. */
	| { type: "fleet-action"; action: JournalFleetAction }
	/** The idle policy's spoken warning fired — see `LiveSessionController`'s idle-hangup policy. */
	| { type: "idle-warning" }
	/**
	 * `reason` names why the session ended beyond the bare error/no-error
	 * distinction — e.g. `"idle"` for the 10-minute idle-hangup policy. Additive
	 * and optional: a reader that only checks `error` sees the same behavior as
	 * before this field existed.
	 */
	| { type: "terminal"; error: string | null; reason?: string };

/** One durable line: a record plus the ordering and identity it was written under. */
export interface JournalEnvelope {
	seq: number;
	at: number;
	sessionId: string;
	record: JournalRecord;
}

export interface LiveJournalOptions {
	/** Broker-minted path for this call's journal file. Absent disables journaling. */
	path?: string;
	sessionId: string;
	/** Injectable for tests. Defaults to an append-only write to `path`, creating parent directories once. */
	write?: (line: string) => Promise<void>;
}

function defaultWriter(filePath: string): (line: string) => Promise<void> {
	let ensured = false;
	return async line => {
		if (!ensured) {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			ensured = true;
		}
		await fs.promises.appendFile(filePath, line, "utf8");
	};
}

/**
 * Appends durable records for one live session.
 *
 * `append()` resolves only once the record has actually landed, so a caller
 * that awaits it before mutating its own in-memory state — the decision
 * arbiter does exactly this — can never expose a state the journal disagrees
 * with. A failed write still advances `seq`: the NEXT successful append lands
 * one sequence number ahead of the one that failed, leaving a visible gap a
 * reader can detect rather than a silent renumbering that hides the loss.
 */
export class LiveJournal {
	readonly #sessionId: string;
	readonly #write: ((line: string) => Promise<void>) | undefined;
	#seq = 0;
	#chain: Promise<void> = Promise.resolve();

	constructor(options: LiveJournalOptions) {
		this.#sessionId = options.sessionId;
		this.#write = options.write ?? (options.path ? defaultWriter(options.path) : undefined);
	}

	/** Whether this journal actually persists anything. False for a call with no minted path. */
	get enabled(): boolean {
		return this.#write !== undefined;
	}

	/** Appends one record. Resolves with the written envelope, or rejects if the write failed. */
	append(record: JournalRecord): Promise<JournalEnvelope> {
		const envelope: JournalEnvelope = { seq: this.#seq, at: Date.now(), sessionId: this.#sessionId, record };
		this.#seq += 1;
		const write = this.#write;
		if (!write) return Promise.resolve(envelope);

		const line = `${JSON.stringify(envelope)}\n`;
		// Queued after whatever is already in flight, so two concurrent callers
		// (a voice resolution and a UI click racing the same decision, say) still
		// land in the order they were queued rather than whichever fs call wins.
		const task = this.#chain.then(() => write(line));
		// The chain itself must never reject, or every append after a failure
		// would queue behind a permanently-rejected promise and never run.
		this.#chain = task.then(
			() => undefined,
			cause => {
				logger.debug("live journal: append failed", { error: String(cause) });
			},
		);
		return task.then(() => envelope);
	}

	/** Resolves once every append queued so far has settled, success or failure. */
	flush(): Promise<void> {
		return this.#chain;
	}
}
