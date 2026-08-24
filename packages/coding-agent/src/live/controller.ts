import * as os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "../session/messages";
import type { BridgeAgentMessage, BridgeAgentRef, InterruptPolicy, PlanPhase, ToolActivity } from "./bridge";
import { trimCodePoints } from "./bridge";
import { DecisionArbiter, type DecisionOption, type DecisionResult, type DecisionSnapshot } from "./decision-arbiter";
import { LiveJournal } from "./journal";
import agentFinalMessageTemplate from "./prompts/agent-final-message.md" with { type: "text" };
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };
import {
	buildDelegationContextAppend,
	buildSessionClose,
	buildSessionContextAppend,
	chunkLiveContext,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol";
import { CodexLiveTransport, type LiveTransportOptions } from "./transport";
import type { LivePhase } from "./visualizer";
import { DEFAULT_LIVE_VOICE } from "./voices";

export type { DecisionOption, DecisionResult, DecisionSnapshot } from "./decision-arbiter";

/**
 * Minimal shape `start()` needs from a microphone source.
 *
 * The real implementation is `AudioCapture` from `@oh-my-pi/pi-natives`, which
 * opens the default miniaudio input device. This seam exists so a test can
 * substitute a spy and prove `noLocalAudio: true` never constructs the real
 * one — a native device open is not something a fast unit test can exercise
 * directly, and concern 09's whole premise is that this device open must be
 * provably skippable.
 */
export interface MicrophoneCaptureLike {
	stop(): void;
}

/** Constructs a microphone source. Defaults to the real native `AudioCapture`. */
export type AudioCaptureFactory = (
	sampleRate: number,
	onAudio: (error: Error | null, samples: Float32Array) => void,
) => MicrophoneCaptureLike;

/**
 * Minimal shape `start()` needs from the realtime provider transport.
 *
 * The real implementation is `CodexLiveTransport`, which opens a native WebRTC
 * peer and performs Codex signaling — not something a fast unit test can do
 * for real. This seam is additive: every existing caller that never passes
 * `transportFactory` gets exactly today's `CodexLiveTransport`.
 */
export interface LiveTransportLike {
	connect(): Promise<void>;
	send(message: LiveClientMessage): Promise<void>;
	pushAudio(samples: Float32Array): void;
	setMuted(muted: boolean): Promise<void>;
	close(): Promise<void>;
}

/** Constructs the realtime transport. Defaults to the real `CodexLiveTransport`. */
export type LiveTransportFactory = (options: LiveTransportOptions) => LiveTransportLike;

/**
 * Adapts a `DecisionResult` to the shape `BridgeHandlers.onResolveDecision`
 * returns. `DecisionSnapshot` and `Decision` are structurally identical —
 * both mirror the same journal record — so no bridge import is needed here to
 * satisfy the field shape a caller wires this into.
 */
export function toResolveDecisionResult(result: DecisionResult): {
	ok: boolean;
	decision?: DecisionSnapshot;
	reason?: string;
	confirmToken?: string;
} {
	return result.ok
		? {
				ok: true,
				decision: result.decision,
				...(result.confirmToken === undefined ? {} : { confirmToken: result.confirmToken }),
			}
		: { ok: false, reason: result.reason, ...(result.decision === undefined ? {} : { decision: result.decision }) };
}

/** Retention policy for journaled transcript turns — see `LiveSessionControllerOptions.recordingMode`. */
export type LiveRecordingMode = "full" | "tails" | "off";
/** Longest transcript excerpt journaled under `"tails"` retention, in code points. */
const TAIL_TRANSCRIPT_POINTS = 240;

/** Floor between spoken progress steps, so a fast tool loop cannot outrun speech. */
const TOOL_PROGRESS_MIN_INTERVAL_MS = 5_000;
/**
 * The V1 idle-hangup default recorded in concern 05's Decisions: 10 minutes
 * since the last human or agent activity. This class itself defaults the
 * policy OFF (`idleHangupMs` undefined) — the product default is applied by
 * the CLI wiring in `LiveCommandController`, which is what keeps every
 * existing test that constructs this class directly inert without opting in.
 */
export const DEFAULT_IDLE_HANGUP_MS = 10 * 60_000;
/** The recorded "spoken warning at ~9 minutes" policy — 90% of the hangup duration. */
const DEFAULT_IDLE_WARNING_RATIO = 0.9;
/** Distinct terminal reason for the idle-hangup policy — see `journal.ts`'s `JournalRecord["terminal"]`. */
const IDLE_TERMINAL_REASON = "idle";
/** Longest progress line forwarded; anything longer is a paragraph, not a status. */
const TOOL_PROGRESS_MAX_CHARS = 120;
/** How often the agent registry is re-read. It emits for some changes, not all. */
const ROSTER_POLL_MS = 1_000;
const OUTPUT_ACTIVE_LEVEL = 0.015;
const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;

/** Incremental or final transcript for one realtime conversational turn. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	/** Monotonic role-local turn number used to coalesce streaming updates. */
	turn: number;
	final: boolean;
}

/** UI notifications emitted during a live session. */
export interface LiveSessionCallbacks {
	/** Reports connection and activity phase changes. */
	onPhase(phase: LivePhase): void;
	/** Reports clamped microphone and speaker RMS levels. */
	onLevels(input: number, output: number): void;
	/** Reports the latest available conversational transcript. */
	onTranscript(transcript: LiveTranscript | undefined): void;
	/**
	 * Reports one terminal stop, optionally carrying its cause.
	 *
	 * `reason` names why the session ended beyond bare error/no-error — e.g.
	 * `"idle"` for the 10-minute idle-hangup policy below. Additive: a caller
	 * that ignores the second parameter sees exactly the prior behavior.
	 */
	onTerminal(error?: Error, reason?: string): void;
	/** Reports one tool call of the delegated work starting or finishing. */
	onToolActivity?(activity: ToolActivity): void;
	/** Reports the current agent roster whenever it changes. */
	onAgents?(agents: readonly BridgeAgentRef[]): void;
	/** Reports the agent's own plan whenever the todo tool revises it. */
	onPlan?(plan: readonly PlanPhase[]): void;
	/** Reports one message from a delegated agent's own transcript. */
	onAgentMessage?(message: BridgeAgentMessage): void;
	/**
	 * Reports every durable decision state change — mint, confirmation, answer,
	 * or termination. The arbiter is the sole writer; this callback only mirrors
	 * what it already wrote to the journal, for a bridge or UI to present.
	 */
	onDecision?(decision: DecisionSnapshot): void;
	/** Reports a change to the do-not-interrupt policy. */
	onInterruptPolicy?(policy: InterruptPolicy): void;
	/**
	 * Reports one chunk of decoded output audio from the realtime provider, as
	 * the browser-audio alternative to the native WebRTC media sink. Only ever
	 * called when this session was constructed with `noLocalAudio: true` — see
	 * that option's doc on `LiveSessionControllerOptions`. Additive: a caller
	 * that never sets the flag or binds this callback sees no change at all.
	 */
	onOutputAudio?(bytes: Uint8Array): void;
}

/** Dependencies and presentation callbacks for a live session. */
export interface LiveSessionControllerOptions {
	/** Agent session that performs all delegated coding work. */
	session: AgentSession;
	/** UI callbacks for live session state. */
	callbacks: LiveSessionCallbacks;
	/** Extracts visible assistant text using the caller's normal UI rules. */
	extractAssistantText(message: AssistantMessage): string;
	/** Realtime output voice, defaulting to sol. */
	voice?: string;
	/**
	 * Host-supplied instructions appended to the live prompt: what surface the
	 * call is attached to and how to learn what the person is looking at.
	 * Data about the environment, never a change to the one-assistant rules.
	 */
	extraInstructions?: string;
	/** Agent registry backing the roster, defaulting to the process-global one. */
	registry?: AgentRegistry;
	/**
	 * Broker-minted call identity, correlating this session's durable journal
	 * with its presentation bridge. Falls back to a locally generated id for a
	 * bare `/live` with no broker in front of it.
	 */
	callId?: string;
	/** Broker-minted per-call journal path. Absent disables journaling entirely. */
	journalPath?: string;
	/** How much of the transcript the journal retains. Defaults to `"tails"`. */
	recordingMode?: LiveRecordingMode;
	/** Injectable for tests — see `LiveJournal`. */
	journal?: LiveJournal;
	/**
	 * Idle-hangup duration after the last human or agent activity, in ms.
	 * Undefined or non-positive disables the policy entirely — the default for
	 * this class, so a bare unit test that constructs it directly never grows a
	 * background timer. The recorded V1 product default (10 minutes,
	 * `DEFAULT_IDLE_HANGUP_MS`) is applied by `LiveCommandController`'s CLI
	 * wiring, configurable there via `OMP_LIVE_IDLE_HANGUP_MS`.
	 */
	idleHangupMs?: number;
	/**
	 * When the spoken idle warning fires, counted from the same last-activity
	 * baseline as `idleHangupMs`. Defaults to 90% of it (~9 minutes at the
	 * recorded 10-minute default). Ignored when `idleHangupMs` is not set.
	 */
	idleWarningMs?: number;
	/**
	 * Disables local audio devices entirely (concern 09: browser-audio-transport).
	 *
	 * When true, `start()` never constructs a microphone source — no miniaudio
	 * input device is opened. Mic PCM must instead reach the session through
	 * `pushRemoteAudio()`, and speaker PCM leaves through `onOutputAudio` rather
	 * than the realtime transport's own native audio sink. The realtime
	 * PROVIDER CONNECTION itself (`CodexLiveTransport`/`LiveWebRtcPeer`, i.e. the
	 * WebRTC signaling and data channel to Codex) is unchanged either way — this
	 * flag moves device I/O only, never the transport. Defaults to false, so
	 * every existing caller keeps opening its own microphone exactly as before.
	 */
	noLocalAudio?: boolean;
	/** Test/back-end seam for the microphone source — see `MicrophoneCaptureLike`. */
	audioCaptureFactory?: AudioCaptureFactory;
	/** Test seam for the realtime transport — see `LiveTransportLike`. */
	transportFactory?: LiveTransportFactory;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, level);
}

function microphoneLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index] ?? 0;
		sumSquares += sample * sample;
	}
	return clampLevel(Math.sqrt(sumSquares / samples.length));
}

/** First string-ish argument that reads like a subject — a path, pattern, or command. */
function toolSubject(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "pattern", "query", "command", "description", "prompt"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim().split("\n", 1)[0];
	}
	return undefined;
}

/** One short, speakable line describing the step a tool call is about to take. */
export function describeToolStep(
	event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
): string | undefined {
	// `intent` is written for humans by the harness; prefer it over reconstructing one.
	const intent = event.intent?.trim();
	const subject = toolSubject(event.args);
	const step = intent || (subject ? `${event.toolName} — ${subject}` : event.toolName);
	if (!step) return undefined;
	return step.length > TOOL_PROGRESS_MAX_CHARS ? `${step.slice(0, TOOL_PROGRESS_MAX_CHARS - 1)}…` : step;
}

const PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned", "blocked"]);

/**
 * Reads the plan out of a todo tool result, or returns undefined.
 *
 * Validated field by field rather than cast: this crosses into a viewer over a
 * socket, and a tool result is the one input here whose shape a future omp is
 * free to change without telling this file.
 */
export function toPlanPhases(result: unknown): PlanPhase[] | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return undefined;
	const phases = (details as { phases?: unknown }).phases;
	if (!Array.isArray(phases)) return undefined;

	const parsed: PlanPhase[] = [];
	for (const phase of phases) {
		if (typeof phase !== "object" || phase === null) continue;
		const { name, tasks } = phase as { name?: unknown; tasks?: unknown };
		if (typeof name !== "string" || !Array.isArray(tasks)) continue;
		const parsedTasks: PlanPhase["tasks"] = [];
		for (const task of tasks) {
			if (typeof task !== "object" || task === null) continue;
			const { content, status, blocker } = task as { content?: unknown; status?: unknown; blocker?: unknown };
			if (typeof content !== "string" || typeof status !== "string" || !PLAN_STATUSES.has(status)) continue;
			parsedTasks.push({
				content,
				status: status as PlanPhase["tasks"][number]["status"],
				...(typeof blocker === "string" ? { blocker } : {}),
			});
		}
		// A phase whose tasks were all dropped is noise, not an empty phase.
		if (parsedTasks.length > 0) parsed.push({ name, tasks: parsedTasks });
	}
	return parsed;
}

/** Plain text of a user message, which may be a string or content blocks. */
function extractUserText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

/* A message has no id of its own, so the timestamp plus role is what makes a
   streaming update replace its earlier self instead of appending beside it. */
function messageKey(message: AgentMessage): string {
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	return `${message.role}:${typeof timestamp === "number" ? timestamp : 0}`;
}

/** Projects a registry entry down to the display-only fields a viewer renders. */
function toBridgeAgentRef(ref: AgentRef): BridgeAgentRef {
	return {
		id: ref.id,
		displayName: ref.displayName,
		kind: ref.kind,
		status: ref.status,
		// omp names a subagent after its type, which IS its role.
		role: ref.displayName,
		...(ref.parentId === undefined ? {} : { parentId: ref.parentId }),
		...(ref.activity === undefined ? {} : { activity: ref.activity }),
	};
}

function currentUser(): { username: string; firstName: string } {
	let username = "user";
	try {
		const candidate = os.userInfo().username.trim();
		if (candidate) username = candidate;
	} catch {
		// Sandboxed runtimes may not expose OS account information.
	}
	const firstPart = username.split(/[._\-\s]+/).find(part => part.length > 0);
	return { username, firstName: firstPart ?? "there" };
}

/** Coordinates the realtime conversational surface with normal AgentSession turns. */
export class LiveSessionController {
	readonly #session: AgentSession;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	readonly #voice: string;
	#extraInstructions: string | undefined;

	readonly #registry: AgentRegistry;

	#transport: LiveTransportLike | undefined;
	#recorder: MicrophoneCaptureLike | undefined;
	readonly #noLocalAudio: boolean;
	readonly #audioCaptureFactory: AudioCaptureFactory;
	readonly #transportFactory: LiveTransportFactory;
	#unsubscribeSession: (() => void) | undefined;
	#unsubscribeRegistry: (() => void) | undefined;
	/** One transcript subscription per delegated agent, keyed by registry id. */
	#agentSubscriptions = new Map<string, () => void>();
	#rosterPoll: NodeJS.Timeout | undefined;
	/* Per-agent model and spend, accumulated from the agents' own messages.
	   Derived rather than queried: every assistant message already carries the
	   model, the provider and its usage, and this controller already subscribes
	   to each agent's session — so a fan-out's cost can be attributed per agent
	   without reaching into anything the registry does not expose. */
	#agentStats = new Map<string, { model?: string; provider?: string; costUsd: number; tokens: number }>();
	#lastRosterSignature = "";
	#sendChain: Promise<void> = Promise.resolve();
	#stopPromise: Promise<void> | undefined;
	#started = false;
	#stopped = false;
	#terminalEmitted = false;
	#failure: Error | undefined;
	#muted = false;
	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	#activeDelegationId: string | undefined;
	#lastToolStep: string | undefined;
	#lastToolStepAt = 0;
	#userTranscript = "";
	#assistantTranscript = "";
	#userTranscriptFinal = false;
	#assistantTranscriptFinal = false;
	#userTranscriptTurn = 0;
	#assistantTranscriptTurn = 0;
	#lastTranscript: LiveTranscript | undefined;

	readonly #callId: string;
	readonly #journal: LiveJournal;
	readonly #decisions: DecisionArbiter;
	readonly #recordingMode: LiveRecordingMode;
	#interruptPolicy: InterruptPolicy = "allow";

	/** `undefined` disables the idle policy entirely — see the constructor doc. */
	readonly #idleHangupMs: number | undefined;
	readonly #idleWarningMs: number | undefined;
	#idleWarnTimer: ReturnType<typeof setTimeout> | undefined;
	#idleHangupTimer: ReturnType<typeof setTimeout> | undefined;
	#idleWarningSpoken = false;
	/** Set just before `stop()` when the idle policy is what ended the call. */
	#idleReason: string | undefined;

	/** True once the realtime session reported `session.started` — the moment context appends are
	 *  known-deliverable. Fleet context arriving earlier is buffered, not dropped (concern 12). */
	#sessionStarted = false;
	/** Fleet context briefs queued before `session.started` — flushed once, in arrival order. */
	#fleetContextQueue: string[] = [];
	/** Bound on the pre-start fleet-context buffer: a reattaching daemon re-sends its brief, and an
	 *  unbounded queue of stale briefs would be replayed as a wall of text. Latest few win. */
	static readonly #MAX_QUEUED_FLEET_CONTEXTS = 4;

	constructor(options: LiveSessionControllerOptions) {
		this.#session = options.session;
		this.#callbacks = options.callbacks;
		this.#extractAssistantText = options.extractAssistantText;
		this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
		this.#extraInstructions = options.extraInstructions?.trim() || undefined;
		this.#registry = options.registry ?? AgentRegistry.global();
		this.#callId =
			options.callId?.trim() || `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.#recordingMode = options.recordingMode ?? "tails";
		this.#journal = options.journal ?? new LiveJournal({ path: options.journalPath, sessionId: this.#callId });
		this.#decisions = new DecisionArbiter({
			journal: this.#journal,
			onDecision: decision => {
				this.#noteActivity();
				this.#guardEvent(() => this.#callbacks.onDecision?.(decision));
			},
			onResolved: (_decision, deliveredText) => this.#deliverDecisionResolution(deliveredText),
		});
		this.#idleHangupMs =
			options.idleHangupMs !== undefined && Number.isFinite(options.idleHangupMs) && options.idleHangupMs > 0
				? options.idleHangupMs
				: undefined;
		this.#idleWarningMs =
			this.#idleHangupMs === undefined
				? undefined
				: options.idleWarningMs !== undefined && Number.isFinite(options.idleWarningMs) && options.idleWarningMs > 0
					? options.idleWarningMs
					: Math.round(this.#idleHangupMs * DEFAULT_IDLE_WARNING_RATIO);
		this.#noLocalAudio = options.noLocalAudio === true;
		this.#audioCaptureFactory =
			options.audioCaptureFactory ?? ((sampleRate, onAudio) => new AudioCapture(sampleRate, onAudio));
		this.#transportFactory =
			options.transportFactory ?? (transportOptions => new CodexLiveTransport(transportOptions));
	}

	/** Broker-minted call identity — the same one a bridge for this call was constructed with. */
	get callId(): string {
		return this.#callId;
	}

	/** Current realtime call phase. */
	get phase(): LivePhase {
		return this.#phase;
	}

	/** Whether microphone input is currently muted. */
	get muted(): boolean {
		return this.#muted;
	}

	/** Connects the realtime surface and starts microphone streaming. */
	async start(): Promise<void> {
		if (this.#stopped) {
			throw (
				this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.")
			);
		}
		if (this.#started) return;
		this.#started = true;
		this.#emitPhase("connecting", true);
		this.#emitTranscript(undefined);
		if (this.#stopped) {
			throw this.#failure ?? new Error("The live session stopped while starting.");
		}

		try {
			const user = currentUser();
			const rendered = prompt.render(liveInstructionsTemplate, user);
			const instructions = this.#extraInstructions
				? `${rendered}\n\n<host-environment>\n${this.#extraInstructions}\n</host-environment>`
				: rendered;
			const transport = this.#transportFactory({
				authStorage: this.#session.modelRegistry.authStorage,
				sessionId: this.#session.sessionId,
				instructions,
				voice: this.#voice,
				callbacks: {
					onEvent: event => this.#guardEvent(() => this.#handleLiveEvent(event)),
					onOutputLevel: level => this.#guardEvent(() => this.#handleOutputLevel(level)),
				},
			});
			this.#transport = transport;
			await transport.connect();
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while connecting.");
			}
			this.#unsubscribeSession = this.#session.subscribe(event =>
				this.#guardEvent(() => this.#handleSessionEvent(event)),
			);
			this.#unsubscribeRegistry = this.#registry.onChange(() =>
				this.#guardEvent(() => {
					this.#publishAgents();
					this.#syncAgentSubscriptions();
				}),
			);
			// A viewer attaching to a session that already has subagents must see them.
			this.#publishAgents();
			this.#syncAgentSubscriptions();

			/* Poll, because the registry deliberately does not emit for everything.
			   `attachSession` mutates a ref's session in place and emits NOTHING, and
			   a subagent registers BEFORE its session exists — so an event-only
			   subscriber attaches to nothing and the agent's whole transcript is lost.
			   `setActivity` is silent for the same reason, which would freeze each
			   agent's gist at whatever it was during the last status change. */
			this.#rosterPoll = setInterval(() => {
				this.#guardEvent(() => {
					this.#publishAgents();
					this.#syncAgentSubscriptions();
				});
			}, ROSTER_POLL_MS);
			this.#rosterPoll.unref?.();
			// The call itself starting counts as the first activity — an idle policy
			// that started its clock before anyone could possibly have spoken would
			// warn and hang up a call nobody ever got to use.
			this.#noteActivity();
			if (this.#muted) await transport.setMuted(true);
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped before recording began.");
			}
			/* Audio-less mode (concern 09) never opens a microphone device: the one
			   miniaudio-fragile call this class would otherwise make (native
			   `AudioCapture`) is skipped entirely, and mic PCM instead arrives through
			   `pushRemoteAudio()`, sourced by a bridge from a browser. */
			if (!this.#noLocalAudio) {
				const recorder = this.#audioCaptureFactory(16_000, (error, samples) => {
					if (error) {
						this.#reportFailure(error);
						return;
					}
					this.#handleMicrophoneAudio(samples);
				});
				if (this.#stopped) {
					try {
						recorder.stop();
					} catch {
						// Preserve the failure that stopped startup.
					}
					throw this.#failure ?? new Error("The live session stopped while recording began.");
				}
				this.#recorder = recorder;
			}
			this.#refreshAudioPhase();
		} catch (cause) {
			const error = errorFrom(cause);
			this.#reportFailure(error);
			await this.stop();
			throw error;
		}
	}

	/** Toggles microphone capture while leaving output and the session connected. */
	toggleMute(): void {
		if (this.#stopped) return;
		this.#muted = !this.#muted;
		if (this.#muted) {
			this.#inputLevel = 0;
			this.#emitLevels();
		}
		this.#refreshAudioPhase();
		const transport = this.#transport;
		if (transport) {
			void transport.setMuted(this.#muted).catch(cause => this.#reportFailure(errorFrom(cause)));
		}
	}

	/**
	 * Feeds one chunk of remote microphone PCM (16 kHz mono `Float32`, the exact
	 * format `AudioCapture` itself produces) into the realtime transport, taking
	 * the place `AudioCapture`'s own device callback fills in local-audio mode —
	 * see `#handleMicrophoneAudio`, which this reuses so level metering and
	 * output-echo suppression apply identically regardless of where the samples
	 * came from.
	 *
	 * A no-op unless this session was constructed with `noLocalAudio: true`: a
	 * session that owns its own microphone device must never ALSO accept
	 * someone else's audio, or the two sources would talk over each other on
	 * the same call.
	 */
	pushRemoteAudio(samples: Float32Array): void {
		if (!this.#noLocalAudio) return;
		this.#handleMicrophoneAudio(samples);
	}

	/**
	 * Injects an operator's typed steering into the delegated work.
	 *
	 * Routed through the SAME path a voice delegation takes — a custom message on
	 * the agent session with `triggerTurn` — so steering typed into a viewer and
	 * steering spoken aloud land as one conversation rather than two competing
	 * ones. Attributed to the user, because it is the user talking.
	 */
	steer(text: string): void {
		const trimmed = text.trim();
		if (this.#stopped || !trimmed) return;
		void this.#session
			.sendCustomMessage(
				{
					customType: LIVE_DELEGATION_MESSAGE_TYPE,
					content: trimmed,
					display: true,
					attribution: "user",
				},
				{ triggerTurn: true },
			)
			.catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	/**
	 * Test seam only. Feeds a `LiveServerEvent` through the exact dispatch
	 * `start()` wires the real transport's `onEvent` callback to (see the
	 * `CodexLiveTransport` construction above) — `#handleLiveEvent` is
	 * otherwise unreachable from outside this class. `start()` itself opens a
	 * real signaling connection and native microphone capture, so it is not
	 * something a fast unit test can call just to exercise transcript
	 * handling; this is the same kind of explicit stand-in `mintDecision`
	 * already is for the idle-timer tests below, which arm the timers without
	 * a real transport connection either.
	 */
	handleLiveEventForTests(event: LiveServerEvent): void {
		this.#guardEvent(() => this.#handleLiveEvent(event));
	}

	/**
	 * Injects a fleet context brief into the realtime session as non-spoken grounding
	 * (concern 12: voice-fleet-delegation). The brief is composed by the room's daemon (it owns
	 * the roster, open decisions, and plan projection) and reaches this controller through the
	 * bridge's authenticated `attachFleet` control — this method only decides WHEN it is safe to
	 * send: before the realtime session has reported `session.started`, context appends have no
	 * live session to land in, so briefs are buffered (bounded, latest few win) and flushed once
	 * the session is up. Rides the `"commentary"` channel — context for the model, never spoken
	 * on its own — exactly like tool-progress narration.
	 */
	pushFleetContext(context: string): void {
		const trimmed = context.trim();
		if (this.#stopped || !trimmed) return;
		if (!this.#sessionStarted || !this.#transport) {
			this.#fleetContextQueue.push(trimmed);
			if (this.#fleetContextQueue.length > LiveSessionController.#MAX_QUEUED_FLEET_CONTEXTS) {
				this.#fleetContextQueue.splice(
					0,
					this.#fleetContextQueue.length - LiveSessionController.#MAX_QUEUED_FLEET_CONTEXTS,
				);
			}
			return;
		}
		this.#sendFleetContext(trimmed);
	}

	#flushFleetContext(): void {
		if (this.#fleetContextQueue.length === 0) return;
		const queued = this.#fleetContextQueue;
		this.#fleetContextQueue = [];
		for (const context of queued) this.#sendFleetContext(context);
	}

	#sendFleetContext(context: string): void {
		for (const chunk of chunkLiveContext(context)) {
			this.#queueSend(buildSessionContextAppend(chunk, "commentary"));
		}
	}

	/**
	 * The explicit decision-minting surface.
	 *
	 * This is the ONLY way a decision comes into existence in this session — a
	 * blocked todo task or a line of model prose must never create one on its
	 * own, and nothing else in this class calls `DecisionArbiter.mint` except in
	 * response to an explicit call here. Resolves once the `open` record has
	 * landed in the journal.
	 */
	mintDecision(input: {
		prompt: string;
		options: readonly DecisionOption[];
		requiresConfirmation?: boolean;
		/** See `DecisionArbiter`'s module doc — `"destructive"` is voice-refused by policy. */
		decisionClass?: DecisionSnapshot["decisionClass"];
	}): Promise<DecisionSnapshot> {
		return this.#decisions.mint(input);
	}

	/**
	 * Proposes a resolution for a decision. `source` records who is answering —
	 * voice and UI both funnel through this one call, and the arbiter, not this
	 * controller, is the sole writer of the resulting state. For a decision that
	 * requires confirmation this only advances it to `awaiting-confirmation`;
	 * `confirmDecision` still has to land before it is answered.
	 */
	resolveDecision(input: {
		decisionId: string;
		optionIndex: number;
		label: string;
		source: "voice" | "ui";
		requestId: string;
	}): Promise<DecisionResult> {
		return this.#decisions.resolve(input);
	}

	/** The second confirming act a consequential decision requires. */
	confirmDecision(input: { decisionId: string; confirmToken: string; requestId: string }): Promise<DecisionResult> {
		return this.#decisions.confirm(input);
	}

	/** Withdraws an open or awaiting decision. */
	cancelDecision(decisionId: string): Promise<DecisionResult> {
		return this.#decisions.cancel(decisionId);
	}

	/** The do-not-interrupt state a viewer, or the operator, most recently set. */
	get interruptPolicy(): InterruptPolicy {
		return this.#interruptPolicy;
	}

	/** Sets whether an urgent decision may interrupt the human right now. */
	setInterruptPolicy(policy: InterruptPolicy): void {
		if (this.#interruptPolicy === policy) return;
		this.#interruptPolicy = policy;
		this.#callbacks.onInterruptPolicy?.(policy);
	}

	/**
	 * Delivers a resolved decision's human turn into the delegated work, on the
	 * SAME path a typed steering message takes — a custom message on the agent
	 * session with `triggerTurn` — so a voice answer, a UI answer, and typed
	 * steering all land as one conversation. `deliveredText` was composed by the
	 * arbiter from the option label alone; nothing agent-authored reaches here.
	 */
	#deliverDecisionResolution(deliveredText: string): void {
		void this.#session
			.sendCustomMessage(
				{
					customType: LIVE_DELEGATION_MESSAGE_TYPE,
					content: deliveredText,
					display: true,
					attribution: "user",
				},
				{ triggerTurn: true },
			)
			.catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	/** Stops recording, closes the live session, and emits one terminal callback. */
	stop(): Promise<void> {
		if (!this.#stopPromise) this.#stopPromise = this.#stop();
		return this.#stopPromise;
	}

	async #stop(): Promise<void> {
		this.#stopped = true;
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		if (this.#rosterPoll) {
			clearInterval(this.#rosterPoll);
			this.#rosterPoll = undefined;
		}
		this.#clearIdleTimers();
		for (const unsubscribe of this.#agentSubscriptions.values()) unsubscribe();
		this.#agentSubscriptions.clear();
		let cleanupError: Error | undefined;

		const recorder = this.#recorder;
		this.#recorder = undefined;
		if (recorder) {
			try {
				recorder.stop();
			} catch (cause) {
				cleanupError = errorFrom(cause);
			}
		}

		await this.#sendChain;
		const transport = this.#transport;
		this.#transport = undefined;
		if (transport) {
			try {
				await transport.send(buildSessionClose());
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
			try {
				await transport.close();
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
		}

		const terminalError = this.#failure ?? cleanupError;
		// A dead call must not leave an answerable decision behind: nothing can
		// resolve one once the session that would act on it is gone.
		await this.#decisions.terminateAll(terminalError ? "failed" : "expired");
		try {
			await this.#journal.append({
				type: "terminal",
				error: terminalError ? terminalError.message : null,
				...(this.#idleReason === undefined ? {} : { reason: this.#idleReason }),
			});
		} catch (cause) {
			logger.debug("live session: terminal journal write failed", { error: String(cause) });
		}

		if (cleanupError) this.#emitPhaseSafely("error");
		this.#emitTerminal(cleanupError, this.#idleReason);
	}

	#guardEvent(handler: () => void): void {
		if (this.#stopped) return;
		try {
			handler();
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#handleLiveEvent(event: LiveServerEvent): void {
		switch (event.type) {
			case "session.started":
				this.#sessionStarted = true;
				this.#emitPhase("listening");
				this.#flushFleetContext();
				break;
			case "session.updated":
			case "unknown":
				break;
			case "output_audio.delta":
				this.#handleOutputAudio(event.audio);
				break;
			case "input_transcript.added":
				this.#addTranscript("user", event.item.text);
				break;
			case "output_transcript.added":
				this.#addTranscript("assistant", event.item.text);
				break;
			case "turn.done":
				this.#finishTranscript(event.turn.role, event.turn.transcript);
				break;
			case "delegation.created":
				this.#handleDelegation(event);
				break;
			case "error":
				this.#reportFailure(new Error(event.message));
				break;
		}
	}

	#handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
		let request = "";
		for (const content of event.item.content) {
			if (content.type !== "input_text") continue;
			request += `${request ? "\n" : ""}${content.text}`;
		}
		request = request.trim();
		if (!request) return;
		this.#activeDelegationId = event.item.id;
		// A steering delegation lands mid-work; its first step is news again.
		this.#lastToolStep = undefined;
		this.#lastToolStepAt = 0;
		this.#emitPhase("working");
		void this.#session
			.sendCustomMessage(
				{
					customType: LIVE_DELEGATION_MESSAGE_TYPE,
					content: request,
					display: true,
					attribution: "agent",
				},
				{ triggerTurn: true },
			)
			.catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "tool_execution_start") {
			this.#publishActivity({
				id: event.toolCallId,
				tool: event.toolName,
				state: "start",
				at: Date.now(),
				...(this.#mainAgentId() === undefined ? {} : { agentId: this.#mainAgentId() }),
				...(toolSubject(event.args) === undefined ? {} : { subject: toolSubject(event.args) }),
			});
			this.#appendToolProgress(event);
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#publishActivity({
				id: event.toolCallId,
				tool: event.toolName,
				state: "end",
				at: Date.now(),
				...(this.#mainAgentId() === undefined ? {} : { agentId: this.#mainAgentId() }),
				...(event.isError === undefined ? {} : { isError: event.isError }),
			});
			/* The todo tool returns the WHOLE plan on every operation, so its result
			   is the one authoritative snapshot available without reaching into the
			   session's private tracker. Reading it here keeps the live surface a
			   subscriber like any other rather than a second owner of that state. */
			if (event.toolName === "todo" && event.isError !== true) this.#publishPlan(event.result);
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const mainId = this.#mainAgentId();
			if (mainId) {
				this.#recordAgentUsage(mainId, event.message);
				this.#publishAgentMessage(mainId, event.message);
			}
			if (event.message.stopReason === "toolUse") this.#appendProgress(event.message);
			return;
		}
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		this.#appendFinalResponse(event.messages);
	}

	/**
	 * Mirrors one delegated agent's transcript to the viewer.
	 *
	 * A subagent runs its own AgentSession, so nothing about its conversation
	 * reaches the main session's event stream — from outside, a fan-out of five
	 * agents is five opaque tool calls. Subscribing per agent is what makes each
	 * delegation renderable as the chat it actually is.
	 */
	#handleAgentEvent(agentId: string, event: AgentSessionEvent): void {
		if (event.type === "message_end" && (event.message.role === "assistant" || event.message.role === "user")) {
			this.#recordAgentUsage(agentId, event.message);
			this.#publishAgentMessage(agentId, event.message);
			return;
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			this.#publishActivity({
				id: event.toolCallId,
				tool: event.toolName,
				state: event.type === "tool_execution_start" ? "start" : "end",
				at: Date.now(),
				agentId,
				...(event.type === "tool_execution_start"
					? toolSubject(event.args) === undefined
						? {}
						: { subject: toolSubject(event.args) }
					: event.isError === undefined
						? {}
						: { isError: event.isError }),
			});
		}
	}

	/** Attaches to agents that appeared and releases the ones that are gone. */
	#syncAgentSubscriptions(): void {
		const live = new Map<string, AgentSession>();
		for (const ref of this.#registry.list()) {
			// The main session is already subscribed; a second listener would double every event.
			if (ref.session && ref.session !== this.#session) live.set(ref.id, ref.session);
		}
		for (const [id, unsubscribe] of [...this.#agentSubscriptions]) {
			if (live.has(id)) continue;
			unsubscribe();
			this.#agentSubscriptions.delete(id);
		}
		for (const [id, session] of live) {
			if (this.#agentSubscriptions.has(id)) continue;
			this.#agentSubscriptions.set(
				id,
				session.subscribe(event => this.#guardEvent(() => this.#handleAgentEvent(id, event))),
			);
		}
	}

	#mainAgentId(): string | undefined {
		return this.#registry.list().find(ref => ref.kind === "main")?.id;
	}

	#recordAgentUsage(agentId: string, message: AgentMessage): void {
		if (message.role !== "assistant") return;
		const m = message as { model?: unknown; provider?: unknown; usage?: unknown };
		const stat = this.#agentStats.get(agentId) ?? { costUsd: 0, tokens: 0 };
		if (typeof m.model === "string") stat.model = m.model;
		if (typeof m.provider === "string") stat.provider = m.provider;
		const usage = m.usage as { totalTokens?: unknown; cost?: { total?: unknown } } | undefined;
		if (usage) {
			if (typeof usage.totalTokens === "number") stat.tokens += usage.totalTokens;
			if (typeof usage.cost?.total === "number") stat.costUsd += usage.cost.total;
		}
		this.#agentStats.set(agentId, stat);
	}

	#publishAgentMessage(agentId: string, message: AgentMessage): void {
		if (!this.#callbacks.onAgentMessage) return;
		if (message.role !== "assistant" && message.role !== "user") return;
		const text =
			message.role === "assistant"
				? this.#extractAssistantText(message as AssistantMessage).trim()
				: extractUserText(message).trim();
		if (!text) return;
		try {
			this.#callbacks.onAgentMessage({
				agentId,
				id: messageKey(message),
				role: message.role,
				text,
				at: Date.now(),
			});
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	/* Presentation only, and only to an attached viewer: the voice model is given
	   a rate-limited paraphrase (see below) because speech is serial, but a screen
	   can carry the whole churn without the user having to listen to it. */
	#publishActivity(activity: ToolActivity): void {
		this.#noteActivity();
		if (!this.#callbacks.onToolActivity) return;
		try {
			this.#callbacks.onToolActivity(activity);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#publishPlan(result: unknown): void {
		if (!this.#callbacks.onPlan) return;
		const plan = toPlanPhases(result);
		if (!plan) return;
		try {
			this.#callbacks.onPlan(plan);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	/* The registry is process-global and already tracks every agent the run spawns,
	   so the roster costs one subscription rather than a parallel bookkeeping of
	   subagent lifecycles that could disagree with the real tree. */
	#publishAgents(): void {
		if (!this.#callbacks.onAgents) return;
		const agents: BridgeAgentRef[] = this.#registry.list().map(ref => {
			const stat = this.#agentStats.get(ref.id);
			const base = toBridgeAgentRef(ref);
			return stat
				? {
						...base,
						...(stat.model === undefined ? {} : { model: stat.model }),
						...(stat.provider === undefined ? {} : { provider: stat.provider }),
						costUsd: Number(stat.costUsd.toFixed(4)),
						tokens: stat.tokens,
					}
				: base;
		});
		/* Polled, so publish only on a real change — otherwise every viewer gets an
		   identical roster frame every second for the life of the call. */
		const signature = JSON.stringify(agents);
		if (signature === this.#lastRosterSignature) return;
		this.#lastRosterSignature = signature;
		try {
			this.#callbacks.onAgents(agents);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	/* A delegated turn is silent from the request to the final answer unless the
	   coding model happens to narrate its own tool calls — which it usually does
	   not, since the preamble is optional. That silence is what turns "what is it
	   doing?" into a contentless holding phrase. Tool starts are the one event
	   that always fires, and `intent` is already a human-readable summary written
	   for display, so it is what a spoken update should carry. */
	#appendToolProgress(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		const step = describeToolStep(event);
		if (!step || step === this.#lastToolStep) return;

		/* Rate-limited, not queued: a turn can fire tool calls faster than speech,
		   and a backlog of stale steps is worse than a gap — it would have the
		   voice narrating a file read that finished a minute ago. Dropping the
		   intermediate steps keeps whatever it says true *now*. */
		const now = Date.now();
		if (this.#lastToolStepAt && now - this.#lastToolStepAt < TOOL_PROGRESS_MIN_INTERVAL_MS) return;
		this.#lastToolStep = step;
		this.#lastToolStepAt = now;
		for (const chunk of chunkLiveContext(`Currently: ${step}`)) {
			this.#queueSend(buildDelegationContextAppend(delegationId, chunk, "commentary"));
		}
	}

	#appendProgress(message: AssistantMessage): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		const progress = this.#extractAssistantText(message).trim();
		if (!progress) return;
		for (const chunk of chunkLiveContext(progress)) {
			this.#queueSend(buildDelegationContextAppend(delegationId, chunk, "commentary"));
		}
	}

	#appendFinalResponse(messages: readonly AgentMessage[]): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			const text = this.#extractAssistantText(message).trim();
			if (!text) continue;
			const finalContext = prompt.render(agentFinalMessageTemplate, { message: text });
			for (const chunk of chunkLiveContext(finalContext)) {
				this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
			}
			break;
		}
		this.#activeDelegationId = undefined;
		this.#lastToolStep = undefined;
		this.#lastToolStepAt = 0;
		this.#refreshAudioPhase();
	}

	/**
	 * Decodes one `output_audio.delta` event and forwards it to `onOutputAudio`.
	 *
	 * This event is part of the wire protocol regardless of audio mode (see
	 * `parseLiveServerEvent`), but only audio-less sessions (concern 09) ever
	 * consume it: in local-audio mode the native transport's own WebRTC media
	 * sink already plays this same audio through the device, and forwarding it
	 * again here too would be redundant, not additive. Malformed base64 is
	 * dropped rather than thrown — a bad audio frame must never take a call
	 * down the way a bad control frame elsewhere in this file never does.
	 */
	#handleOutputAudio(base64: string): void {
		if (!this.#noLocalAudio || !this.#callbacks.onOutputAudio) return;
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(Buffer.from(base64, "base64"));
		} catch (cause) {
			logger.debug("live session: could not decode output_audio.delta", { error: String(cause) });
			return;
		}
		if (bytes.length === 0) return;
		try {
			this.#callbacks.onOutputAudio(bytes);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#handleOutputLevel(level: number): void {
		this.#outputLevel = clampLevel(level);
		this.#emitLevels();
		if (!this.#activeDelegationId) this.#refreshAudioPhase();
	}

	#handleMicrophoneAudio(samples: Float32Array): void {
		if (this.#stopped || !this.#transport) return;
		if (this.#muted) return;
		this.#inputLevel = microphoneLevel(samples);
		this.#emitLevels();
		const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
		const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.#outputLevel * OUTPUT_ECHO_RATIO);
		if (outputActive && this.#inputLevel < echoThreshold) return;
		try {
			this.#transport.pushAudio(samples);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#addTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		let next: string;
		if (!current) {
			this.#startTranscriptTurn(role);
			next = text;
		} else if (wasFinal) {
			if (text === current || current.endsWith(text)) return;
			this.#startTranscriptTurn(role);
			next = text;
		} else if (text.startsWith(current)) {
			next = text;
		} else if (current.endsWith(text)) {
			next = current;
		} else {
			next = current + text;
		}
		this.#storeTranscript(role, next, false);
	}

	#finishTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		if (!current) {
			this.#startTranscriptTurn(role);
		} else if (wasFinal) {
			if (text === current) return;
			this.#startTranscriptTurn(role);
		}
		const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
		this.#storeTranscript(role, next, true);
	}

	#startTranscriptTurn(role: LiveTranscript["role"]): void {
		if (role === "user") {
			this.#userTranscriptTurn += 1;
		} else {
			this.#assistantTranscriptTurn += 1;
		}
	}

	#storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		const normalized = text.trim();
		if (!normalized) return;
		/* While the idle warning is outstanding, the model's OWN speech must not
		   rescue the call: the warning is spoken over the "speakable" channel,
		   which the transport echoes straight back as an output_transcript event
		   into this same function — treating that as activity would clear both
		   timers and un-mute #idleWarningSpoken on every cycle, so the warning
		   fires again 9 minutes later forever and the hangup never happens. User
		   speech, tool activity (#publishActivity), and decision events
		   (DecisionArbiter's onDecision) all still call #noteActivity() directly
		   and are unaffected — only an assistant transcript arriving after the
		   warning has spoken is exempted, and only until the next real rescue. */
		if (!(role === "assistant" && this.#idleWarningSpoken)) this.#noteActivity();
		const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
		if (role === "user") {
			this.#userTranscript = normalized;
			this.#userTranscriptFinal = final;
		} else {
			this.#assistantTranscript = normalized;
			this.#assistantTranscriptFinal = final;
		}
		if (
			this.#lastTranscript?.role === role &&
			this.#lastTranscript.turn === turn &&
			this.#lastTranscript.text === normalized &&
			this.#lastTranscript.final === final
		) {
			return;
		}
		const transcript: LiveTranscript = { role, turn, text: normalized, final };
		if (final) this.#journalTranscript(transcript);
		this.#emitTranscript(transcript);
	}

	/**
	 * Retains a settled transcript turn in the durable journal, by the recording
	 * mode this session was constructed with. `"off"` retains nothing; `"tails"`
	 * retains that a turn happened with only a short excerpt, matching the
	 * bounded snapshot the bridge already shows a viewer; `"full"` retains the
	 * turn verbatim. Streaming (non-final) deltas are never journaled — only a
	 * settled turn is durable history.
	 */
	#journalTranscript(transcript: LiveTranscript): void {
		if (this.#recordingMode === "off") return;
		const text =
			this.#recordingMode === "full" ? transcript.text : trimCodePoints(transcript.text, TAIL_TRANSCRIPT_POINTS);
		void this.#journal.append({ type: "transcript", transcript: { ...transcript, text } }).catch(cause => {
			logger.debug("live session: transcript journal write failed", { error: String(cause) });
		});
	}

	/**
	 * Marks the moment as the session's last human or agent activity, per the
	 * recorded idle-hangup policy (transcript turns, tool activity, and decision
	 * events — see `LiveSessionControllerOptions.idleHangupMs`'s doc for why
	 * this class defaults the policy off). Re-arms both the spoken-warning and
	 * the hangup timer relative to now, and un-mutes the warning so a session
	 * that goes idle again after recovering gets warned again.
	 */
	#noteActivity(): void {
		if (this.#idleHangupMs === undefined || this.#stopped) return;
		this.#idleWarningSpoken = false;
		if (this.#idleWarnTimer) clearTimeout(this.#idleWarnTimer);
		if (this.#idleHangupTimer) clearTimeout(this.#idleHangupTimer);
		this.#idleWarnTimer = setTimeout(() => this.#guardEvent(() => this.#speakIdleWarning()), this.#idleWarningMs);
		this.#idleWarnTimer.unref?.();
		this.#idleHangupTimer = setTimeout(() => this.#guardEvent(() => this.#idleHangup()), this.#idleHangupMs);
		this.#idleHangupTimer.unref?.();
	}

	#clearIdleTimers(): void {
		if (this.#idleWarnTimer) {
			clearTimeout(this.#idleWarnTimer);
			this.#idleWarnTimer = undefined;
		}
		if (this.#idleHangupTimer) {
			clearTimeout(this.#idleHangupTimer);
			this.#idleHangupTimer = undefined;
		}
	}

	/**
	 * Speaks the recorded "~90% of the timeout" idle warning over the SAME live
	 * session the human is already on — `buildSessionContextAppend` with the
	 * `"speakable"` channel, outside any delegation, is the transport's own
	 * direct-speech affordance (the `"commentary"` channel used elsewhere in this
	 * file is narration-only context, never spoken on its own). Journaled so the
	 * warning is durable history, not just a frame that may have had no listener.
	 */
	#speakIdleWarning(): void {
		if (this.#stopped || this.#idleWarningSpoken || this.#idleHangupMs === undefined) return;
		this.#idleWarningSpoken = true;
		const remainingMs = Math.max(0, this.#idleHangupMs - (this.#idleWarningMs ?? this.#idleHangupMs));
		const remainingMinutes = Math.max(1, Math.round(remainingMs / 60_000));
		const text = `Nobody has spoken for a while. This call will end in about ${remainingMinutes} minute${
			remainingMinutes === 1 ? "" : "s"
		} unless there's more activity.`;
		this.#queueSend(buildSessionContextAppend(text, "speakable"));
		void this.#journal.append({ type: "idle-warning" }).catch(cause => {
			logger.debug("live session: idle-warning journal write failed", { error: String(cause) });
		});
	}

	/** The idle-hangup policy's own terminal act — a clean stop, not a failure. */
	#idleHangup(): void {
		if (this.#stopped) return;
		this.#idleReason = IDLE_TERMINAL_REASON;
		void this.stop();
	}

	#queueSend(message: LiveClientMessage): void {
		const transport = this.#transport;
		if (!transport || this.#stopped) return;
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (!this.#stopped) await transport.send(message);
			})
			.catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	#refreshAudioPhase(): void {
		if (this.#stopped) return;
		if (this.#muted) {
			this.#emitPhase("muted");
		} else if (this.#activeDelegationId) {
			this.#emitPhase("working");
		} else if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL) {
			this.#emitPhase("speaking");
		} else {
			this.#emitPhase("listening");
		}
	}

	#emitPhase(phase: LivePhase, force = false): void {
		if (!force && this.#phase === phase) return;
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitPhaseSafely(phase: LivePhase): void {
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch {
			// Terminal callback is the final error boundary for UI failures.
		}
	}

	#emitLevels(): void {
		try {
			this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitTranscript(transcript: LiveTranscript | undefined): void {
		this.#lastTranscript = transcript;
		try {
			this.#callbacks.onTranscript(transcript);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#reportFailure(error: Error): void {
		if (this.#terminalEmitted) return;
		this.#failure = error;
		this.#emitPhaseSafely("error");
		this.#emitTerminal(error);
		void this.stop();
	}

	#emitTerminal(error?: Error, reason?: string): void {
		if (this.#terminalEmitted) return;
		this.#terminalEmitted = true;
		try {
			this.#callbacks.onTerminal(error, reason);
		} catch {
			// Nothing remains above the terminal callback to receive its error.
		}
	}
}
