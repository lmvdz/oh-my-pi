// PR10 / §22.8: evaluate one completed full-depth candidate family without
// printing candidate, rubric, or evaluator artifact contents. The fixture is
// an operator-authored digest/reference manifest generated from one session;
// it intentionally cannot invoke a provider or invent an evaluator verdict.
import {
	evaluateControlledReasoningBenchmark,
	type ControlledReasoningCandidateOutcome,
} from "@oh-my-pi/pi-coding-agent/context-lineage";

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error("Usage: bun packages/coding-agent/scripts/context-lineage-gates/pr10-controlled-reasoning-evaluation.ts <fixture.json>");

const fixture = await Bun.file(fixturePath).json();
if (!isEvaluationFixture(fixture)) throw new Error("Invalid PR10 controlled-reasoning evaluation fixture");

const report = evaluateControlledReasoningBenchmark({
	familyId: fixture.familyId,
	candidates: fixture.candidateIds.map(candidateId => ({ candidateId })),
	rubricArtifactRef: fixture.rubricArtifactRef,
	rubricContentDigest: fixture.rubricContentDigest,
	evaluatorProfileId: fixture.evaluatorProfileId,
	continuedCandidateIds: fixture.continuedCandidateIds,
	outcomes: fixture.outcomes,
});

console.log(`PR10 evaluation ${report.benchmarkId}`);
console.log(`family=${report.familyId} candidates=${report.result.candidateCount} evaluator=${report.evaluatorProfileId}`);
console.log(
	`falsePruning=${report.result.falsePruning} prunedAcceptable=${report.result.prunedAcceptableCandidateIds.length} unnecessaryContinuation=${report.result.unnecessaryContinuationCandidateIds.length}`,
);
console.log("No artifact bytes were read or printed; retain the fixture and raw artifacts under the authorized session boundary.");

interface ControlledReasoningEvaluationFixture {
	readonly version: 1;
	readonly familyId: string;
	readonly candidateIds: readonly string[];
	readonly rubricArtifactRef: string;
	readonly rubricContentDigest: string;
	readonly evaluatorProfileId: string;
	readonly continuedCandidateIds: readonly string[];
	readonly outcomes: readonly ControlledReasoningCandidateOutcome[];
}

function isEvaluationFixture(value: unknown): value is ControlledReasoningEvaluationFixture {
	if (!isRecord(value) || value.version !== 1) return false;
	if (
		typeof value.familyId !== "string" ||
		!Array.isArray(value.candidateIds) ||
		!value.candidateIds.every(candidateId => typeof candidateId === "string") ||
		typeof value.rubricArtifactRef !== "string" ||
		typeof value.rubricContentDigest !== "string" ||
		typeof value.evaluatorProfileId !== "string" ||
		!Array.isArray(value.continuedCandidateIds) ||
		!value.continuedCandidateIds.every(candidateId => typeof candidateId === "string") ||
		!Array.isArray(value.outcomes)
	) {
		return false;
	}
	return value.outcomes.every(isOutcome);
}

function isOutcome(value: unknown): value is ControlledReasoningCandidateOutcome {
	return (
		isRecord(value) &&
		typeof value.candidateId === "string" &&
		typeof value.artifactRef === "string" &&
		typeof value.candidateContentDigest === "string" &&
		typeof value.evaluatorInputDigest === "string" &&
		typeof value.evaluationArtifactRef === "string" &&
		typeof value.evaluationContentDigest === "string" &&
		(value.verdict === "acceptable" || value.verdict === "unacceptable")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
