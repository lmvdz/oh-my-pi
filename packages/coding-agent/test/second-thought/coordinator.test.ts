import { afterEach, describe, expect, it } from "bun:test";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	BranchCaller,
	type BranchCallHandle,
	type BranchCallRequest,
	type BranchCallResult,
	type BranchStreamOptions,
	type EagerBranchFanOut,
} from "../../src/session/second-thought/branch-call";
import {
	type BranchStarter,
	buildConditioningText,
	FINALIZER_TIMEOUT_MS,
	HARVEST_GRACE_MS,
	SecondThoughtCoordinator,
	type SecondThoughtDropReason,
	type SecondThoughtForkContext,
	type SecondThoughtForkInfo,
	type SecondThoughtHarvest,
	type SecondThoughtHost,
	type SecondThoughtLedgerSink,
	type SecondThoughtSkipReason,
} from "../../src/session/second-thought/coordinator";

// ── fixtures ────────────────────────────────────────────────────────────────

function model<TApi extends Api>(api: TApi, provider: string, id: string): Model<TApi> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		api,
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

const ANTHROPIC = model("anthropic-messages", "anthropic", "claude-fable-5");
const OPENAI = model("openai-completions", "openai", "gpt-test");

const CONDITIONING =
	"The failing assertion is in the parser tests; I should read the fixture before editing anything at all.";

function usage(cacheRead = 4096): Usage {
	return {
		input: 20,
		output: 40,
		cacheRead,
		cacheWrite: 0,
		totalTokens: 60 + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: ANTHROPIC.api,
		provider: ANTHROPIC.provider,
		model: ANTHROPIC.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: 7,
	} as AssistantMessage;
}

/** A streaming assistant message instance, as the interceptor sees it. */
function streamingPartial(thinking = CONDITIONING, timestamp = 1000): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking },
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
		],
		api: ANTHROPIC.api,
		provider: ANTHROPIC.provider,
		model: ANTHROPIC.id,
		usage: usage(),
		stopReason: "toolUse",
		timestamp,
	} as unknown as AssistantMessage;
}

function mainContext(tail?: Message): Context {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "fix the failing test" }], timestamp: 1 },
		assistantMessage("looking at it"),
	];
	if (tail) messages.push(tail);
	return {
		systemPrompt: ["You are pi."],
		messages,
		tools: [
			{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
		] as Context["tools"],
	};
}

const BRANCH_TEXT =
	'<reflect type="check">the fixture path may be stale</reflect>\n' +
	'<reflect type="recall">the parser repairs malformed closers</reflect>';

interface StreamScript {
	/** Text chunks the fake provider streams before finishing. */
	deltas?: string[];
	/** Never finish and ignore abort — the wedged-provider case. */
	wedge?: boolean;
	/** Delay before the first delta, ms. */
	firstDelayMs?: number;
	/**
	 * Deliver the scripted deltas even after the caller aborted, then settle
	 * `aborted`.
	 *
	 * Models the real shape of a mid-stream teardown: `controller.abort()` does
	 * not empty the socket, so chunks already in flight are still read by the
	 * `for await` loop and their text is still harvestable. Without this the fake
	 * provider drops everything the instant the signal trips, which makes it
	 * impossible to express "a branch settles with units INSIDE the grace".
	 */
	deltasSurviveAbort?: boolean;
}

interface FakeProvider {
	streamFn: (model: Model, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessageEventStream>;
	calls: { model: Model; context: Context; options: SimpleStreamOptions }[];
	release(): void;
}

function fakeProvider(script: StreamScript = {}): FakeProvider {
	const calls: FakeProvider["calls"] = [];
	const releases: (() => void)[] = [];
	const streamFn = async (m: Model, context: Context, options: SimpleStreamOptions = {}) => {
		calls.push({ model: m, context, options });
		const stream = new AssistantMessageEventStream();
		const signal = options.signal;
		let text = "";
		void (async () => {
			if (script.firstDelayMs) await new Promise(resolve => setTimeout(resolve, script.firstDelayMs));
			for (const delta of script.deltas ?? [BRANCH_TEXT]) {
				if (signal?.aborted && !script.deltasSurviveAbort) break;
				text += delta;
				stream.push({ type: "text_delta", contentIndex: 0, delta, partial: assistantMessage(text) });
				await Promise.resolve();
			}
			if (script.wedge) {
				// Deliberately ignores the abort signal: the branch's result must
				// never settle, so the harvest can only be bounded by the grace.
				await new Promise<void>(resolve => releases.push(resolve));
			}
			if (signal?.aborted) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: assistantMessage(text),
				} as unknown as Parameters<typeof stream.push>[0]);
				stream.end();
				return;
			}
			const message = assistantMessage(text);
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		})();
		return stream;
	};
	const release = () => {
		for (const resolve of releases.splice(0)) resolve();
	};
	return { streamFn, calls, release };
}

// ── harness ─────────────────────────────────────────────────────────────────

interface LedgerRecord {
	skips: { reason: SecondThoughtSkipReason; info?: Record<string, unknown> }[];
	forks: SecondThoughtForkInfo[];
	results: BranchCallResult[];
	drops: { reason: SecondThoughtDropReason; info?: Record<string, unknown> }[];
	harvests: SecondThoughtHarvest[];
}

interface Harness {
	coordinator: SecondThoughtCoordinator;
	ledger: LedgerRecord;
	folds: SecondThoughtHarvest[];
	provider: FakeProvider;
	/** Every handle the coordinator ever received, with its abort calls. */
	handles: { handle: BranchCallHandle; aborts: unknown[] }[];
	controller: AbortController;
	epoch: { value: number };
	settings: Settings;
	starts: number;
	/** Every request handed to the branch starter. */
	requests: BranchCallRequest[];
}

interface HarnessOptions {
	overrides?: Partial<Record<SettingPath, unknown>>;
	agentKind?: "main" | "sub";
	primaryModel?: Model | undefined;
	script?: StreamScript;
	prepareFork?: (m: Model) => SecondThoughtForkContext | undefined;
	estimateContextTokens?: () => number | undefined;
	graceMs?: number;
	finalizerTimeoutMs?: number;
	starter?: BranchStarter;
	now?: () => number;
	adaptiveProbeInterval?: number;
	deliverHarvest?: (harvest: SecondThoughtHarvest) => void;
	streamOptions?: BranchStreamOptions;
}

function harness(options: HarnessOptions = {}): Harness {
	const settings = Settings.isolated({ "secondThought.enabled": true, ...options.overrides });
	const provider = fakeProvider(options.script);
	const controller = new AbortController();
	const epoch = { value: 1 };
	const ledger: LedgerRecord = { skips: [], forks: [], results: [], drops: [], harvests: [] };
	const folds: SecondThoughtHarvest[] = [];
	const handles: Harness["handles"] = [];

	const sink: SecondThoughtLedgerSink = {
		recordSkip: (reason, info) => ledger.skips.push({ reason, info }),
		recordFork: info => ledger.forks.push(info),
		recordBranchResult: result => ledger.results.push(result),
		recordDrop: (reason, info) => ledger.drops.push({ reason, info }),
		recordHarvest: h => ledger.harvests.push(h),
	};

	const streamOptions =
		options.streamOptions ??
		({
			apiKey: "k",
			reasoning: undefined,
			hideThinkingSummary: undefined,
			cacheRetention: undefined,
		} as BranchStreamOptions);

	const host: SecondThoughtHost = {
		settings,
		agentKind: () => options.agentKind ?? "main",
		primaryModel: () => ("primaryModel" in options ? options.primaryModel : ANTHROPIC),
		availableModels: () => [ANTHROPIC, OPENAI],
		historyEpoch: () => epoch.value,
		prepareFork:
			options.prepareFork ??
			(() => ({
				context: mainContext(),
				cacheSessionId: "sess-1",
				promptCacheKey: "cache-1",
				streamOptions,
				signal: controller.signal,
			})),
		estimateContextTokens: options.estimateContextTokens,
		deliverHarvest: h => {
			folds.push(h);
			options.deliverHarvest?.(h);
		},
		ledger: sink,
		harvestGraceMs: () => options.graceMs ?? 40,
		finalizerTimeoutMs: () => options.finalizerTimeoutMs ?? 60,
		now: options.now,
		adaptiveProbeInterval:
			options.adaptiveProbeInterval === undefined ? undefined : () => options.adaptiveProbeInterval as number,
	};

	const inner: BranchStarter = options.starter ?? new BranchCaller({ streamFn: provider.streamFn as never });
	const result: Harness = {
		coordinator: undefined as unknown as SecondThoughtCoordinator,
		ledger,
		folds,
		provider,
		handles,
		controller,
		epoch,
		settings,
		starts: 0,
		requests: [],
	};
	// Records every handle and every abort so "no branch outlives the
	// coordinator" is checkable after each test. The wrapper preserves the eager
	// contract: its handle array is live and grows in step with the inner one.
	const wrap = (handle: BranchCallHandle): BranchCallHandle => {
		const entry = { handle, aborts: [] as unknown[] };
		const wrapped: BranchCallHandle = {
			...handle,
			settledResult: () => handle.settledResult(),
			abort: (reason?: unknown) => {
				entry.aborts.push(reason);
				handle.abort(reason);
			},
		};
		entry.handle = wrapped;
		handles.push(entry);
		return wrapped;
	};
	const recording: BranchStarter = {
		startManyEager(count: number, request: BranchCallRequest): EagerBranchFanOut {
			result.starts++;
			result.requests.push(request);
			const fanOut = inner.startManyEager(count, request);
			const live: BranchCallHandle[] = [];
			const sync = () => {
				for (let index = live.length; index < fanOut.handles.length; index++)
					live.push(wrap(fanOut.handles[index]));
			};
			sync();
			return {
				handles: live,
				settled: fanOut.settled.then(() => {
					sync();
					return live;
				}),
			};
		},
	};
	result.coordinator = new SecondThoughtCoordinator(host, recording);
	return result;
}

/**
 * The invariant every test closes on: the coordinator holds nothing, and every
 * branch it ever started was told to stop.
 */
async function expectNoBranchOutlives(h: Harness): Promise<void> {
	expect(h.coordinator.activeBranchCount).toBe(0);
	expect(h.coordinator.activeGeneration).toBeUndefined();
	for (const entry of h.handles) expect(entry.aborts.length).toBeGreaterThan(0);
	h.provider.release();
	await h.coordinator.whenSettled();
}

/**
 * A fresh partial instance per event, mirroring `snapshotAssistantMessage`.
 *
 * `agent-loop.ts` reassigns `partialMessage = event.partial` on every stream
 * event, so the interceptor never sees the same object twice. A harness that
 * reuses one object cannot detect a single-fire keyed on object identity —
 * exactly the defect gauntlet round 1 found.
 */
function snapshotPartial(partial: AssistantMessage): AssistantMessage {
	return {
		...partial,
		content: partial.content.map(block => ({ ...block })),
		usage: partial.usage ? { ...partial.usage } : undefined,
	} as AssistantMessage;
}

let streamTokenSeq = 0;

interface StreamOptions {
	/** Host stream token; a fresh one per call unless pinned. */
	token?: unknown;
	/** Skip the host arming call (a host that never wires `noteStreamStart`). */
	arm?: boolean;
	/** How many tool calls this one streaming message emits. */
	toolCalls?: number;
}

/**
 * Replay one provider stream the way `agent-loop.ts` drives the interceptor:
 * the wiring arms the stream at `message_start`, then every CONTENT event
 * (`thinking_*` / `toolcall_*`) reaches `onAssistantEvent` with its own partial.
 *
 * Note what is deliberately absent: no `start`-typed `AssistantMessageEvent`.
 * The loop's `case "start"` pushes `message_start` to the session stream and
 * never calls `config.onAssistantMessageEvent`, so the coordinator cannot see
 * one on the live surface.
 */
function streamToolCall(h: Harness, partial: AssistantMessage, options: StreamOptions = {}): void {
	const { arm = true, token = `stream-${++streamTokenSeq}`, toolCalls = 1 } = options;
	if (arm) h.coordinator.noteStreamStart(token);
	h.coordinator.onAssistantEvent({
		type: "thinking_delta",
		contentIndex: 0,
		delta: CONDITIONING,
		partial: snapshotPartial(partial),
	} as AssistantMessageEvent);
	for (let index = 0; index < toolCalls; index++) {
		const contentIndex = 1 + index;
		h.coordinator.onAssistantEvent({
			type: "toolcall_start",
			contentIndex,
			partial: snapshotPartial(partial),
		} as AssistantMessageEvent);
		h.coordinator.onAssistantEvent({
			type: "toolcall_delta",
			contentIndex,
			delta: "{}",
			partial: snapshotPartial(partial),
		} as AssistantMessageEvent);
		h.coordinator.onAssistantEvent({
			type: "toolcall_end",
			contentIndex,
			toolCall: { id: `t${index}`, name: "read", arguments: {} },
			partial: snapshotPartial(partial),
		} as unknown as AssistantMessageEvent);
	}
}

/** Let the fire-and-forget fork actually start its branches. */
async function settleFork(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
	await new Promise(resolve => setTimeout(resolve, 1));
}

const openHarnesses: Harness[] = [];
function track(h: Harness): Harness {
	openHarnesses.push(h);
	return h;
}

afterEach(() => {
	for (const h of openHarnesses.splice(0)) {
		h.coordinator.dispose();
		h.provider.release();
	}
});

// ── conditioning ────────────────────────────────────────────────────────────

describe("conditioning text", () => {
	it("prefers thinking blocks and falls back to emitted prose", () => {
		expect(buildConditioningText(streamingPartial())).toBe(CONDITIONING);
		expect(
			buildConditioningText({
				role: "assistant",
				content: [{ type: "text", text: "prose only" }],
			} as AssistantMessage),
		).toBe("prose only");
		expect(
			buildConditioningText({
				role: "assistant",
				content: [{ type: "redactedThinking", data: "opaque" }],
			} as unknown as AssistantMessage),
		).toBe("");
		expect(buildConditioningText(undefined)).toBe("");
	});
});

// ── fork trigger ────────────────────────────────────────────────────────────

describe("fork trigger", () => {
	it("forks on the first toolcall_start of an armed stream", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();

		expect(h.coordinator.forkCount).toBe(1);
		expect(h.starts).toBe(1);
		expect(h.ledger.forks).toHaveLength(1);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});

	it("forks ONCE across a multi-tool message even though every event carries a fresh partial", async () => {
		// The regression gauntlet r1 found: `agent-loop` reassigns
		// `partialMessage = event.partial` per event, so identity-keyed single-fire
		// cancelled and re-forked on every tool call of a batch.
		const h = track(harness());
		streamToolCall(h, streamingPartial(), { toolCalls: 4 });
		await settleFork();

		expect(h.coordinator.forkCount).toBe(1);
		expect(h.starts).toBe(1);
		expect(h.provider.calls).toHaveLength(1);
		expect(h.ledger.drops).toHaveLength(0);
		expect(h.coordinator.activeGeneration).toBe(1);

		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(1);
		await expectNoBranchOutlives(h);
	});

	it("evaluates the gate once per stream, so a skipped batch records one skip", async () => {
		const h = track(harness({ overrides: { "secondThought.minConditioningChars": 5000 } }));
		streamToolCall(h, streamingPartial(), { toolCalls: 5 });
		await settleFork();

		expect(h.ledger.skips.map(skip => skip.reason)).toEqual(["conditioning-too-short"]);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});

	it("does not fork on text, thinking, or toolcall_delta events", async () => {
		const h = track(harness());
		const partial = streamingPartial();
		h.coordinator.noteStreamStart("s1");
		for (const event of [
			{ type: "text_delta", contentIndex: 0, delta: "writing prose" },
			{ type: "thinking_delta", contentIndex: 0, delta: CONDITIONING },
			{ type: "toolcall_delta", contentIndex: 1, delta: "{" },
		]) {
			h.coordinator.onAssistantEvent({ ...event, partial: snapshotPartial(partial) } as AssistantMessageEvent);
		}
		await settleFork();

		expect(h.coordinator.forkCount).toBe(0);
		expect(h.provider.calls).toHaveLength(0);
		await expectNoBranchOutlives(h);
	});

	it("does nothing at turn end for a no-tool turn", async () => {
		const h = track(harness());
		h.coordinator.noteStreamStart("s1");
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.folds).toHaveLength(0);
		expect(h.ledger.drops).toHaveLength(0);
		await expectNoBranchOutlives(h);
	});

	it("still forks once per turn when the host never arms a stream", async () => {
		// A host that has not wired `noteStreamStart` must degrade to one fork per
		// turn, not one fork for the whole session.
		const h = track(harness());
		streamToolCall(h, streamingPartial(), { arm: false, toolCalls: 3 });
		await settleFork();
		expect(h.coordinator.forkCount).toBe(1);
		await h.coordinator.onPrimaryTurnEnd();

		streamToolCall(h, streamingPartial(CONDITIONING, 2000), { arm: false });
		await settleFork();
		expect(h.coordinator.forkCount).toBe(2);
		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(2);
		await expectNoBranchOutlives(h);
	});

	it("records a `disposed` skip when a tool call arrives after dispose", async () => {
		const h = track(harness());
		h.coordinator.dispose();
		streamToolCall(h, streamingPartial());
		await settleFork();

		expect(h.ledger.skips.map(skip => skip.reason)).toEqual(["disposed"]);
		expect(h.coordinator.forkCount).toBe(0);
		await expectNoBranchOutlives(h);
	});

	it("passes the fork-time snapshot and conditioning to the branch call", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();

		expect(h.provider.calls).toHaveLength(1);
		const call = h.provider.calls[0];
		expect(call.model.id).toBe(ANTHROPIC.id);
		expect(call.options.sessionId).toContain("sess-1:side:reflect:");
		expect(call.options.promptCacheKey).toBe("cache-1");
		const last = call.context.messages.at(-1) as Message;
		expect(last.role).toBe("user");
		expect(JSON.stringify(last.content)).toContain(CONDITIONING);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});
});

// ── skip conditions ─────────────────────────────────────────────────────────

describe("skip conditions", () => {
	async function expectSkip(h: Harness, reason: SecondThoughtSkipReason): Promise<void> {
		streamToolCall(h, streamingPartial());
		await settleFork();
		expect(h.ledger.skips.map(skip => skip.reason)).toEqual([reason]);
		expect(h.coordinator.forkCount).toBe(0);
		expect(h.provider.calls).toHaveLength(0);
		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(0);
		await expectNoBranchOutlives(h);
	}

	it("skips when the feature is disabled", async () => {
		await expectSkip(track(harness({ overrides: { "secondThought.enabled": false } })), "disabled");
	});

	it("skips sub-sessions", async () => {
		await expectSkip(track(harness({ agentKind: "sub" })), "sub-session");
	});

	it("skips a non-Anthropic primary model", async () => {
		await expectSkip(track(harness({ primaryModel: OPENAI })), "primary-model-not-anthropic");
	});

	it("skips when the conditioning text is below the minimum", async () => {
		const h = track(harness({ overrides: { "secondThought.minConditioningChars": 500 } }));
		await expectSkip(h, "conditioning-too-short");
		expect(h.ledger.skips[0].info).toMatchObject({ minChars: 500 });
	});

	it("skips when the context estimate exceeds the cap", async () => {
		const h = track(
			harness({
				overrides: { "secondThought.maxContextTokens": 1000 },
				estimateContextTokens: () => 5000,
			}),
		);
		await expectSkip(h, "context-too-large");
	});

	it("skips while the provider is in a 429 cooldown, and forks again after it lapses", async () => {
		let clock = 10_000;
		const h = track(harness({ now: () => clock }));
		h.coordinator.noteProviderRateLimit("anthropic", 5_000);
		streamToolCall(h, streamingPartial());
		await settleFork();
		expect(h.ledger.skips.map(skip => skip.reason)).toEqual(["provider-cooldown"]);

		clock = 20_000;
		streamToolCall(h, streamingPartial(CONDITIONING, 2000));
		await settleFork();
		expect(h.coordinator.forkCount).toBe(1);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});

	// The cap must SEAT main + K branches, so the boundary is `limit < K + 1`.
	// The original `<=` meant the canonical Anthropic cap of 2 with K=1 — main
	// call plus exactly one branch, the shape the feature is designed around —
	// never forked at all.
	it("forks at the in-flight cap boundary (limit 2, one branch)", async () => {
		const h = track(
			harness({
				overrides: { "providers.maxInFlightRequests": { anthropic: 2 }, "secondThought.branchCount": 1 },
			}),
		);
		streamToolCall(h, streamingPartial());
		await settleFork();

		expect(h.ledger.skips).toHaveLength(0);
		expect(h.coordinator.forkCount).toBe(1);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});

	it("skips one below the in-flight cap boundary (limit 2, two branches)", async () => {
		const h = track(
			harness({
				overrides: { "providers.maxInFlightRequests": { anthropic: 2 }, "secondThought.branchCount": 2 },
			}),
		);
		await expectSkip(h, "in-flight-cap");
		expect(h.ledger.skips[0].info).toMatchObject({ limit: 2, branchCount: 2 });
	});

	it("forks when the cap exactly seats the main call and every branch", async () => {
		const h = track(
			harness({
				overrides: { "providers.maxInFlightRequests": { anthropic: 3 }, "secondThought.branchCount": 2 },
			}),
		);
		streamToolCall(h, streamingPartial());
		await settleFork();
		expect(h.coordinator.forkCount).toBe(1);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});

	it("skips when the fork-time snapshot ends in a developer turn", async () => {
		const h = track(
			harness({
				prepareFork: () => ({
					context: mainContext({
						role: "developer",
						content: [{ type: "text", text: "reminder" }],
						timestamp: 5,
					} as unknown as Message),
					cacheSessionId: "sess-1",
					streamOptions: {} as BranchStreamOptions,
				}),
			}),
		);
		await expectSkip(h, "developer-tail");
	});

	it("skips when the host cannot materialize a fork context", async () => {
		await expectSkip(track(harness({ prepareFork: () => undefined })), "no-fork-context");
	});

	it("skips when the host's prepareFork throws", async () => {
		await expectSkip(
			track(
				harness({
					prepareFork: () => {
						throw new Error("no context");
					},
				}),
			),
			"no-fork-context",
		);
	});

	it("skips when the snapshot is not structured-cloneable", async () => {
		const context = mainContext();
		(context.messages[0] as unknown as { bad: unknown }).bad = () => "not cloneable";
		await expectSkip(
			track(
				harness({
					prepareFork: () => ({
						context,
						cacheSessionId: "sess-1",
						streamOptions: {} as BranchStreamOptions,
					}),
				}),
			),
			"snapshot-failed",
		);
	});

	/** Turn 1 measures a slow branch TTFT inside a 1ms tool-batch window. */
	async function primeAdaptiveSkip(h: Harness, clock: { value: number }): Promise<void> {
		clock.value = 0;
		streamToolCall(h, streamingPartial(CONDITIONING, 1));
		await settleFork();
		// Let the branch actually produce its first token so a TTFT is measured.
		await new Promise(resolve => setTimeout(resolve, 20));
		clock.value = 1; // 1ms window — far below the branch's measured TTFT
		await h.coordinator.onPrimaryTurnEnd();
		await h.coordinator.whenSettled();
		expect(h.ledger.results.length).toBeGreaterThan(0);
		expect(h.coordinator.forkCount).toBe(1);
	}

	it("skips adaptively when tool batches finish faster than branch first-token", async () => {
		const clock = { value: 0 };
		const h = track(harness({ now: () => clock.value, script: { firstDelayMs: 5 }, adaptiveProbeInterval: 100 }));
		await primeAdaptiveSkip(h, clock);

		for (let turn = 0; turn < 5; turn++) {
			streamToolCall(h, streamingPartial(CONDITIONING, 10 + turn));
			await settleFork();
			await h.coordinator.onPrimaryTurnEnd();
		}
		expect(h.coordinator.forkCount).toBe(1);
		expect(h.ledger.skips.map(skip => skip.reason)).toEqual(Array(5).fill("adaptive-window"));
		await expectNoBranchOutlives(h);
	});

	it("forks anyway on the probe interval, so the estimate cannot pin the feature off", async () => {
		// Pinned against the injected interval: deleting the probe branch makes
		// turn 3 skip and this test fail, which the previous (uninjected,
		// interval-20) version could not detect.
		const clock = { value: 0 };
		const h = track(harness({ now: () => clock.value, script: { firstDelayMs: 5 }, adaptiveProbeInterval: 3 }));
		await primeAdaptiveSkip(h, clock);

		const forksPerTurn: number[] = [];
		for (let turn = 0; turn < 6; turn++) {
			const before = h.coordinator.forkCount;
			streamToolCall(h, streamingPartial(CONDITIONING, 10 + turn));
			await settleFork();
			forksPerTurn.push(h.coordinator.forkCount - before);
			await h.coordinator.onPrimaryTurnEnd();
			await h.coordinator.whenSettled();
		}
		// skip, skip, PROBE, skip, skip, PROBE
		expect(forksPerTurn).toEqual([0, 0, 1, 0, 0, 1]);
		expect(h.ledger.skips.map(skip => skip.reason)).toEqual(Array(4).fill("adaptive-window"));
		await expectNoBranchOutlives(h);
	});
});

// ── harvest ─────────────────────────────────────────────────────────────────

describe("harvest", () => {
	it("harvests settled units, interleaves the fold, and hands it to the host", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.folds).toHaveLength(1);
		const fold = h.folds[0];
		expect(fold.units).toEqual([
			["check", "the fixture path may be stale"],
			["recall", "the parser repairs malformed closers"],
		]);
		expect(fold.unitsByAtom.check).toEqual(["the fixture path may be stale"]);
		expect(fold.fold).toContain('<reflect type="check">the fixture path may be stale</reflect>');
		expect(fold.fold).toContain('<reflect type="recall">the parser repairs malformed closers</reflect>');
		expect(fold.settledCount).toBe(1);
		expect(fold.epoch).toBe(1);
		expect(h.ledger.harvests).toHaveLength(1);
		expect(h.ledger.results).toHaveLength(1);
		await expectNoBranchOutlives(h);
	});

	it("caps harvested units per atom", async () => {
		const many = Array.from({ length: 5 }, (_, index) => `<reflect type="check">unit ${index}</reflect>`).join("");
		const h = track(harness({ overrides: { "secondThought.harvestCapPerAtom": 2 }, script: { deltas: [many] } }));
		streamToolCall(h, streamingPartial());
		await settleFork();
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.folds[0].unitsByAtom.check).toEqual(["unit 0", "unit 1"]);
		await expectNoBranchOutlives(h);
	});

	it("drops the fold when the history epoch moved between fork and harvest", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();
		h.epoch.value = 2; // rewind / replaceMessages / compaction
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.folds).toHaveLength(0);
		expect(h.ledger.drops.map(drop => drop.reason)).toEqual(["history-epoch"]);
		// Usage still attributed even though the fold is discarded.
		expect(h.ledger.results).toHaveLength(1);
		await expectNoBranchOutlives(h);
	});

	it("drops when the branch produced no units", async () => {
		const h = track(harness({ script: { deltas: ["no markup here"] } }));
		streamToolCall(h, streamingPartial());
		await settleFork();
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.folds).toHaveLength(0);
		expect(h.ledger.drops.map(drop => drop.reason)).toEqual(["no-units"]);
		await expectNoBranchOutlives(h);
	});

	it("bounds the harvest at the grace even against a wedged provider stream", async () => {
		const wedged = track(harness({ script: { wedge: true }, graceMs: HARVEST_GRACE_MS, finalizerTimeoutMs: 50 }));
		streamToolCall(wedged, streamingPartial());
		await settleFork();

		const startedAt = Date.now();
		await wedged.coordinator.onPrimaryTurnEnd();
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeLessThan(HARVEST_GRACE_MS * 3);
		expect(wedged.folds).toHaveLength(0);
		expect(wedged.ledger.drops.map(drop => drop.reason)).toEqual(["no-settled-branches"]);
		expect(wedged.coordinator.activeBranchCount).toBe(0);
		for (const entry of wedged.handles) expect(entry.aborts.length).toBeGreaterThan(0);
	});
});

// ── cancellation exit paths ─────────────────────────────────────────────────

describe("cancellation exit paths", () => {
	async function expectCancelled(h: Harness, reason: SecondThoughtDropReason): Promise<void> {
		expect(h.folds).toHaveLength(0);
		expect(h.ledger.drops.map(drop => drop.reason)).toContain(reason);
		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(0);
		await expectNoBranchOutlives(h);
	}

	it("cancels on the run abort signal (user Esc mid-stream)", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();
		h.controller.abort("user-abort");
		await expectCancelled(h, "cancelled");
		expect(h.ledger.drops[0].info).toMatchObject({ reason: "run-abort" });
	});

	it("cancels on an explicit session abort mid tool batch", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();
		h.coordinator.cancelActive("session-abort");
		await expectCancelled(h, "cancelled");
	});

	it("cancels on a compaction-shaped reset and clears adaptive state", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();
		h.coordinator.reset("reset");
		await expectCancelled(h, "cancelled");
	});

	it("cancels on dispose and refuses to fork afterwards", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();
		h.coordinator.dispose();
		streamToolCall(h, streamingPartial(CONDITIONING, 2000));
		await settleFork();

		expect(h.coordinator.forkCount).toBe(1);
		await expectCancelled(h, "cancelled");
	});

	it("cancels when the fork is aborted while the branches are still starting", async () => {
		let release = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const provider = fakeProvider();
		const inner = new BranchCaller({ streamFn: provider.streamFn as never });
		// A starter whose handles ALL arrive late: the coordinator's cancel walks
		// an empty array and must still tear down what appears afterwards.
		const slowStarter: BranchStarter = {
			startManyEager(count, request) {
				const handles: BranchCallHandle[] = [];
				const settled = gate.then(async () => {
					handles.push(...(await inner.startMany(count, request)));
					return handles;
				});
				return { handles, settled };
			},
		};
		const h = track(harness({ starter: slowStarter, script: {} }));
		streamToolCall(h, streamingPartial());
		h.coordinator.cancelActive("session-abort");
		release();
		await settleFork();

		expect(h.handles.length).toBeGreaterThan(0);
		await expectCancelled(h, "cancelled");
		provider.release();
	});

	it("publishes the first handle synchronously, so a same-tick cancel has something to abort", async () => {
		const h = track(harness({ script: { firstDelayMs: 200 } }));
		streamToolCall(h, streamingPartial());
		// No await: the fork was started inside the event handler above.
		expect(h.coordinator.activeBranchCount).toBe(1);
		h.coordinator.cancelActive("session-abort");
		expect(h.handles).toHaveLength(1);
		expect(h.handles[0].aborts.length).toBeGreaterThan(0);
		await expectCancelled(h, "cancelled");
	});

	it("aborts the branch signal synchronously on every teardown path", async () => {
		for (const teardown of ["cancelActive", "reset", "dispose", "turnEnd"] as const) {
			const h = track(harness({ script: { firstDelayMs: 200 } }));
			streamToolCall(h, streamingPartial());
			const signal = h.requests[0].signal as AbortSignal;
			expect(signal.aborted).toBe(false);
			if (teardown === "cancelActive") h.coordinator.cancelActive("session-abort");
			else if (teardown === "reset") h.coordinator.reset("reset");
			else if (teardown === "dispose") h.coordinator.dispose();
			else void h.coordinator.onPrimaryTurnEnd();
			// Synchronously, before any await: the queued branches check this
			// signal before firing, so they never start.
			expect(signal.aborted).toBe(true);
		}
	});

	it("is idempotent", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial());
		await settleFork();
		h.coordinator.cancelActive("session-abort");
		h.coordinator.cancelActive("session-abort");
		h.coordinator.dispose();
		h.coordinator.dispose();

		expect(h.ledger.drops).toHaveLength(1);
		await expectNoBranchOutlives(h);
	});

	it("does not fork when the run signal is already aborted", async () => {
		const h = track(harness());
		h.controller.abort("already");
		streamToolCall(h, streamingPartial());
		await settleFork();

		expect(h.starts).toBe(0);
		expect(h.ledger.drops.map(drop => drop.reason)).toEqual(["cancelled"]);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});
});

// ── re-arm semantics ────────────────────────────────────────────────────────

describe("re-arm semantics", () => {
	it("cancels the stale generation and re-arms on a second streaming sequence (Harmony abort-retry)", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial(CONDITIONING, 1000), { token: "call-1" });
		await settleFork();
		expect(h.coordinator.activeGeneration).toBe(1);

		// The abort-retry `continue`s into a whole new provider call: new stream,
		// new token, same turn.
		streamToolCall(h, streamingPartial(CONDITIONING, 1000), { token: "call-2" });
		await settleFork();

		expect(h.coordinator.forkCount).toBe(2);
		expect(h.coordinator.activeGeneration).toBe(2);
		expect(h.ledger.drops.map(drop => drop.reason)).toEqual(["superseded"]);
		expect(h.handles[0].aborts.length).toBeGreaterThan(0);

		await h.coordinator.onPrimaryTurnEnd();
		// Only the surviving generation's harvest is delivered.
		expect(h.folds).toHaveLength(1);
		expect(h.folds[0].generation).toBe(2);
		await expectNoBranchOutlives(h);
	});

	it("does not re-arm on truncate-resume, replaying agent-loop's real event set", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial(), { token: "call-1" });
		await settleFork();
		const generation = h.coordinator.activeGeneration ?? 0;

		// agent-loop's truncate-and-resume path (`if (recovered)`) pushes exactly
		// this: a `message_start` and a `message_end` for the recovered message,
		// and NOTHING else — no `toolcall_start`, no content events, no new
		// provider stream. Per the host contract the wiring either does not arm at
		// all, or arms with the same token; both must leave the fork alone.
		h.coordinator.noteStreamStart("call-1"); // same token = same stream
		// (no assistant content events reach the interceptor on this path)

		expect(h.coordinator.forkCount).toBe(1);
		expect(h.coordinator.activeGeneration).toBe(generation);
		expect(h.ledger.drops).toHaveLength(0);
		expect(h.handles[0].aborts).toHaveLength(0);

		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(1);
		expect(h.folds[0].generation).toBe(generation);
		await expectNoBranchOutlives(h);
	});

	it("re-arms on a same-millisecond replacement stream, which timestamps cannot distinguish", async () => {
		const fixed = () => 4242;
		const h = track(harness({ now: fixed }));
		streamToolCall(h, streamingPartial(CONDITIONING, 4242), { token: "call-1" });
		await settleFork();
		streamToolCall(h, streamingPartial(CONDITIONING, 4242), { token: "call-2" });
		await settleFork();

		expect(h.ledger.forks.map(fork => fork.generation)).toEqual([1, 2]);
		expect(h.ledger.forks[0].forkedAt).toBe(h.ledger.forks[1].forkedAt);
		expect(h.coordinator.activeGeneration).toBe(2);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});

	it("is idempotent for a repeated stream token", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial(), { token: "call-1" });
		await settleFork();
		h.coordinator.noteStreamStart("call-1");
		h.coordinator.noteStreamStart("call-1");
		await settleFork();

		expect(h.coordinator.forkCount).toBe(1);
		expect(h.coordinator.activeGeneration).toBe(1);
		expect(h.ledger.drops).toHaveLength(0);
		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(1);
		await expectNoBranchOutlives(h);
	});

	it("cancels a live fork when a new stream is armed before any tool call", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial(), { token: "call-1" });
		await settleFork();
		h.coordinator.noteStreamStart("call-2");

		expect(h.coordinator.activeGeneration).toBeUndefined();
		expect(h.ledger.drops.map(drop => drop.reason)).toEqual(["superseded"]);
		expect(h.handles[0].aborts.length).toBeGreaterThan(0);
		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(0);
		await expectNoBranchOutlives(h);
	});

	it("re-forks on the next turn after a completed harvest", async () => {
		const h = track(harness());
		streamToolCall(h, streamingPartial(CONDITIONING, 1));
		await settleFork();
		await h.coordinator.onPrimaryTurnEnd();
		streamToolCall(h, streamingPartial(CONDITIONING, 2));
		await settleFork();
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.coordinator.forkCount).toBe(2);
		expect(h.folds).toHaveLength(2);
		await expectNoBranchOutlives(h);
	});
});

// ── failure containment ─────────────────────────────────────────────────────

describe("failure containment", () => {
	it("never throws out of the trigger when a host hook fails", async () => {
		const h = track(
			harness({
				prepareFork: () => {
					throw new Error("boom");
				},
			}),
		);
		expect(() => streamToolCall(h, streamingPartial())).not.toThrow();
		await settleFork();
		await expectNoBranchOutlives(h);
	});

	it("never throws out of turn end when harvest delivery fails", async () => {
		const h = track(
			harness({
				deliverHarvest: () => {
					throw new Error("fold store exploded");
				},
			}),
		);
		streamToolCall(h, streamingPartial());
		await settleFork();
		await h.coordinator.onPrimaryTurnEnd();

		// The harvest still reached the ledger; only delivery failed.
		expect(h.ledger.harvests).toHaveLength(1);
		await expectNoBranchOutlives(h);
	});

	it("survives a starter that violates the never-throws contract", async () => {
		const h = track(
			harness({
				starter: {
					startManyEager: () => {
						throw new Error("startManyEager exploded");
					},
				},
			}),
		);
		streamToolCall(h, streamingPartial());
		await settleFork();

		expect(h.coordinator.activeGeneration).toBeUndefined();
		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(0);
		await expectNoBranchOutlives(h);
	});

	it("survives a starter whose settled promise rejects", async () => {
		const provider = fakeProvider();
		const inner = new BranchCaller({ streamFn: provider.streamFn as never });
		const h = track(
			harness({
				starter: {
					startManyEager(count, request) {
						const fanOut = inner.startManyEager(count, request);
						return { handles: fanOut.handles, settled: Promise.reject(new Error("stagger exploded")) };
					},
				},
			}),
		);
		streamToolCall(h, streamingPartial());
		await settleFork();

		expect(h.coordinator.activeBranchCount).toBe(1);
		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(1);
		await expectNoBranchOutlives(h);
		provider.release();
	});
});

// ── stagger races (gauntlet round 1) ────────────────────────────────────────

describe("stagger races", () => {
	/**
	 * A starter that publishes call 1 immediately and holds calls 2..K behind a
	 * manual gate — the real stagger's shape, made deterministic.
	 *
	 * The gate is bounded by `request.signal` exactly as the real
	 * `#awaitStaggerGate` is. That fidelity is load-bearing rather than
	 * decorative: a fake whose `settled` can only resolve on `lift()` never runs
	 * its tail during a teardown, so it cannot see the tail race the harvest for
	 * the same handles — which is precisely how the K=2 turn-end test read green
	 * over a real drop.
	 */
	function staggeredStarter(inner: BranchCaller): {
		starter: BranchStarter;
		lift(): void;
		started: number;
	} {
		let lift = () => {};
		const gate = new Promise<void>(resolve => {
			lift = resolve;
		});
		const state = { started: 0 };
		const starter: BranchStarter = {
			startManyEager(count, request) {
				const handles: BranchCallHandle[] = [inner.start(request)];
				state.started++;
				const signal = request.signal;
				const aborted = new Promise<void>(resolve => {
					if (!signal) return;
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				const settled = Promise.race([gate, aborted]).then(() => {
					// Exactly what `startManyEager` does after its gate lifts.
					if (request.signal?.aborted) return handles;
					for (let index = 1; index < count; index++) {
						handles.push(inner.start(request));
						state.started++;
					}
					return handles;
				});
				return { handles, settled };
			},
		};
		return {
			starter,
			lift: () => lift(),
			get started() {
				return state.started;
			},
		};
	}

	it("turn end during the stagger wait harvests branch 1 and never starts the rest", async () => {
		const provider = fakeProvider();
		const inner = new BranchCaller({ streamFn: provider.streamFn as never });
		const staggered = staggeredStarter(inner);
		const h = track(
			harness({
				starter: staggered.starter,
				overrides: { "secondThought.branchCount": 2 },
			}),
		);
		streamToolCall(h, streamingPartial());
		// Branch 1 exists on the same tick; branch 2 is still behind the gate.
		expect(h.coordinator.activeBranchCount).toBe(1);
		expect(staggered.started).toBe(1);

		// The tool batch beat the branch TTFT — the exact case that used to
		// harvest nothing and then start K−1 calls into a finished turn.
		await h.coordinator.onPrimaryTurnEnd();
		staggered.lift();
		await settleFork();
		await h.coordinator.whenSettled();

		expect(staggered.started).toBe(1);
		expect(h.folds).toHaveLength(1);
		expect(h.folds[0].units.map(unit => unit[0])).toEqual(["check", "recall"]);
		expect(h.ledger.results).toHaveLength(1);
		await expectNoBranchOutlives(h);
		provider.release();
	});

	it("cancel during the stagger wait never starts the remaining branches", async () => {
		const provider = fakeProvider();
		const inner = new BranchCaller({ streamFn: provider.streamFn as never });
		const staggered = staggeredStarter(inner);
		const h = track(harness({ starter: staggered.starter, overrides: { "secondThought.branchCount": 3 } }));
		streamToolCall(h, streamingPartial());
		h.coordinator.cancelActive("session-abort");
		staggered.lift();
		await settleFork();

		expect(staggered.started).toBe(1);
		expect(h.handles).toHaveLength(1);
		// Attributed exactly once, even though the cancel path and the stagger
		// tail both reached the same handle.
		await h.coordinator.whenSettled();
		expect(h.ledger.results).toHaveLength(1);
		await expectNoBranchOutlives(h);
		provider.release();
	});

	it("real startManyEager: K=2 turn end during the gate still folds handle 0's units", async () => {
		// The round-2 HIGH, end to end against the REAL stagger gate rather than a
		// fake one. Turn end aborts synchronously, which is one of the three things
		// the real gate is bounded by, so `fanOut.settled` resolves at the harvest's
		// FIRST await. If the harvest has not already claimed handle 0 by then, the
		// settled tail claims it into the ledger-only finalizer and the fold is lost
		// as `no-settled-branches` — silently, since the ledger still shows a paid
		// branch result.
		const h = track(
			harness({
				// First token deliberately later than the tool batch: the gate is
				// still open at turn end, so branch 2 is never sent. The chunks
				// already in flight land after the abort and are still harvestable.
				script: { firstDelayMs: 5, deltasSurviveAbort: true },
				graceMs: 200,
				overrides: { "secondThought.branchCount": 2 },
			}),
		);
		streamToolCall(h, streamingPartial());
		expect(h.coordinator.activeBranchCount).toBe(1);
		expect(h.provider.calls).toHaveLength(1);

		await h.coordinator.onPrimaryTurnEnd();

		// Branch 2 never started: the gate was bounded by the turn-end abort.
		expect(h.provider.calls).toHaveLength(1);
		// Handle 0 settled inside the 200ms grace, so its units MUST fold.
		expect(h.folds).toHaveLength(1);
		expect(h.folds[0].units.map(unit => unit[0])).toEqual(["check", "recall"]);
		expect(h.folds[0].settledCount).toBe(1);
		expect(h.ledger.drops).toHaveLength(0);
		// And exactly one ledger attribution — the tail must not have drained a
		// handle the harvest already owned.
		expect(h.ledger.results).toHaveLength(1);
		await expectNoBranchOutlives(h);
		expect(h.ledger.results).toHaveLength(1);
	});

	it("real BranchCaller.startManyEager publishes handle 0 before the gate and honours a sync abort", async () => {
		const provider = fakeProvider({ firstDelayMs: 50 });
		const h = track(harness({ script: { firstDelayMs: 50 }, overrides: { "secondThought.branchCount": 3 } }));
		streamToolCall(h, streamingPartial());
		expect(h.coordinator.activeBranchCount).toBe(1);
		expect(h.provider.calls).toHaveLength(1);

		h.coordinator.cancelActive("session-abort");
		await new Promise(resolve => setTimeout(resolve, 80));
		// The gate lifted after the abort; branches 2 and 3 were never sent.
		expect(h.provider.calls).toHaveLength(1);
		await expectNoBranchOutlives(h);
		provider.release();
	});
});

// ── state-write guards (gauntlet round 1) ───────────────────────────────────

describe("state-write guards", () => {
	it("refuses to deliver a fold when reset lands during the harvest", async () => {
		// `reset` is wired for model change, which does NOT move the history
		// epoch — the history check alone cannot see this.
		const h = track(
			harness({
				script: { firstDelayMs: 15 },
				graceMs: 200,
				deliverHarvest: () => {
					throw new Error("delivery must not be reached");
				},
			}),
		);
		streamToolCall(h, streamingPartial());
		await settleFork();

		const turnEnd = h.coordinator.onPrimaryTurnEnd();
		h.coordinator.reset("reset"); // model change, mid-grace
		await turnEnd;

		expect(h.folds).toHaveLength(0);
		expect(h.ledger.harvests).toHaveLength(0);
		expect(h.ledger.drops.map(drop => drop.reason)).toContain("coordinator-epoch");
		await expectNoBranchOutlives(h);
	});

	it("does not let a post-reset finalizer write the adaptive EMAs", async () => {
		const clock = { value: 0 };
		// The branch emits its first token (so a TTFT exists to be measured) and
		// then wedges, so it can only settle inside the DETACHED finalizer — the
		// window in which `reset()` routinely lands.
		const h = track(
			harness({
				now: () => clock.value,
				script: { firstDelayMs: 1, wedge: true },
				graceMs: 1,
				finalizerTimeoutMs: 2_000,
			}),
		);
		streamToolCall(h, streamingPartial());
		await settleFork();
		await new Promise(resolve => setTimeout(resolve, 20)); // first token streamed
		clock.value = 5;
		await h.coordinator.onPrimaryTurnEnd(); // grace 1ms — the wedged branch misses it
		expect(h.coordinator.adaptiveEmas.branchTtftMs).toBeUndefined();

		h.coordinator.reset("reset"); // model change while the finalizer is in flight
		h.provider.release();
		await h.coordinator.whenSettled();

		// The usage the branch already incurred is still attributed; the adaptive
		// state, which steers the NEXT conversation, is not touched.
		expect(h.ledger.results).toHaveLength(1);
		expect(h.ledger.results[0].ttftMs).toBeGreaterThan(0);
		expect(h.coordinator.adaptiveEmas).toEqual({ toolBatchMs: undefined, branchTtftMs: undefined });
		await expectNoBranchOutlives(h);
	});

	it("does not let a rewound turn's window steer the adaptive skip", async () => {
		const clock = { value: 0 };
		const h = track(harness({ now: () => clock.value }));
		streamToolCall(h, streamingPartial());
		await settleFork();
		clock.value = 9999;
		h.epoch.value = 2; // rewind under the fork
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.ledger.drops.map(drop => drop.reason)).toEqual(["history-epoch"]);
		expect(h.coordinator.adaptiveEmas.toolBatchMs).toBeUndefined();
		// Both EMAs, not just the tool-batch one. A history-epoch move is a
		// teardown the coordinator epoch cannot see, and the branch DID settle with
		// a real TTFT here — gating that write on the coordinator epoch alone let a
		// rewound turn steer the adaptive window through the other door.
		expect(h.coordinator.adaptiveEmas.branchTtftMs).toBeUndefined();
		// The money the branch already cost is still attributed: the split between
		// ledger truth and adaptive state is the documented policy.
		expect(h.ledger.results).toHaveLength(1);
		await expectNoBranchOutlives(h);
		expect(h.coordinator.adaptiveEmas).toEqual({ toolBatchMs: undefined, branchTtftMs: undefined });
	});

	it("records the tool-batch window on a surviving harvest", async () => {
		const clock = { value: 0 };
		const h = track(harness({ now: () => clock.value }));
		streamToolCall(h, streamingPartial());
		await settleFork();
		clock.value = 1234;
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.folds[0].windowMs).toBe(1234);
		expect(h.coordinator.adaptiveEmas.toolBatchMs).toBe(1234);
		await expectNoBranchOutlives(h);
	});
});

// ── bounds (gauntlet round 1) ───────────────────────────────────────────────

describe("bounds", () => {
	it("keeps the loop on the grace even when the finalizer bound is production-magnitude", async () => {
		// The finalizer is 10s in production; the invariant is that the primary
		// loop never observes it. Real timers here would hang the suite for 10s
		// exactly when the invariant is broken, which is the point.
		const clock = { value: 0 };
		const h = track(
			harness({
				now: () => clock.value,
				script: { wedge: true },
				graceMs: 30,
				finalizerTimeoutMs: FINALIZER_TIMEOUT_MS,
			}),
		);
		expect(FINALIZER_TIMEOUT_MS).toBe(10_000);
		streamToolCall(h, streamingPartial());
		await settleFork();

		const startedAt = Date.now();
		await h.coordinator.onPrimaryTurnEnd();
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeLessThan(1_000);
		expect(h.folds).toHaveLength(0);
		expect(h.ledger.drops.map(drop => drop.reason)).toEqual(["no-settled-branches"]);
		expect(h.coordinator.activeBranchCount).toBe(0);
		// Releasing the wedge lets the finalizer settle well inside its bound, so
		// the usage the branch incurred still reaches the ledger.
		h.provider.release();
		await h.coordinator.whenSettled();
		expect(h.ledger.results).toHaveLength(1);
	});

	it("passes the required cache-identity stream option keys through to the provider", async () => {
		const streamOptions = {
			apiKey: "k",
			reasoning: { effort: "high" },
			hideThinkingSummary: true,
			cacheRetention: "1h",
			serviceTier: "priority",
			// Cache-hostile fields 02 must strip.
			toolChoice: "required",
			anthropicCacheRefresh: true,
		} as unknown as BranchStreamOptions;
		const h = track(harness({ streamOptions }));
		streamToolCall(h, streamingPartial());
		await settleFork();

		const sent = h.provider.calls[0].options as Record<string, unknown>;
		expect(sent.reasoning).toEqual({ effort: "high" });
		expect(sent.hideThinkingSummary).toBe(true);
		expect(sent.cacheRetention).toBe("1h");
		expect(sent.serviceTier).toBe("priority");
		expect(sent.toolChoice).toBeUndefined();
		expect(sent.anthropicCacheRefresh).toBeUndefined();
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});
});
