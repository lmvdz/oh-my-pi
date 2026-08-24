import { describe, expect, test } from "bun:test";
import {
	MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES,
	prepareContextLineageCandidateRubric,
} from "../src/context-lineage/candidate-rubric";

describe("Context Lineage candidate rubrics", () => {
	test("preserves bounded operator criteria for sidecar persistence without retaining surrounding command whitespace", () => {
		expect(prepareContextLineageCandidateRubric("  Verify rollback behavior and preserve completed evidence.  ")).toEqual({
			valid: true,
			content: "Verify rollback behavior and preserve completed evidence.",
		});
	});

	test("rejects an oversized rubric before it can reach a reviewer artifact", () => {
		expect(prepareContextLineageCandidateRubric("x".repeat(MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES + 1))).toEqual({
			valid: false,
			reason: "too_large",
		});
	});
});
