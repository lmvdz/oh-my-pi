import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { evaluateSecondThoughtGate } from "../../src/session/second-thought/gating";

function model<TApi extends Api>(api: TApi, provider: string, id: string): Model<TApi> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		api,
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const anthropic = model("anthropic-messages", "anthropic", "claude-test");
const openai = model("openai-completions", "openai", "gpt-test");

function enabledSettings(): Settings {
	return Settings.isolated({ "secondThought.enabled": true });
}

describe("Second Thought gate", () => {
	test("disables Second Thought when the feature flag is off", () => {
		const result = evaluateSecondThoughtGate({
			settings: Settings.isolated(),
			agentKind: "main",
			primaryModel: anthropic,
			availableModels: [anthropic],
		});

		expect(result).toEqual({ allowed: false, branchModel: undefined, reason: "disabled" });
	});

	test("rejects sub-sessions even with an Anthropic primary model", () => {
		const result = evaluateSecondThoughtGate({
			settings: enabledSettings(),
			agentKind: "sub",
			primaryModel: anthropic,
			availableModels: [anthropic],
		});

		expect(result).toMatchObject({ allowed: false, branchModel: anthropic, reason: "sub-session" });
	});

	test("rejects when no primary model is selected", () => {
		const result = evaluateSecondThoughtGate({
			settings: enabledSettings(),
			agentKind: "main",
			primaryModel: undefined,
			availableModels: [anthropic],
		});

		expect(result).toEqual({ allowed: false, branchModel: undefined, reason: "no-primary-model" });
	});

	test("rejects a non-Anthropic primary model", () => {
		const result = evaluateSecondThoughtGate({
			settings: enabledSettings(),
			agentKind: "main",
			primaryModel: openai,
			availableModels: [openai],
		});

		expect(result).toMatchObject({ allowed: false, branchModel: openai, reason: "primary-model-not-anthropic" });
	});

	test("rejects a reflect override that resolves to a non-Anthropic model", () => {
		const settings = enabledSettings();
		settings.setModelRole("reflect", "openai/gpt-test");

		const result = evaluateSecondThoughtGate({
			settings,
			agentKind: "main",
			primaryModel: anthropic,
			availableModels: [anthropic, openai],
		});

		expect(result).toMatchObject({ allowed: false, branchModel: openai, reason: "branch-model-not-anthropic" });
	});

	test("falls back to the Anthropic primary model when the reflect override cannot resolve", () => {
		const settings = enabledSettings();
		settings.setModelRole("reflect", "openai/missing-model");

		const result = evaluateSecondThoughtGate({
			settings,
			agentKind: "main",
			primaryModel: anthropic,
			availableModels: [anthropic],
		});

		expect(result).toEqual({ allowed: true, branchModel: anthropic });
	});

	test("uses the primary model when no reflect override is configured", () => {
		const result = evaluateSecondThoughtGate({
			settings: enabledSettings(),
			agentKind: "main",
			primaryModel: anthropic,
			availableModels: [anthropic],
		});

		expect(result).toEqual({ allowed: true, branchModel: anthropic });
	});

	test("uses a configured Anthropic reflect override", () => {
		const override = model("anthropic-messages", "anthropic", "claude-reflect");
		const settings = enabledSettings();
		settings.setModelRole("reflect", "anthropic/claude-reflect");

		const result = evaluateSecondThoughtGate({
			settings,
			agentKind: "main",
			primaryModel: anthropic,
			availableModels: [anthropic, override],
		});

		expect(result).toEqual({ allowed: true, branchModel: override });
	});

	test("returns stable failures when the once-per-reason notice is reached repeatedly", () => {
		const options = {
			settings: enabledSettings(),
			agentKind: "main" as const,
			primaryModel: openai,
			availableModels: [openai],
		};

		expect(evaluateSecondThoughtGate(options)).toMatchObject({
			allowed: false,
			reason: "primary-model-not-anthropic",
		});
		expect(evaluateSecondThoughtGate(options)).toMatchObject({
			allowed: false,
			reason: "primary-model-not-anthropic",
		});
	});
});

describe("Second Thought settings", () => {
	test("provides the configured schema defaults", () => {
		const settings = Settings.isolated();

		expect(settings.get("secondThought.enabled")).toBe(false);
		expect(settings.get("secondThought.branchCount")).toBe(1);
		expect(settings.get("secondThought.branchMaxTokens")).toBe(2048);
		expect(settings.get("secondThought.harvestCapPerAtom")).toBe(20);
		expect(settings.get("secondThought.deliveryCalls")).toBe(1);
	});
});
