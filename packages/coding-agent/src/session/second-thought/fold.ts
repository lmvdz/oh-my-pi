/**
 * Second Thought's ephemeral fold: how a harvest reaches the next model call.
 *
 * The coordinator (03) hands a settled {@link SecondThoughtHarvest} to its host
 * through `deliverHarvest`. This module is what the host puts behind that
 * callback. It holds the harvest as a *pending fold*, renders it into one inert
 * user-role observation block, injects that block during per-request context
 * assembly for the next model call(s) of the SAME run, and then retires it.
 *
 * ## Nothing here is persisted as a context message
 *
 * The fold exists only inside the message array handed to one provider request.
 * It is never appended to `agent.state.messages`, never written to the session
 * file as a `message` or `custom_message` entry, and therefore cannot become a
 * compaction cut point, an editable session-tree node, or a reload hazard
 * (DESIGN.md, "Red team concerns addressed").
 *
 * What IS persisted is a {@link SecondThoughtFoldEntry}: the `data` payload of a
 * plain `CustomEntry` (`type: "custom"`, `customType:
 * {@link SECOND_THOUGHT_FOLD_CUSTOM_TYPE}`). `buildSessionContext` emits messages
 * for exactly `message`, `custom_message` and `branch_summary` entries, so a
 * `custom` entry is structurally incapable of reaching `convertToLlm` — the same
 * shape `tool_execution_start`, `session_exit` and `user_todo_edit` already use.
 * Ticket 08 wires the real `appendCustomEntry`; ticket 07 renders the payload.
 *
 * ## Why user role, and why the very end of the array
 *
 * A `developer`-role message is upgraded to mid-conversation *system* authority
 * on current Anthropic models, which would give model-generated text system
 * weight — a prompt-injection amplifier. The block is therefore always
 * `role: "user"`, `synthetic: true`, attributed to the agent.
 *
 * Placement is the END of the request array, which at injection time is strictly
 * after the fold turn's tool results. Two tails are refused rather than appended
 * to, and both DEFER instead of dropping (the next request of the same run is
 * usually fine, and run end retires anything still undelivered):
 *
 * - An assistant tail holding tool calls. Appending a user message between an
 *   assistant tool-call message and its `toolResult`s breaks provider pairing.
 * - A `developer` tail. Appending after it suppresses the developer→system
 *   upgrade the main call relies on, changing the main request's meaning — the
 *   same shape divergence 02 refuses to fork on.
 *
 * ## Delivery is once, by default
 *
 * `secondThought.deliveryCalls` (default 1) counts REQUESTS, not turns. Injecting
 * into later requests would shift message positions across requests and churn the
 * provider cache prefix for no additional signal, so the fold delivers and dies.
 * A run that ends before delivery retires the fold undelivered: v1 sharpens the
 * very next call, it does not carry reflections into the next user prompt.
 *
 * ## Idempotence
 *
 * {@link injectFoldBlock} is pure — it never mutates its input and returns the
 * input array itself when there is nothing to add. Assembling the same request
 * twice cannot double-inject: an array that already carries a fold block is
 * recognized directly, and an explicit `requestKey` re-delivers the identical
 * block without spending a second delivery.
 *
 * The module is generic over the message element type so it can be wired at
 * either assembly point 08 may choose — `transformContext` (`AgentMessage[]`,
 * pre-conversion) or `transformProviderContext` (`Context.messages`,
 * post-conversion). Both are per-request; neither persists.
 */

import type { Usage, UserMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { SecondThoughtHarvest } from "./coordinator";
import { MAX_REFLECT_FOLD_BYTES, parseReflectTypedUnits, type ReflectTypedUnit, reflectUnits } from "./parser";
import foldWrapperPrompt from "./prompts/fold-wrapper.md" with { type: "text" };

/** Framing text marking the block as inert observations. Verbatim `.md` asset. */
export const FOLD_WRAPPER_TEXT = foldWrapperPrompt.trim();

/** Opening delimiter of the injected block; also the idempotence marker. */
export const FOLD_BLOCK_OPEN = "<second-thought-observations>";

/** Closing delimiter of the injected block. */
export const FOLD_BLOCK_CLOSE = "</second-thought-observations>";

/**
 * `customType` of the non-context diagnostic entry.
 *
 * Paired with `type: "custom"`, which `buildSessionContext` never turns into a
 * message. 07 reverse-scans the branch for it; 08 writes it.
 */
export const SECOND_THOUGHT_FOLD_CUSTOM_TYPE = "second_thought_fold";

/** Payload schema version, so a reload can reject entries it cannot read. */
export const SECOND_THOUGHT_FOLD_ENTRY_VERSION = 1;

/** Default number of following requests that receive a fold. */
export const DEFAULT_DELIVERY_CALLS = 1;

/** Maximum unsafe-tail refusals before a fold is retired as undeliverable. */
export const MAX_FOLD_DEFERRALS = 5;

/** Complete units, used to validate and re-cap markup at the injection boundary. */
const REFLECT_UNIT_RE = /<reflect(?:\s+[^>]*)?>.*?<\/reflect>/gs;
const TYPED_REFLECT_OPEN_RE = /^<reflect\s+type="[^"]*">/;
const FOLD_NESTED_CONTROL_TAG_RE = /<\/?(?:system-reminder|second-thought-observations)(?=[\s/>"'=])[^<>]*>/i;

/** Why a pending fold stopped being pending. */
export type FoldRetireReason =
	/** Injected into as many requests as `deliveryCalls` allows. */
	| "delivered"
	/** The run ended with the fold never injected. */
	| "run-end"
	/** History moved (rewind / replaceMessages / compaction) before delivery. */
	| "history-epoch"
	/** `reset()` / `dispose()` — session switch, model change, navigation. */
	| "reset"
	/** A newer harvest replaced it before it was delivered. */
	| "superseded"
	/** `secondThought.deliveryCalls` is zero: nothing may ever be delivered. */
	| "no-delivery-budget"
	/** Too many requests ended in a tail that cannot accept the fold. */
	| "deferral-limit"
	/** The rendered block held no units. */
	| "empty";

/** One harvest, rendered and waiting for the next request. */
export interface PendingFold {
	readonly generation: number;
	/** Host history epoch at harvest time; re-checked at every injection. */
	readonly epoch: number;
	readonly forkedAt: number;
	/** Turn timestamp — when the harvest settled. */
	readonly harvestedAt: number;
	readonly windowMs: number;
	readonly units: readonly ReflectTypedUnit[];
	readonly unitsByAtom: Readonly<Record<string, readonly string[]>>;
	/** Interleaved `<reflect type=…>` markup, re-capped to the parser's fold cap. */
	readonly markup: string;
	/** The full injectable text: wrapper prose plus one delimited units section. */
	readonly block: string;
	/** True when the harvest's markup exceeded the cap and whole units were dropped. */
	readonly truncated: boolean;
	readonly branchCount: number;
	readonly settledCount: number;
	readonly usage: readonly (Usage | undefined)[];
	/** Requests this fold may still be injected into. */
	deliveriesRemaining: number;
	/** Requests this fold has been injected into. */
	deliveryCount: number;
	/** Requests that refused injection because of an unsafe tail. */
	deferralCount: number;
}

/**
 * The non-context diagnostic payload recording one fold.
 *
 * Deliberately an inert state payload: no `role`, no `content`, nothing a
 * message converter could consume. It is stored as `CustomEntry.data` under
 * {@link SECOND_THOUGHT_FOLD_CUSTOM_TYPE}.
 */
export interface SecondThoughtFoldEntry {
	readonly version: typeof SECOND_THOUGHT_FOLD_ENTRY_VERSION;
	readonly generation: number;
	readonly epoch: number;
	readonly forkedAt: number;
	readonly harvestedAt: number;
	readonly retiredAt: number;
	/** Fork → turn end: the wall-clock the branch actually had. */
	readonly windowMs: number;
	/** Units per atom, in canonical atom order — what 07 renders. */
	readonly unitsByAtom: Record<string, string[]>;
	readonly unitCount: number;
	readonly branchCount: number;
	readonly settledCount: number;
	readonly markupBytes: number;
	readonly blockBytes: number;
	readonly truncated: boolean;
	readonly usage: readonly (Usage | undefined)[];
	/** Whether the fold reached at least one request. */
	readonly delivered: boolean;
	readonly deliveryCount: number;
	readonly deferralCount: number;
	readonly retireReason: FoldRetireReason;
	/** Skip-reason counters snapshotted from the host's ledger (06), when available. */
	readonly skips?: Record<string, number>;
}

/**
 * Persistence seam for the diagnostic entry.
 *
 * Ticket 08 implements it as
 * `appendCustomEntry(SECOND_THOUGHT_FOLD_CUSTOM_TYPE, entry)`. The method is
 * contracted never to throw; the store guards it anyway, because a diagnostic
 * write must never fail a request assembly.
 */
export interface SecondThoughtDiagnosticSink {
	appendFoldEntry(entry: SecondThoughtFoldEntry): void;
}

/** Capabilities the fold store borrows from its owning session. */
export interface SecondThoughtFoldHost {
	readonly settings: Settings;
	/** Same counter the coordinator reads; a move between harvest and injection drops the fold. */
	historyEpoch(): number;
	/** Where the diagnostic entry goes. Absent = diagnostics disabled. */
	readonly diagnostics?: SecondThoughtDiagnosticSink;
	/** Skip-reason counters to fold into the diagnostic entry (06). */
	skipStats?(): Record<string, number> | undefined;
	/** Injectable clock (tests). */
	now?(): number;
}

/**
 * The structural minimum the injection needs from a message.
 *
 * Keeps the module usable against both `Message` and `AgentMessage` (whose
 * custom members carry roles like `"custom"` / `"bashExecution"` that this
 * module only ever has to *not* mistake for an assistant or developer tail).
 */
export interface FoldMessageLike {
	readonly role: string;
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Trim complete `<reflect>` units off the tail until the markup fits.
 *
 * The coordinator already caps at {@link MAX_REFLECT_FOLD_BYTES} while
 * interleaving, so this is defence in depth rather than the primary cap — but a
 * host may hand a fold from elsewhere, and a half-serialized unit in the request
 * would be worse than a shorter fold. Units are never split.
 */
export function capReflectMarkup(markup: string, maxBytes: number = MAX_REFLECT_FOLD_BYTES): string {
	if (!markup) return "";
	if (maxBytes <= 0) return "";

	const kept: string[] = [];
	let bytes = 0;
	for (const match of markup.matchAll(REFLECT_UNIT_RE)) {
		const unit = match[0];
		if (!reflectMarkupUnitIsSafe(unit)) continue;
		const added = utf8Bytes(unit) + (kept.length === 0 ? 0 : 1);
		if (bytes + added > maxBytes) break;
		kept.push(unit);
		bytes += added;
	}
	return kept.join("\n");
}

function reflectMarkupUnitIsSafe(unit: string): boolean {
	// Keep this injection-boundary guard independent from the parser's list. A
	// future parser regression must not let a body terminate our wrapper or forge
	// the system-reminder convention used elsewhere in the coding agent.
	if (FOLD_NESTED_CONTROL_TAG_RE.test(unit)) return false;
	if (TYPED_REFLECT_OPEN_RE.test(unit)) return parseReflectTypedUnits(unit).length === 1;
	return reflectUnits(unit).length === 1;
}

/** Render the injectable text: framing prose plus one delimited units section. */
export function buildFoldBlock(markup: string, wrapper: string = FOLD_WRAPPER_TEXT): string {
	return `${wrapper}\n\n${FOLD_BLOCK_OPEN}\n${markup}\n${FOLD_BLOCK_CLOSE}`;
}

/**
 * The injected message: user role, synthetic, agent-attributed.
 *
 * NEVER `developer`, and never a custom type that converts to one — see the
 * module doc.
 */
export function buildFoldMessage(block: string, timestamp: number = Date.now()): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text: block }],
		synthetic: true,
		attribution: "agent",
		timestamp,
	};
}

/** Whether this message is an injected fold block. */
export function isFoldMessage(message: FoldMessageLike | undefined): boolean {
	if (message?.role !== "user") return false;
	const { content } = message as UserMessage;
	if (typeof content === "string") return content.includes(FOLD_BLOCK_OPEN);
	if (!Array.isArray(content)) return false;
	return content.some(block => block.type === "text" && block.text.includes(FOLD_BLOCK_OPEN));
}

/** Whether a request array carries a fold block anywhere in its history. */
export function hasFoldMessage(messages: readonly FoldMessageLike[]): boolean {
	return messages.some(isFoldMessage);
}

/**
 * Whether a user message may be appended after this conversation tail.
 *
 * `false` for an assistant tail holding tool calls (pairing) and for a
 * `developer` tail (suppressed system upgrade). Both cases DEFER: the fold stays
 * pending for the next request.
 */
export function foldTailIsInjectable(messages: readonly FoldMessageLike[]): boolean {
	const tail = messages.at(-1);
	if (!tail) return false;
	if (tail.role === "developer") return false;
	if (tail.role !== "assistant") return true;
	const content = (tail as { content?: unknown }).content;
	if (!Array.isArray(content)) return true;
	return !content.some(block => (block as { type?: unknown })?.type === "toolCall");
}

/** Why {@link injectFoldBlock} declined to inject. */
export type FoldInjectionSkip = "no-block" | "already-present" | "unsafe-tail";

/** What one injection attempt did. */
export interface FoldInjectionResult<T> {
	/** The request messages, with the block appended when it was injected. */
	readonly messages: readonly (T | UserMessage)[];
	readonly injected: boolean;
	readonly skip?: FoldInjectionSkip;
}

/**
 * Pure injection: append the fold block to the end of a request array.
 *
 * Never mutates `messages`; returns the SAME array reference when nothing was
 * added and a fresh array when something was. Idempotent — an array whose final
 * message is the previously appended fold block is returned untouched. Earlier
 * marker text is history, not proof that this append has already happened.
 */
export function injectFoldBlock<T extends FoldMessageLike>(
	messages: readonly T[],
	block: string | undefined,
	timestamp: number = Date.now(),
): FoldInjectionResult<T> {
	if (!block) return { messages, injected: false, skip: "no-block" };
	if (isFoldMessage(messages.at(-1))) return { messages, injected: false, skip: "already-present" };
	if (!foldTailIsInjectable(messages)) return { messages, injected: false, skip: "unsafe-tail" };
	return { messages: [...messages, buildFoldMessage(block, timestamp)], injected: true };
}

/** Read back a persisted diagnostic payload; `undefined` when it is not one. */
export function parseFoldEntry(data: unknown): SecondThoughtFoldEntry | undefined {
	if (!data || typeof data !== "object") return undefined;
	const candidate = data as Partial<SecondThoughtFoldEntry>;
	if (candidate.version !== SECOND_THOUGHT_FOLD_ENTRY_VERSION) return undefined;
	if (typeof candidate.generation !== "number") return undefined;
	return candidate as SecondThoughtFoldEntry;
}

/**
 * Holds at most one pending fold and runs its deliver → retire lifecycle.
 *
 * Every public method is safe to call in any order and more than once, and none
 * of them throw into the primary loop: an injection that fails must cost the
 * fold, never the request.
 */
export class SecondThoughtFoldStore {
	readonly #host: SecondThoughtFoldHost;
	#pending: PendingFold | undefined;
	/**
	 * The last block delivered, keyed by the request it went to.
	 *
	 * Survives retirement on purpose: with `deliveryCalls: 1` the fold is retired
	 * by the very delivery that used it, so without this a re-assembly of THAT
	 * request would silently drop the block and produce a different request than
	 * the one already built. Epoch and message identity bind the replay to that
	 * request rather than the key alone. Cleared by run end and reset.
	 */
	#replay:
		| {
				readonly key: unknown;
				readonly block: string;
				readonly epoch: number;
				readonly messages: readonly FoldMessageLike[];
		  }
		| undefined;

	constructor(host: SecondThoughtFoldHost) {
		this.#host = host;
	}

	/** The fold waiting for the next request, if any. */
	get pending(): PendingFold | undefined {
		return this.#pending;
	}

	/** Whether a fold is waiting for a request. */
	get hasPending(): boolean {
		return this.#pending !== undefined;
	}

	#now(): number {
		try {
			return this.#host.now?.() ?? Date.now();
		} catch {
			return Date.now();
		}
	}

	#deliveryCalls(): number {
		try {
			const configured = this.#host.settings.get("secondThought.deliveryCalls");
			if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_DELIVERY_CALLS;
			return Math.max(0, Math.trunc(configured));
		} catch {
			return DEFAULT_DELIVERY_CALLS;
		}
	}

	#historyEpoch(): number {
		try {
			return this.#host.historyEpoch();
		} catch {
			// NaN never equals a fold's epoch, so a throwing host drops the fold
			// rather than injecting into a conversation it cannot vouch for.
			return Number.NaN;
		}
	}

	/**
	 * Accept a harvest as the pending fold. Wire as the coordinator's
	 * `deliverHarvest`; it is never awaited by the primary loop.
	 *
	 * A fold already pending is retired first — its entry is still written, so
	 * that turn stays inspectable whether or not it was ever delivered.
	 */
	accept(harvest: SecondThoughtHarvest): void {
		try {
			this.#retire("superseded");
			// A new fold obsoletes the previous one's re-assembly window.
			this.#replay = undefined;

			const markup = capReflectMarkup(harvest.fold);
			const unitsByAtom: Record<string, string[]> = {};
			for (const [atom, bodies] of Object.entries(harvest.unitsByAtom)) unitsByAtom[atom] = [...bodies];

			const fold: PendingFold = {
				generation: harvest.generation,
				epoch: harvest.epoch,
				forkedAt: harvest.forkedAt,
				harvestedAt: harvest.harvestedAt,
				windowMs: harvest.windowMs,
				units: [...harvest.units],
				unitsByAtom,
				markup,
				block: buildFoldBlock(markup),
				truncated: markup !== harvest.fold,
				branchCount: harvest.branchCount,
				settledCount: harvest.settledCount,
				usage: [...harvest.usage],
				deliveriesRemaining: this.#deliveryCalls(),
				deliveryCount: 0,
				deferralCount: 0,
			};
			this.#pending = fold;

			// Retire immediately in the two states that can never deliver, so the
			// diagnostic entry lands on the turn it describes instead of waiting for
			// a run end that may be several turns away.
			if (!markup) this.#retire("empty");
			else if (fold.deliveriesRemaining <= 0) this.#retire("no-delivery-budget");
		} catch (error) {
			logger.debug("Second Thought fold accept failed", { error });
			this.#pending = undefined;
		}
	}

	/**
	 * Per-request context assembly hook: return the request's messages with the
	 * pending fold appended, if one is due.
	 *
	 * Wire at the single point every provider request passes through (08). Never
	 * mutates `messages`; returns the same reference when nothing was added.
	 *
	 * `requestKey` makes re-assembly of the SAME request free: a key that was
	 * already delivered to re-injects the identical block without spending a
	 * second delivery. Omitting it is safe — an array that already carries the
	 * block is recognized directly.
	 */
	applyToRequest<T extends FoldMessageLike>(
		messages: readonly T[],
		requestKey?: unknown,
	): readonly (T | UserMessage)[] {
		try {
			// Re-assembly of a request that already received a block: byte-identical
			// output, no delivery spent, whether or not the fold is still pending.
			if (requestKey !== undefined && this.#replay?.key === requestKey) {
				const replay = this.#replay;
				const currentEpoch = this.#historyEpoch();
				if (replay.epoch !== currentEpoch || !sameRequestMessages(messages, replay.messages)) {
					this.#replay = undefined;
					if (this.#pending && this.#pending.epoch !== currentEpoch) this.#retire("history-epoch");
					return messages;
				}
				return injectFoldBlock(messages, replay.block, this.#now()).messages;
			}

			const fold = this.#pending;
			if (!fold) return messages;

			if (fold.epoch !== this.#historyEpoch()) {
				// rewind / replaceMessages / compaction moved history under the fold:
				// the reflections describe a conversation that no longer exists. The
				// coordinator epoch-gates delivery too; this is the re-check at the
				// point where the messages are actually in hand.
				this.#retire("history-epoch");
				return messages;
			}

			if (fold.deliveriesRemaining <= 0) {
				this.#retire("delivered");
				return messages;
			}

			const result = injectFoldBlock(messages, fold.block, this.#now());
			if (!result.injected) {
				if (result.skip === "unsafe-tail") {
					fold.deferralCount++;
					if (fold.deferralCount === 1) {
						logger.debug("Second Thought fold deferred by unsafe request tail", { generation: fold.generation });
					}
					if (fold.deferralCount >= MAX_FOLD_DEFERRALS) this.#retire("deferral-limit");
				}
				return result.messages;
			}

			fold.deliveryCount++;
			fold.deliveriesRemaining--;
			this.#replay = { key: requestKey, block: fold.block, epoch: fold.epoch, messages };
			if (fold.deliveriesRemaining <= 0) this.#retire("delivered");
			return result.messages;
		} catch (error) {
			logger.debug("Second Thought fold injection failed", { error });
			return messages;
		}
	}

	/**
	 * Run-end hook: retire whatever is still pending.
	 *
	 * A fold that never reached a request is retired UNDELIVERED — v1 does not
	 * carry reflections across a user prompt.
	 */
	onRunEnd(): void {
		this.#retire("run-end");
		this.#replay = undefined;
	}

	/**
	 * Drop the pending fold for a conversation-shaped state change: session
	 * switch, branch/tree navigation, rewind, model change, dispose. Mirrors the
	 * coordinator's `reset()`.
	 */
	reset(reason: FoldRetireReason = "reset"): void {
		this.#retire(reason);
		this.#replay = undefined;
	}

	/** Retire and emit the diagnostic entry. Idempotent; never throws. */
	#retire(reason: FoldRetireReason): void {
		const fold = this.#pending;
		if (!fold) return;
		this.#pending = undefined;
		// `delivered` is the truthful reason whenever the fold reached a request,
		// whatever ended it: a run end or reset landing on an already-delivered fold
		// must not report it as undelivered.
		const retireReason: FoldRetireReason =
			fold.deliveryCount > 0 && reason !== "deferral-limit" ? "delivered" : reason;
		const entry: SecondThoughtFoldEntry = {
			version: SECOND_THOUGHT_FOLD_ENTRY_VERSION,
			generation: fold.generation,
			epoch: fold.epoch,
			forkedAt: fold.forkedAt,
			harvestedAt: fold.harvestedAt,
			retiredAt: this.#now(),
			windowMs: fold.windowMs,
			unitsByAtom: Object.fromEntries(Object.entries(fold.unitsByAtom).map(([atom, bodies]) => [atom, [...bodies]])),
			unitCount: fold.units.length,
			branchCount: fold.branchCount,
			settledCount: fold.settledCount,
			markupBytes: utf8Bytes(fold.markup),
			blockBytes: utf8Bytes(fold.block),
			truncated: fold.truncated,
			usage: [...fold.usage],
			delivered: fold.deliveryCount > 0,
			deliveryCount: fold.deliveryCount,
			deferralCount: fold.deferralCount,
			retireReason,
			...this.#skips(),
		};
		try {
			this.#host.diagnostics?.appendFoldEntry(entry);
		} catch (error) {
			logger.debug("Second Thought diagnostic sink threw", { error });
		}
	}

	#skips(): { skips?: Record<string, number> } {
		try {
			const skips = this.#host.skipStats?.();
			return skips && Object.keys(skips).length > 0 ? { skips: { ...skips } } : {};
		} catch {
			return {};
		}
	}
}

function sameRequestMessages(left: readonly FoldMessageLike[], right: readonly FoldMessageLike[]): boolean {
	return left === right || (left.length === right.length && left.every((message, index) => message === right[index]));
}
