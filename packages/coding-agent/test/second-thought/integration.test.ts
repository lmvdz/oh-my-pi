/**
 * END-TO-END acceptance for Second Thought, driven through the REAL
 * `AgentSession` — not the stub host the coordinator's own suite uses.
 *
 * The point of this file is the set of claims a module-level test structurally
 * cannot make:
 *
 * - the fold reaches call N+1 of the SAME run, as the FINAL message on the wire
 *   (the fix for the draft's fatal `appendMessage`-invisible-to-live-run flaw);
 * - the branch request's encoded prefix is byte-identical to the main call's
 *   (the cache acceptance gate — a live `cache_read_input_tokens` assertion
 *   needs a paid Anthropic call and is out of scope, so this asserts the wire
 *   shape that is its precondition);
 * - a branch call leaves the primary session's stats and provider-header ingest
 *   completely untouched;
 * - every abort-shaped exit tears the branch down and delivers no fold;
 * - with the feature off, the session is INDISTINGUISHABLE from one that never
 *   had the feature — including at the pre-model abort gate, whose behaviour
 *   changes if a `beforeModelCall` is merely registered;
 * - a branch's provider-session state can never mutate the primary's;
 * - a secret the branch saw as a placeholder reaches the wire as a placeholder,
 *   even though the harvest is deobfuscated in between;
 * - the harvest completes before the advisors' catch-up, with advisors live.
 *
 * The provider is scripted at the `streamFn` boundary, so every request the
 * session makes — main calls and branch calls alike — is recorded with its full
 * `Context` and `SimpleStreamOptions`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderResponseMetadata,
	SimpleStreamOptions,
	ToolCall,
} from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { obfuscateProviderContext } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { COMBINED_BRANCH_PROMPT } from "@oh-my-pi/pi-coding-agent/session/second-thought/atoms";
import { BRANCH_SIDE_ROLE } from "@oh-my-pi/pi-coding-agent/session/second-thought/branch-call";
import {
	FOLD_BLOCK_OPEN,
	SECOND_THOUGHT_FOLD_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/second-thought/fold";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

/** One recorded provider request. */
interface RecordedCall {
	readonly kind: "main" | "branch";
	readonly model: Model;
	/** Live context object handed to the stream fn. */
	readonly context: Context;
	/** JSON snapshot taken at call time, before anything downstream can mutate. */
	readonly messagesJson: string;
	readonly options: SimpleStreamOptions | undefined;
}

/** Long enough to clear `secondThought.minConditioningChars` (64). */
const THINKING =
	"The failing assertion mentions a frozen clock, so the fixture is probably " +
	"pinning Date.now and the helper under test reads it twice. I should read " +
	"the fixture before editing anything.";

const REFLECT_TEXT =
	'<reflect type="check">The fixture may pin the clock in a beforeEach that this file never runs.</reflect>\n' +
	'<reflect type="alternative">Reading the helper first would confirm the double read.</reflect>';

function usage(): AssistantMessage["usage"] {
	return {
		input: 11,
		output: 7,
		cacheRead: 3,
		cacheWrite: 5,
		totalTokens: 26,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textOf(message: Message | undefined): string {
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

interface MainTurn {
	/** Thinking emitted before the first tool call. */
	readonly thinking?: string;
	/** When set, the turn opens a tool call with these arguments. */
	readonly toolCall?: { name: string; args: Record<string, unknown> };
	readonly text?: string;
	/** Invoked once the tool call has been announced, before the turn completes. */
	readonly afterToolCallStart?: () => void | Promise<void>;
}

interface ScriptOptions {
	readonly turns: readonly MainTurn[];
	/** Branch reply text; `undefined` makes the branch hang until aborted. */
	readonly branchText?: string;
	/** Headers the BRANCH response reports, to prove they never reach the session. */
	readonly branchResponseHeaders?: Record<string, string>;
	/** Headers the MAIN response reports, to prove the session still ingests its own. */
	readonly mainResponseHeaders?: Record<string, string>;
}

interface Script {
	readonly calls: RecordedCall[];
	readonly streamFn: (
		model: Model,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	mainCalls(): RecordedCall[];
	branchCalls(): RecordedCall[];
	/** Resolves once at least `n` branch calls have been observed. */
	waitForBranchCalls(n: number, timeoutMs?: number): Promise<void>;
}

function metadata(headers: Record<string, string>): ProviderResponseMetadata {
	return { status: 200, headers, requestId: undefined } as unknown as ProviderResponseMetadata;
}

function createScript(options: ScriptOptions): Script {
	const calls: RecordedCall[] = [];
	let mainIndex = 0;
	const branchWaiters: { need: number; resolve: () => void }[] = [];

	const noteCall = () => {
		for (let i = branchWaiters.length - 1; i >= 0; i--) {
			const waiter = branchWaiters[i]!;
			if (calls.filter(call => call.kind === "branch").length >= waiter.need) {
				branchWaiters.splice(i, 1);
				waiter.resolve();
			}
		}
	};

	const streamFn = (model: Model, context: Context, streamOptions?: SimpleStreamOptions) => {
		const branch = isBranchRequest(context);
		calls.push({
			kind: branch ? "branch" : "main",
			model,
			context,
			messagesJson: JSON.stringify(context.messages),
			options: streamOptions,
		});
		noteCall();
		const stream = new AssistantMessageEventStream();
		if (branch) {
			void driveBranch(stream, model, streamOptions, options);
			return stream;
		}
		const turn = options.turns[Math.min(mainIndex, options.turns.length - 1)]!;
		mainIndex++;
		void driveMain(stream, model, streamOptions, turn, options);
		return stream;
	};

	return {
		calls,
		streamFn,
		mainCalls: () => calls.filter(call => call.kind === "main"),
		branchCalls: () => calls.filter(call => call.kind === "branch"),
		waitForBranchCalls(need, timeoutMs = 2_000) {
			if (calls.filter(call => call.kind === "branch").length >= need) return Promise.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${need} branch call(s)`)), timeoutMs);
			branchWaiters.push({
				need,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
			return promise;
		},
	};
}

async function driveMain(
	stream: AssistantMessageEventStream,
	model: Model,
	streamOptions: SimpleStreamOptions | undefined,
	turn: MainTurn,
	script: ScriptOptions,
): Promise<void> {
	if (script.mainResponseHeaders) {
		await streamOptions?.onResponse?.(metadata(script.mainResponseHeaders), model);
	}
	const content: AssistantMessage["content"] = [];
	const partial = (): AssistantMessage => ({
		role: "assistant",
		content: [...content],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: usage(),
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
	if (turn.toolCall) {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `toolu_${turn.toolCall.name}_${content.length}`,
			name: turn.toolCall.name,
			arguments: turn.toolCall.args,
		};
		content.push(toolCall);
		const index = content.length - 1;
		stream.push({ type: "toolcall_start", contentIndex: index, partial: partial() });
		await turn.afterToolCallStart?.();
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
	// A real provider would call this hook; the branch must never have one wired,
	// which is exactly what makes this line safe to leave in.
	if (script.branchResponseHeaders) {
		await streamOptions?.onResponse?.(metadata(script.branchResponseHeaders), model);
	}
	if (script.branchText === undefined) {
		// Hang until the coordinator aborts. `abort` on the branch handle rejects
		// the caller's signal; the stream is closed here so nothing leaks.
		streamOptions?.signal?.addEventListener("abort", () => stream.push({ type: "error", ...abortedError(model) }), {
			once: true,
		});
		return;
	}
	const content: AssistantMessage["content"] = [{ type: "text", text: script.branchText }];
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: { input: 200, output: 40, cacheRead: 900, cacheWrite: 0, totalTokens: 1140, cost: zeroCost() },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: { ...message, content: [] } });
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	stream.push({ type: "text_delta", contentIndex: 0, delta: script.branchText, partial: message });
	stream.push({ type: "text_end", contentIndex: 0, content: script.branchText, partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

function zeroCost(): AssistantMessage["usage"]["cost"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function abortedError(model: Model): { reason: "aborted"; error: never } {
	return {
		reason: "aborted",
		error: {
			errorMessage: "aborted",
			usage: undefined,
			model: model.id,
		},
	} as unknown as { reason: "aborted"; error: never };
}

// ---------------------------------------------------------------------------
// Session harness
// ---------------------------------------------------------------------------

/** Mutable so a test can make the tool result carry a secret. */
let probeOutput = "probe ok";
/** Mutable hook run INSIDE tool execution, i.e. between two provider calls. */
let probeDuringExecute: (() => Promise<void>) | undefined;

const PROBE_TOOL: AgentTool = {
	name: "probe",
	label: "Probe",
	description: "Test tool that always succeeds",
	parameters: type({}),
	execute: async () => {
		await probeDuringExecute?.();
		return { content: [{ type: "text" as const, text: probeOutput }] };
	},
};

interface Harness {
	readonly session: AgentSession;
	readonly script: Script;
	readonly settings: Settings;
	readonly obfuscator: SecretObfuscator | undefined;
}

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
const openSessions: AgentSession[] = [];

async function createHarness(args: {
	script: ScriptOptions;
	settings?: Record<string, unknown>;
	/** Omit the settings-aware side stream fn, as a bare host would. */
	withoutSideStreamFn?: boolean;
	agentKind?: "main" | "sub";
	/**
	 * Install the session's secret boundary AND the SDK's outbound redaction on
	 * the agent (`sdk.ts`'s `transformProviderContext` runs
	 * `obfuscateProviderContext` first). Both halves are required: without the
	 * transform there is no boundary for the fold to cross.
	 */
	obfuscator?: SecretObfuscator;
}): Promise<Harness> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model to exist");

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
	authStorage = authStorage ?? (await AuthStorage.create(":memory:"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const obfuscator = args.obfuscator;

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["You are pi."], tools: [PROBE_TOOL], messages: [] },
		convertToLlm,
		streamFn: script.streamFn,
		// Mirrors sdk.ts:3146 — the outbound redaction runs inside
		// `transformProviderContext`, i.e. BEFORE `addBeforeModelCall`.
		...(obfuscator
			? { transformProviderContext: (context: Context) => obfuscateProviderContext(obfuscator, context) }
			: {}),
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		agentKind: args.agentKind,
		toolRegistry: new Map<string, AgentTool>([[PROBE_TOOL.name, PROBE_TOOL]]),
		...(obfuscator ? { obfuscator } : {}),
		...(args.withoutSideStreamFn ? {} : { sideStreamFn: script.streamFn }),
	});
	openSessions.push(session);
	return { session, script, settings, obfuscator };
}

/** The wire encoding of a request's messages, through the real Anthropic converter. */
function encodeWire(messages: Message[], model: Model): unknown[] {
	return convertAnthropicMessages(structuredClone(messages), model as Model<"anthropic-messages">, false) as unknown[];
}

function foldMessages(context: Context): Message[] {
	return context.messages.filter(message => textOf(message).includes(FOLD_BLOCK_OPEN));
}

beforeEach(() => {
	tempDir = TempDir.createSync("second-thought-integration");
	probeOutput = "probe ok";
	probeDuringExecute = undefined;
});

afterEach(async () => {
	while (openSessions.length > 0) {
		await openSessions.pop()?.dispose();
	}
	tempDir.removeSync();
});

// ---------------------------------------------------------------------------

describe("Second Thought end to end", () => {
	it("forks on the first tool call, harvests at turn end, and delivers the fold as the FINAL message of call N+1", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }],
				branchText: REFLECT_TEXT,
			},
		});

		await session.prompt("fix the failing test");

		const main = script.mainCalls();
		expect(main.length).toBeGreaterThanOrEqual(2);
		expect(script.branchCalls()).toHaveLength(1);

		// Call 1 carried no fold — nothing had been harvested yet.
		expect(foldMessages(main[0]!.context)).toHaveLength(0);

		// Call 2 of the SAME run carries exactly one fold, and it is LAST.
		const delivery = main[1]!;
		const injected = foldMessages(delivery.context);
		expect(injected).toHaveLength(1);
		const last = delivery.context.messages.at(-1)!;
		expect(last.role).toBe("user");
		expect(textOf(last)).toContain(FOLD_BLOCK_OPEN);
		expect(textOf(last)).toContain("The fixture may pin the clock");
		expect((last as { synthetic?: boolean }).synthetic).toBe(true);
		// Never `developer`: that role is upgraded to system authority on current
		// Anthropic models, which would give model-generated text system weight.
		expect(delivery.context.messages.every(message => message.role !== "developer")).toBe(true);

		// The fold delivers once and dies.
		expect(session.secondThought?.hasPendingFold).toBe(false);
	});

	it("writes a non-context diagnostic entry that can never become a message", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }],
				branchText: REFLECT_TEXT,
			},
		});

		await session.prompt("fix the failing test");
		expect(script.branchCalls()).toHaveLength(1);

		const entries = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === SECOND_THOUGHT_FOLD_CUSTOM_TYPE);
		expect(entries).toHaveLength(1);
		const data = (entries[0] as { data?: Record<string, unknown> }).data ?? {};
		expect(data.delivered).toBe(true);
		expect(data.retireReason).toBe("delivered");
		expect(data.unitCount).toBe(2);

		// `buildSessionContext` only emits messages for `message`, `custom_message`
		// and `branch_summary` entries, so a `custom` entry is structurally
		// incapable of reaching the provider.
		const contextMessages = session.sessionManager.buildSessionContext().messages;
		expect(contextMessages.some(message => textOf(message as Message).includes(FOLD_BLOCK_OPEN))).toBe(false);
	});

	it("CACHE ACCEPTANCE GATE: the branch request's encoded prefix is byte-identical to the main call's", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }],
				branchText: REFLECT_TEXT,
			},
		});

		await session.prompt("fix the failing test");

		const mainCall = script.mainCalls()[0]!;
		const branchCall = script.branchCalls()[0]!;
		const model = mainCall.model;

		const mainWire = encodeWire(JSON.parse(mainCall.messagesJson) as Message[], model);
		const branchWire = encodeWire(JSON.parse(branchCall.messagesJson) as Message[], model);

		// Exactly one appended turn: the synthetic user conditioning message.
		expect(branchWire).toHaveLength(mainWire.length + 1);
		// The bytes the provider hashes for the cache prefix.
		expect(JSON.stringify(branchWire.slice(0, mainWire.length))).toBe(JSON.stringify(mainWire));
		// System prompt and tool set are the other two halves of the cache key.
		expect(JSON.stringify(branchCall.context.systemPrompt)).toBe(JSON.stringify(mainCall.context.systemPrompt));
		// Compared on the fields the encoder reads: the live main-call tools also
		// carry host-only members (`label`, `execute`) that never reach the wire and
		// are deliberately dropped from the branch's structured-cloneable copy.
		const wireTools = (context: Context) =>
			(context.tools ?? []).map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				strict: tool.strict,
				native: tool.native,
			}));
		expect(JSON.stringify(wireTools(branchCall.context))).toBe(JSON.stringify(wireTools(mainCall.context)));
		// Same model, and a side session id derived from the primary one so
		// provider routing keeps its own lineage without a new cache namespace.
		expect(branchCall.model.id).toBe(mainCall.model.id);
		expect(branchCall.options?.sessionId).toContain(`:side:${BRANCH_SIDE_ROLE}:`);
		// The branch pins the main call's cache identity explicitly, because its own
		// `sessionId` is deliberately different (`promptCacheKey` falls back to
		// `sessionId` when unset, which would otherwise split the cache namespace).
		expect(branchCall.options?.promptCacheKey).toBe(
			mainCall.options?.promptCacheKey ?? (mainCall.options?.sessionId as string),
		);
		expect(branchCall.options?.sessionId).not.toBe(mainCall.options?.sessionId);
		// Cache-hostile fields never reach the branch request.
		expect(branchCall.options?.toolChoice).toBeUndefined();
		expect(branchCall.options?.disableReasoning).toBeUndefined();
		expect(branchCall.options?.anthropicCacheRefresh).toBeUndefined();
		expect(session.secondThought).toBeDefined();
	});

	it("HEADER-INGEST ISOLATION: a branch call leaves primary stats and quota ingest untouched", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }],
				branchText: REFLECT_TEXT,
				branchResponseHeaders: { "anthropic-ratelimit-unified-status": "rejected" },
				mainResponseHeaders: { "anthropic-ratelimit-unified-status": "allowed" },
			},
		});

		await session.prompt("fix the failing test");

		const branchCall = script.branchCalls()[0]!;
		// The session's provider-header ingest hook is never wired onto a branch.
		expect(branchCall.options?.onResponse).toBeUndefined();

		// The primary session's own token totals count only its own assistant
		// messages. The branch reported 900 cacheRead tokens; the two main turns
		// reported 3 each.
		const stats = session.getSessionStats();
		expect(stats.tokens.cacheRead).toBeLessThan(900);
		expect(stats.tokens.input).toBeLessThan(200);

		// Branch spend is visible, separately, on the coordinator's own ledger.
		const report = session.secondThought?.report();
		expect(report?.branches).toBe(1);
		expect(report?.tokens.cacheRead).toBe(900);
	});

	it("is completely off by default: no branch, no fold, no diagnostic entry", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }],
				branchText: REFLECT_TEXT,
			},
			settings: { "secondThought.enabled": false },
		});

		await session.prompt("fix the failing test");

		expect(script.branchCalls()).toHaveLength(0);
		for (const call of script.mainCalls()) {
			expect(foldMessages(call.context)).toHaveLength(0);
		}
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === SECOND_THOUGHT_FOLD_CUSTOM_TYPE),
		).toHaveLength(0);
		// Disabled at construction means the runtime is never built at all — not
		// built-but-idle. See the abort-shape delta test below for why that
		// distinction is the whole point.
		expect(session.secondThought).toBeUndefined();
	});

	it("DISABLED-PATH DELTA: an abort at the pre-model gate makes the same provider calls with the feature off as with no feature at all", async () => {
		// `agent-loop.ts` reads the mere PRESENCE of a `beforeModelCall` as an
		// aborted-gate signal:
		//
		//     if (config.beforeModelCall && signal?.aborted) gateResult = { stop: true };
		//
		// Second Thought owns the repo's only registration of it. Registering it in
		// a session whose feature is OFF therefore changes that session's abort
		// shape — deterministically, on every main session in the product — purely
		// by existing. This asserts the two sessions are indistinguishable.
		//
		// The abort lands DURING tool execution, so the loop finishes the tool,
		// re-enters with `hasMoreToolCalls`, and reaches `prepareProviderCall` with
		// an already-aborted signal. That is the exact window the hook's presence
		// changes: measured here as 2 provider calls without the hook and 1 with it.
		const run = async (settings: Record<string, unknown>, withoutSideStreamFn: boolean) => {
			let sessionRef: AgentSession | undefined;
			const harness = await createHarness({
				script: {
					turns: [
						{ thinking: THINKING, toolCall: { name: "probe", args: {} } },
						{ text: "done" },
						{ text: "done again" },
					],
					branchText: REFLECT_TEXT,
				},
				settings,
				withoutSideStreamFn,
			});
			sessionRef = harness.session;
			probeDuringExecute = async () => {
				void sessionRef?.abort({ reason: "test-interrupt" });
				await Bun.sleep(10);
			};
			await harness.session.prompt("fix the failing test").catch(() => undefined);
			await harness.session.secondThought?.whenSettled();
			return harness.script.mainCalls().length;
		};

		// Control: a host that never supplied a side stream fn, so the feature
		// cannot exist here under any setting.
		const control = await run({ "secondThought.enabled": true }, true);
		// The case under test: the feature is available but switched off.
		const disabled = await run({ "secondThought.enabled": false }, false);
		// Positive control: with the feature ON the hook IS installed, and this
		// scenario does change shape. That is what makes the assertion above a real
		// assertion rather than a vacuous one — the scenario discriminates.
		const enabled = await run({ "secondThought.enabled": true }, false);

		expect(disabled).toBe(control);
		expect(enabled).not.toBe(control);
	});

	it("PROVIDER SESSION STATE: a branch mutation can never reach the primary's map", async () => {
		// The map is a degradation ledger providers WRITE to (strict-tools off,
		// reasoning-effort fallback, fast-mode). A branch 400 flipping any of those
		// for the primary call is a speculative side call degrading the main loop.
		const { session, script } = await createHarness({
			script: {
				turns: [
					{ thinking: THINKING, toolCall: { name: "probe", args: {} } },
					{ thinking: THINKING, toolCall: { name: "probe", args: { second: true } } },
					{ text: "done" },
				],
				branchText: REFLECT_TEXT,
			},
		});

		await session.prompt("run two tools");

		const branchCalls = script.branchCalls();
		expect(branchCalls).toHaveLength(2);
		const primaryState = session.providerSessionState;

		for (const call of branchCalls) {
			const branchState = call.options?.providerSessionState;
			expect(branchState).toBeDefined();
			// Not the primary's object, by identity.
			expect(branchState).not.toBe(primaryState);
		}
		// Two forks, two independent maps.
		expect(branchCalls[0]!.options?.providerSessionState).not.toBe(branchCalls[1]!.options?.providerSessionState);

		// The mutation a provider error path performs (`disableStrictToolsForScope`
		// and friends all `.set(...)` on this map) is observed on the branch's
		// object and is invisible to the primary's.
		const closed: string[] = [];
		branchCalls[0]!.options?.providerSessionState?.set("strict-tools:anthropic", {
			close: () => closed.push("branch"),
		});
		expect(primaryState.size).toBe(0);
		expect(primaryState.has("strict-tools:anthropic")).toBe(false);

		// And the primary's own map is still the object the agent was handed, so
		// nothing here isolated the primary from ITSELF.
		expect(session.agent.providerSessionState).toBe(primaryState);
	});

	it("SECRET ROUND TRIP: a placeholder echoed by the branch reaches the wire as a PLACEHOLDER, not plaintext", async () => {
		// The full loop the security finding describes:
		//   tool output holds a plaintext secret
		//     → `transformProviderContext` obfuscates the main context
		//     → the branch is forked from that context, so it sees a PLACEHOLDER
		//     → the branch quotes the placeholder back in its <reflect> text
		//     → `branch-call` DEOBFUSCATES the harvest, so the fold holds plaintext
		//     → the fold is injected AFTER obfuscation ran
		// Without re-obfuscation at injection, that last step puts the plaintext
		// secret on the wire.
		const SECRET = "sk-live-second-thought-canary-7fd2";
		probeOutput = `the api key is ${SECRET} and it works`;

		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		expect(placeholder).not.toBe(SECRET);
		expect(placeholder).not.toContain(SECRET);
		// The branch quotes back the placeholder it was shown. It cannot quote the
		// plaintext, because it was never shown the plaintext — which is exactly why
		// a deobfuscated harvest reintroducing it is a leak and not a round trip.
		const branchEcho =
			`<reflect type="check">The probe returned ${placeholder} so the credential path is live.</reflect>\n` +
			'<reflect type="alternative">Reading the helper first would confirm the double read.</reflect>';

		// The fork fires on the FIRST tool call of a stream, so the tool RESULT
		// carrying the secret only exists from the second provider call onward.
		// Turn 2 is therefore the turn whose fork can see it.
		const { session, script } = await createHarness({
			script: {
				turns: [
					{ thinking: THINKING, toolCall: { name: "probe", args: {} } },
					{ thinking: THINKING, toolCall: { name: "probe", args: { second: true } } },
					{ text: "done" },
				],
				branchText: branchEcho,
			},
			obfuscator,
		});

		await session.prompt("fix the failing test");

		const branchCalls = script.branchCalls();
		expect(branchCalls).toHaveLength(2);
		// (a) The branch was forked from the OBFUSCATED context: it saw the
		// placeholder and never the plaintext secret.
		const secretAwareBranch = branchCalls[1]!;
		expect(secretAwareBranch.messagesJson).toContain(placeholder);
		expect(secretAwareBranch.messagesJson).not.toContain(SECRET);

		// (b) The harvest from that branch reached the next main call, and the fold
		// carries the PLACEHOLDER on the wire — not the plaintext the deobfuscated
		// harvest actually holds in memory.
		const delivery = script.mainCalls()[2]!;
		const fold = delivery.context.messages.at(-1)!;
		expect(textOf(fold)).toContain(FOLD_BLOCK_OPEN);
		expect(textOf(fold)).toContain(placeholder);
		expect(textOf(fold)).not.toContain(SECRET);
		// The whole request, not just its tail: nothing anywhere reintroduced it.
		expect(delivery.messagesJson).not.toContain(SECRET);
		for (const call of script.calls) expect(call.messagesJson).not.toContain(SECRET);

		// (c) The LOCAL audit trail is deliberately plaintext: redacting the
		// diagnostic entry would make the feature's own record unreadable, and a
		// `custom` entry is structurally incapable of reaching a provider.
		const entries = session.sessionManager
			.getBranch()
			.filter(item => item.type === "custom" && item.customType === SECOND_THOUGHT_FOLD_CUSTOM_TYPE);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.some(item => JSON.stringify((item as { data?: unknown }).data).includes(SECRET))).toBe(true);
	});

	it("resets on a model change, so a fork taken against the old request shape cannot be delivered", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }, { text: "fresh" }],
				branchText: REFLECT_TEXT,
			},
			settings: { "secondThought.deliveryCalls": 4 },
		});
		const runtime = session.secondThought!;

		await session.prompt("fix the failing test");
		const epochBefore = runtime.historyEpoch;

		const other = getBundledModel("anthropic", "claude-haiku-4-5") ?? getBundledModel("anthropic", "claude-opus-4-1");
		expect(other).toBeDefined();
		await session.setModel(other!);

		// The model switch invalidated the branch's whole cache identity, so both
		// the fork and any fold harvested from it are dropped.
		expect(runtime.historyEpoch).toBeGreaterThan(epochBefore);
		expect(runtime.hasPendingFold).toBe(false);

		const callsBefore = script.mainCalls().length;
		await session.prompt("and now?");
		for (const call of script.mainCalls().slice(callsBefore)) {
			expect(foldMessages(call.context)).toHaveLength(0);
		}
	});

	it("resets on tree navigation (branch to an earlier entry)", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }, { text: "fresh" }],
				branchText: REFLECT_TEXT,
			},
			settings: { "secondThought.deliveryCalls": 4 },
		});
		const runtime = session.secondThought!;

		await session.prompt("fix the failing test");
		const epochBefore = runtime.historyEpoch;

		const target = session.sessionManager.getBranch().find(entry => entry.type === "message");
		expect(target).toBeDefined();
		await session.branch((target as { id: string }).id);

		expect(runtime.historyEpoch).toBeGreaterThan(epochBefore);
		expect(runtime.hasPendingFold).toBe(false);

		const callsBefore = script.mainCalls().length;
		await session.prompt("different path");
		for (const call of script.mainCalls().slice(callsBefore)) {
			expect(foldMessages(call.context)).toHaveLength(0);
		}
	});

	it("carries no fold across a handoff", async () => {
		// A handoff replaces the entire transcript the reflections describe, so no
		// fold may survive it. `session-handoff.ts` calls `resetSecondThought()`
		// next to `resetAdvisorSessionState()`.
		//
		// Stated plainly, because a reader deserves to know how much this test
		// proves: the handoff's own `agent.replaceMessages` already moves the epoch
		// through the wrapped method, so this OUTCOME holds with the explicit reset
		// removed. The explicit call is there so the rule is written down at the
		// boundary instead of emerging from a side effect two modules away, and so
		// that a fork still in flight (a handoff racing a run) is cancelled rather
		// than merely made undeliverable. What this test guards is the outcome —
		// it fails if either mechanism is removed AND the other is not there to
		// cover it.
		const { session, script } = await createHarness({
			script: {
				turns: [
					{ thinking: THINKING, toolCall: { name: "probe", args: {} } },
					{ text: "done" },
					// The handoff generation call is answered with the document.
					{ text: "# Handoff\n\nPick up from the failing test." },
					{ text: "fresh" },
				],
				branchText: REFLECT_TEXT,
			},
			settings: { "secondThought.deliveryCalls": 4 },
		});
		const runtime = session.secondThought!;

		await session.prompt("fix the failing test");
		const epochBefore = runtime.historyEpoch;

		const result = await session.handoff();
		expect(result?.document).toContain("Handoff");

		expect(runtime.historyEpoch).toBeGreaterThan(epochBefore);
		expect(runtime.hasPendingFold).toBe(false);
		expect(runtime.coordinator.activeBranchCount).toBe(0);

		const callsBefore = script.mainCalls().length;
		await session.prompt("continue");
		for (const call of script.mainCalls().slice(callsBefore)) {
			expect(foldMessages(call.context)).toHaveLength(0);
		}
	});

	it("HARVEST BEFORE ADVISORS: the ≤300 ms harvest completes ahead of a slow advisor catch-up", async () => {
		// The ordering constraint the wiring exists to satisfy: `onTurnEnd` runs
		// Second Thought's harvest BEFORE `#advisors.onPrimaryTurnEnd`, whose
		// `waitForCatchup` can block for tens of seconds. The rest of the suite
		// runs with advisors disabled, so a swap of the two lines survives it —
		// this test does not.
		const order: string[] = [];
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }],
				branchText: REFLECT_TEXT,
			},
			settings: { "advisor.enabled": true },
		});

		const runtime = session.secondThought!;
		// Observe the harvest on the runtime instance the session holds.
		const originalHarvest = runtime.onPrimaryTurnEnd.bind(runtime);
		(runtime as unknown as { onPrimaryTurnEnd: () => Promise<void> }).onPrimaryTurnEnd = async () => {
			order.push("harvest:start");
			await originalHarvest();
			order.push("harvest:end");
		};

		// Stand a SLOW advisor catch-up exactly where the real backlog wait stands.
		// Patched on the prototype because the session's `#advisors` is private —
		// this is the same method object `agent-session.ts`'s turn-end closure
		// calls, so the ordering observed here is the production ordering.
		const originalAdvisors = SessionAdvisors.prototype.onPrimaryTurnEnd;
		SessionAdvisors.prototype.onPrimaryTurnEnd = async function patched(
			this: SessionAdvisors,
			...args: Parameters<SessionAdvisors["onPrimaryTurnEnd"]>
		) {
			order.push("advisors:start");
			await Bun.sleep(250);
			try {
				return await originalAdvisors.apply(this, args);
			} finally {
				order.push("advisors:end");
			}
		} as SessionAdvisors["onPrimaryTurnEnd"];

		try {
			await session.prompt("fix the failing test");
		} finally {
			SessionAdvisors.prototype.onPrimaryTurnEnd = originalAdvisors;
		}

		// Strictly interleaved, not merely both-present: the harvest is COMPLETE
		// before the advisor wait even begins. Swapping the two lines in
		// `agent-session.ts`'s `setOnTurnEnd` closure inverts this.
		const first = order.indexOf("advisors:start");
		expect(first).toBeGreaterThan(-1);
		expect(order.slice(0, first)).toEqual(["harvest:start", "harvest:end"]);

		// And the harvest was real work, not an early no-op: the branch ran and its
		// fold reached the next provider call of the same run.
		expect(script.branchCalls()).toHaveLength(1);
		expect(foldMessages(script.mainCalls()[1]!.context)).toHaveLength(1);
	});

	it("never constructs the runtime for a sub-session or without a settings-aware stream fn", async () => {
		const sub = await createHarness({
			script: { turns: [{ text: "done" }] },
			agentKind: "sub",
		});
		expect(sub.session.secondThought).toBeUndefined();

		const bare = await createHarness({
			script: { turns: [{ text: "done" }] },
			withoutSideStreamFn: true,
		});
		expect(bare.session.secondThought).toBeUndefined();

		// And the bare host still runs a normal turn with zero delta.
		await bare.session.prompt("hello");
		expect(bare.script.branchCalls()).toHaveLength(0);
	});

	it("cancels the branch on abort and delivers no fold", async () => {
		let sessionRef: AgentSession | undefined;
		const harness = await createHarness({
			script: {
				turns: [
					{
						thinking: THINKING,
						toolCall: { name: "probe", args: {} },
						// Abort the session from inside the stream, after the fork is live.
						afterToolCallStart: async () => {
							await sessionRef?.abort({ reason: "test-interrupt" });
						},
					},
					{ text: "done" },
				],
				// The branch never replies; only a cancel can end it.
				branchText: undefined,
			},
		});
		sessionRef = harness.session;

		await harness.session.prompt("fix the failing test").catch(() => undefined);
		await harness.session.secondThought?.whenSettled();

		expect(harness.session.secondThought?.coordinator.activeBranchCount).toBe(0);
		expect(harness.session.secondThought?.coordinator.activeGeneration).toBeUndefined();
		expect(harness.session.secondThought?.hasPendingFold).toBe(false);
		for (const call of harness.script.mainCalls()) {
			expect(foldMessages(call.context)).toHaveLength(0);
		}
	});

	it("spends `deliveryCalls: 2` across TWO provider calls of the same run", async () => {
		// The setting is inert in a two-call run, because the fold is retired at
		// `agent_end` before a second request ever exists. Turn 2 opens a tool call
		// with NO thinking, so its conditioning is too short to fork — the fold
		// from turn 1 survives an extra provider call instead of being superseded.
		const { session, script } = await createHarness({
			script: {
				turns: [
					{ thinking: THINKING, toolCall: { name: "probe", args: {} } },
					{ toolCall: { name: "probe", args: { second: true } } },
					{ text: "done" },
				],
				branchText: REFLECT_TEXT,
			},
			settings: { "secondThought.deliveryCalls": 2 },
		});

		await session.prompt("fix the failing test");

		expect(script.branchCalls()).toHaveLength(1);
		const main = script.mainCalls();
		expect(main.length).toBeGreaterThanOrEqual(3);
		// Call 1 predates the harvest; calls 2 and 3 each carry it, and it is the
		// final message on both.
		expect(foldMessages(main[0]!.context)).toHaveLength(0);
		for (const call of [main[1]!, main[2]!]) {
			expect(foldMessages(call.context)).toHaveLength(1);
			expect(textOf(call.context.messages.at(-1))).toContain(FOLD_BLOCK_OPEN);
		}
		// Budget spent: nothing pending, and the entry records two deliveries.
		expect(session.secondThought?.hasPendingFold).toBe(false);
		const entry = session.sessionManager
			.getBranch()
			.find(item => item.type === "custom" && item.customType === SECOND_THOUGHT_FOLD_CUSTOM_TYPE);
		expect((entry as { data?: { deliveryCount?: number } } | undefined)?.data?.deliveryCount).toBe(2);
	});

	it("drops the fold when history moves under it (rewind / compaction / replaceMessages)", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [
					{ thinking: THINKING, toolCall: { name: "probe", args: {} } },
					{ text: "done" },
					{ text: "done again" },
				],
				branchText: REFLECT_TEXT,
			},
			settings: { "secondThought.deliveryCalls": 2 },
		});

		const runtime = session.secondThought!;
		await session.prompt("fix the failing test");

		// Stated rather than assumed: the fold is ALREADY gone here, retired by
		// `onRunEnd` when the run finished — v1 never carries a fold across a
		// prompt, whatever `deliveryCalls` says. So `hasPendingFold` below proves
		// nothing about the epoch on its own; the load-bearing claim is that the
		// epoch MOVES and that the next run is clean.
		expect(runtime.hasPendingFold).toBe(false);

		// The history rewrite compaction/rewind performs. The wrapped
		// `replaceMessages` is what moves the epoch, so this is the production path.
		const epochBefore = runtime.historyEpoch;
		session.agent.replaceMessages(session.agent.state.messages.slice(0, 1));
		expect(runtime.historyEpoch).toBeGreaterThan(epochBefore);

		const callsBefore = script.mainCalls().length;
		await session.prompt("and now?");
		for (const call of script.mainCalls().slice(callsBefore)) {
			expect(foldMessages(call.context)).toHaveLength(0);
		}
	});

	it("leaks no branch across dispose", async () => {
		const { session } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }],
				branchText: undefined,
			},
		});
		const runtime = session.secondThought!;
		const run = session.prompt("fix the failing test").catch(() => undefined);
		await session.dispose();
		await run;
		await runtime.whenSettled();
		expect(runtime.coordinator.activeBranchCount).toBe(0);
	});

	it("resets on a session switch so reflections cannot cross a conversation boundary", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [{ thinking: THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }, { text: "fresh" }],
				branchText: REFLECT_TEXT,
			},
			settings: { "secondThought.deliveryCalls": 4 },
		});
		const runtime = session.secondThought!;

		await session.prompt("fix the failing test");
		const epochBefore = runtime.historyEpoch;

		await session.newSession();
		expect(runtime.historyEpoch).toBeGreaterThan(epochBefore);
		expect(runtime.hasPendingFold).toBe(false);

		const callsBefore = script.mainCalls().length;
		await session.prompt("hello again");
		for (const call of script.mainCalls().slice(callsBefore)) {
			expect(foldMessages(call.context)).toHaveLength(0);
		}
	});

	it("does not fork a turn that never opens a tool call", async () => {
		const { session, script } = await createHarness({
			script: { turns: [{ thinking: THINKING, text: "no tools needed" }], branchText: REFLECT_TEXT },
		});

		await session.prompt("just answer");
		expect(script.branchCalls()).toHaveLength(0);
		expect(session.secondThought?.report().skips["conditioning-too-short"] ?? 0).toBe(0);
	});

	it("forks once per stream, not once per tool call in a multi-tool message", async () => {
		const { session, script } = await createHarness({
			script: {
				turns: [
					{ thinking: THINKING, toolCall: { name: "probe", args: {} } },
					{ thinking: THINKING, toolCall: { name: "probe", args: { second: true } } },
					{ text: "done" },
				],
				branchText: REFLECT_TEXT,
			},
		});

		await session.prompt("run two tools");

		// Two provider calls each opened one stream that opened one tool call, so
		// two forks — never four, which is what keying on `event.partial` identity
		// would have produced.
		expect(script.branchCalls()).toHaveLength(2);
		expect(session.secondThought?.report().branches).toBe(2);
		expect(session.secondThought?.coordinator.forkCount).toBe(2);
	});
});
