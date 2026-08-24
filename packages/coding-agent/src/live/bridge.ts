import { logger } from "@oh-my-pi/pi-utils";
import type { LiveTranscript } from "./controller";
import type { FleetDecisionOptionSpec, FleetDecisionSpec, FleetRelayResult } from "./fleet-tools";
import type { LivePhase } from "./visualizer";

/**
 * Mirrors a `/live` session's presentation state onto a loopback WebSocket so an
 * external surface can render it.
 *
 * This is a *tee*, not a control plane. It carries the same four values the
 * terminal visualizer already receives — phase, levels, transcript, terminal —
 * and accepts exactly two commands back, the same two the visualizer binds to
 * `esc` and `space`. It never touches the transport, the audio devices, the
 * credentials, or the agent session.
 *
 * Failure here must never take the call down: a bridge that cannot bind, cannot
 * send, or has no listeners is a no-op, and `/live` proceeds exactly as if it
 * were not compiled in.
 */

/** Protocol version. Bump only on a breaking change to the frame shape. */
const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 8788;
const DEFAULT_HOST = "127.0.0.1";
/**
 * Binary WS frame tags (concern 09: browser-audio-transport).
 *
 * The JSON control/presentation protocol above uses TEXT frames exclusively
 * (`ws.send(string)`); audio uses BINARY frames instead of base64-in-JSON, so
 * a v1 client that only ever sent/received text frames is structurally
 * unaffected — it never sends a binary frame, and the bridge never sends one
 * back unless `onMicAudio` is wired (see `hello`'s `audio` field), which only
 * happens when the session was built in `noLocalAudio` mode.
 */
const MIC_AUDIO_FRAME_TAG = 0x01;
const OUTPUT_AUDIO_FRAME_TAG = 0x02;
/** Sample rate `LiveSessionController.pushRemoteAudio`/`AudioCapture` both use — mono Float32 PCM. */
const MIC_AUDIO_SAMPLE_RATE_HZ = 16_000;
/**
 * Assumed sample rate and encoding of the realtime provider's
 * `output_audio.delta` event (mono, 16-bit PCM, little-endian) — OpenAI's
 * documented Realtime API default for `pcm16` audio output. Unverified
 * against a live Codex call from this checkout: this environment's own
 * miniaudio backend is the thing concern 09 exists to route around (see
 * DESIGN.md and this concern's Resolution), so there was no local speaker to
 * confirm against. A browser client that finds this wrong only needs this one
 * constant to change, and the field is carried on the wire (`hello.audio`) so
 * a client never has to hardcode it either.
 */
const OUTPUT_AUDIO_SAMPLE_RATE_HZ = 24_000;
const OUTPUT_AUDIO_ENCODING = "pcm16le";
/** A viewer socket, as this bridge sends both JSON text frames and binary audio frames to it. */
type BridgeSocket = { send(data: string | Uint8Array): unknown };
/** Trimmed transcript length, in code points — see `trimCodePoints`. */
const MAX_TRANSCRIPT_POINTS = 480;
/** Retained transcript turns; the snapshot sent to a late joiner. */
const MAX_TRANSCRIPTS = 24;
/** Retained tool steps. Deep enough to show the shape of a turn, bounded so a
    long-running session cannot grow the snapshot without limit. */
const MAX_ACTIVITY = 64;
/** Trimmed activity subject length, in code points. A path, not a payload. */
const MAX_SUBJECT_POINTS = 160;
/** Tasks retained per plan phase. A plan longer than this is a document, not a pin. */
const MAX_PLAN_TASKS = 40;
/** Longest context push accepted from a viewer, in code points (a view, not a message). */
const MAX_CONTEXT_POINTS = 16_000;
/** Longest steering message accepted from a viewer, in code points. */
const MAX_STEER_POINTS = 4_000;
/** Retained delegated-agent messages across all agents. */
const MAX_AGENT_MESSAGES = 120;
/** Trimmed length of one delegated message. Markdown needs room; a payload does not. */
const MAX_AGENT_MESSAGE_POINTS = 4_000;
/** Longest fleet context brief accepted from an attaching executor, in code points (concern 12).
 *  A room projection is a screenful of roster and open questions, not a document. */
const MAX_FLEET_CONTEXT_POINTS = 16_000;
/** How long one relayed fleet tool call may stay outstanding before it fails honestly. Sized for
 *  the slowest legitimate relay (a spawn provisions a worktree and starts a process), bounded so a
 *  wedged daemon can never hang the delegated agent's tool call forever. */
const DEFAULT_FLEET_CALL_TIMEOUT_MS = 60_000;

/** One tool call as it starts or finishes, for a viewer's activity feed. */
export interface ToolActivity {
	/** Tool call id, so a viewer can pair an end with the start it closes. */
	id: string;
	tool: string;
	/** Path, pattern, or command the call is about, when it has one. */
	subject?: string;
	state: "start" | "end";
	isError?: boolean;
	at: number;
	/** Registry id of the agent that ran it, so a nested chat shows its own churn. */
	agentId?: string;
}

/**
 * One message from a delegated agent's own transcript.
 *
 * The delegated work is a full conversation, not a status line: it has the
 * agent's prose, its markdown, and its tool calls. Publishing it per agent is
 * what lets a viewer render each delegation as its own chat rather than as a
 * spinner the operator has to take on faith.
 */
export interface BridgeAgentMessage {
	/** Registry id of the agent whose transcript this belongs to. */
	agentId: string;
	/** Stable id for the message, so a growing message replaces rather than repeats. */
	id: string;
	role: "user" | "assistant";
	text: string;
	at: number;
}

/** One task in the agent's own plan. Mirrors `TodoItem` in tools/todo.ts. */
export interface PlanTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
	/** What a blocked task is waiting for, when the agent recorded one. */
	blocker?: string;
}

/** One phase of the plan, as the todo tool groups it. */
export interface PlanPhase {
	name: string;
	tasks: PlanTask[];
}

/** One agent in the run tree, as a viewer needs to render it. */
export interface BridgeAgentRef {
	id: string;
	displayName: string;
	kind: "main" | "sub" | "advisor";
	status: "running" | "idle" | "parked" | "aborted";
	parentId?: string;
	/** Short gist of the agent's current work, when the registry has one. */
	activity?: string;
	/** The agent's role — omp names a subagent after its type (scout, reviewer…). */
	role?: string;
	/** Model actually answering for this agent, as its own messages report it. */
	model?: string;
	provider?: string;
	/** Accumulated spend and tokens for THIS agent, not the run as a whole. */
	costUsd?: number;
	tokens?: number;
}

/**
 * Narrows one `fleetResult` control frame's `result` payload into a `FleetRelayResult`
 * (concern 12). The executor is token-authenticated, but its payload still gets the same
 * field-by-field discipline every other inbound value on this socket gets: anything that doesn't
 * structurally match resolves as an honest failure, never as an unchecked object handed to a tool.
 */
export function narrowFleetResult(raw: unknown): FleetRelayResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { status: "failed", detail: "malformed fleet result" };
	const record = raw as Record<string, unknown>;
	const detail = typeof record.detail === "string" ? record.detail : undefined;
	const data = typeof record.data === "string" ? record.data : undefined;
	if (record.status === "ok") {
		return { status: "ok", ...(detail === undefined ? {} : { detail }), ...(data === undefined ? {} : { data }) };
	}
	if (record.status === "failed") {
		return { status: "failed", detail: detail ?? "fleet action failed" };
	}
	if (record.status === "needs-decision") {
		const spec = record.decision;
		if (spec && typeof spec === "object" && !Array.isArray(spec)) {
			const s = spec as Record<string, unknown>;
			const options: FleetDecisionOptionSpec[] = Array.isArray(s.options)
				? s.options.flatMap(option => {
						if (!option || typeof option !== "object") return [];
						const o = option as Record<string, unknown>;
						if (typeof o.label !== "string" || !o.label.trim()) return [];
						return [{ label: o.label, consequence: typeof o.consequence === "string" ? o.consequence : "" }];
					})
				: [];
			if (
				typeof s.prompt === "string" &&
				s.prompt.trim() &&
				options.length > 0 &&
				typeof s.deferredActionId === "string" &&
				s.deferredActionId
			) {
				const decision: FleetDecisionSpec = {
					prompt: s.prompt,
					options,
					deferredActionId: s.deferredActionId,
					...(typeof s.requiresConfirmation === "boolean" ? { requiresConfirmation: s.requiresConfirmation } : {}),
				};
				return { status: "needs-decision", decision, ...(detail === undefined ? {} : { detail }) };
			}
		}
		return { status: "failed", detail: "malformed needs-decision fleet result" };
	}
	return { status: "failed", detail: "malformed fleet result" };
}

function parseOriginsEnv(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

/** Retention state advertised to a viewer. Not a control — set once, at construction. */
export type RecordingMode = "full" | "tails" | "off";

/** One human-facing option of a decision, as the arbiter minted it. Index, label, consequence only — never an agent-authored payload. */
export interface DecisionOption {
	index: number;
	label: string;
	consequence: string;
}

export type DecisionState = "open" | "awaiting-confirmation" | "answered" | "expired" | "cancelled" | "failed";

export interface DecisionResolution {
	optionIndex: number;
	label: string;
	source: "voice" | "ui";
}

/**
 * The recorded voice-resolution policy for a decision — see concern 05's
 * Decisions. `"destructive"` is UI-only for V1; absent or `"routine"` is
 * voice-resolvable. Additive: a v1 client that has never seen this field
 * ignores it and renders exactly as before.
 */
export type DecisionClass = "destructive" | "routine";

/** A structural clone of one decision's state, as the arbiter's sole write produced it. */
export interface Decision {
	id: string;
	prompt: string;
	options: DecisionOption[];
	requiresConfirmation: boolean;
	/** Absent means unclassified — a voice resolution is allowed, same as `"routine"`. */
	decisionClass?: DecisionClass;
	state: DecisionState;
	createdAt: number;
	updatedAt: number;
	resolution?: DecisionResolution;
}

export type InterruptPolicy = "allow" | "doNotInterrupt";

/** A viewer's request to resolve or confirm a decision, after the bridge has authorized the frame. */
export interface ResolveDecisionRequest {
	decisionId: string;
	optionIndex: number;
	label: string;
	requestId: string;
	/** Present when this is the second, confirming act for a decision requiring one. */
	confirmToken?: string;
	source: "ui";
}

export interface ResolveDecisionResult {
	ok: boolean;
	decision?: Decision;
	reason?: string;
	/** Returned when the resolution only advanced the decision to `awaiting-confirmation`. */
	confirmToken?: string;
}

export interface SetInterruptPolicyRequest {
	policy: InterruptPolicy;
	requestId: string;
}

export interface BridgeHandlers {
	/** Invoked when a viewer asks to end the call. Same contract as visualizer `onStop`. */
	onStop(): void;
	/** Invoked when a viewer toggles the microphone. Same contract as `onToggleMute`. */
	onToggleMute(): void;
	/**
	 * Invoked when a viewer types a steering message for the delegated work.
	 *
	 * THIS IS THE ONE CONTROL THAT CHANGES WHAT THE AGENT DOES. Everything else a
	 * viewer can send only stops or mutes the call. Steering injects operator text
	 * into a session that runs with real credentials on real files, so it is
	 * gated: the handler is optional, and the bridge refuses the action outright
	 * when `OMP_LIVE_BRIDGE_STEERING=0`. A viewer is a page on this machine; a
	 * page on this machine should not silently acquire the ability to drive an
	 * agent unless the operator meant to grant it.
	 */
	onSteer?(text: string): void;
	/**
	 * Invoked when a viewer pushes CONTEXT — what the person is looking at —
	 * as grounding for the realtime model (the commentary channel: read, never
	 * spoken, never a delegated turn). Unlike `steer` it does not make the agent
	 * do anything, but it still shapes what it says, so it rides the same
	 * `OMP_LIVE_BRIDGE_STEERING` gate. `canContext` in `hello` is true only
	 * when this is wired.
	 */
	onContext?(text: string): void;
	/**
	 * Invoked once a resolve/confirm control frame has already passed token,
	 * Origin, and session validation. The handler still owns label-echo,
	 * idempotency, and state-machine validation — it is expected to be backed by
	 * a `DecisionArbiter`, which is the sole writer of decision state. `canResolve`
	 * in `hello` is true only when this is wired.
	 */
	onResolveDecision?(request: ResolveDecisionRequest): Promise<ResolveDecisionResult> | ResolveDecisionResult;
	/** Invoked for an authorized `setInterruptPolicy` control frame. */
	onSetInterruptPolicy?(
		request: SetInterruptPolicyRequest,
	): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
	/**
	 * Invoked once an authenticated `attachFleet` control frame carried a `context` payload
	 * (concern 12: voice-fleet-delegation) — the room's projection (roster, states, open
	 * decisions), composed by the attaching daemon, for the host to inject into the realtime
	 * session as grounding data. Already token/session-authorized and bounded
	 * (`MAX_FLEET_CONTEXT_POINTS`) by the time this fires. Optional: a host that does not wire it
	 * simply attaches executors without context seeding.
	 */
	onFleetContext?(context: string): void;
	/**
	 * Invoked for one binary mic-audio frame from a viewer (concern 09:
	 * browser-audio-transport) — mono 16 kHz `Float32` PCM, the exact format
	 * `AudioCapture`'s own device callback produces. Wired only when the
	 * session was started with `noLocalAudio: true`; its presence is what
	 * flips `hello.audio.transport` to true, exactly like `canSteer`/`canResolve`
	 * above. A viewer must not be invited to stream audio into a call that owns
	 * its own local microphone — the two sources would talk over each other.
	 */
	onMicAudio?(samples: Float32Array): void;
}

interface TranscriptEntry {
	role: LiveTranscript["role"];
	text: string;
	turn: number;
	final: boolean;
}

/**
 * Trims to the last `max` **code points**.
 *
 * `String.prototype.slice` counts UTF-16 code units and will cut a surrogate
 * pair in half, leaving a lone surrogate that cannot be encoded as valid UTF-8 —
 * one emoji at the boundary is enough to corrupt the frame for a strict decoder.
 * Iterating with `Array.from` walks code points and cannot split one.
 */
export function trimCodePoints(text: string, max: number): string {
	const points = Array.from(text);
	if (points.length <= max) return text;
	return points.slice(points.length - max).join("");
}

/** A loopback fan-out of live-session presentation state. */
export class Bridge {
	readonly #handlers: BridgeHandlers;
	readonly #sessionId: string;
	readonly #port: number;
	readonly #host: string;

	#server: ReturnType<typeof Bun.serve> | undefined;
	#sockets = new Set<BridgeSocket>();
	#seq = 0;
	#closed = false;

	#phase: LivePhase = "connecting";
	#muted = false;
	#transcripts: TranscriptEntry[] = [];
	#activity: ToolActivity[] = [];
	#agents: BridgeAgentRef[] = [];
	#plan: PlanPhase[] = [];
	readonly #steeringEnabled = process.env.OMP_LIVE_BRIDGE_STEERING !== "0";
	#agentMessages: BridgeAgentMessage[] = [];

	/** Broker-minted call identity. Undefined for a bare `/live` started with no broker in front of it. */
	readonly #callId: string | undefined;
	readonly #recordingMode: RecordingMode;
	/**
	 * Per-call secret the daemon holds. When set, `resolveDecision` and
	 * `setInterruptPolicy` frames MUST echo it exactly or are refused — a local
	 * page cannot silently answer an agent decision just because it can reach
	 * the loopback port. Undefined only for a bare `/live` with no broker, where
	 * the caller (a human at their own terminal) already IS the operator.
	 */
	readonly #controlToken: string | undefined;
	/** Non-empty only when the caller opted into origin checking (normally broker-supplied). */
	readonly #allowedOrigins: Set<string> | undefined;
	#decisions = new Map<string, Decision>();
	#interruptPolicy: InterruptPolicy = "allow";

	/**
	 * Whether this bridge carries the fleet-delegation surface at all (concern 12). Set by the
	 * headless entry, which is the only host that wires fleet tools — advertised as `canFleet` in
	 * `hello` so a daemon never attempts `attachFleet` against a bridge that would refuse it.
	 */
	readonly #fleetEnabled: boolean;
	/** The ONE socket authorized to execute fleet tool calls — the latest authenticated
	 *  `attachFleet` wins (a reattaching daemon replaces its own dead predecessor). */
	#fleetExecutor: BridgeSocket | undefined;
	#fleetCallSeq = 0;
	readonly #pendingFleetCalls = new Map<
		string,
		{ resolve: (result: FleetRelayResult) => void; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(
		handlers: BridgeHandlers,
		options?: {
			port?: number;
			host?: string;
			sessionId?: string;
			callId?: string;
			recordingMode?: RecordingMode;
			controlToken?: string;
			allowedOrigins?: readonly string[];
			/** Concern 12: advertise + accept the fleet-delegation controls. Off by default. */
			fleetEnabled?: boolean;
		},
	) {
		this.#handlers = handlers;
		this.#port = options?.port ?? Number(process.env.OMP_LIVE_BRIDGE_PORT ?? DEFAULT_PORT);
		/* Loopback by default: this carries live transcript text and must not be
		   reachable off-host. Overridable because a viewer on the other side of a
		   VM boundary (a Windows browser onto a WSL host, say) may not be able to
		   reach a loopback-only bind. Widening it is a deliberate act. */
		this.#host = options?.host ?? process.env.OMP_LIVE_BRIDGE_HOST ?? DEFAULT_HOST;
		// Identity for the whole session. A restarted `/live` gets a fresh id, which
		// is how a viewer tells a live frame from a straggler off the previous call.
		this.#sessionId =
			options?.sessionId ?? `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.#callId = options?.callId?.trim() || undefined;
		this.#recordingMode = options?.recordingMode ?? "tails";
		this.#controlToken = options?.controlToken?.trim() || undefined;
		const origins = options?.allowedOrigins ?? parseOriginsEnv(process.env.OMP_LIVE_BRIDGE_ORIGINS);
		this.#allowedOrigins = origins.length > 0 ? new Set(origins) : undefined;
		this.#fleetEnabled = options?.fleetEnabled === true;
	}

	/** Binds the loopback listener. Returns false if the bridge is unavailable. */
	open(): boolean {
		if (this.#server || this.#closed) return false;
		try {
			this.#server = Bun.serve({
				port: this.#port,
				hostname: this.#host,
				fetch: (request, server) => {
					/* An explicit allowlist, checked before the upgrade — not just on the
					   response, since by then the side effect (a connected control channel)
					   has already happened. Absent header means a non-browser caller (the
					   test harness, `omp-live`'s own tooling); only a header that names a
					   DISALLOWED origin is refused. */
					const origin = request.headers.get("origin");
					if (this.#allowedOrigins && origin && !this.#allowedOrigins.has(origin)) {
						return new Response("live bridge: origin not allowed", { status: 403 });
					}
					if (server.upgrade(request, { data: undefined })) return undefined;
					return new Response("live bridge: websocket only", { status: 426 });
				},
				websocket: {
					open: ws => {
						this.#sockets.add(ws);
						// A viewer that joins mid-call must render correctly straight away
						// rather than waiting for the next state change.
						this.#sendTo(ws, {
							type: "hello",
							phase: this.#phase,
							muted: this.#muted,
							transcripts: this.#transcripts,
							activity: this.#activity,
							agents: this.#agents,
							plan: this.#plan,
							agentMessages: this.#agentMessages,
							// A viewer must not offer a steering box that silently does nothing.
							canSteer: this.#steeringEnabled && this.#handlers.onSteer !== undefined,
							canContext: this.#steeringEnabled && this.#handlers.onContext !== undefined,
							// Additive: a v1 client that doesn't know these fields ignores them
							// and keeps working exactly as before.
							...(this.#callId === undefined ? {} : { callId: this.#callId }),
							recordingMode: this.#recordingMode,
							canResolve: this.#handlers.onResolveDecision !== undefined,
							decisions: [...this.#decisions.values()],
							interruptPolicy: this.#interruptPolicy,
							/* Additive (concern 12), same rule as canSteer/canResolve: absent or false
							   means no fleet surface — a daemon reads this before ever sending
							   attachFleet, so an older/TUI bridge is feature-off, not broken. */
							...(this.#fleetEnabled ? { canFleet: true } : {}),
							/* Additive, same rule as canSteer/canResolve: absent or false means a
							   v1 client sees nothing new. True only when the session behind this
							   bridge was started with noLocalAudio — a viewer has no business
							   streaming a microphone into (or expecting output audio from) a call
							   that already owns a local device. */
							...(this.#handlers.onMicAudio === undefined
								? {}
								: {
										audio: {
											transport: true,
											micSampleRate: MIC_AUDIO_SAMPLE_RATE_HZ,
											outputSampleRate: OUTPUT_AUDIO_SAMPLE_RATE_HZ,
											outputEncoding: OUTPUT_AUDIO_ENCODING,
										},
									}),
						});
					},
					message: (ws, message) => {
						// Binary frames are audio (concern 09); text frames are the existing
						// JSON control/presentation protocol. A v1 client never sends binary.
						if (typeof message === "string") this.#handleControl(ws, message);
						else this.#handleMicAudioFrame(message);
					},
					close: ws => {
						this.#sockets.delete(ws);
						// Concern 12: a departing fleet executor takes its in-flight calls with it —
						// each pending call fails honestly NOW rather than waiting out its timeout.
						if (ws === this.#fleetExecutor) {
							this.#fleetExecutor = undefined;
							this.#failPendingFleetCalls("the fleet executor disconnected");
						}
					},
				},
			});
			return true;
		} catch (cause) {
			/* Failing soft is right — a viewer is optional and must never take a call
			   down. But failing *silently* is not: the overwhelmingly common cause is
			   a second session colliding on the port, and from the viewer's side that
			   is indistinguishable from a bridge that was never built. Warn, and name
			   the way out. */
			logger.warn(
				`live bridge: could not bind ${this.#host}:${this.#port} — this session has no viewer. ` +
					`Another /live session is probably already using it; set OMP_LIVE_BRIDGE_PORT to a free port.`,
				{ host: this.#host, port: this.#port, error: String(cause) },
			);
			this.#server = undefined;
			return false;
		}
	}

	/** Mirrors `LiveSessionCallbacks.onPhase`. */
	publishPhase(phase: LivePhase): void {
		this.#phase = phase;
		if (phase === "muted") this.#muted = true;
		this.#broadcast({ type: "phase", phase });
	}

	/**
	 * Mirrors `LiveSessionCallbacks.onLevels`.
	 *
	 * Both levels are forwarded. The terminal visualizer only consumes `input`,
	 * but `output` is what lets an external surface react while the assistant is
	 * speaking rather than only while the user is.
	 */
	publishLevels(input: number, output: number): void {
		this.#broadcast({ type: "levels", input, output });
	}

	/** Mirrors `LiveSessionCallbacks.onTranscript`. */
	publishTranscript(transcript: LiveTranscript | undefined): void {
		if (!transcript) return;
		const entry: TranscriptEntry = {
			role: transcript.role,
			text: trimCodePoints(transcript.text, MAX_TRANSCRIPT_POINTS),
			turn: transcript.turn,
			final: transcript.final,
		};
		// Streaming updates re-send a growing utterance under one (role, turn).
		// Replace in place so a snapshot holds turns, not keystrokes.
		const at = this.#transcripts.findIndex(item => item.role === entry.role && item.turn === entry.turn);
		if (at >= 0) this.#transcripts[at] = entry;
		else this.#transcripts.push(entry);
		if (this.#transcripts.length > MAX_TRANSCRIPTS) {
			this.#transcripts.splice(0, this.#transcripts.length - MAX_TRANSCRIPTS);
		}
		this.#broadcast({ type: "transcript", ...entry });
	}

	/**
	 * Publishes one tool step of the delegated work.
	 *
	 * The transcript says what the assistant *said*; this says what it *did*, which
	 * is the only channel that distinguishes a claim from a step actually taken.
	 * Starts and ends are separate frames carrying a shared id so a viewer can show
	 * a call as in-flight and then close it, rather than inferring duration.
	 */
	publishActivity(activity: ToolActivity): void {
		const entry: ToolActivity = {
			...activity,
			...(activity.subject === undefined ? {} : { subject: trimCodePoints(activity.subject, MAX_SUBJECT_POINTS) }),
		};
		this.#activity.push(entry);
		if (this.#activity.length > MAX_ACTIVITY) {
			this.#activity.splice(0, this.#activity.length - MAX_ACTIVITY);
		}
		this.#broadcast({ type: "activity", activity: entry });
	}

	/**
	 * Publishes the current agent roster — the driving agent plus any subagents.
	 *
	 * Sent whole rather than as deltas: the roster is a handful of entries, and a
	 * viewer that joins mid-run or drops a frame would otherwise render a tree that
	 * silently disagrees with the run.
	 */
	publishAgents(agents: readonly BridgeAgentRef[]): void {
		this.#agents = [...agents];
		this.#broadcast({ type: "agents", agents: this.#agents });
	}

	/**
	 * Publishes the agent's own plan — the todo tool's latest snapshot.
	 *
	 * Sent whole and replacing, like the roster: the tool already emits the
	 * complete phase list on every operation, so reconstructing it from deltas
	 * would be strictly worse. A viewer pins the LATEST snapshot rather than
	 * showing every revision inline, which is what keeps a plan revised eight
	 * times from becoming eight plans in the transcript.
	 */
	publishPlan(plan: readonly PlanPhase[]): void {
		this.#plan = plan.map(phase => ({
			name: trimCodePoints(phase.name, MAX_SUBJECT_POINTS),
			tasks: phase.tasks.slice(0, MAX_PLAN_TASKS).map(task => ({
				content: trimCodePoints(task.content, MAX_SUBJECT_POINTS),
				status: task.status,
				...(task.blocker === undefined ? {} : { blocker: trimCodePoints(task.blocker, MAX_SUBJECT_POINTS) }),
			})),
		}));
		this.#broadcast({ type: "plan", plan: this.#plan });
	}

	/**
	 * Publishes one message from a delegated agent's transcript.
	 *
	 * Keyed by `(agentId, id)` and replaced in place: an assistant message grows
	 * as it streams, and appending every revision would render one answer as
	 * fifty. Same rule the voice transcript already uses for utterances.
	 */
	publishAgentMessage(message: BridgeAgentMessage): void {
		const entry: BridgeAgentMessage = {
			...message,
			text: trimCodePoints(message.text, MAX_AGENT_MESSAGE_POINTS),
		};
		const at = this.#agentMessages.findIndex(item => item.agentId === entry.agentId && item.id === entry.id);
		if (at >= 0) this.#agentMessages[at] = entry;
		else this.#agentMessages.push(entry);
		if (this.#agentMessages.length > MAX_AGENT_MESSAGES) {
			this.#agentMessages.splice(0, this.#agentMessages.length - MAX_AGENT_MESSAGES);
		}
		this.#broadcast({ type: "agentMessage", message: entry });
	}

	/** Records the mute state a viewer's toggle produced. */
	publishMuted(muted: boolean): void {
		this.#muted = muted;
		/* Broadcast, not just record.
		 *
		 * Recording it only told the NEXT viewer, in its `hello`. An attached one
		 * learned about muting solely from the phase frame, which can say "muted"
		 * but never says "no longer muted" — so a viewer latched mute on and could
		 * not clear it, its button stayed "Unmute", and pressing it muted again.
		 * Mute is a fact about the session, so it gets a frame of its own. */
		this.#broadcast({ type: "muted", muted });
	}

	/**
	 * Publishes one decision's current state to every viewer.
	 *
	 * The bridge is presentation, not the record: only `open` and
	 * `awaiting-confirmation` decisions live in the retained snapshot a late
	 * joiner's `hello` carries, because the durable history is the journal's
	 * job, not this socket's. A decision reaching a terminal state is broadcast
	 * once and then dropped from the snapshot.
	 */
	publishDecision(decision: Decision): void {
		if (decision.state === "open" || decision.state === "awaiting-confirmation") {
			this.#decisions.set(decision.id, decision);
		} else {
			this.#decisions.delete(decision.id);
		}
		this.#broadcast({ type: "decision", decision });
	}

	/** Publishes the do-not-interrupt state a viewer (or the operator) set. */
	publishInterruptPolicy(policy: InterruptPolicy): void {
		this.#interruptPolicy = policy;
		this.#broadcast({ type: "interruptPolicy", policy });
	}

	/**
	 * Sends one chunk of decoded output audio to every viewer (concern 09:
	 * browser-audio-transport) — a binary frame tagged `OUTPUT_AUDIO_FRAME_TAG`,
	 * never the JSON presentation protocol above. A no-op with no listener,
	 * same as `#broadcast`; a dead socket is dropped the same way too.
	 */
	publishOutputAudio(bytes: Uint8Array): void {
		if (bytes.length === 0 || this.#sockets.size === 0) return;
		const frame = new Uint8Array(1 + bytes.length);
		frame[0] = OUTPUT_AUDIO_FRAME_TAG;
		frame.set(bytes, 1);
		for (const ws of [...this.#sockets]) {
			try {
				ws.send(frame);
			} catch {
				this.#sockets.delete(ws); // A dead socket must not stall the call.
			}
		}
	}

	/**
	 * Mirrors `LiveSessionCallbacks.onTerminal` and releases the listener.
	 *
	 * `reason` names why the session ended beyond bare error/no-error — e.g.
	 * `"idle"` for the 10-minute idle-hangup policy. Additive and optional: a v1
	 * client that has never seen this field sees the same terminal frame as
	 * before.
	 */
	close(error?: Error, reason?: string): void {
		if (this.#closed) return;
		this.#closed = true;
		// Concern 12: nothing can answer a fleet call once the session is over — settle every
		// outstanding one honestly before the terminal frame goes out.
		this.#fleetExecutor = undefined;
		this.#failPendingFleetCalls("the call has ended");
		this.#broadcast({
			type: "terminal",
			error: error ? error.message : null,
			...(reason === undefined ? {} : { reason }),
		});
		const sockets = [...this.#sockets];
		this.#sockets.clear();
		const server = this.#server;
		this.#server = undefined;
		// Tearing the socket down in the same tick as the broadcast drops the
		// terminal frame, and the viewer never learns why the call ended. Yield
		// once so the frame reaches the wire, then release everything.
		setTimeout(() => {
			for (const ws of sockets) {
				try {
					(ws as { close?: () => void }).close?.();
				} catch {
					// Already gone; nothing to release.
				}
			}
			try {
				server?.stop(true);
			} catch (cause) {
				logger.debug("live bridge: stop failed", { error: String(cause) });
			}
		}, 0);
	}

	/**
	 * Handles one binary frame from a viewer (concern 09: browser-audio-transport).
	 *
	 * Only `MIC_AUDIO_FRAME_TAG` is accepted from a client — the other tag is
	 * server→client only. Malformed input (too short, not a whole number of
	 * `Float32` samples, or arriving with no `onMicAudio` wired at all) is
	 * dropped silently, exactly like malformed JSON control input elsewhere in
	 * this class: a viewer fully controls this input and must never be able to
	 * throw inside the bridge.
	 */
	#handleMicAudioFrame(buffer: Buffer): void {
		if (buffer.length < 2 || buffer[0] !== MIC_AUDIO_FRAME_TAG) return;
		const handler = this.#handlers.onMicAudio;
		if (!handler) return; // Not wired: this bridge isn't in audio-relay mode.
		const payload = buffer.subarray(1);
		if (payload.length === 0 || payload.length % 4 !== 0) return; // Not a whole number of Float32 samples.
		/* Copy defensively into a fresh, 4-byte-aligned buffer: `payload` views a
		   `Buffer` at a byte offset the websocket implementation chose, which
		   `Float32Array` requires to be a multiple of 4 and which is free to reuse
		   the underlying allocation once this callback returns. */
		const copy = new Uint8Array(payload.length);
		copy.set(payload);
		try {
			handler(new Float32Array(copy.buffer));
		} catch (cause) {
			logger.debug("live bridge: onMicAudio handler failed", { error: String(cause) });
		}
	}

	#handleControl(ws: BridgeSocket, message: string | Buffer): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
		} catch {
			return; // Malformed input from a viewer is ignored, never thrown.
		}
		if (!parsed || typeof parsed !== "object") return;
		const frame = parsed as Record<string, unknown>;
		if (frame.type !== "control") return;
		// An allowlist, not a dispatch table: a viewer can end the call, toggle the
		// microphone, steer (if wired), or ask for a resolve/interrupt-policy
		// action authorized below. Nothing else is accepted.
		if (frame.action === "stop") this.#handlers.onStop();
		else if (frame.action === "toggleMute") this.#handlers.onToggleMute();
		else if (frame.action === "steer") this.#handleSteer(frame);
		else if (frame.action === "context") this.#handleContext(frame);
		else if (frame.action === "resolveDecision") void this.#handleResolveDecision(ws, frame);
		else if (frame.action === "setInterruptPolicy") void this.#handleSetInterruptPolicy(ws, frame);
		else if (frame.action === "attachFleet") this.#handleAttachFleet(ws, frame);
		else if (frame.action === "fleetResult") this.#handleFleetResult(ws, frame);
	}

	/**
	 * Checks the parts of a control frame that are the SAME for every gated
	 * action, before the action-specific handler runs: the frame must carry a
	 * `requestId` to ack against, the daemon-held token (when one is
	 * configured), and the session this bridge is actually running.
	 *
	 * Returns undefined when there is no `requestId` to ack against at all —
	 * that frame is dropped exactly like any other malformed input, never
	 * thrown at, never acked.
	 */
	#authorizeControl(frame: Record<string, unknown>): { requestId: string; reason?: string } | undefined {
		const requestId = typeof frame.requestId === "string" && frame.requestId ? frame.requestId : undefined;
		if (!requestId) return undefined;
		if (this.#controlToken !== undefined && frame.token !== this.#controlToken) {
			return { requestId, reason: "invalid-token" };
		}
		if (typeof frame.sessionId !== "string" || frame.sessionId !== this.#sessionId) {
			return { requestId, reason: "wrong-session" };
		}
		return { requestId };
	}

	async #handleResolveDecision(ws: BridgeSocket, frame: Record<string, unknown>): Promise<void> {
		const auth = this.#authorizeControl(frame);
		if (!auth) return;
		if (auth.reason) {
			this.#ack(ws, auth.requestId, false, auth.reason);
			return;
		}
		const handler = this.#handlers.onResolveDecision;
		if (!handler) {
			this.#ack(ws, auth.requestId, false, "not-supported");
			return;
		}
		const decisionId = typeof frame.decisionId === "string" ? frame.decisionId : undefined;
		const optionIndex = typeof frame.optionIndex === "number" ? frame.optionIndex : undefined;
		const label = typeof frame.label === "string" ? frame.label : undefined;
		const confirmToken = typeof frame.confirmToken === "string" ? frame.confirmToken : undefined;
		if (decisionId === undefined || optionIndex === undefined || label === undefined) {
			this.#ack(ws, auth.requestId, false, "malformed-request");
			return;
		}
		try {
			const result = await handler({
				decisionId,
				optionIndex,
				label,
				requestId: auth.requestId,
				source: "ui",
				...(confirmToken === undefined ? {} : { confirmToken }),
			});
			this.#ack(ws, auth.requestId, result.ok, result.reason, result.decision, result.confirmToken);
		} catch (cause) {
			logger.debug("live bridge: resolveDecision handler failed", { error: String(cause) });
			this.#ack(ws, auth.requestId, false, "handler-error");
		}
	}

	async #handleSetInterruptPolicy(ws: BridgeSocket, frame: Record<string, unknown>): Promise<void> {
		const auth = this.#authorizeControl(frame);
		if (!auth) return;
		if (auth.reason) {
			this.#ack(ws, auth.requestId, false, auth.reason);
			return;
		}
		const handler = this.#handlers.onSetInterruptPolicy;
		if (!handler) {
			this.#ack(ws, auth.requestId, false, "not-supported");
			return;
		}
		const policy = frame.policy === "doNotInterrupt" || frame.policy === "allow" ? frame.policy : undefined;
		if (!policy) {
			this.#ack(ws, auth.requestId, false, "malformed-request");
			return;
		}
		try {
			const result = await handler({ policy, requestId: auth.requestId });
			this.#ack(ws, auth.requestId, result.ok, result.reason);
		} catch (cause) {
			logger.debug("live bridge: setInterruptPolicy handler failed", { error: String(cause) });
			this.#ack(ws, auth.requestId, false, "handler-error");
		}
	}

	/**
	 * Handles an authenticated `attachFleet` control frame (concern 12): the sending socket
	 * becomes THE fleet executor (latest wins — a reattaching daemon replaces its dead
	 * predecessor), and an optional bounded `context` payload is forwarded to `onFleetContext`
	 * for the host to inject into the realtime session. Same token/session authorization as
	 * `resolveDecision` — a page that can merely reach the loopback port cannot become the fleet.
	 */
	#handleAttachFleet(ws: BridgeSocket, frame: Record<string, unknown>): void {
		const auth = this.#authorizeControl(frame);
		if (!auth) return;
		if (auth.reason) {
			this.#ack(ws, auth.requestId, false, auth.reason);
			return;
		}
		if (!this.#fleetEnabled) {
			this.#ack(ws, auth.requestId, false, "not-supported");
			return;
		}
		this.#fleetExecutor = ws;
		this.#ack(ws, auth.requestId, true);
		const context = typeof frame.context === "string" ? frame.context.trim() : "";
		if (context && this.#handlers.onFleetContext) {
			/* Head-keeping trim, unlike `trimCodePoints` (which keeps the TAIL for transcripts): a
			   context brief leads with its data-not-instructions framing header, which must survive
			   any truncation or the payload loses the very labeling that makes it safe to inject. */
			const bounded = Array.from(context).slice(0, MAX_FLEET_CONTEXT_POINTS).join("");
			try {
				this.#handlers.onFleetContext(bounded);
			} catch (cause) {
				logger.debug("live bridge: onFleetContext handler failed", { error: String(cause) });
			}
		}
	}

	/**
	 * Handles an authenticated `fleetResult` control frame — the executor's answer to one
	 * directed `fleetCall`. Only the currently-attached executor's results are accepted; a result
	 * for an unknown/already-settled call is acked `unknown-fleet-call` (it may simply have timed
	 * out first). The result payload is narrowed field-by-field — the daemon is authenticated, but
	 * a malformed shape still resolves the pending call as an honest failure rather than leaking
	 * an unchecked object into a tool result.
	 */
	#handleFleetResult(ws: BridgeSocket, frame: Record<string, unknown>): void {
		const auth = this.#authorizeControl(frame);
		if (!auth) return;
		if (auth.reason) {
			this.#ack(ws, auth.requestId, false, auth.reason);
			return;
		}
		if (ws !== this.#fleetExecutor) {
			this.#ack(ws, auth.requestId, false, "not-attached");
			return;
		}
		const fleetCallId = typeof frame.fleetCallId === "string" ? frame.fleetCallId : undefined;
		if (!fleetCallId) {
			this.#ack(ws, auth.requestId, false, "malformed-request");
			return;
		}
		const pending = this.#pendingFleetCalls.get(fleetCallId);
		if (!pending) {
			this.#ack(ws, auth.requestId, false, "unknown-fleet-call");
			return;
		}
		this.#pendingFleetCalls.delete(fleetCallId);
		clearTimeout(pending.timer);
		pending.resolve(narrowFleetResult(frame.result));
		this.#ack(ws, auth.requestId, true);
	}

	/**
	 * Relays one fleet tool call to the attached executor (concern 12) and resolves with its
	 * narrowed result. Never rejects: no executor, a closed bridge, a timeout, and a departed
	 * executor all resolve as `{status:"failed"}` with a named detail — the fleet tool turns that
	 * into an honest tool result rather than an exception in the delegated agent's turn.
	 */
	callFleetTool(
		tool: string,
		args: unknown,
		timeoutMs: number = DEFAULT_FLEET_CALL_TIMEOUT_MS,
	): Promise<FleetRelayResult> {
		if (this.#closed) return Promise.resolve({ status: "failed", detail: "the call has ended" });
		const executor = this.#fleetExecutor;
		if (!executor) return Promise.resolve({ status: "failed", detail: "no fleet executor is attached to this call" });
		this.#fleetCallSeq += 1;
		const fleetCallId = `fleet-${this.#fleetCallSeq}-${Math.random().toString(36).slice(2, 8)}`;
		return new Promise<FleetRelayResult>(resolve => {
			const timer = setTimeout(() => {
				this.#pendingFleetCalls.delete(fleetCallId);
				resolve({ status: "failed", detail: `the fleet executor did not answer within ${timeoutMs}ms` });
			}, timeoutMs);
			timer.unref?.();
			this.#pendingFleetCalls.set(fleetCallId, { resolve, timer });
			// Directed at the executor only, never broadcast — same discipline as controlAck.
			this.#sendTo(executor, { type: "fleetCall", fleetCallId, tool, args });
			// #sendTo drops a dead socket from #sockets but doesn't know about the executor role;
			// if the send failed the socket is gone from #sockets, so fail fast rather than waiting
			// out the whole timeout against a socket that will never answer.
			if (!this.#sockets.has(executor)) {
				const pending = this.#pendingFleetCalls.get(fleetCallId);
				if (pending) {
					this.#pendingFleetCalls.delete(fleetCallId);
					clearTimeout(pending.timer);
					if (this.#fleetExecutor === executor) this.#fleetExecutor = undefined;
					pending.resolve({ status: "failed", detail: "the fleet executor disconnected" });
				}
			}
		});
	}

	#failPendingFleetCalls(detail: string): void {
		for (const [, pending] of this.#pendingFleetCalls) {
			clearTimeout(pending.timer);
			pending.resolve({ status: "failed", detail });
		}
		this.#pendingFleetCalls.clear();
	}

	/** Directed, never broadcast: the ack answers the one socket that asked. */
	#ack(
		ws: BridgeSocket,
		requestId: string,
		ok: boolean,
		reason?: string,
		decision?: Decision,
		confirmToken?: string,
	): void {
		this.#sendTo(ws, {
			type: "controlAck",
			requestId,
			ok,
			...(reason === undefined ? {} : { reason }),
			...(decision === undefined ? {} : { decision }),
			...(confirmToken === undefined ? {} : { confirmToken }),
		});
	}

	/* Bounded and trimmed before it reaches the session: a control frame is the
	   one input here that a viewer fully controls, and it becomes a prompt. */
	#handleSteer(frame: { text?: unknown }): void {
		if (!this.#steeringEnabled || !this.#handlers.onSteer) return;
		if (typeof frame.text !== "string") return;
		const text = frame.text.trim();
		if (!text) return;
		this.#handlers.onSteer(Array.from(text).slice(0, MAX_STEER_POINTS).join(""));
	}

	#handleContext(frame: { text?: unknown }): void {
		if (!this.#steeringEnabled || !this.#handlers.onContext) return;
		if (typeof frame.text !== "string") return;
		const text = frame.text.trim();
		if (!text) return;
		this.#handlers.onContext(Array.from(text).slice(0, MAX_CONTEXT_POINTS).join(""));
	}

	#broadcast(body: Record<string, unknown>): void {
		if (this.#sockets.size === 0) {
			this.#seq += 1; // Keep the sequence monotonic even with no listeners.
			return;
		}
		const frame = this.#frame(body);
		for (const ws of [...this.#sockets]) {
			try {
				ws.send(frame);
			} catch {
				this.#sockets.delete(ws); // A dead socket must not stall the call.
			}
		}
	}

	#sendTo(ws: BridgeSocket, body: Record<string, unknown>): void {
		try {
			ws.send(this.#frame(body));
		} catch {
			this.#sockets.delete(ws);
		}
	}

	#frame(body: Record<string, unknown>): string {
		const seq = this.#seq;
		this.#seq += 1;
		return JSON.stringify({ v: PROTOCOL_VERSION, sessionId: this.#sessionId, seq, ...body });
	}
}
