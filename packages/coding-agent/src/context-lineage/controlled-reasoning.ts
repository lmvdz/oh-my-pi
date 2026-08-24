import type { ContextLineageCandidate } from "./deliberation";
import { isContextLineageDeclaredOutcome, type ContextLineageDeclaredOutcome } from "./declared-outcome";
import { semanticIdentity } from "./identity";

/** One independent full-depth adjudication of a candidate under a declared rubric. */
export interface ControlledReasoningCandidateOutcome {
	readonly candidateId: string;
	readonly artifactRef: string;
	/** Digest of the candidate body stored at artifactRef; raw content stays local. */
	readonly candidateContentDigest: string;
	/** Digest of the two bodies visible to this evaluator: rubric and candidate only. */
	readonly evaluatorInputDigest: string;
	readonly evaluationArtifactRef: string;
	/** Digest of the evaluator body stored at evaluationArtifactRef. */
	readonly evaluationContentDigest: string;
	readonly verdict: "acceptable" | "unacceptable";
	/** Optional deterministic outcome reference for evaluator calibration. */
	readonly declaredOutcome?: ContextLineageDeclaredOutcome;
}

/** Immutable inputs and results for one PR10/§22.8 selection evaluation. */
export interface ControlledReasoningBenchmarkReport {
	readonly version: 1;
	readonly benchmarkId: string;
	readonly familyId: string;
	readonly rubricArtifactRef: string;
	/** Digest of the rubric body stored at rubricArtifactRef. */
	readonly rubricContentDigest: string;
	readonly evaluatorProfileId: string;
	/** Candidate IDs granted expensive continuation after the operator's decision. */
	readonly continuedCandidateIds: readonly string[];
	/** Full-depth outcomes, including branches the operator pruned. */
	readonly outcomes: readonly ControlledReasoningCandidateOutcome[];
	readonly result: ControlledReasoningBenchmarkResult;
}

/** Metrics that separate a missed viable branch from needless deepening. */
export interface ControlledReasoningBenchmarkResult {
	readonly candidateCount: number;
	readonly acceptableCandidateIds: readonly string[];
	readonly continuedAcceptableCandidateIds: readonly string[];
	readonly prunedAcceptableCandidateIds: readonly string[];
	/** True when full-depth evaluation found value but continuation excluded every viable candidate. */
	readonly falsePruning: boolean;
	/** Continued branches that full-depth evaluation found unacceptable. */
	readonly unnecessaryContinuationCandidateIds: readonly string[];
	/** Present only when every full-depth outcome carries one declared-rule reference. */
	readonly declaredOutcome?: ControlledReasoningDeclaredOutcomeResult;
}

/** Calibration against a declared artifact-only outcome contract, not model self-assessment. */
export interface ControlledReasoningDeclaredOutcomeResult {
	readonly profileId: string;
	readonly acceptableCandidateIds: readonly string[];
	readonly continuedAcceptableCandidateIds: readonly string[];
	readonly falsePruning: boolean;
	/** Evaluator accepted a candidate rejected by the declared outcome contract. */
	readonly evaluatorFalseAcceptanceCandidateIds: readonly string[];
	/** Evaluator rejected a candidate accepted by the declared outcome contract. */
	readonly evaluatorFalseRejectionCandidateIds: readonly string[];
}

/**
 * Measures user-approved candidate continuation against a full-depth rubric
 * evaluation. Raw candidate and evaluator bodies stay behind artifact refs;
 * this report is safe to persist in a session journal and aggregate across
 * independent samples.
 */
export function evaluateControlledReasoningBenchmark(input: {
	readonly familyId: string;
	readonly candidates: readonly Pick<ContextLineageCandidate, "candidateId">[];
	readonly rubricArtifactRef: string;
	readonly rubricContentDigest: string;
	readonly evaluatorProfileId: string;
	readonly continuedCandidateIds: readonly string[];
	readonly outcomes: readonly ControlledReasoningCandidateOutcome[];
}): ControlledReasoningBenchmarkReport {
	if (input.candidates.length < 2) throw new Error("Controlled reasoning benchmark requires at least two candidates");
	if (!input.rubricArtifactRef || !input.rubricContentDigest || !input.evaluatorProfileId) {
		throw new Error("Controlled reasoning benchmark requires rubric and evaluator provenance");
	}
	const candidateIds = new Set(input.candidates.map(candidate => candidate.candidateId));
	if (candidateIds.size !== input.candidates.length) throw new Error("Controlled reasoning benchmark candidates must be unique");
	const continuedCandidateIds = canonicalCandidateIds(input.continuedCandidateIds, candidateIds, "continued candidate");
	const outcomes = canonicalOutcomes(input.outcomes, candidateIds, input.rubricContentDigest);
	const acceptableCandidateIds = outcomes.filter(outcome => outcome.verdict === "acceptable").map(outcome => outcome.candidateId);
	const continued = new Set(continuedCandidateIds);
	const continuedAcceptableCandidateIds = acceptableCandidateIds.filter(candidateId => continued.has(candidateId));
	const prunedAcceptableCandidateIds = acceptableCandidateIds.filter(candidateId => !continued.has(candidateId));
	const unnecessaryContinuationCandidateIds = outcomes
		.filter(outcome => continued.has(outcome.candidateId) && outcome.verdict === "unacceptable")
		.map(outcome => outcome.candidateId);
	const result: ControlledReasoningBenchmarkResult = {
		candidateCount: input.candidates.length,
		acceptableCandidateIds,
		continuedAcceptableCandidateIds,
		prunedAcceptableCandidateIds,
		falsePruning: acceptableCandidateIds.length > 0 && continuedAcceptableCandidateIds.length === 0,
		unnecessaryContinuationCandidateIds,
		...declaredOutcomeResult(outcomes, continued),
	};
	const semanticReport = {
		version: 1 as const,
		familyId: input.familyId,
		rubricArtifactRef: input.rubricArtifactRef,
		rubricContentDigest: input.rubricContentDigest,
		evaluatorProfileId: input.evaluatorProfileId,
		continuedCandidateIds,
		outcomes,
		result,
	};
	return {
		...semanticReport,
		benchmarkId: semanticIdentity("context-lineage-controlled-reasoning-benchmark", semanticReport),
	};
}

function declaredOutcomeResult(
	outcomes: readonly ControlledReasoningCandidateOutcome[],
	continued: ReadonlySet<string>,
): Pick<ControlledReasoningBenchmarkResult, "declaredOutcome"> {
	const declaredOutcomes = outcomes.map(outcome => outcome.declaredOutcome);
	if (declaredOutcomes.every(outcome => outcome === undefined)) return {};
	if (declaredOutcomes.some(outcome => outcome === undefined)) {
		throw new Error("Controlled reasoning benchmark requires declared outcomes for every candidate or none");
	}
	const first = declaredOutcomes[0];
	if (!first) throw new Error("Controlled reasoning benchmark declared outcome is missing");
	if (declaredOutcomes.some(outcome => outcome?.profileId !== first.profileId)) {
		throw new Error("Controlled reasoning benchmark declared outcomes must share one profile");
	}
	const acceptableCandidateIds = outcomes
		.filter(outcome => outcome.declaredOutcome?.verdict === "acceptable")
		.map(outcome => outcome.candidateId);
	const continuedAcceptableCandidateIds = acceptableCandidateIds.filter(candidateId => continued.has(candidateId));
	return {
		declaredOutcome: {
			profileId: first.profileId,
			acceptableCandidateIds,
			continuedAcceptableCandidateIds,
			falsePruning: acceptableCandidateIds.length > 0 && continuedAcceptableCandidateIds.length === 0,
			evaluatorFalseAcceptanceCandidateIds: outcomes
				.filter(outcome => outcome.verdict === "acceptable" && outcome.declaredOutcome?.verdict === "unacceptable")
				.map(outcome => outcome.candidateId),
			evaluatorFalseRejectionCandidateIds: outcomes
				.filter(outcome => outcome.verdict === "unacceptable" && outcome.declaredOutcome?.verdict === "acceptable")
				.map(outcome => outcome.candidateId),
		},
	};
}

/** Digest a local artifact body without placing that body in a durable report. */
export function contextLineageArtifactContentDigest(content: string): string {
	return semanticIdentity("context-lineage-artifact-content", content);
}

/** Bind an evaluator turn to exactly its declared clean-room inputs. */
export function contextLineageEvaluatorInputDigest(input: {
	readonly rubricContentDigest: string;
	readonly candidateContentDigest: string;
}): string {
	if (!input.rubricContentDigest || !input.candidateContentDigest) {
		throw new Error("Controlled reasoning evaluator input requires rubric and candidate digests");
	}
	return semanticIdentity("context-lineage-evaluator-input", input);
}

/**
 * Re-read the authorized local artifacts and prove that a persisted report still
 * refers to the exact rubric, candidate, and evaluator bodies it measured.
 */
export async function verifyControlledReasoningArtifactIntegrity(
	report: ControlledReasoningBenchmarkReport,
	readArtifact: (artifactRef: string) => Promise<string | undefined>,
): Promise<void> {
	const rubric = await readArtifact(report.rubricArtifactRef);
	if (rubric === undefined || contextLineageArtifactContentDigest(rubric) !== report.rubricContentDigest) {
		throw new Error("Controlled reasoning rubric artifact no longer matches its persisted digest");
	}
	for (const outcome of report.outcomes) {
		const candidate = await readArtifact(outcome.artifactRef);
		if (candidate === undefined || contextLineageArtifactContentDigest(candidate) !== outcome.candidateContentDigest) {
			throw new Error("Controlled reasoning candidate artifact no longer matches its persisted digest");
		}
		const evaluator = await readArtifact(outcome.evaluationArtifactRef);
		if (evaluator === undefined || contextLineageArtifactContentDigest(evaluator) !== outcome.evaluationContentDigest) {
			throw new Error("Controlled reasoning evaluator artifact no longer matches its persisted digest");
		}
		if (
			contextLineageEvaluatorInputDigest({
				rubricContentDigest: report.rubricContentDigest,
				candidateContentDigest: outcome.candidateContentDigest,
			}) !== outcome.evaluatorInputDigest
		) {
			throw new Error("Controlled reasoning evaluator inputs no longer match declared clean-room provenance");
		}
	}
}

function canonicalCandidateIds(
	candidateIds: readonly string[],
	knownCandidateIds: ReadonlySet<string>,
	label: string,
): readonly string[] {
	if (candidateIds.length === 0) throw new Error("Controlled reasoning benchmark requires at least one continued candidate");
	const unique = [...new Set(candidateIds)].sort();
	if (unique.length !== candidateIds.length) throw new Error(`Controlled reasoning benchmark ${label}s must be unique`);
	if (unique.some(candidateId => !knownCandidateIds.has(candidateId))) {
		throw new Error(`Controlled reasoning benchmark references an unknown ${label}`);
	}
	return unique;
}

function canonicalOutcomes(
	outcomes: readonly ControlledReasoningCandidateOutcome[],
	knownCandidateIds: ReadonlySet<string>,
	rubricContentDigest: string,
): readonly ControlledReasoningCandidateOutcome[] {
	if (outcomes.length !== knownCandidateIds.size) {
		throw new Error("Controlled reasoning benchmark requires a full-depth outcome for every candidate");
	}
	const byCandidateId = new Map<string, ControlledReasoningCandidateOutcome>();
	for (const outcome of outcomes) {
		if (!knownCandidateIds.has(outcome.candidateId)) throw new Error("Controlled reasoning benchmark outcome references an unknown candidate");
		if (
			!outcome.artifactRef ||
			!outcome.candidateContentDigest ||
			!outcome.evaluatorInputDigest ||
			!outcome.evaluationArtifactRef ||
			!outcome.evaluationContentDigest
		) {
			throw new Error("Controlled reasoning benchmark outcomes require candidate and evaluation artifact references");
		}
		if (outcome.declaredOutcome !== undefined && !isContextLineageDeclaredOutcome(outcome.declaredOutcome)) {
			throw new Error("Controlled reasoning benchmark declared outcome is invalid");
		}
		if (
			contextLineageEvaluatorInputDigest({
				rubricContentDigest,
				candidateContentDigest: outcome.candidateContentDigest,
			}) !== outcome.evaluatorInputDigest
		) {
			throw new Error("Controlled reasoning benchmark outcome evaluator input digest is invalid");
		}
		if (byCandidateId.has(outcome.candidateId)) throw new Error("Controlled reasoning benchmark outcomes must be unique");
		byCandidateId.set(outcome.candidateId, outcome);
	}
	return [...byCandidateId.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}
