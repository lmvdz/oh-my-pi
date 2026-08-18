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
} from "../../src/session/second-thought/branch-call";
import {
	type BranchStarter,
	buildConditioningText,
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
				if (signal?.aborted) break;
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
	deliverHarvest?: (harvest: SecondThoughtHarvest) => void;
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

	const streamOptions = {
		apiKey: "k",
		reasoning: undefined,
		hideThinkingSummary: undefined,
		cacheRetention: undefined,
	} as BranchStreamOptions;

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
	};
	// Records every handle and every abort so "no branch outlives the
	// coordinator" is checkable after each test.
	const recording: BranchStarter = {
		async startMany(count: number, request: BranchCallRequest): Promise<BranchCallHandle[]> {
			result.starts++;
			const started = await inner.startMany(count, request);
			return started.map(handle => {
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
			});
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

function streamToolCall(h: Harness, partial: AssistantMessage, withStart = true): void {
	if (withStart) h.coordinator.onAssistantEvent({ type: "start", partial } as AssistantMessageEvent);
	h.coordinator.onAssistantEvent({
		type: "thinking_delta",
		contentIndex: 0,
		delta: CONDITIONING,
		partial,
	} as AssistantMessageEvent);
	h.coordinator.onAssistantEvent({ type: "toolcall_start", contentIndex: 1, partial } as AssistantMessageEvent);
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
	it("forks on the first toolcall_start and only once per message instance", async () => {
		const h = track(harness());
		const partial = streamingPartial();
		streamToolCall(h, partial);
		await settleFork();
		h.coordinator.onAssistantEvent({ type: "toolcall_start", contentIndex: 2, partial } as AssistantMessageEvent);
		await settleFork();

		expect(h.coordinator.forkCount).toBe(1);
		expect(h.starts).toBe(1);
		expect(h.ledger.forks).toHaveLength(1);
		await h.coordinator.onPrimaryTurnEnd();
		await expectNoBranchOutlives(h);
	});

	it("does not fork on text, thinking, or toolcall_delta events", async () => {
		const h = track(harness());
		const partial = streamingPartial();
		h.coordinator.onAssistantEvent({ type: "start", partial } as AssistantMessageEvent);
		h.coordinator.onAssistantEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "writing prose",
			partial,
		} as AssistantMessageEvent);
		h.coordinator.onAssistantEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: CONDITIONING,
			partial,
		} as AssistantMessageEvent);
		h.coordinator.onAssistantEvent({
			type: "toolcall_delta",
			contentIndex: 1,
			delta: "{",
			partial,
		} as AssistantMessageEvent);
		await settleFork();

		expect(h.coordinator.forkCount).toBe(0);
		expect(h.provider.calls).toHaveLength(0);
		await expectNoBranchOutlives(h);
	});

	it("does nothing at turn end for a no-tool turn", async () => {
		const h = track(harness());
		const partial = streamingPartial();
		h.coordinator.onAssistantEvent({ type: "start", partial } as AssistantMessageEvent);
		await h.coordinator.onPrimaryTurnEnd();

		expect(h.folds).toHaveLength(0);
		expect(h.ledger.drops).toHaveLength(0);
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

	it("skips when the provider in-flight cap leaves no spare slot", async () => {
		await expectSkip(
			track(harness({ overrides: { "providers.maxInFlightRequests": { anthropic: 2 } } })),
			"in-flight-cap",
		);
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

	it("skips adaptively when tool batches finish faster than branch first-token, with a periodic probe", async () => {
		let clock = 0;
		const h = track(harness({ now: () => clock, script: { firstDelayMs: 5 } }));
		// Turn 1 measures both EMAs: a slow branch (TTFT) in a very short window.
		clock = 0;
		streamToolCall(h, streamingPartial(CONDITIONING, 1));
		await settleFork();
		// Let the branch actually produce its first token so a TTFT is measured.
		await new Promise(resolve => setTimeout(resolve, 20));
		clock = 1; // 1ms window — far below the branch's measured TTFT
		await h.coordinator.onPrimaryTurnEnd();
		await h.coordinator.whenSettled();
		expect(h.ledger.results.length).toBeGreaterThan(0);
		expect(h.coordinator.forkCount).toBe(1);

		// Subsequent turns skip.
		for (let turn = 0; turn < 5; turn++) {
			streamToolCall(h, streamingPartial(CONDITIONING, 10 + turn));
			await settleFork();
			await h.coordinator.onPrimaryTurnEnd();
		}
		expect(h.coordinator.forkCount).toBe(1);
		expect(h.ledger.skips.map(skip => skip.reason)).toEqual(Array(5).fill("adaptive-window"));
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
		const slowStarter: BranchStarter = {
			async startMany(count, request) {
				await gate;
				return inner.startMany(count, request);
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
		const first = streamingPartial(CONDITIONING, 1000);
		streamToolCall(h, first);
		await settleFork();
		expect(h.coordinator.activeGeneration).toBe(1);

		const second = streamingPartial(CONDITIONING, 1000); // same timestamp, new instance
		streamToolCall(h, second);
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

	it("does not re-arm on truncate-resume, which re-streams nothing", async () => {
		const h = track(harness());
		const partial = streamingPartial();
		streamToolCall(h, partial);
		await settleFork();
		const generation = h.coordinator.activeGeneration ?? 0;

		// Truncate-resume replaces the message and emits no assistant stream
		// events; the coordinator must see nothing at all.
		expect(h.coordinator.forkCount).toBe(1);
		expect(h.coordinator.activeGeneration).toBe(generation);
		expect(h.ledger.drops).toHaveLength(0);

		await h.coordinator.onPrimaryTurnEnd();
		expect(h.folds).toHaveLength(1);
		expect(h.folds[0].generation).toBe(generation);
		await expectNoBranchOutlives(h);
	});

	it("distinguishes same-millisecond message replacement by instance, not timestamp", async () => {
		const fixed = () => 4242;
		const h = track(harness({ now: fixed }));
		const first = streamingPartial(CONDITIONING, 4242);
		const second = streamingPartial(CONDITIONING, 4242);
		streamToolCall(h, first);
		await settleFork();
		streamToolCall(h, second);
		await settleFork();

		expect(h.ledger.forks.map(fork => fork.generation)).toEqual([1, 2]);
		expect(h.ledger.forks[0].forkedAt).toBe(h.ledger.forks[1].forkedAt);
		expect(h.coordinator.activeGeneration).toBe(2);
		await h.coordinator.onPrimaryTurnEnd();
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
					startMany: async () => {
						throw new Error("startMany exploded");
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
});
