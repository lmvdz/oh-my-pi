import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ATOM_NAMES, COMBINED_BRANCH_PROMPT, ReflectAtom } from "../../src/session/second-thought/atoms";
import {
	BranchCaller,
	type BranchCallRequest,
	buildBranchContext,
	buildBranchSessionId,
	buildBranchStreamOptions,
	DEFAULT_BRANCH_MAX_TOKENS,
	normalizeBranchAtoms,
	snapshotBranchContext,
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

function usage(): Usage {
	return {
		input: 12,
		output: 34,
		cacheRead: 5000,
		cacheWrite: 0,
		totalTokens: 5046,
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
		onDelta?: (index: number) => void;
	} = {},
) {
	const calls = opts.calls ?? [];
	return async (model: Model, context: Context, options: SimpleStreamOptions = {}) => {
		calls.push({ model, context, options });
		if (opts.finish === "throw") throw new Error("provider exploded");
		const stream = new AssistantMessageEventStream();
		const signal = options.signal;
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
					error: doneMessage(text, { stopReason: "aborted", errorMessage: "aborted" }),
				});
				stream.end();
				return;
			}
			if (opts.finish === "error") {
				stream.push({
					type: "error",
					reason: "error",
					error: doneMessage(text, { stopReason: "error", errorMessage: "overloaded_error" }),
				});
				stream.end();
				return;
			}
			const message = doneMessage(text);
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		})();
		return stream;
	};
}

function request(overrides: Partial<BranchCallRequest> = {}): BranchCallRequest {
	const snapshot = snapshotBranchContext(mainCallContext(), MODEL, 100);
	return {
		model: MODEL,
		snapshot,
		conditioningText: "I should check whether the test is flaky.",
		cacheSessionId: "sess-1",
		promptCacheKey: "cache-1",
		streamOptions: { apiKey: "k", reasoning: Effort.Medium, serviceTier: "auto" } as SimpleStreamOptions,
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
});

describe("branch request shape", () => {
	it("is byte-equal to the main call up to the synthetic suffix", () => {
		const main = mainCallContext();
		const snapshot = snapshotBranchContext(main, MODEL, 100);
		const branch = buildBranchContext(snapshot, {
			model: MODEL,
			conditioningText: "conditioning",
			now: 200,
		});

		expect(JSON.stringify(branch.systemPrompt)).toBe(JSON.stringify(main.systemPrompt));
		expect(JSON.stringify(branch.tools)).toBe(JSON.stringify(main.tools));
		const prefix = branch.messages.slice(0, main.messages.length);
		expect(JSON.stringify(prefix)).toBe(JSON.stringify(main.messages));
		expect(branch.messages).toHaveLength(main.messages.length + 2);
	});

	it("appends an assistant conditioning message and the combined-atom user prompt", () => {
		const snapshot = snapshotBranchContext(mainCallContext(), MODEL, 100);
		const branch = buildBranchContext(snapshot, {
			model: MODEL,
			conditioningText: "conditioning",
			now: 200,
		});
		const [assistant, user] = branch.messages.slice(-2) as [AssistantMessage, Message];

		expect(assistant.role).toBe("assistant");
		expect(assistant.model).toBe(MODEL.id);
		expect(assistant.content).toEqual([{ type: "text", text: "conditioning" }]);
		expect(user.role).toBe("user");
		expect(user).toMatchObject({ synthetic: true, content: [{ type: "text", text: COMBINED_BRANCH_PROMPT }] });
	});

	it("strips cache-hostile options and keeps the primary prompt cache key", () => {
		const signal = new AbortController().signal;
		const options = buildBranchStreamOptions(
			request({
				streamOptions: {
					apiKey: "k",
					reasoning: Effort.High,
					toolChoice: "none",
					disableReasoning: true,
					anthropicCacheRefresh: true,
				} as SimpleStreamOptions,
			}),
			"sess-1:side:reflect:1",
			signal,
		);

		expect(options.toolChoice).toBeUndefined();
		expect(options.disableReasoning).toBeUndefined();
		expect(options.anthropicCacheRefresh).toBeUndefined();
		expect(options.reasoning).toBe(Effort.High);
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
});
