/**
 * Run a realtime voice session with no terminal UI, teeing its state to a
 * loopback bridge.
 *
 * `/live` is a slash command inside interactive mode: it swaps the TUI editor
 * for a visualizer, so it needs a human at a terminal and cannot be reached by
 * `-p/--print`. This subcommand is the same session with the terminal removed.
 * `LiveSessionController` was already decoupled from the UI — it takes a
 * `LiveSessionCallbacks` set — so the only real work here is bootstrapping an
 * `AgentSession` outside interactive mode, which `createAgentSession()` does.
 *
 * Nothing about the transport, credentials or attestation path changes: this is
 * the same in-process `CodexLiveTransport` the TUI drives, reached through the
 * same authorized provider credentials. The only thing removed is the terminal.
 *
 * Unlike the TUI, a bridge that cannot bind is FATAL here. Under `/live` the
 * bridge is a secondary surface and dropping it silently is correct — the
 * visualizer is still there. Headless, the bridge is the *only* surface, so a
 * session nobody can observe or stop is worse than a clear failure to start.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getProjectDir, logger, postmortem } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { Bridge, type RecordingMode, type ResolveDecisionRequest } from "../live/bridge";
import { LiveSessionController, toResolveDecisionResult } from "../live/controller";
import { createFleetToolPort, createFleetTools } from "../live/fleet-tools";
import { LiveJournal } from "../live/journal";
import { createAgentSession } from "../sdk";
import { getLatestTodoPhasesFromEntries } from "../tools/todo";

/**
 * Resolves what the operator meant by `--resume`.
 *
 * Three forms, in the order a person would try them: an actual path, `latest`
 * for "the one I was just in", or any fragment of a session id. Sessions are
 * per-project directories of `<timestamp>_<uuid>.jsonl`, and the timestamp
 * prefix sorts chronologically, so "newest" is the last name in sorted order —
 * no stat call per candidate.
 */
function resolveResumeTarget(request: string, sessionDir: string, ownFile?: string): string | undefined {
	const wanted = request.trim();
	if (!wanted) return undefined;
	if (wanted.endsWith(".jsonl") && fs.existsSync(wanted)) return path.resolve(wanted);

	let names: string[];
	try {
		/* Exclude THIS session's own file. `createAgentSession()` has already
		   created it and its timestamp sorts newest, so "latest" would resolve to
		   the empty session we are sitting in and resume it into itself — which
		   looks exactly like a resume that silently restored nothing. */
		const own = ownFile ? path.basename(ownFile) : undefined;
		names = fs
			.readdirSync(sessionDir)
			.filter(name => name.endsWith(".jsonl") && name !== own)
			.sort();
	} catch {
		return undefined;
	}
	if (names.length === 0) return undefined;
	if (wanted === "latest") return path.join(sessionDir, names[names.length - 1] as string);
	const match = names.filter(name => name.includes(wanted)).pop();
	return match ? path.join(sessionDir, match) : undefined;
}

/**
 * Visible assistant text, without the UI's presentation rules.
 *
 * Only `text` blocks are taken. That is not merely a simplification: thinking
 * blocks are hidden reasoning and tool blocks are raw tool output, and neither
 * belongs on a wire a browser is reading.
 */
function plainAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

/** Reads a recording mode from an environment string, falling back for anything unrecognized. */
function asRecordingMode(value: string | undefined): RecordingMode | undefined {
	return value === "full" || value === "tails" || value === "off" ? value : undefined;
}

/** Reads a boolean env override the same way `Flags.boolean` reads a CLI flag: any non-empty value but "0"/"false" is on. */
function asEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value !== "0" && value.toLowerCase() !== "false";
}

export default class Live extends Command {
	static description = "Run a realtime voice session headlessly, teeing its state to a loopback bridge";

	static flags = {
		"bridge-port": Flags.integer({
			description: "Loopback port for the state bridge (default: OMP_LIVE_BRIDGE_PORT, else 8788)",
		}),
		"bridge-host": Flags.string({
			description: "Interface to bind the bridge to (default: 127.0.0.1)",
		}),
		voice: Flags.string({ description: "Realtime output voice" }),
		resume: Flags.string({
			description: 'Resume a session: "latest", a session id/prefix, or a path to its .jsonl',
		}),
		"call-id": Flags.string({
			description: "Broker-minted call identity (default: OMP_LIVE_CALL_ID, else a generated one)",
		}),
		"journal-path": Flags.string({
			description: "Broker-minted per-call journal path (default: OMP_LIVE_JOURNAL_PATH, else no journal)",
		}),
		"control-token": Flags.string({
			description:
				"Per-call token the daemon holds for resolve/interrupt controls (default: OMP_LIVE_CONTROL_TOKEN)",
		}),
		"recording-mode": Flags.string({
			description: "Transcript retention: full | tails | off (default: OMP_LIVE_RECORDING_MODE, else tails)",
		}),
		"no-local-audio": Flags.boolean({
			description:
				"Never open a local microphone or rely on the transport's own audio device (default: OMP_LIVE_NO_LOCAL_AUDIO). " +
				"Mic PCM arrives, and speaker PCM leaves, over the bridge instead — see concern 09 (browser-audio-transport).",
		}),
	};

	static examples = ["omp live", "omp live --bridge-port 8790"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Live);

		/* Bridge reads its port and host from the environment so that the
		   TUI and this command configure it the same way. Flags win over an
		   inherited value; a broker that spawns us can use either. */
		const port = flags["bridge-port"];
		if (port !== undefined) {
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				process.stderr.write(chalk.red(`error: --bridge-port must be between 1 and 65535\n`));
				process.exit(1);
			}
			process.env.OMP_LIVE_BRIDGE_PORT = String(port);
		}
		if (flags["bridge-host"] !== undefined) process.env.OMP_LIVE_BRIDGE_HOST = flags["bridge-host"];
		if (flags["call-id"] !== undefined) process.env.OMP_LIVE_CALL_ID = flags["call-id"];
		if (flags["journal-path"] !== undefined) process.env.OMP_LIVE_JOURNAL_PATH = flags["journal-path"];
		if (flags["control-token"] !== undefined) process.env.OMP_LIVE_CONTROL_TOKEN = flags["control-token"];
		if (flags["recording-mode"] !== undefined) process.env.OMP_LIVE_RECORDING_MODE = flags["recording-mode"];

		/* A single read, shared by the bridge and the controller: the journal and
		   the presentation surface it tees to must correlate under the SAME call
		   identity, or a daemon reading one cannot line it up with the other. */
		const callId = process.env.OMP_LIVE_CALL_ID?.trim() || undefined;
		const journalPath = process.env.OMP_LIVE_JOURNAL_PATH?.trim() || undefined;
		const recordingMode = asRecordingMode(process.env.OMP_LIVE_RECORDING_MODE);
		const controlToken = process.env.OMP_LIVE_CONTROL_TOKEN?.trim() || undefined;
		/* Concern 09 (browser-audio-transport): the flag wins over the env default,
		   same precedence every other flag above already uses. Audio-less mode
		   never opens a local microphone (see `LiveSessionController`'s
		   `noLocalAudio` doc) and never relies on the transport's own audio
		   device — mic PCM arrives, and speaker PCM leaves, through the bridge. */
		const noLocalAudio = flags["no-local-audio"] ?? asEnvFlag(process.env.OMP_LIVE_NO_LOCAL_AUDIO);

		await Settings.init({ cwd: getProjectDir() });

		/* One call identity shared by the journal, the bridge, and the controller — computed HERE
		   (mirroring the controller's own fallback) because the fleet tool surface journals under
		   the same identity and all three must agree, or a daemon reading the journal could not
		   line it up with the bridge (concern 12). */
		const effectiveCallId = callId ?? `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		/* The session's ONE durable journal, shared by the controller (decisions, transcripts,
		   terminal) and the fleet tools (fleet-action records) — two journals over one path would
		   interleave two independent seq counters into the same file. */
		const journal = new LiveJournal({ path: journalPath, sessionId: effectiveCallId });

		/* The fleet tool surface (concern 12) must exist BEFORE the session is created — custom
		   tools are registered at construction — but its dependencies (bridge, controller, journal)
		   come up afterwards, so the port is late-bound and wired below. A tool call arriving
		   before then fails honestly ("not connected yet") rather than throwing. */
		const fleetPort = createFleetToolPort();

		/* Host environment text (Stateroom and the like): appended to the realtime
		   prompt AND to the delegated session's system prompt, so both halves of the
		   one assistant know what surface they are attached to. Data, not policy. */
		const readEnvText = (name: string): string | undefined => {
			const file = process.env[`${name}_FILE`];
			if (file) {
				try {
					return fs.readFileSync(file, "utf8");
				} catch {
					process.stderr.write(chalk.yellow(`warn: ${name}_FILE unreadable: ${file}\n`));
				}
			}
			return process.env[name] || undefined;
		};
		const extraInstructions = readEnvText("OMP_LIVE_EXTRA_INSTRUCTIONS");
		const appendSystemPrompt = readEnvText("OMP_LIVE_APPEND_SYSTEM_PROMPT");
		const { session } = await createAgentSession({
			customTools: createFleetTools(fleetPort),
			...(appendSystemPrompt ? { appendSystemPrompt } : {}),
		});

		/* Resume before the call opens, not after.
		   A live session is a voice surface over an AgentSession; ending the call
		   kills the process but the transcript is already on disk, so "resumable"
		   just means pointing a new call at the old file. Doing it before the
		   controller starts means the first thing the operator says lands in a
		   session that already knows what happened. */
		if (flags.resume) {
			const ownFile = session.sessionManager.getSessionFile() ?? "";
			const target = resolveResumeTarget(flags.resume, path.dirname(ownFile), ownFile);
			if (!target) {
				process.stderr.write(chalk.red(`error: no session matching "${flags.resume}"\n`));
				await session.dispose?.();
				process.exit(1);
			}
			const switched = await session.switchSession(target);
			if (!switched) {
				process.stderr.write(chalk.red(`error: could not resume ${target}\n`));
				await session.dispose?.();
				process.exit(1);
			}
			process.stdout.write(chalk.dim(`resumed ${path.basename(target)}\n`));
		}

		let controller: LiveSessionController | undefined;
		const onStop = (): void => {
			void controller?.stop().catch(cause => {
				logger.debug("Headless live stop failed", { error: cause instanceof Error ? cause.message : cause });
			});
		};
		const onToggleMute = (): void => {
			controller?.toggleMute();
			bridge.publishMuted(controller?.muted ?? false);
		};

		/* Typed steering from an attached viewer, on the same path a spoken
		   delegation takes. Gated inside the bridge — see BridgeHandlers. */
		const onSteer = (text: string): void => {
			controller?.steer(text);
		};
		/* Context from a viewer: grounding for the realtime model, no turn. */
		const onContext = (text: string): void => {
			controller?.pushFleetContext(text);
		};
		const onResolveDecision = async (request: ResolveDecisionRequest) => {
			if (!controller) return { ok: false, reason: "not-found" };
			const result =
				request.confirmToken === undefined
					? await controller.resolveDecision({
							decisionId: request.decisionId,
							optionIndex: request.optionIndex,
							label: request.label,
							source: request.source,
							requestId: request.requestId,
						})
					: await controller.confirmDecision({
							decisionId: request.decisionId,
							confirmToken: request.confirmToken,
							requestId: request.requestId,
						});
			return toResolveDecisionResult(result);
		};
		const onSetInterruptPolicy = (request: { policy: "allow" | "doNotInterrupt"; requestId: string }) => {
			controller?.setInterruptPolicy(request.policy);
			return { ok: true };
		};
		/* Concern 09 (browser-audio-transport): a browser's mic frames arrive here
		   and go straight into the transport on `controller`'s own audio path —
		   `pushRemoteAudio` is itself a no-op unless the controller below was built
		   with `noLocalAudio: true`, so wiring this handler unconditionally is
		   harmless in device-audio mode. Only WIRING it (rather than passing
		   `undefined`) is what flips `hello.audio.transport` on for a viewer,
		   which is why it is gated here on the same flag that will construct the
		   controller in audio-less mode. */
		const onMicAudio = noLocalAudio
			? (samples: Float32Array): void => controller?.pushRemoteAudio(samples)
			: undefined;

		const bridge = new Bridge(
			{
				onStop,
				onToggleMute,
				onSteer,
				onContext,
				onResolveDecision,
				onSetInterruptPolicy,
				...(onMicAudio ? { onMicAudio } : {}),
				/* Concern 12: the attaching daemon's room projection (roster, states, open
				   decisions) — injected into the realtime session as grounding data. The
				   controller buffers a brief that arrives before the session is up. */
				onFleetContext: text => controller?.pushFleetContext(text),
			},
			/* fleetEnabled: the headless entry is the ONE host that registers fleet tools (a bare
			   TUI /live has no daemon to attach), so it is the one that advertises canFleet. */
			{ callId: effectiveCallId, recordingMode, controlToken, fleetEnabled: true },
		);
		if (!bridge.open()) {
			process.stderr.write(
				chalk.red(
					`error: could not bind the state bridge on ${process.env.OMP_LIVE_BRIDGE_HOST ?? "127.0.0.1"}:` +
						`${process.env.OMP_LIVE_BRIDGE_PORT ?? "8788"}\n`,
				) + chalk.dim("A headless live session has no other surface — refusing to start one nobody can see.\n"),
			);
			await session.dispose?.();
			process.exit(1);
		}

		/* A resumed session already has a plan; publish it immediately.
		   Bridge state starts empty on every call, so without this a resume looks
		   like it restored nothing — the agent remembers the run but the screen
		   shows "No plan. Nothing has been asked yet." until the next todo write. */
		if (flags.resume) {
			try {
				const phases = getLatestTodoPhasesFromEntries(session.sessionManager.getBranch());
				if (phases.length > 0) bridge.publishPlan(phases);
			} catch (cause) {
				logger.debug("Could not republish a resumed plan", { error: String(cause) });
			}
		}

		/* Resolved by the terminal callback or by a signal. `ended` guards against
		   a second resolve: onTerminal and SIGINT can both fire for one shutdown. */
		let ended = false;
		let exitCode = 0;
		let settle: () => void = () => {};
		const finished = new Promise<void>(resolve => {
			settle = () => {
				if (ended) return;
				ended = true;
				resolve();
			};
		});

		controller = new LiveSessionController({
			session,
			extractAssistantText: plainAssistantText,
			voice: flags.voice,
			extraInstructions,
			callId: effectiveCallId,
			journal,
			recordingMode,
			noLocalAudio,
			callbacks: {
				onPhase: phase => bridge.publishPhase(phase),
				onLevels: (input, output) => bridge.publishLevels(input, output),
				onTranscript: transcript => bridge.publishTranscript(transcript),
				/* Audio-less mode's speaker-out path (concern 09): decoded output audio
				   reaches the bridge as a binary frame instead of the transport's own
				   native media sink. `onOutputAudio` is only ever invoked when
				   `noLocalAudio` is set (see LiveSessionController), so wiring it here
				   unconditionally changes nothing for a device-audio session. */
				onOutputAudio: bytes => bridge.publishOutputAudio(bytes),
				/* A headless session has NO other surface: there is no TUI beside it
				   rendering the work. Everything the viewer needs about the delegated
				   run has to come through here, so this path must publish strictly
				   more than the TUI's bridge, never less. */
				onToolActivity: activity => bridge.publishActivity(activity),
				onAgents: agents => bridge.publishAgents(agents),
				onPlan: plan => bridge.publishPlan(plan),
				onAgentMessage: message => bridge.publishAgentMessage(message),
				onDecision: decision => bridge.publishDecision(decision),
				onInterruptPolicy: policy => bridge.publishInterruptPolicy(policy),
				onTerminal: error => {
					/* Publish the cause before tearing the socket down. A viewer that
					   only sees the close has no way to explain why the call ended,
					   which is the one moment the reason matters most. */
					bridge.close(error);
					if (error) {
						exitCode = 1;
						process.stderr.write(chalk.red(`live session ended: ${error.message}\n`));
					}
					settle();
				},
			},
		});

		/* Concern 12: wire the fleet tool surface now that every dependency exists — relay rides
		   the bridge's directed fleetCall/fleetResult round trip to the attached daemon;
		   mintDecision routes through the controller to the arbiter (the destructive-class
		   deferral); journal is the session's own shared journal (write-before-act). */
		const liveController = controller;
		fleetPort.wire({
			relay: (tool, args) => bridge.callFleetTool(tool, args),
			mintDecision: input => liveController.mintDecision(input),
			journal: record => journal.append(record),
		});

		/* Ctrl-C is the only stop control a headless session has locally; the
		   bridge's own stop control covers the remote case. Both route through
		   controller.stop() so the provider sees a clean teardown either way. */
		const onSignal = (): void => {
			if (ended) {
				settle();
				return;
			}
			void controller?.stop().catch(() => {});
			// If the session never reaches a terminal callback, do not hang forever.
			setTimeout(settle, 4000).unref?.();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);

		try {
			await controller.start();
			process.stdout.write(
				chalk.green("live session up") +
					chalk.dim(
						` — bridge on ${process.env.OMP_LIVE_BRIDGE_HOST ?? "127.0.0.1"}:` +
							`${process.env.OMP_LIVE_BRIDGE_PORT ?? "8788"}` +
							(noLocalAudio ? " (audio-less: no local microphone or speaker device)\n" : "\n"),
					),
			);
			await finished;
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			process.stderr.write(chalk.red(`error: ${message}\n`));
			exitCode = 1;
			await controller.stop().catch(() => {});
			bridge.close(cause instanceof Error ? cause : new Error(message));
		}

		/* Same exit discipline as `omp commit`: an AgentSession leaves keep-alive
		   sockets and armed timers that pin the event loop well past the point the
		   work is done, so returning from run() is not enough to reach the shell. */
		await postmortem.quit(exitCode);
	}
}
