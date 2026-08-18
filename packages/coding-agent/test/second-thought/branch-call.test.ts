import { describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ATOM_NAMES, COMBINED_BRANCH_PROMPT, ReflectAtom } from "../../src/session/second-thought/atoms";
import {
	BranchCaller,
	type BranchCallRequest,
	type BranchStreamOptions,
	buildBranchConditioningPrompt,
	buildBranchContext,
	buildBranchSessionId,
	buildBranchStreamOptions,
	DEFAULT_BRANCH_MAX_TOKENS,
	DEFAULT_STAGGER_TIMEOUT_MS,
	normalizeBranchAtoms,
	snapshotBranchContext,
	truncateToUnitCap,
} from "../../src/session/second-thought/branch-call";

const MODEL = {
	id: "claude-fable-5",
	api: "anthropic-messages",
	provider: "anthropic",
	name: "Claude Fable 5",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
} as unknown as Model;

function usage(cacheRead = 5000): Usage {
	return {
		input: 12,
		output: 34,
		cacheRead,
		cacheWrite: 0,
		totalTokens: 46 + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mainCallContext(): Context {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "fix the failing test" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "looking" }],
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: usage(),
			stopReason: "toolUse",
			timestamp: 2,
		} satisfies AssistantMessage,
	];
	return {
		systemPrompt: ["You are pi.", "Repo rules."],
		messages,
		tools: [
			{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
			{ name: "bash", description: "run a command", parameters: { type: "object", properties: {} } },
		] as Context["tools"],
	};
}

function doneMessage(text: string, extra?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: 3,
		...extra,
	};
}

interface ScriptedCall {
	model: Model;
	context: Context;
	options: SimpleStreamOptions;
}

/** A stream fn that emits scripted deltas, honoring the request signal. */
function scriptedStreamFn(
	deltas: string[],
	opts: {
		calls?: ScriptedCall[];
		holdAfter?: number;
		emitToolCall?: boolean;
		finish?: "done" | "abortError" | "error" | "throw";
		terminalUsage?: Usage;
		onDelta?: (index: number) => void;
	} = {},
) {
	const calls = opts.calls ?? [];
	return async (model: Model, context: Context, options: SimpleStreamOptions = {}) => {
		calls.push({ model, context, options });
		if (opts.finish === "throw") throw new Error("provider exploded");
		const stream = new AssistantMessageEventStream();
		const signal = options.signal;
		const terminalUsage = opts.terminalUsage ?? usage();
		let text = "";
		void (async () => {
			for (const [index, delta] of deltas.entries()) {
				if (signal?.aborted) break;
				text += delta;
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta,
					partial: doneMessage(text),
				});
				opts.onDelta?.(index);
				if (opts.holdAfter !== undefined && index === opts.holdAfter) {
					// Wait for the caller to abort rather than finishing on our own.
					await new Promise<void>(resolve => {
						if (signal?.aborted) return resolve();
						signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					break;
				}
				await Promise.resolve();
			}
			if (opts.emitToolCall) {
				stream.push({
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: {} },
					partial: doneMessage(text),
				});
			}
			if (signal?.aborted || opts.finish === "abortError") {
				stream.push({
					type: "error",
					reason: "aborted",
					error: doneMessage(text, { stopReason: "aborted", errorMessage: "aborted", usage: terminalUsage }),
				});
				stream.end();
				return;
			}
			if (opts.finish === "error") {
				stream.push({
					type: "error",
					reason: "error",
					error: doneMessage(text, {
						stopReason: "error",
						errorMessage: "overloaded_error",
						usage: terminalUsage,
					}),
				});
				stream.end();
				return;
			}
			const message = doneMessage(text, { usage: terminalUsage });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		})();
		return stream;
	};
}

function hostOptions(extra: Partial<SimpleStreamOptions> = {}): BranchStreamOptions {
	return {
		apiKey: "k",
		reasoning: Effort.Medium,
		hideThinkingSummary: undefined,
		cacheRetention: undefined,
		serviceTier: "auto",
		...extra,
	} as BranchStreamOptions;
}

function request(overrides: Partial<BranchCallRequest> = {}): BranchCallRequest {
	const snapshot = snapshotBranchContext(mainCallContext(), MODEL, 100);
	return {
		model: MODEL,
		snapshot,
		conditioningText: "I should check whether the test is flaky.",
		cacheSessionId: "sess-1",
		promptCacheKey: "cache-1",
		streamOptions: hostOptions(),
		...overrides,
	};
}

describe("branch snapshot", () => {
	it("deep-copies the materialized request so in-place mutation cannot reach a queued branch", () => {
		const context = mainCallContext();
		const snapshot = snapshotBranchContext(context, MODEL, 100);

		const assistant = context.messages[1] as AssistantMessage;
		(assistant.content[0] as { text: string }).text = "PRUNED";
		context.messages.push({ role: "user", content: [{ type: "text", text: "later" }], timestamp: 9 });
		(context.systemPrompt as string[]).push("mutated");
		(context.tools as { name: string }[])[0].name = "renamed";

		expect((snapshot.messages[1] as AssistantMessage).content[0]).toEqual({ type: "text", text: "looking" });
		expect(snapshot.messages).toHaveLength(2);
		expect(snapshot.systemPrompt).toEqual(["You are pi.", "Repo rules."]);
		expect(snapshot.tools[0]?.name).toBe("read");
		expect(snapshot.modelId).toBe(MODEL.id);
		expect(snapshot.forkedAt).toBe(100);
	});

	it("preserves binary payloads instead of JSON-stripping them into index objects", () => {
		const context = mainCallContext();
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		(context.messages[0] as unknown as { providerPayload: unknown }).providerPayload = { raw: bytes };

		const snapshot = snapshotBranchContext(context, MODEL, 100);
		const copied = (snapshot.messages[0] as unknown as { providerPayload: { raw: Uint8Array } }).providerPayload.raw;

		expect(copied).toBeInstanceOf(Uint8Array);
		expect(copied).not.toBe(bytes);
		expect(Array.from(copied)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	});

	it("throws rather than lossily copying a context structuredClone cannot handle", () => {
		const context = mainCallContext();
		(context.messages[0] as unknown as { hook: unknown }).hook = () => "not cloneable";
		expect(() => snapshotBranchContext(context, MODEL, 100)).toThrow(/not structured-cloneable/);
	});
});

describe("branch request shape", () => {
	it("is byte-equal to the main call up to the synthetic suffix", () => {
		const main = mainCallContext();
		const snapshot = snapshotBranchContext(main, MODEL, 100);
		const branch = buildBranchContext(snapshot, {
			conditioningText: "conditioning",
			now: 200,
		});

		expect(JSON.stringify(branch.systemPrompt)).toBe(JSON.stringify(main.systemPrompt));
		expect(JSON.stringify(branch.tools)).toBe(JSON.stringify(main.tools));
		const prefix = branch.messages.slice(0, main.messages.length);
		expect(JSON.stringify(prefix)).toBe(JSON.stringify(main.messages));
		expect(branch.messages).toHaveLength(main.messages.length + 1);
	});

	it("appends exactly one synthetic user message carrying the conditioning and combined prompt", () => {
		const snapshot = snapshotBranchContext(mainCallContext(), MODEL, 100);
		const branch = buildBranchContext(snapshot, {
			conditioningText: "conditioning",
			now: 200,
		});
		const suffix = branch.messages.slice(-1) as Message[];

		expect(suffix).toHaveLength(1);
		const [user] = suffix;
		expect(user.role).toBe("user");
		// The synthetic-assistant shape is what diverged the wire prefix; nothing
		// after the snapshot may be an assistant message.
		expect(branch.messages.filter(m => m.role === "assistant")).toHaveLength(
			snapshot.messages.filter(m => m.role === "assistant").length,
		);
		expect(user).toMatchObject({ synthetic: true, attribution: "agent" });
		const text = (user.content as { text: string }[])[0].text;
		expect(text).toContain("conditioning");
		expect(text).toContain(COMBINED_BRANCH_PROMPT);
		expect(text).toBe(buildBranchConditioningPrompt("conditioning"));
	});

	it("falls back to the bare combined prompt when there is no conditioning text", () => {
		expect(buildBranchConditioningPrompt("   ")).toBe(COMBINED_BRANCH_PROMPT);
	});

	it("deep-copies per outbound context so two branches never share object refs", () => {
		const snapshot = snapshotBranchContext(mainCallContext(), MODEL, 100);
		const a = buildBranchContext(snapshot, { conditioningText: "a", now: 200 });
		const b = buildBranchContext(snapshot, { conditioningText: "b", now: 200 });

		expect(a.messages[0]).not.toBe(b.messages[0]);
		expect(a.messages[0]).not.toBe(snapshot.messages[0]);
		expect(a.tools).not.toBe(b.tools);
		expect(a.systemPrompt).not.toBe(snapshot.systemPrompt);

		// A host hook mutating what it was handed cannot reach the other call.
		((a.messages[1] as AssistantMessage).content[0] as { text: string }).text = "MUTATED";
		expect(((b.messages[1] as AssistantMessage).content[0] as { text: string }).text).toBe("looking");
		expect(((snapshot.messages[1] as AssistantMessage).content[0] as { text: string }).text).toBe("looking");
	});

	it("strips cache-hostile options and keeps the primary prompt cache key", () => {
		const signal = new AbortController().signal;
		const options = buildBranchStreamOptions(
			request({
				streamOptions: hostOptions({
					reasoning: Effort.High,
					hideThinkingSummary: true,
					cacheRetention: "long",
					toolChoice: "none",
					disableReasoning: true,
					forceReasoningOff: true,
					anthropicCacheRefresh: true,
				}),
			}),
			"sess-1:side:reflect:1",
			signal,
		);

		expect(options.toolChoice).toBeUndefined();
		expect(options.disableReasoning).toBeUndefined();
		expect(options.forceReasoningOff).toBeUndefined();
		expect(options.anthropicCacheRefresh).toBeUndefined();
		expect("forceReasoningOff" in options).toBe(false);
		expect(options.reasoning).toBe(Effort.High);
		expect(options.hideThinkingSummary).toBe(true);
		expect(options.cacheRetention).toBe("long");
		expect(options.promptCacheKey).toBe("cache-1");
		expect(options.maxTokens).toBe(DEFAULT_BRANCH_MAX_TOKENS);
		expect(options.sessionId).toBe("sess-1:side:reflect:1");
		expect(options.signal).toBe(signal);
	});

	it("honors a configured branchMaxTokens and falls back to the cache session id", () => {
		const options = buildBranchStreamOptions(
			request({ maxTokens: 512, promptCacheKey: undefined }),
			"sid",
			new AbortController().signal,
		);
		expect(options.maxTokens).toBe(512);
		expect(options.promptCacheKey).toBe("sess-1");
	});

	it("derives a reflect-scoped side session id", () => {
		expect(buildBranchSessionId("sess-1", "42")).toBe("sess-1:side:reflect:42");
	});

	it("canonicalizes atoms and drops model- or caller-supplied unknown names", () => {
		expect(normalizeBranchAtoms(undefined)).toEqual([...ATOM_NAMES]);
		expect(normalizeBranchAtoms(["alternative", "check", "../../etc/passwd"])).toEqual([
			ReflectAtom.Check,
			ReflectAtom.Alternative,
		]);
		expect(normalizeBranchAtoms(["nonsense"])).toEqual([...ATOM_NAMES]);
	});
});

describe("BranchCaller construction", () => {
	it("requires an explicit settings-aware stream fn", () => {
		expect(() => new BranchCaller({} as never)).toThrow(/settings-aware stream fn/);
		expect(() => new BranchCaller({ streamFn: undefined } as never)).toThrow(/settings-aware stream fn/);
	});
});

describe("BranchCaller execution", () => {
	it("accumulates text, reports usage, and filters typed units through ATOM_NAMES", async () => {
		const calls: ScriptedCall[] = [];
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(
				[
					'<reflect type="check">assumption a</reflect>\n',
					'<reflect type="rogue">injected</reflect>\n',
					'<reflect type="recall">earlier detail</reflect>',
				],
				{ calls },
			),
			nextSideCallId: () => "1",
		});

		const result = await caller.run(request());

		expect(result.outcome).toBe("completed");
		expect(result.sessionId).toBe("sess-1:side:reflect:1");
		expect(result.unitCount).toBe(3);
		expect(result.units).toEqual([
			["check", "assumption a"],
			["recall", "earlier detail"],
		]);
		expect(result.usage?.cacheRead).toBe(5000);
		expect(result.toolUseLeak).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.sessionId).toBe("sess-1:side:reflect:1");
	});

	it("stops early once harvestCapPerAtom x atomCount units are complete, and does not retry", async () => {
		const calls: ScriptedCall[] = [];
		const emitted: number[] = [];
		const deltas = Array.from({ length: 10 }, (_, i) => `<reflect type="check">u${i}</reflect>`);
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(deltas, { calls, onDelta: index => emitted.push(index) }),
		});

		const result = await caller.run(request({ harvestCapPerAtom: 1, atoms: ["check", "recall"] }));

		expect(result.outcome).toBe("unitCap");
		expect(result.unitCount).toBe(2);
		expect(emitted.length).toBeLessThan(deltas.length);
		expect(calls).toHaveLength(1);
	});

	it("treats harvestCapPerAtom 0 as no early stop", async () => {
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>', '<reflect type="check">b</reflect>']),
		});
		const result = await caller.run(request({ harvestCapPerAtom: 0 }));
		expect(result.outcome).toBe("completed");
		expect(result.unitCount).toBe(2);
	});

	it("returns the partial buffer on caller abort without throwing or retrying", async () => {
		const calls: ScriptedCall[] = [];
		const controller = new AbortController();
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">partial</reflect>', "never"], {
				calls,
				holdAfter: 0,
			}),
		});

		const handle = caller.start(request({ signal: controller.signal }));
		await handle.firstToken;
		controller.abort();
		const result = await handle.result;

		expect(result.outcome).toBe("aborted");
		expect(result.text).toBe('<reflect type="check">partial</reflect>');
		expect(result.units).toEqual([["check", "partial"]]);
		expect(calls).toHaveLength(1);
	});

	it("aborts on its own handle too", async () => {
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">partial</reflect>', "never"], { holdAfter: 0 }),
		});
		const handle = caller.start(request());
		await handle.firstToken;
		handle.abort();
		const result = await handle.result;
		expect(result.outcome).toBe("aborted");
		expect(result.text).toContain("partial");
	});

	it("settles as aborted when the caller signal is already aborted at fork time", async () => {
		const controller = new AbortController();
		controller.abort();
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(["ignored"], { holdAfter: 0 }),
		});
		const result = await caller.run(request({ signal: controller.signal }));
		expect(result.outcome).toBe("aborted");
	});

	it("flags a tool-call leak", async () => {
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>'], { emitToolCall: true }),
		});
		const result = await caller.run(request());
		expect(result.toolUseLeak).toBe(true);
		expect(result.outcome).toBe("completed");
	});

	it("returns a provider error instead of throwing", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(["partial"], { finish: "error" }) });
		const result = await caller.run(request());
		expect(result.outcome).toBe("error");
		expect(result.error).toBe("overloaded_error");
		expect(result.text).toBe("partial");
	});

	it("returns a thrown transport failure instead of throwing", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn([], { finish: "throw" }) });
		const result = await caller.run(request());
		expect(result.outcome).toBe("error");
		expect(result.error).toBe("provider exploded");
	});

	it("applies host obfuscation on the way out and deobfuscation on the way back", async () => {
		const calls: ScriptedCall[] = [];
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">SECRET</reflect>'], { calls }),
			obfuscateContext: context => ({ ...context, systemPrompt: ["REDACTED"] }),
			deobfuscateText: text => text.replace("SECRET", "s3cr3t"),
		});

		const result = await caller.run(request());

		expect(calls[0]?.context.systemPrompt).toEqual(["REDACTED"]);
		expect(result.units).toEqual([["check", "s3cr3t"]]);
	});

	it("lets the host layer per-provider stream options", async () => {
		const calls: ScriptedCall[] = [];
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(["ok"], { calls }),
			prepareStreamOptions: (options, provider) => ({ ...options, headers: { "x-provider": provider ?? "" } }),
		});
		await caller.run(request());
		expect(calls[0]?.options.headers).toEqual({ "x-provider": "anthropic" });
	});
});

describe("BranchCaller stagger", () => {
	it("fires call 1 alone and the rest only after its first streamed token", async () => {
		const calls: ScriptedCall[] = [];
		let firstDeltaSeen = false;
		let callsAtFirstDelta = -1;
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>', "tail"], {
				calls,
				onDelta: () => {
					if (firstDeltaSeen) return;
					firstDeltaSeen = true;
					callsAtFirstDelta = calls.length;
				},
			}),
		});

		const handles = await caller.startMany(3, request());
		const results = await Promise.all(handles.map(handle => handle.result));

		expect(handles).toHaveLength(3);
		expect(callsAtFirstDelta).toBe(1);
		expect(calls).toHaveLength(3);
		expect(new Set(handles.map(handle => handle.sessionId)).size).toBe(3);
		expect(results.every(result => result.outcome === "completed")).toBe(true);
	});

	it("returns a single handle for K=1 without waiting", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(["a"], { holdAfter: 0 }) });
		const handles = await caller.startMany(1, request());
		expect(handles).toHaveLength(1);
		handles[0]?.abort();
		await handles[0]?.result;
	});

	it("returns nothing for K<=0", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(["a"]) });
		expect(await caller.startMany(0, request())).toEqual([]);
	});

	it("does not wait forever when call 1 never emits a text delta", async () => {
		// `start` and thinking events must NOT open the gate: they fire before the
		// provider has produced cacheable output. Only the timeout releases here.
		const calls: ScriptedCall[] = [];
		const controllers: AbortController[] = [];
		const streamFn = async (model: Model, context: Context, options: SimpleStreamOptions = {}) => {
			calls.push({ model, context, options });
			const stream = new AssistantMessageEventStream();
			const local = new AbortController();
			controllers.push(local);
			void (async () => {
				stream.push({ type: "start", partial: doneMessage("") });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: doneMessage("") });
				await new Promise<void>(resolve => {
					if (options.signal?.aborted) return resolve();
					options.signal?.addEventListener("abort", () => resolve(), { once: true });
					local.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				const message = doneMessage("");
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			})();
			return stream;
		};

		const caller = new BranchCaller({ streamFn });
		const started = Date.now();
		const handles = await caller.startMany(
			3,
			request({ streamOptions: hostOptions({ streamFirstEventTimeoutMs: 25 }) }),
		);

		expect(handles).toHaveLength(3);
		expect(Date.now() - started).toBeLessThan(DEFAULT_STAGGER_TIMEOUT_MS);
		for (const local of controllers) local.abort();
		await Promise.all(handles.map(handle => handle.result));
	});

	for (const timeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
		it(`uses the default bound when the stagger timeout is ${String(timeoutMs)}`, async () => {
			vi.useFakeTimers();
			try {
				const calls: ScriptedCall[] = [];
				const streamFn = async (model: Model, context: Context, options: SimpleStreamOptions = {}) => {
					calls.push({ model, context, options });
					const stream = new AssistantMessageEventStream();
					void (async () => {
						stream.push({ type: "start", partial: doneMessage("") });
						const abortGate = Promise.withResolvers<void>();
						const onAbort = () => abortGate.resolve();
						if (options.signal?.aborted) abortGate.resolve();
						else options.signal?.addEventListener("abort", onAbort, { once: true });
						await abortGate.promise;
						const message = doneMessage("");
						stream.push({ type: "done", reason: "stop", message });
						stream.end(message);
					})();
					return stream;
				};

				const caller = new BranchCaller({ streamFn });
				const pending = caller.startMany(
					3,
					request({ streamOptions: hostOptions({ streamFirstEventTimeoutMs: timeoutMs }) }),
				);
				await Promise.resolve();
				expect(calls).toHaveLength(1);

				// The gate must hold for the FULL default bound — not release on a
				// setTimeout-clamped degenerate delay (0/NaN/Infinity coerce to ~1ms),
				// which would fire the fan-out before call 1's first token.
				vi.advanceTimersByTime(50);
				await Promise.resolve();
				await Promise.resolve();
				expect(calls).toHaveLength(1);

				vi.advanceTimersByTime(DEFAULT_STAGGER_TIMEOUT_MS);
				const handles = await pending;
				expect(handles).toHaveLength(3);
				expect(calls).toHaveLength(3);

				for (const handle of handles) handle.abort();
				await Promise.all(handles.map(handle => handle.result));
			} finally {
				vi.useRealTimers();
			}
		});
	}

	it("does not fan out when the caller aborted while the gate was open", async () => {
		const calls: ScriptedCall[] = [];
		const controller = new AbortController();
		const streamFn = async (model: Model, context: Context, options: SimpleStreamOptions = {}) => {
			calls.push({ model, context, options });
			const stream = new AssistantMessageEventStream();
			void (async () => {
				stream.push({ type: "start", partial: doneMessage("") });
				await new Promise<void>(resolve => {
					if (options.signal?.aborted) return resolve();
					options.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				stream.push({
					type: "error",
					reason: "aborted",
					error: doneMessage("", { stopReason: "aborted", errorMessage: "aborted" }),
				});
				stream.end();
			})();
			return stream;
		};

		const caller = new BranchCaller({ streamFn });
		const pending = caller.startMany(4, request({ signal: controller.signal }));
		await Promise.resolve();
		controller.abort();
		const handles = await pending;

		expect(handles).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect((await handles[0]!.result).outcome).toBe("aborted");
	});

	it("does not fan out when call 1 fails before producing a token", async () => {
		const calls: ScriptedCall[] = [];
		const caller = new BranchCaller({ streamFn: scriptedStreamFn([], { calls, finish: "error" }) });
		const handles = await caller.startMany(3, request());
		expect(handles).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect((await handles[0]!.result).outcome).toBe("error");
	});
});

describe("BranchCaller.startManyEager", () => {
	it("publishes handle 0 synchronously and grows the SAME array when the gate lifts", async () => {
		const calls: ScriptedCall[] = [];
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>', "tail"], { calls }),
		});

		const fanOut = caller.startManyEager(3, request());
		// Before any await at all: the caller already has something to abort.
		expect(fanOut.handles).toHaveLength(1);
		expect(calls).toHaveLength(1);

		const settled = await fanOut.settled;
		expect(settled).toBe(fanOut.handles);
		expect(fanOut.handles).toHaveLength(3);
		expect(calls).toHaveLength(3);
		expect(new Set(fanOut.handles.map(handle => handle.sessionId)).size).toBe(3);
		await Promise.all(fanOut.handles.map(handle => handle.result));
	});

	it("starts nothing beyond call 1 when the caller aborts synchronously", async () => {
		const calls: ScriptedCall[] = [];
		const controller = new AbortController();
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>'], { calls }),
		});

		const fanOut = caller.startManyEager(4, request({ signal: controller.signal }));
		expect(fanOut.handles).toHaveLength(1);
		// Same tick, no await: exactly what the coordinator's teardown paths do.
		controller.abort("torn down");

		const settled = await fanOut.settled;
		expect(settled).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect((await settled[0]!.result).outcome).toBe("aborted");
	});

	it("resolves immediately for K=1 and K=0", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(["a"], { holdAfter: 0 }) });
		const one = caller.startManyEager(1, request());
		expect(one.handles).toHaveLength(1);
		expect(await one.settled).toBe(one.handles);
		one.handles[0]?.abort();
		await one.handles[0]?.result;

		const none = caller.startManyEager(0, request());
		expect(none.handles).toEqual([]);
		expect(await none.settled).toEqual([]);
	});

	it("is what startMany delegates to — identical stagger observable", async () => {
		const calls: ScriptedCall[] = [];
		let callsAtFirstDelta = -1;
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>', "tail"], {
				calls,
				onDelta: () => {
					if (callsAtFirstDelta === -1) callsAtFirstDelta = calls.length;
				},
			}),
		});
		const handles = await caller.startMany(3, request());
		expect(callsAtFirstDelta).toBe(1);
		expect(handles).toHaveLength(3);
		await Promise.all(handles.map(handle => handle.result));
	});
});

describe("BranchCaller never throws", () => {
	const hooks = [
		["obfuscateContext", { obfuscateContext: () => throwing("obfuscate exploded") }],
		["prepareStreamOptions", { prepareStreamOptions: () => throwing("prepare exploded") }],
		["deobfuscateText", { deobfuscateText: () => throwing("deobfuscate exploded") }],
	] as const;

	function throwing(message: string): never {
		throw new Error(message);
	}

	for (const [name, host] of hooks) {
		it(`settles as error when the host ${name} hook throws`, async () => {
			const caller = new BranchCaller({
				streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>']),
				...(host as object),
			});
			const result = await caller.run(request());
			expect(result.outcome).toBe("error");
			expect(result.error).toMatch(/exploded/);
		});
	}

	it("settles as error when atoms are not iterable", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(["a"]) });
		const result = await caller.run(request({ atoms: 42 as unknown as string[] }));
		expect(result.outcome).toBe("error");
	});

	it("settles as error when the snapshot cannot be cloned for the outbound context", async () => {
		const snapshot = snapshotBranchContext(mainCallContext(), MODEL, 100);
		(snapshot.messages[0] as unknown as { hook: unknown }).hook = () => "not cloneable";
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(["a"]) });
		const result = await caller.run(request({ snapshot }));
		expect(result.outcome).toBe("error");
		expect(result.error).toMatch(/not structured-cloneable/);
	});

	it("does not throw synchronously from start() when the id source throws", async () => {
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn(["a"]),
			nextSideCallId: () => {
				throw new Error("snowflake exploded");
			},
		});
		let handle: ReturnType<BranchCaller["start"]> | undefined;
		expect(() => {
			handle = caller.start(request());
		}).not.toThrow();
		// A throwing id source falls back to the random suffix rather than failing
		// the branch, so the call still runs.
		const result = await handle!.result;
		expect(result.outcome).toBe("completed");
		expect(result.sessionId.startsWith("sess-1:side:reflect:")).toBe(true);
	});

	it("does not throw synchronously from start() when the caller signal rejects listeners", async () => {
		const signal = {
			aborted: false,
			reason: undefined,
			addEventListener: () => {
				throw new Error("listener exploded");
			},
			removeEventListener: () => {},
		} as unknown as AbortSignal;
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(["a"]) });
		let handle: ReturnType<BranchCaller["start"]> | undefined;
		expect(() => {
			handle = caller.start(request({ signal }));
		}).not.toThrow();
		const result = await handle!.result;
		expect(result.outcome).toBe("error");
		expect(result.error).toBe("listener exploded");
		expect(handle!.settledResult()?.outcome).toBe("error");
	});

	it("survives a throwing onTextDelta observer", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(['<reflect type="check">a</reflect>']) });
		const result = await caller.run(
			request({
				onTextDelta: () => {
					throw new Error("tui exploded");
				},
			}),
		);
		expect(result.outcome).toBe("completed");
		expect(result.units).toEqual([["check", "a"]]);
	});
});

describe("BranchCaller usage and outcome accounting", () => {
	it("surfaces the last streamed partial usage when an abort leaves no terminal usage", async () => {
		const controller = new AbortController();
		const streamFn = async (_model: Model, _context: Context, options: SimpleStreamOptions = {}) => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: doneMessage("partial") });
				await new Promise<void>(resolve => {
					if (options.signal?.aborted) return resolve();
					options.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				// No terminal event at all: the transport just goes away.
				stream.end();
			})();
			return stream;
		};

		const caller = new BranchCaller({ streamFn });
		const handle = caller.start(request({ signal: controller.signal }));
		await handle.firstToken;
		controller.abort();
		const result = await handle.result;

		expect(result.outcome).toBe("aborted");
		expect(result.usage?.cacheRead).toBe(5000);
		expect(result.text).toBe("partial");
	});

	it("keeps 'completed' when the abort lands after the provider finished naturally", async () => {
		const caller = new BranchCaller({ streamFn: scriptedStreamFn(['<reflect type="check">done</reflect>']) });
		const handle = caller.start(request());
		const result = await handle.result;
		handle.abort();
		expect(result.outcome).toBe("completed");
		expect((await handle.result).outcome).toBe("completed");
	});

	it("truncates a multi-unit delta back to the cap and still records terminal usage", async () => {
		const overshoot = Array.from({ length: 5 }, (_, i) => `<reflect type="check">u${i}</reflect>`).join("");
		const caller = new BranchCaller({
			streamFn: scriptedStreamFn([overshoot, "trailing garbage"], { terminalUsage: usage(9000) }),
		});

		const result = await caller.run(request({ harvestCapPerAtom: 1, atoms: ["check", "recall"] }));

		expect(result.outcome).toBe("unitCap");
		expect(result.unitCount).toBe(2);
		expect(result.units).toEqual([
			["check", "u0"],
			["check", "u1"],
		]);
		expect(result.text).toBe('<reflect type="check">u0</reflect><reflect type="check">u1</reflect>');
		// The drain kept reading past the abort, so terminal usage overrides the
		// distinct partial-usage fixture carried by the text delta.
		expect(result.usage?.cacheRead).toBe(9000);
	});

	it("truncateToUnitCap drops whole units from the tail", () => {
		const text = '<reflect type="check">a</reflect><reflect type="check">b</reflect><reflect type="check">c';
		expect(truncateToUnitCap(text, 1)).toBe('<reflect type="check">a</reflect>');
		expect(truncateToUnitCap(text, 5)).toBe('<reflect type="check">a</reflect><reflect type="check">b</reflect>');
		expect(truncateToUnitCap("", 2)).toBe("");
	});
});
