/**
 * Scripted-provider harness for the Second Thought eval (ST-09).
 *
 * This is `test/second-thought/integration.test.ts`'s `createHarness` widened
 * into something an eval can drive: the branch can be made to settle at an
 * arbitrary speed (the single variable the mechanism's turn-end cost depends
 * on), the reflect payload is generated rather than fixed, and every provider
 * request is still recorded with its full `Context` so wire-level claims stay
 * checkable.
 *
 * Nothing here talks to a provider. See RESULTS.md for what that forecloses.
 */

import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ToolCall,
} from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { COMBINED_BRANCH_PROMPT } from "@oh-my-pi/pi-coding-agent/session/second-thought/atoms";
import { FOLD_BLOCK_OPEN } from "@oh-my-pi/pi-coding-agent/session/second-thought/fold";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

export { COMBINED_BRANCH_PROMPT, FOLD_BLOCK_OPEN };

/** One recorded provider request. */
export interface RecordedCall {
	readonly kind: "main" | "branch";
	readonly model: Model;
	readonly context: Context;
	/** JSON snapshot taken at call time, before anything downstream can mutate. */
	readonly messagesJson: string;
	readonly options: SimpleStreamOptions | undefined;
	/** ms since the script was created, so branch/main interleaving is visible. */
	readonly atMs: number;
	/** Raw `performance.now()`, comparable with timers taken outside the script. */
	readonly atAbsMs: number;
}

/** Long enough to clear `secondThought.minConditioningChars` (64 by default). */
export const THINKING =
	"The failing assertion mentions a frozen clock, so the fixture is probably " +
	"pinning Date.now and the helper under test reads it twice. I should read " +
	"the fixture before editing anything.";

/** Below the default `minConditioningChars`, to drive the conditioning skip. */
export const SHORT_THINKING = "hmm.";

export type Atom = "check" | "rehearse" | "recall" | "alternative";

/** Build a reflect payload with `perAtom` units of each listed atom. */
export function reflectText(atoms: readonly Atom[], perAtom = 1): string {
	const out: string[] = [];
	for (const atom of atoms) {
		for (let i = 0; i < perAtom; i++) {
			out.push(`<reflect type="${atom}">Unit ${i + 1} for ${atom}: the fixture may pin the clock in a beforeEach this file never runs.</reflect>`);
		}
	}
	return out.join("\n");
}

export const DEFAULT_REFLECT = reflectText(["check", "alternative"], 1);

function mainUsage(): AssistantMessage["usage"] {
	return {
		input: 11,
		output: 7,
		cacheRead: 3,
		cacheWrite: 5,
		totalTokens: 26,
		cost: zeroCost(),
	};
}

function zeroCost(): AssistantMessage["usage"]["cost"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function textOf(message: Message | undefined): string {
	if (!message || !("content" in message)) return "";
	const { content } = message as { content: unknown };
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => (block as { type?: string })?.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** A branch request is the one carrying the combined-atom prompt in its tail. */
function isBranchRequest(context: Context): boolean {
	return textOf(context.messages.at(-1)).includes(COMBINED_BRANCH_PROMPT);
}

export interface MainTurn {
	readonly thinking?: string;
	/** When set, the turn opens a tool call with these arguments. */
	readonly toolCall?: { name: string; args: Record<string, unknown> };
	/** A second tool call in the SAME stream, to probe fork-per-stream. */
	readonly secondToolCall?: { name: string; args: Record<string, unknown> };
	readonly text?: string;
}

export interface ScriptOptions {
	readonly turns: readonly MainTurn[];
	/** Branch reply text; `undefined` makes the branch hang until aborted. */
	readonly branchText?: string;
	/** Delay before the branch emits anything, in ms. */
	readonly branchDelayMs?: number;
	/** Branch usage reported to the ledger. */
	readonly branchUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface Script {
	readonly calls: RecordedCall[];
	readonly streamFn: (
		model: Model,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	mainCalls(): RecordedCall[];
	branchCalls(): RecordedCall[];
}

export function createScript(options: ScriptOptions): Script {
	const calls: RecordedCall[] = [];
	const t0 = performance.now();
	let mainIndex = 0;

	const streamFn = (model: Model, context: Context, streamOptions?: SimpleStreamOptions) => {
		const branch = isBranchRequest(context);
		calls.push({
			kind: branch ? "branch" : "main",
			model,
			context,
			messagesJson: JSON.stringify(context.messages),
			options: streamOptions,
			atMs: performance.now() - t0,
			atAbsMs: performance.now(),
		});
		const stream = new AssistantMessageEventStream();
		if (branch) {
			void driveBranch(stream, model, streamOptions, options);
			return stream;
		}
		const turn = options.turns[Math.min(mainIndex, options.turns.length - 1)]!;
		mainIndex++;
		void driveMain(stream, model, turn);
		return stream;
	};

	return {
		calls,
		streamFn,
		mainCalls: () => calls.filter(call => call.kind === "main"),
		branchCalls: () => calls.filter(call => call.kind === "branch"),
	};
}

async function driveMain(stream: AssistantMessageEventStream, model: Model, turn: MainTurn): Promise<void> {
	const content: AssistantMessage["content"] = [];
	const partial = (): AssistantMessage => ({
		role: "assistant",
		content: [...content],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: mainUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	});

	stream.push({ type: "start", partial: partial() });

	if (turn.thinking) {
		content.push({ type: "thinking", thinking: "" });
		const index = content.length - 1;
		stream.push({ type: "thinking_start", contentIndex: index, partial: partial() });
		content[index] = { type: "thinking", thinking: turn.thinking };
		stream.push({ type: "thinking_delta", contentIndex: index, delta: turn.thinking, partial: partial() });
		stream.push({ type: "thinking_end", contentIndex: index, content: turn.thinking, partial: partial() });
	}

	if (turn.text) {
		content.push({ type: "text", text: turn.text });
		const index = content.length - 1;
		stream.push({ type: "text_start", contentIndex: index, partial: partial() });
		stream.push({ type: "text_delta", contentIndex: index, delta: turn.text, partial: partial() });
		stream.push({ type: "text_end", contentIndex: index, content: turn.text, partial: partial() });
	}

	let stopReason: AssistantMessage["stopReason"] = "stop";
	for (const spec of [turn.toolCall, turn.secondToolCall]) {
		if (!spec) continue;
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `toolu_${spec.name}_${content.length}`,
			name: spec.name,
			arguments: spec.args,
		};
		content.push(toolCall);
		const index = content.length - 1;
		stream.push({ type: "toolcall_start", contentIndex: index, partial: partial() });
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: partial() });
		stopReason = "toolUse";
	}

	const message: AssistantMessage = { ...partial(), stopReason };
	stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message });
}

async function driveBranch(
	stream: AssistantMessageEventStream,
	model: Model,
	streamOptions: SimpleStreamOptions | undefined,
	script: ScriptOptions,
): Promise<void> {
	if (script.branchText === undefined) {
		streamOptions?.signal?.addEventListener("abort", () => stream.push({ type: "error", ...abortedError(model) }), {
			once: true,
		});
		return;
	}
	const delay = script.branchDelayMs ?? 0;
	if (delay > 0) {
		let aborted = false;
		streamOptions?.signal?.addEventListener(
			"abort",
			() => {
				aborted = true;
				stream.push({ type: "error", ...abortedError(model) });
			},
			{ once: true },
		);
		await Bun.sleep(delay);
		if (aborted) return;
	}
	const u = script.branchUsage ?? { input: 200, output: 40, cacheRead: 900, cacheWrite: 0 };
	const content: AssistantMessage["content"] = [{ type: "text", text: script.branchText }];
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: { ...u, totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite, cost: zeroCost() },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: { ...message, content: [] } });
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	stream.push({ type: "text_delta", contentIndex: 0, delta: script.branchText, partial: message });
	stream.push({ type: "text_end", contentIndex: 0, content: script.branchText, partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

function abortedError(model: Model): { reason: "aborted"; error: never } {
	return {
		reason: "aborted",
		error: { errorMessage: "aborted", usage: undefined, model: model.id },
	} as unknown as { reason: "aborted"; error: never };
}

// ---------------------------------------------------------------------------
// Session harness
// ---------------------------------------------------------------------------

/** Mutable so a scenario can make the tool result grow the context on purpose. */
let probeOutput = "probe ok";

/** Set the probe tool's payload; `tokens` is approximate (4 bytes/token). */
export function setProbeOutputTokens(tokens: number): void {
	probeOutput = tokens <= 2 ? "probe ok" : `probe ok\n${"lorem ipsum dolor sit amet ".repeat(Math.ceil((tokens * 4) / 27))}`;
}

/** Mutable so a scenario can hold the turn open while the branch is in flight. */
let probeDelayMs = 0;

export function setProbeDelayMs(ms: number): void {
	probeDelayMs = ms;
}

const PROBE_TOOL: AgentTool = {
	name: "probe",
	label: "Probe",
	description: "Test tool that always succeeds",
	parameters: type({}),
	execute: async () => {
		if (probeDelayMs > 0) await Bun.sleep(probeDelayMs);
		return { content: [{ type: "text" as const, text: probeOutput }] };
	},
};

export interface Harness {
	readonly session: AgentSession;
	readonly script: Script;
	readonly settings: Settings;
	readonly model: Model;
	dispose(): void;
}

let sharedAuth: AuthStorage | undefined;
const tempDirs: TempDir[] = [];

export async function createHarness(args: {
	script: ScriptOptions;
	settings?: Record<string, unknown>;
	agentKind?: "main" | "sub";
	/** Provider/model pair for the PRIMARY model; defaults to the bundled Anthropic Sonnet. */
	primary?: { provider: string; id: string };
	/** Omit the settings-aware side stream fn, as a bare host would. */
	withoutSideStreamFn?: boolean;
}): Promise<Harness> {
	const spec = args.primary ?? { provider: "anthropic", id: "claude-sonnet-4-5" };
	const model = getBundledModel(spec.provider, spec.id);
	if (!model) throw new Error(`Expected bundled model ${spec.provider}/${spec.id} to exist`);

	const tempDir = TempDir.createSync("st-eval");
	tempDirs.push(tempDir);
	const script = createScript(args.script);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"advisor.enabled": false,
		"todo.enabled": false,
		"title.refreshOnReplan": false,
		"secondThought.enabled": true,
		...args.settings,
	});
	const sessionManager = SessionManager.inMemory(tempDir.path());
	sharedAuth = sharedAuth ?? (await AuthStorage.create(":memory:"));
	sharedAuth.setRuntimeApiKey(spec.provider, "test-key");
	sharedAuth.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(sharedAuth, tempDir.join("models.yml"));

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["You are pi."], tools: [PROBE_TOOL], messages: [] },
		convertToLlm,
		streamFn: script.streamFn,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		agentKind: args.agentKind,
		toolRegistry: new Map<string, AgentTool>([[PROBE_TOOL.name, PROBE_TOOL]]),
		...(args.withoutSideStreamFn ? {} : { sideStreamFn: script.streamFn }),
	});

	return {
		session,
		script,
		settings,
		model,
		dispose: () => {
			try {
				session.dispose();
			} catch {
				// disposal races are not what this eval measures
			}
		},
	};
}

export function cleanupTempDirs(): void {
	for (const dir of tempDirs.splice(0)) {
		try {
			dir.removeSync();
		} catch {
			// best effort
		}
	}
}

/** The wire encoding of a request's messages, through the real Anthropic converter. */
export function encodeWire(messages: Message[], model: Model): unknown[] {
	return convertAnthropicMessages(structuredClone(messages), model as Model<"anthropic-messages">, false) as unknown[];
}

/** Messages in a request that carry the fold block. */
export function foldMessages(context: Context): Message[] {
	return context.messages.filter(message => textOf(message).includes(FOLD_BLOCK_OPEN));
}

// ---------------------------------------------------------------------------
// Small stats helpers
// ---------------------------------------------------------------------------

export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo]!;
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function mean(values: readonly number[]): number {
	if (values.length === 0) return Number.NaN;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

export function round(n: number, places = 2): number {
	const f = 10 ** places;
	return Math.round(n * f) / f;
}
