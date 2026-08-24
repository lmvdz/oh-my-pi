import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { Bridge, type RecordingMode, type ResolveDecisionRequest, type ResolveDecisionResult } from "../../live/bridge";
import {
	DEFAULT_IDLE_HANGUP_MS,
	LiveSessionController,
	type LiveSessionControllerOptions,
	type LiveTranscript,
	toResolveDecisionResult,
} from "../../live/controller";
import { LIVE_MODEL } from "../../live/protocol";
import { LiveVisualizer } from "../../live/visualizer";
import { vocalizer } from "../../tts/vocalizer";
import type { AssistantMessageComponent } from "../components/assistant-message";
import type { CustomEditor } from "../components/custom-editor";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";

const ANIMATION_INTERVAL_MS = 80;
type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionController;

const LIVE_MESSAGE_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Reads a recording mode from an environment string, falling back for anything unrecognized. */
function asRecordingMode(value: string | undefined): RecordingMode | undefined {
	return value === "full" || value === "tails" || value === "off" ? value : undefined;
}

/** Reads a positive millisecond duration from an environment string, or undefined for anything else. */
function asPositiveMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Owns the editor-replacing visualizer and realtime session lifecycle for `/live`. */
export class LiveCommandController {
	readonly #ctx: InteractiveModeContext;
	readonly #createSession: LiveSessionFactory | undefined;

	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#visualizer: LiveVisualizer | undefined;
	#bridge: Bridge | undefined;
	#detachedEditor: CustomEditor | undefined;
	#animationInterval: NodeJS.Timeout | undefined;
	#previousShowHardwareCursor: boolean | undefined;
	#previousUseTerminalCursor: boolean | undefined;
	#resumeVocalizer: (() => void) | undefined;
	#assistantTranscriptComponent: AssistantMessageComponent | undefined;
	#assistantTranscriptTurn = 0;
	#assistantTranscriptStartedAt = 0;

	constructor(ctx: InteractiveModeContext, createSession?: LiveSessionFactory) {
		this.#ctx = ctx;
		this.#createSession = createSession;
	}

	/** Whether a live session is connected, connecting, or closing. */
	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined;
	}

	/** Start live mode, or stop the currently active session. */
	async handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		if (this.#settling) await this.#settling;
		await this.#start();
	}

	/** Stop the active live session and restore the editor. */
	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, errorFrom(cause));
		} finally {
			this.#finish(session);
		}
	}

	/** Release UI resources during synchronous InteractiveMode teardown. */
	dispose(): void {
		const session = this.#session;
		if (session) {
			this.#finish(session);
			void session.stop().catch(cause => {
				logger.debug("Live session teardown failed", { error: errorFrom(cause).message });
			});
		} else {
			this.#restoreEditor();
		}
	}

	async #start(): Promise<void> {
		this.#assistantTranscriptTurn = 0;
		this.#assistantTranscriptStartedAt = 0;
		const onStop = (): void => {
			void this.stop().catch(cause => this.#ctx.showError(errorFrom(cause).message));
		};
		const onToggleMute = (): void => {
			this.#session?.toggleMute();
			this.#bridge?.publishMuted(this.#session?.muted ?? false);
		};
		/* Typed steering from an attached viewer. The TUI has its own editor for
		   this; the bridge is how a browser gets the same reach, and it is gated
		   on the bridge side (see LiveBridgeHandlers.onSteer). */
		const onSteer = (text: string): void => {
			this.#session?.steer(text);
		};
		/* A broker-spawned session gets these from its env; a bare terminal `/live`
		   has none of them, and every one is optional — no journal, no per-call
		   token, no origin allowlist, exactly today's behavior. */
		const callId = process.env.OMP_LIVE_CALL_ID?.trim() || undefined;
		const journalPath = process.env.OMP_LIVE_JOURNAL_PATH?.trim() || undefined;
		const recordingMode = asRecordingMode(process.env.OMP_LIVE_RECORDING_MODE);
		const controlToken = process.env.OMP_LIVE_CONTROL_TOKEN?.trim() || undefined;
		/* The recorded V1 default (concern 05's Decisions: 10-minute idle hangup,
		   spoken warning at ~9 minutes) is applied HERE, not inside
		   LiveSessionController, so a bare unit test that constructs that class
		   directly never gets an idle timer it didn't ask for. Env-overridable for
		   an operator who wants a different cadence without a code change. */
		const idleHangupMs = asPositiveMs(process.env.OMP_LIVE_IDLE_HANGUP_MS) ?? DEFAULT_IDLE_HANGUP_MS;
		const rawIdleWarningMs = asPositiveMs(process.env.OMP_LIVE_IDLE_WARNING_MS);
		// An operator-configured warning >= the hangup duration would silently
		// skip the spoken warning entirely: the hangup timer fires first, calls
		// stop(), and the later warning timer's own #stopped guard swallows it —
		// no warning, straight to hangup. Clamp to 90% of the hangup so the
		// warning always front-runs by construction (matching this class's own
		// unclamped default ratio for when no override is given at all).
		const idleWarningMs =
			rawIdleWarningMs === undefined ? undefined : Math.min(rawIdleWarningMs, Math.round(idleHangupMs * 0.9));
		const onResolveDecision = (request: ResolveDecisionRequest) => this.#resolveDecision(request);
		const onSetInterruptPolicy = (request: { policy: "allow" | "doNotInterrupt"; requestId: string }) => {
			this.#session?.setInterruptPolicy(request.policy);
			return { ok: true };
		};
		const visualizer = new LiveVisualizer({
			onStop,
			onToggleMute,
			stopKeys: this.#ctx.keybindings.getKeys("app.live.toggle"),
		});
		this.#mountVisualizer(visualizer);

		// Tee presentation state to any external surface. A bridge that cannot bind
		// is dropped: `/live` must behave identically with no viewer attached.
		const bridge = new Bridge(
			{ onStop, onToggleMute, onSteer, onResolveDecision, onSetInterruptPolicy },
			{ callId, recordingMode, controlToken },
		);
		this.#bridge = bridge.open() ? bridge : undefined;

		let session: LiveSessionController;
		const options: LiveSessionControllerOptions = {
			session: this.#ctx.session,
			extractAssistantText: message => this.#ctx.extractAssistantText(message),
			voice: this.#ctx.settings.get("live.voice"),
			callId,
			journalPath,
			recordingMode,
			idleHangupMs,
			...(idleWarningMs === undefined ? {} : { idleWarningMs }),
			callbacks: {
				onPhase: phase => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setPhase(phase);
					this.#bridge?.publishPhase(phase);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onLevels: (input, output) => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setInputLevel(input);
					// The visualizer renders only the microphone; the bridge forwards the
					// speaker level too, so an external surface can react while the
					// assistant is speaking.
					this.#bridge?.publishLevels(input, output);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onTranscript: transcript => {
					if (this.#visualizer !== visualizer) return;
					this.#bridge?.publishTranscript(transcript);
					if (!transcript) {
						visualizer.clearTranscript();
						this.#ctx.ui.requestComponentRender(visualizer);
					} else if (transcript.role === "user") {
						visualizer.setTranscript(transcript.text);
						this.#ctx.ui.requestComponentRender(visualizer);
					} else {
						this.#presentAssistantTranscript(transcript);
					}
				},
				/* Viewer-only channels. The terminal visualizer has the TUI's own tool
				   rendering right below it, so mirroring the churn there would double
				   it; an attached surface has no other way to see the work happen. */
				onToolActivity: activity => {
					this.#bridge?.publishActivity(activity);
				},
				onAgents: agents => {
					this.#bridge?.publishAgents(agents);
				},
				onPlan: plan => {
					this.#bridge?.publishPlan(plan);
				},
				onAgentMessage: message => {
					this.#bridge?.publishAgentMessage(message);
				},
				onDecision: decision => {
					this.#bridge?.publishDecision(decision);
				},
				onInterruptPolicy: policy => {
					this.#bridge?.publishInterruptPolicy(policy);
				},
				onTerminal: (error, reason) => {
					this.#bridge?.close(error, reason);
					this.#bridge = undefined;
					this.#finish(session, error);
				},
			},
		};
		session = this.#createSession ? this.#createSession(options) : new LiveSessionController(options);
		this.#session = session;

		try {
			await session.start();
		} catch (cause) {
			if (this.#session === session) {
				await session.stop();
				this.#finish(session, errorFrom(cause));
			}
		}
	}

	/**
	 * Routes an authorized `resolveDecision` control frame to the session's
	 * arbiter — a confirm token means this is the second, confirming act, so it
	 * goes through `confirmDecision` rather than `resolveDecision` again.
	 */
	async #resolveDecision(request: ResolveDecisionRequest): Promise<ResolveDecisionResult> {
		const session = this.#session;
		if (!session) return { ok: false, reason: "not-found" };
		const result =
			request.confirmToken === undefined
				? await session.resolveDecision({
						decisionId: request.decisionId,
						optionIndex: request.optionIndex,
						label: request.label,
						source: request.source,
						requestId: request.requestId,
					})
				: await session.confirmDecision({
						decisionId: request.decisionId,
						confirmToken: request.confirmToken,
						requestId: request.requestId,
					});
		return toResolveDecisionResult(result);
	}

	#presentAssistantTranscript(transcript: LiveTranscript): void {
		if (
			transcript.turn < this.#assistantTranscriptTurn ||
			(transcript.turn === this.#assistantTranscriptTurn && !this.#assistantTranscriptComponent)
		) {
			return;
		}
		if (transcript.turn > this.#assistantTranscriptTurn) {
			this.#finalizeAssistantTranscript();
			this.#assistantTranscriptTurn = transcript.turn;
		}

		let component = this.#assistantTranscriptComponent;
		if (!component) {
			component = createAssistantMessageComponent(this.#ctx);
			component.setTextColorTransform(text => theme.fg("borderAccent", text));
			this.#assistantTranscriptComponent = component;
			this.#assistantTranscriptStartedAt = Date.now();
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: transcript.text }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: LIVE_MODEL,
			usage: { ...LIVE_MESSAGE_USAGE },
			stopReason: "stop",
			timestamp: this.#assistantTranscriptStartedAt,
		};
		component.updateContent(message, { transient: !transcript.final });
		if (transcript.final) {
			component.markTranscriptBlockFinalized();
			this.#assistantTranscriptComponent = undefined;
			this.#assistantTranscriptStartedAt = 0;
		}
		if (!this.#ctx.chatContainer.children.includes(component)) {
			this.#ctx.present(component);
		} else {
			this.#ctx.ui.requestComponentRender(component);
		}
	}

	#finalizeAssistantTranscript(): void {
		const component = this.#assistantTranscriptComponent;
		if (!component) return;
		component.markTranscriptBlockFinalized();
		this.#assistantTranscriptComponent = undefined;
		this.#assistantTranscriptStartedAt = 0;
		this.#ctx.ui.requestComponentRender(component);
	}

	#mountVisualizer(visualizer: LiveVisualizer): void {
		this.#visualizer = visualizer;
		this.#detachedEditor = this.#ctx.editor;
		this.#previousShowHardwareCursor = this.#ctx.ui.getShowHardwareCursor();
		this.#previousUseTerminalCursor = this.#ctx.editor.getUseTerminalCursor();
		this.#ctx.ui.setShowHardwareCursor(false);
		this.#ctx.editor.setUseTerminalCursor(false);
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(visualizer);
		this.#ctx.ui.setFocus(visualizer);
		this.#resumeVocalizer = vocalizer.suspend();
		let frame = 0;
		this.#animationInterval = setInterval(() => {
			if (this.#visualizer !== visualizer) return;
			frame += 1;
			visualizer.setFrame(frame);
			this.#ctx.ui.requestComponentRender(visualizer);
		}, ANIMATION_INTERVAL_MS);
		this.#ctx.ui.requestRender();
	}

	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#restoreEditor();
		if (error) this.#ctx.showError(error.message);
		const settling = session.stop().catch(cause => {
			logger.debug("Live session cleanup failed", { error: errorFrom(cause).message });
		});
		this.#settling = settling;
		void settling.finally(() => {
			if (this.#settling === settling) this.#settling = undefined;
		});
	}

	#restoreEditor(): void {
		this.#finalizeAssistantTranscript();
		if (this.#animationInterval) {
			clearInterval(this.#animationInterval);
			this.#animationInterval = undefined;
		}
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
		// Releases the listening socket on every teardown path, not just onTerminal.
		this.#bridge?.close();
		this.#bridge = undefined;
		const editor = this.#detachedEditor;
		this.#detachedEditor = undefined;
		this.#visualizer = undefined;
		if (!editor) return;
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(editor);
		if (this.#previousShowHardwareCursor !== undefined) {
			this.#ctx.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
		}
		if (this.#previousUseTerminalCursor !== undefined) {
			editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
		}
		this.#previousShowHardwareCursor = undefined;
		this.#previousUseTerminalCursor = undefined;
		this.#ctx.ui.setFocus(editor);
		this.#ctx.ui.requestRender();
	}
}
