import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ModelSpec,
	SimpleStreamOptions,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { COMBINED_BRANCH_PROMPT } from "../../src/session/second-thought/atoms";
import {
	type BranchCallRequest,
	type BranchSnapshot,
	type BranchStreamOptions,
	buildBranchConditioningPrompt,
	buildBranchContext,
	buildBranchStreamOptions,
	snapshotBranchContext,
	snapshotTailIsDeveloper,
} from "../../src/session/second-thought/branch-call";
import { buildFoldBlock, buildFoldMessage } from "../../src/session/second-thought/fold";

/**
 * GOLDEN PREFIX TEST — the acceptance gate for Second Thought's cache economics.
 *
 * The in-memory `JSON.stringify(branch.messages.slice(0, n)) === main.messages`
 * check cannot see the defect this file exists for: the branch and the main
 * call carry the SAME message objects and still encode to DIFFERENT wire bytes,
 * because `transformMessages` decides thinking-block policy from
 * `latestSurvivingAssistantIndex` — a property of the whole message list, not
 * of any one message.
 *
 * The fixture is the routine adaptive-model shape: an ABANDONED TOOL-USE
 * assistant turn (`stopReason !== "toolUse"` while the content still carries a
 * `toolCall` block) whose thinking blocks are SIGNED. On the main call that turn
 * is the latest surviving assistant, so Anthropic's byte-for-byte rule keeps its
 * thinking blocks untouched. Append a synthetic ASSISTANT suffix and it is no
 * longer latest: every signature is stripped as end_turn-bound and the blocks
 * are demoted or dropped. Same prefix objects, different bytes, no cache read,
 * and a live risk of `400 Invalid signature in thinking block`.
 *
 * The test drives the deepest host-side encoder reachable without a network:
 * `convertAnthropicMessages`, which runs the full `transformMessages` pipeline
 * and emits the exact `messages` array that `buildParams` puts on the wire.
 */

function anthropicModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-fable-5",
		name: "Claude Fable 5",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 64_000,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

const MODEL = anthropicModel();

function usage(): Usage {
	return {
		input: 10,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 30,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * The main call's materialized context, ending in an abandoned-tool-use
 * assistant turn with signed thinking plus its placeholder tool result.
 */
function mainContext(): Context {
	const user: UserMessage = {
		role: "user",
		content: [{ type: "text", text: "fix the failing test" }],
		timestamp: 1,
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "The suite probably fails because the fixture clock is frozen.",
				thinkingSignature: "sig-abcdef0123456789",
			},
			{ type: "text", text: "Let me look at the fixture." },
			{ type: "toolCall", id: "toolu_01abandoned", name: "read", arguments: { path: "fixture.ts" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		usage: usage(),
		// The defining property: tool calls present, but the turn did NOT request
		// execution. The agent loop pairs them with placeholder results.
		stopReason: "stop",
		timestamp: 2,
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "toolu_01abandoned",
		toolName: "read",
		content: [{ type: "text", text: "tool call was not executed" }],
		isError: false,
		timestamp: 3,
	};
	return {
		systemPrompt: ["You are pi.", "Repo rules."],
		messages: [user, assistant, toolResult],
		tools: [
			{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
		] as Context["tools"],
	};
}

/** A supported-model shape where a trailing developer turn becomes `system`. */
function developerTailContext(): Context {
	return {
		systemPrompt: [],
		messages: [
			{ role: "user", content: "Summarize the plan.", timestamp: 1 },
			{ role: "developer", content: "Keep the answer to one paragraph.", timestamp: 2 },
		],
		tools: [],
	};
}

function encode(messages: Message[]): string {
	return JSON.stringify(convertAnthropicMessages(structuredClone(messages), MODEL, false));
}

function encodedParams(messages: Message[]): unknown[] {
	return convertAnthropicMessages(structuredClone(messages), MODEL, false) as unknown[];
}

/** The wire prefix: everything the branch shares with the main call. */
function encodedPrefix(branchMessages: Message[], prefixLength: number): string {
	return JSON.stringify(encodedParams(branchMessages).slice(0, prefixLength));
}

function snapshot(): BranchSnapshot {
	return snapshotBranchContext(mainContext(), MODEL, 100);
}

/** The rejected reference shape: conditioning replayed as a synthetic assistant. */
function legacyAssistantSuffixMessages(snap: BranchSnapshot, conditioningText: string): Message[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: conditioningText }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: 200,
	};
	const user: UserMessage = {
		role: "user",
		content: [{ type: "text", text: COMBINED_BRANCH_PROMPT }],
		synthetic: true,
		attribution: "agent",
		timestamp: 200,
	};
	return [...structuredClone(snap.messages), assistant, user];
}

function hostOptions(extra: Partial<SimpleStreamOptions> = {}): BranchStreamOptions {
	return {
		apiKey: "k",
		reasoning: "medium",
		hideThinkingSummary: undefined,
		cacheRetention: undefined,
		...extra,
	} as unknown as BranchStreamOptions;
}

function branchRequest(extra: Partial<SimpleStreamOptions> = {}): BranchCallRequest {
	return {
		model: MODEL as unknown as Model,
		snapshot: snapshot(),
		conditioningText: "I should check whether the fixture clock is frozen.",
		cacheSessionId: "sess-1",
		promptCacheKey: "cache-1",
		streamOptions: hostOptions(extra),
	};
}

describe("golden Anthropic prefix parity", () => {
	it("documents the developer-tail role divergence caused by the appended conditioning user", () => {
		const main = developerTailContext();
		const snap = snapshotBranchContext(main, MODEL, 100);
		const branch = buildBranchContext(snap, { conditioningText: "Check the plan's assumptions.", now: 200 });

		// EXPECTED DIVERGENCE (ticket 03 owns the branch skip policy): Anthropic
		// may upgrade the main call's terminal developer turn to system, but the
		// appended branch user makes that developer turn ineligible for upgrade.
		expect(encodedParams(main.messages).map(message => (message as { role: string }).role)).toEqual([
			"user",
			"system",
		]);
		expect(encodedParams(branch.messages).map(message => (message as { role: string }).role)).toEqual([
			"user",
			"user",
			"user",
		]);
	});

	it("detects developer, user, and assistant snapshot tails", () => {
		const user = { role: "user", content: "user", timestamp: 1 } satisfies Message;
		const developer = { role: "developer", content: "developer", timestamp: 2 } satisfies Message;
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "assistant" }],
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: usage(),
			stopReason: "stop",
			timestamp: 3,
		} satisfies AssistantMessage;

		expect(snapshotTailIsDeveloper([user, developer])).toBe(true);
		expect(snapshotTailIsDeveloper([user])).toBe(false);
		expect(snapshotTailIsDeveloper([user, assistant])).toBe(false);
	});

	it("the fixture actually exercises the abandoned-tool-use signed-thinking path", () => {
		const params = encodedParams(mainContext().messages) as {
			role: string;
			content: { type: string; signature?: string }[];
		}[];
		const assistantParam = params.find(param => param.role === "assistant");
		const thinking = assistantParam?.content.find(block => block.type === "thinking");

		expect(thinking).toBeDefined();
		expect(thinking?.signature).toBe("sig-abcdef0123456789");
	});

	it("keeps the encoded prefix byte-identical with the user-message conditioning suffix", () => {
		const main = mainContext();
		const goldenPrefix = encode(main.messages);
		const branch = buildBranchContext(snapshot(), {
			conditioningText: "I should check whether the fixture clock is frozen.",
			now: 200,
		});

		const branchParams = encodedParams(branch.messages);
		const mainParams = encodedParams(main.messages);

		expect(branchParams).toHaveLength(mainParams.length + 1);
		expect(encodedPrefix(branch.messages, mainParams.length)).toBe(goldenPrefix);
	});

	it("preserves the system prompt and tool set verbatim", () => {
		const main = mainContext();
		const branch = buildBranchContext(snapshot(), { conditioningText: "c", now: 200 });
		expect(JSON.stringify(branch.systemPrompt)).toBe(JSON.stringify(main.systemPrompt));
		expect(JSON.stringify(branch.tools)).toBe(JSON.stringify(main.tools));
	});

	it("carries the conditioning text and combined prompt in the appended user turn", () => {
		const branch = buildBranchContext(snapshot(), { conditioningText: "conditioning here", now: 200 });
		const params = encodedParams(branch.messages) as {
			role: string;
			content: string | { type: string; text: string }[];
		}[];
		const last = params[params.length - 1];
		const text = typeof last.content === "string" ? last.content : last.content[0].text;

		expect(last.role).toBe("user");
		expect(text).toBe(buildBranchConditioningPrompt("conditioning here"));
		expect(text).toContain("conditioning here");
		expect(text).toContain(COMBINED_BRANCH_PROMPT);
	});

	// The negative control. This is the evidence for the recorded deviation in
	// plans/second-thought/BUILD-NOTES-02.md: a synthetic assistant suffix cannot
	// be made prefix-safe, so the reference's continuation-prompting shape is not
	// adoptable here.
	it("PROVES a synthetic assistant suffix diverges the encoded prefix", () => {
		const main = mainContext();
		const goldenPrefix = encode(main.messages);
		const mainLength = encodedParams(main.messages).length;
		const legacy = legacyAssistantSuffixMessages(snapshot(), "conditioning");

		expect(encodedPrefix(legacy, mainLength)).not.toBe(goldenPrefix);
	});

	it("shows exactly how the assistant suffix breaks it: the prefix's signed thinking is lost", () => {
		const legacy = legacyAssistantSuffixMessages(snapshot(), "conditioning");
		const params = encodedParams(legacy) as {
			role: string;
			content: { type: string; signature?: string }[];
		}[];
		const prefixAssistant = params.find(param => param.role === "assistant");
		const thinking = prefixAssistant?.content.find(block => block.type === "thinking");

		// Either dropped outright or stripped of its signature — never the
		// byte-for-byte block the main call sends.
		expect(thinking?.signature).not.toBe("sig-abcdef0123456789");
	});
});

describe("golden prefix under flipped parity flags", () => {
	const goldenPrefix = encode(mainContext().messages);
	const mainLength = encodedParams(mainContext().messages).length;

	const cacheHostile = [
		["toolChoice", { toolChoice: "none" }],
		["disableReasoning", { disableReasoning: true }],
		["forceReasoningOff", { forceReasoningOff: true }],
		["anthropicCacheRefresh", { anthropicCacheRefresh: true }],
	] as const;

	for (const [flag, extra] of cacheHostile) {
		it(`strips ${flag} from the host options and leaves the prefix byte-identical`, () => {
			const request = branchRequest(extra as Partial<SimpleStreamOptions>);
			const options = buildBranchStreamOptions(request, "sess-1:side:reflect:1", new AbortController().signal);

			expect(flag in options).toBe(false);

			const branch = buildBranchContext(request.snapshot, {
				conditioningText: request.conditioningText,
				now: 200,
			});
			expect(encodedPrefix(branch.messages, mainLength)).toBe(goldenPrefix);
		});
	}

	const passThrough = [
		["reasoning", { reasoning: "high" }, "high"],
		["hideThinkingSummary", { hideThinkingSummary: true }, true],
		["cacheRetention", { cacheRetention: "long" }, "long"],
	] as const;

	for (const [flag, extra, expected] of passThrough) {
		it(`passes ${flag} through untouched and leaves the prefix byte-identical`, () => {
			const request = branchRequest(extra as Partial<SimpleStreamOptions>);
			const options = buildBranchStreamOptions(request, "sess-1:side:reflect:1", new AbortController().signal);

			expect((options as Record<string, unknown>)[flag]).toBe(expected);

			const branch = buildBranchContext(request.snapshot, {
				conditioningText: request.conditioningText,
				now: 200,
			});
			expect(encodedPrefix(branch.messages, mainLength)).toBe(goldenPrefix);
		});
	}

	it("holds for a differently-worded conditioning text and a custom prompt", () => {
		const branch = buildBranchContext(snapshot(), {
			conditioningText: "a totally different chain of reasoning\nover several lines",
			prompt: "custom combined prompt",
			now: 999,
		});
		expect(encodedPrefix(branch.messages, mainLength)).toBe(goldenPrefix);
	});
});

/**
 * The wiring's own prefix obligation (ticket 08).
 *
 * Ticket 08 forks from the provider context the main call is ACTUALLY sending —
 * captured after the fold was injected, not reconstructed from session history.
 * That means the fold block, when one is delivered, is part of the main call's
 * cache prefix, and the branch must inherit it verbatim. This extends the golden
 * fixture above rather than restating it: same `mainContext()`, same encoder,
 * one extra tail message.
 */
describe("golden prefix with a delivered fold on the main call", () => {
	/** `mainContext()` as the request assembler leaves it after fold injection. */
	function mainContextWithFold(): Context {
		const base = mainContext();
		const block = buildFoldBlock('<reflect type="check">The placeholder result may hide a real failure.</reflect>');
		return { ...base, messages: [...base.messages, buildFoldMessage(block, 400)] };
	}

	it("keeps the branch prefix byte-identical when the main call ends in a fold block", () => {
		const main = mainContextWithFold();
		const goldenPrefix = encode(main.messages);
		const mainLength = encodedParams(main.messages).length;

		const snap = snapshotBranchContext(main, MODEL, 500);
		const branch = buildBranchContext(snap, { conditioningText: "Re-check the abandoned tool call.", now: 600 });

		expect(encodedParams(branch.messages)).toHaveLength(mainLength + 1);
		expect(encodedPrefix(branch.messages, mainLength)).toBe(goldenPrefix);
	});

	it("a fold tail is a user tail, so it never triggers the developer-tail skip", () => {
		// The developer-tail policy exists because that role is upgraded to
		// mid-conversation `system`; the fold is deliberately `user` for the same
		// reason, which is also what keeps it forkable.
		expect(snapshotTailIsDeveloper(mainContextWithFold().messages)).toBe(false);
		expect(mainContextWithFold().messages.at(-1)?.role).toBe("user");
	});
});
