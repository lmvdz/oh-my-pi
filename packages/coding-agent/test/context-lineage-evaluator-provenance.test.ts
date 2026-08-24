import { describe, expect, test } from "bun:test";
import { createContextLineageEvaluationProvenance } from "../src/context-lineage/evaluator-provenance";

describe("Context Lineage evaluator provenance", () => {
	test("records same-session evaluation against the exact candidate model", () => {
		expect(
			createContextLineageEvaluationProvenance({
				candidate: { provider: "openai-codex", model: "gpt-5.4-mini" },
				evaluator: { provider: "openai-codex", model: "gpt-5.4-mini" },
				isolation: "same-session",
				profileId: "adapter-authority",
				continuationPolicy: "preliminary-rubric",
			}),
		).toEqual({
			candidateProfileId: "openai-codex/gpt-5.4-mini",
			evaluatorProfileId: "context-lineage-pr10-full-depth-v1:same-session:openai-codex/gpt-5.4-mini:adapter-authority:preliminary-rubric",
		});
	});

	test("rejects a false same-session claim and labels a distinct evaluator session", () => {
		expect(() =>
			createContextLineageEvaluationProvenance({
				candidate: { provider: "openai-codex", model: "gpt-5.4-mini" },
				evaluator: { provider: "anthropic", model: "claude-haiku-4-5" },
				isolation: "same-session",
				profileId: "adapter-authority",
				continuationPolicy: "preliminary-rubric",
			}),
		).toThrow("Same-session evaluator provenance must match the candidate model");
		expect(
			createContextLineageEvaluationProvenance({
				candidate: { provider: "openai-codex", model: "gpt-5.4-mini" },
				evaluator: { provider: "anthropic", model: "claude-haiku-4-5" },
				isolation: "separate-session",
				profileId: "adapter-authority",
				continuationPolicy: "preliminary-rubric",
			}).evaluatorProfileId,
		).toBe("context-lineage-pr10-full-depth-v1:separate-session:anthropic/claude-haiku-4-5:adapter-authority:preliminary-rubric");
	});
});
