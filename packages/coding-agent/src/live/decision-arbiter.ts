import { logger } from "@oh-my-pi/pi-utils";
import type {
	JournalDecisionClass,
	JournalDecisionOption,
	JournalDecisionResolution,
	JournalDecisionSnapshot,
	LiveJournal,
} from "./journal";

/**
 * The sole writer of a live session's decision states.
 *
 * A blocked todo task or a line of model prose must never become a decision by
 * itself — the only way one exists is a caller invoking `mint()` explicitly.
 * Once minted, `open → awaiting-confirmation → answered` (or `expired` /
 * `cancelled` / `failed`) is a state machine THIS class owns; nothing else in
 * the process is allowed to write a decision's state, including the bridge and
 * the controller that host it. Voice and UI are both proposers, never writers:
 * whichever gets here first for a given decision wins, and the loser is
 * rejected rather than silently overwritten, so one decision always resolves
 * to one attributed human answer.
 *
 * The delivered text an arbiter composes on resolution — see `#finalize` — is
 * built ONLY from the option label the human actually saw. Nothing else about
 * an option (a `consequence` string an agent wrote, say) ever reaches it, so an
 * agent-authored payload can never masquerade as what the human chose.
 *
 * A decision's `decisionClass` is the same kind of guarantee applied to WHO may
 * answer, not WHAT the answer says: a `"destructive"` decision is the
 * merge/publish/spend/delete class the product owner recorded as UI-only for
 * V1 (see concern 05's Decisions), so a voice-sourced resolution against one is
 * refused here — not just discouraged in a viewer — with a distinct reason
 * (`"ui-only-class"`), the same rejection discipline `#resolveLocked` already
 * applies to a label echo mismatch or a stale request. Declared once, at
 * `mint()`, and never inferred from prompt text: the class is what the caller
 * says it is, exactly like every other field on `MintDecisionInput`.
 */

export type DecisionOption = JournalDecisionOption;
export type DecisionClass = JournalDecisionClass;
export type DecisionState = JournalDecisionSnapshot["state"];
export type DecisionResolutionSource = "voice" | "ui";
export type DecisionSnapshot = JournalDecisionSnapshot;

export interface MintDecisionInput {
	prompt: string;
	options: readonly DecisionOption[];
	/** Consequential work needs a second confirming act; see the module doc. */
	requiresConfirmation?: boolean;
	/** Absent means unclassified — voice-resolvable, same as `"routine"`. See the module doc. */
	decisionClass?: DecisionClass;
}

export interface ResolveDecisionInput {
	decisionId: string;
	optionIndex: number;
	/** The label the proposer displayed for that option — echoed back and checked. */
	label: string;
	source: DecisionResolutionSource;
	/** Caller-scoped idempotency key. A retried request with the same id is a no-op, not a second act. */
	requestId: string;
}

export interface ConfirmDecisionInput {
	decisionId: string;
	/** The token returned when the decision entered `awaiting-confirmation`. */
	confirmToken: string;
	requestId: string;
}

export type DecisionRejectionReason =
	| "not-found"
	| "not-open"
	| "not-awaiting-confirmation"
	| "invalid-option"
	| "label-mismatch"
	| "duplicate-request"
	| "wrong-request-id"
	| "already-terminal"
	/** A voice-sourced resolve/confirm against a `"destructive"`-class decision. See the module doc. */
	| "ui-only-class";

export type DecisionResult =
	| { ok: true; decision: DecisionSnapshot; confirmToken?: string }
	| { ok: false; reason: DecisionRejectionReason; decision?: DecisionSnapshot };

export interface DecisionArbiterOptions {
	journal: LiveJournal;
	/** Injectable for deterministic tests. */
	now?: () => number;
	idFactory?: () => string;
	/** Fired after every durable state change, success or failure of the write itself. */
	onDecision?: (decision: DecisionSnapshot) => void;
	/**
	 * Fired once a decision reaches `answered`. `deliveredText` is the ONLY thing
	 * that may be injected into the agent session as the human's turn — see the
	 * module doc on why it never carries anything agent-authored.
	 */
	onResolved?: (decision: DecisionSnapshot, deliveredText: string) => void;
}

function randomId(): string {
	return crypto.randomUUID();
}

interface PendingConfirmation {
	optionIndex: number;
	label: string;
	source: DecisionResolutionSource;
	confirmToken: string;
}

export class DecisionArbiter {
	readonly #journal: LiveJournal;
	readonly #now: () => number;
	readonly #idFactory: () => string;
	readonly #onDecision: ((decision: DecisionSnapshot) => void) | undefined;
	readonly #onResolved: ((decision: DecisionSnapshot, deliveredText: string) => void) | undefined;

	readonly #decisions = new Map<string, DecisionSnapshot>();
	readonly #pending = new Map<string, PendingConfirmation>();
	readonly #seenRequests = new Map<string, Set<string>>();
	/** Per-decision serialization, the same trick `LiveJournal#append` uses for its own writes. */
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(options: DecisionArbiterOptions) {
		this.#journal = options.journal;
		this.#now = options.now ?? Date.now;
		this.#idFactory = options.idFactory ?? randomId;
		this.#onDecision = options.onDecision;
		this.#onResolved = options.onResolved;
	}

	/** The current snapshot of one decision, or undefined if none was ever minted with that id. */
	get(decisionId: string): DecisionSnapshot | undefined {
		return this.#decisions.get(decisionId);
	}

	/** Every decision minted this session, in mint order. */
	list(): DecisionSnapshot[] {
		return [...this.#decisions.values()];
	}

	/**
	 * The one way a decision comes into existence.
	 *
	 * Resolves once the `open` record has actually landed in the journal — a
	 * caller that awaits this before presenting the decision anywhere else can
	 * never expose a decision the journal disagrees with.
	 */
	async mint(input: MintDecisionInput): Promise<DecisionSnapshot> {
		if (input.options.length === 0) throw new Error("a decision needs at least one option");
		const now = this.#now();
		const snapshot: DecisionSnapshot = {
			id: this.#idFactory(),
			prompt: input.prompt,
			options: input.options.map(option => ({ ...option })),
			requiresConfirmation: input.requiresConfirmation ?? false,
			...(input.decisionClass === undefined ? {} : { decisionClass: input.decisionClass }),
			state: "open",
			createdAt: now,
			updatedAt: now,
		};
		await this.#appendJournal(snapshot);
		this.#decisions.set(snapshot.id, snapshot);
		this.#seenRequests.set(snapshot.id, new Set());
		this.#onDecision?.(snapshot);
		return snapshot;
	}

	/**
	 * Proposes a resolution. For a decision that does not require confirmation
	 * this finalizes it directly; for one that does, this only advances it to
	 * `awaiting-confirmation` and a matching `confirm()` is still required.
	 *
	 * Serialized per decision id: two proposals racing for the same `open`
	 * decision — a spoken answer and a click landing in the same instant — run
	 * one after the other rather than concurrently, so exactly one of them sees
	 * `open` and the other is rejected as stale.
	 */
	resolve(input: ResolveDecisionInput): Promise<DecisionResult> {
		return this.#serialize(input.decisionId, () => this.#resolveLocked(input));
	}

	/** The second confirming act a consequential decision requires. */
	confirm(input: ConfirmDecisionInput): Promise<DecisionResult> {
		return this.#serialize(input.decisionId, () => this.#confirmLocked(input));
	}

	/** Withdraws an open or awaiting decision — the human, or the session, called it off. */
	cancel(decisionId: string): Promise<DecisionResult> {
		return this.#serialize(decisionId, () => this.#terminate(decisionId, "cancelled"));
	}

	/** Times an open or awaiting decision out — nobody answered before the deadline. */
	expire(decisionId: string): Promise<DecisionResult> {
		return this.#serialize(decisionId, () => this.#terminate(decisionId, "expired"));
	}

	/** Marks a decision as failed — the session ended, or delivering the answer broke. */
	fail(decisionId: string): Promise<DecisionResult> {
		return this.#serialize(decisionId, () => this.#terminate(decisionId, "failed"));
	}

	/** Terminates every still-open or awaiting decision. Called once, at session end. */
	async terminateAll(state: "expired" | "cancelled" | "failed"): Promise<void> {
		const live = this.list().filter(d => d.state === "open" || d.state === "awaiting-confirmation");
		for (const decision of live) await this.#serialize(decision.id, () => this.#terminate(decision.id, state));
	}

	#serialize<T>(decisionId: string, task: () => Promise<T>): Promise<T> {
		const prior = this.#chains.get(decisionId) ?? Promise.resolve();
		const result = prior.then(task, task);
		this.#chains.set(
			decisionId,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	async #resolveLocked(input: ResolveDecisionInput): Promise<DecisionResult> {
		const decision = this.#decisions.get(input.decisionId);
		if (!decision) return { ok: false, reason: "not-found" };
		const seen = this.#seenRequests.get(decision.id);
		if (seen?.has(input.requestId)) return { ok: false, reason: "duplicate-request", decision };
		if (decision.state !== "open") {
			return {
				ok: false,
				reason: decision.state === "awaiting-confirmation" ? "not-open" : "already-terminal",
				decision,
			};
		}
		const option = decision.options[input.optionIndex];
		if (!option) return { ok: false, reason: "invalid-option", decision };
		if (option.label !== input.label) return { ok: false, reason: "label-mismatch", decision };
		// Enforced here, not just hinted in a viewer: see the module doc on `decisionClass`.
		if (input.source === "voice" && decision.decisionClass === "destructive") {
			return { ok: false, reason: "ui-only-class", decision };
		}
		seen?.add(input.requestId);

		if (!decision.requiresConfirmation) {
			return this.#finalize(decision, input.optionIndex, option.label, input.source);
		}

		const confirmToken = this.#idFactory();
		const updated: DecisionSnapshot = { ...decision, state: "awaiting-confirmation", updatedAt: this.#now() };
		await this.#appendJournal(updated);
		this.#decisions.set(decision.id, updated);
		this.#pending.set(decision.id, {
			optionIndex: input.optionIndex,
			label: option.label,
			source: input.source,
			confirmToken,
		});
		this.#onDecision?.(updated);
		return { ok: true, decision: updated, confirmToken };
	}

	async #confirmLocked(input: ConfirmDecisionInput): Promise<DecisionResult> {
		const decision = this.#decisions.get(input.decisionId);
		if (!decision) return { ok: false, reason: "not-found" };
		if (decision.state !== "awaiting-confirmation") {
			return {
				ok: false,
				reason: decision.state === "open" ? "not-awaiting-confirmation" : "already-terminal",
				decision,
			};
		}
		const pending = this.#pending.get(decision.id);
		if (!pending || pending.confirmToken !== input.confirmToken) {
			return { ok: false, reason: "wrong-request-id", decision };
		}
		const seen = this.#seenRequests.get(decision.id);
		if (seen?.has(input.requestId)) return { ok: false, reason: "duplicate-request", decision };
		seen?.add(input.requestId);
		this.#pending.delete(decision.id);
		return this.#finalize(decision, pending.optionIndex, pending.label, pending.source);
	}

	async #finalize(
		decision: DecisionSnapshot,
		optionIndex: number,
		label: string,
		source: DecisionResolutionSource,
	): Promise<DecisionResult> {
		const resolution: JournalDecisionResolution = { optionIndex, label, source };
		const updated: DecisionSnapshot = { ...decision, state: "answered", updatedAt: this.#now(), resolution };
		await this.#appendJournal(updated);
		this.#decisions.set(decision.id, updated);
		this.#onDecision?.(updated);
		// Composed from the label alone — see the module doc.
		this.#onResolved?.(updated, `The operator selected: ${label}`);
		return { ok: true, decision: updated };
	}

	async #terminate(decisionId: string, state: "expired" | "cancelled" | "failed"): Promise<DecisionResult> {
		const decision = this.#decisions.get(decisionId);
		if (!decision) return { ok: false, reason: "not-found" };
		if (decision.state !== "open" && decision.state !== "awaiting-confirmation") {
			return { ok: false, reason: "already-terminal", decision };
		}
		this.#pending.delete(decisionId);
		const updated: DecisionSnapshot = { ...decision, state, updatedAt: this.#now() };
		await this.#appendJournal(updated);
		this.#decisions.set(decisionId, updated);
		this.#onDecision?.(updated);
		return { ok: true, decision: updated };
	}

	/**
	 * Writes through to the journal and always settles — a failed write still
	 * advances the journal's own sequence counter and leaves a detectable gap
	 * (see `LiveJournal`), but it must not take the whole call down. Awaited
	 * either way, so every state change here still lands in the journal before
	 * this method's caller sees the in-memory decision change.
	 */
	async #appendJournal(decision: DecisionSnapshot): Promise<void> {
		try {
			await this.#journal.append({ type: "decision", decision });
		} catch (cause) {
			logger.debug("decision arbiter: journal write failed", { error: String(cause), decisionId: decision.id });
		}
	}
}
