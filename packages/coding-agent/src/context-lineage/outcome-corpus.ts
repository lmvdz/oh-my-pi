import { semanticIdentity } from "./identity";

/** Immutable, structured PR10 task contract used to calibrate an evaluator. */
export interface ContextLineageOutcomeCorpusCase {
	readonly caseId: string;
	readonly requiredObligationIds: readonly string[];
	readonly forbiddenObligationIds: readonly string[];
}

/** Candidate-declared outcome shape. Bodies stay in artifacts; this is parsed transiently. */
export interface ContextLineageStructuredCandidateOutcome {
	readonly satisfiedObligationIds: readonly string[];
	readonly proposedForbiddenObligationIds: readonly string[];
}

/** Digest-safe declared-rule adjudication of an immutable outcome corpus case. */
export interface ContextLineageOutcomeCorpusAdjudication {
	readonly caseId: string;
	readonly corpusCaseId: string;
	readonly verdict: "acceptable" | "unacceptable";
	readonly missingRequiredObligationIds: readonly string[];
	readonly proposedForbiddenObligationIds: readonly string[];
}

/** A human measurement choice; it never authorizes execution or continuation. */
export type ContextLineageStructuredOutcomeMeasurementOverride =
	| { readonly kind: "candidate"; readonly candidateId: string }
	| { readonly kind: "stop" };

/** Digest/reference-only candidate inputs retained by the durable PR10 harness. */
export interface ContextLineageStructuredOutcomeMeasurementCandidate {
	readonly candidateId: string;
	readonly candidateArtifactRef: string;
	readonly candidateContentDigest: string;
	readonly candidateContent: string;
	readonly evaluatorArtifactRef: string;
	readonly evaluatorContentDigest: string;
	readonly evaluatorVerdict: "acceptable" | "unacceptable";
}

/** One safely reportable structured-corpus outcome; raw bodies remain in artifacts. */
export interface ContextLineageStructuredOutcomeMeasurementCandidateResult {
	readonly candidateId: string;
	readonly candidateArtifactRef: string;
	readonly candidateContentDigest: string;
	readonly evaluatorArtifactRef: string;
	readonly evaluatorContentDigest: string;
	readonly evaluatorVerdict: "acceptable" | "unacceptable";
	readonly structuredOutcomeStatus: "valid" | "malformed" | "unknown_obligation";
	readonly deterministicVerdict: "acceptable" | "unacceptable";
	readonly corpusAdjudication?: ContextLineageOutcomeCorpusAdjudication;
}

/** Aggregate calibration metrics for exactly one two-candidate PR10 corpus measurement. */
export interface ContextLineageStructuredOutcomeMeasurementReport {
	readonly version: 1;
	readonly measurementId: string;
	readonly caseId: string;
	readonly corpusCaseId: string;
	readonly override: ContextLineageStructuredOutcomeMeasurementOverride;
	readonly candidates: readonly ContextLineageStructuredOutcomeMeasurementCandidateResult[];
	readonly deterministicAcceptableCandidateIds: readonly string[];
	readonly evaluatorVsDeterministicDisagreementCandidateIds: readonly string[];
	readonly evaluatorFalseAcceptanceCandidateIds: readonly string[];
	readonly evaluatorFalseRejectionCandidateIds: readonly string[];
	readonly falsePruning: boolean;
	readonly unnecessaryContinuationCandidateIds: readonly string[];
}

/** First bounded corpus: representative PR10 boundary/recovery contracts, not selection authority. */
export const CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1: readonly ContextLineageOutcomeCorpusCase[] = [
	{
		caseId: "adapter-authority",
		requiredObligationIds: ["adapter_optional", "adapter_non_mutating", "snapshot_staleness", "fallback", "authority_regression_test"],
		forbiddenObligationIds: ["external_graph_current_truth", "implicit_network_retrieval"],
	},
	{
		caseId: "capability-isolation",
		requiredObligationIds: ["frozen_base", "no_tools", "parent_raw_answer_isolation", "negative_capability_test", "restart_or_retry"],
		forbiddenObligationIds: ["workspace_access", "unprovided_provider_capability"],
	},
	{
		caseId: "recovery-replay",
		requiredObligationIds: ["completed_output_durability", "restart_recovery", "approved_replacement", "descendant_only_replay", "unaffected_stage_test"],
		forbiddenObligationIds: ["branch_state_merge", "ungrounded_cache_claim"],
	},
] as const;

/** Strictly parse a candidate's standalone structured outcome declaration. */
export function parseContextLineageStructuredCandidateOutcome(content: string): ContextLineageStructuredCandidateOutcome {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("Structured candidate outcome must be valid JSON");
	}
	if (!isRecord(value) || !isStringArray(value.satisfiedObligationIds) || !isStringArray(value.proposedForbiddenObligationIds)) {
		throw new Error("Structured candidate outcome must declare obligation ID arrays");
	}
	if (new Set(value.satisfiedObligationIds).size !== value.satisfiedObligationIds.length) {
		throw new Error("Structured candidate outcome cannot repeat satisfied obligation IDs");
	}
	if (new Set(value.proposedForbiddenObligationIds).size !== value.proposedForbiddenObligationIds.length) {
		throw new Error("Structured candidate outcome cannot repeat forbidden obligation IDs");
	}
	return {
		satisfiedObligationIds: [...value.satisfiedObligationIds].sort(),
		proposedForbiddenObligationIds: [...value.proposedForbiddenObligationIds].sort(),
	};
}

/** Compare a structured candidate declaration against one immutable corpus case. */
export function adjudicateContextLineageOutcomeCorpus(
	corpusCase: ContextLineageOutcomeCorpusCase,
	candidate: ContextLineageStructuredCandidateOutcome,
): ContextLineageOutcomeCorpusAdjudication {
	validateCase(corpusCase);
	const satisfied = new Set(candidate.satisfiedObligationIds);
	const forbidden = new Set(candidate.proposedForbiddenObligationIds);
	const known = new Set([...corpusCase.requiredObligationIds, ...corpusCase.forbiddenObligationIds]);
	if ([...satisfied, ...forbidden].some(id => !known.has(id))) {
		throw new Error("Structured candidate outcome references an obligation outside its immutable corpus case");
	}
	const missingRequiredObligationIds = corpusCase.requiredObligationIds.filter(id => !satisfied.has(id));
	const proposedForbiddenObligationIds = corpusCase.forbiddenObligationIds.filter(id => forbidden.has(id));
	return {
		caseId: corpusCase.caseId,
		corpusCaseId: semanticIdentity("context-lineage-pr10-outcome-corpus-case", corpusCase),
		verdict: missingRequiredObligationIds.length === 0 && proposedForbiddenObligationIds.length === 0 ? "acceptable" : "unacceptable",
		missingRequiredObligationIds,
		proposedForbiddenObligationIds,
	};
}

/**
 * Build the digest-safe report for one structured PR10 corpus measurement.
 * Invalid candidate JSON is deliberately retained as an explicit unacceptable
 * result so a provider response cannot abort or silently improve the sample.
 */
export function evaluateContextLineageStructuredOutcomeMeasurement(input: {
	readonly corpusCase: ContextLineageOutcomeCorpusCase;
	readonly candidates: readonly ContextLineageStructuredOutcomeMeasurementCandidate[];
	readonly override: ContextLineageStructuredOutcomeMeasurementOverride;
}): ContextLineageStructuredOutcomeMeasurementReport {
	validateCase(input.corpusCase);
	if (input.candidates.length !== 2) throw new Error("Structured outcome measurement requires exactly two candidates");
	const candidateIds = new Set(input.candidates.map(candidate => candidate.candidateId));
	if (candidateIds.size !== input.candidates.length || [...candidateIds].some(candidateId => !candidateId)) {
		throw new Error("Structured outcome measurement candidate IDs must be unique and non-empty");
	}
	if (input.override.kind === "candidate" && !candidateIds.has(input.override.candidateId)) {
		throw new Error("Structured outcome measurement override references an unknown candidate");
	}
	const candidates = input.candidates
		.map(candidate => measureCandidate(input.corpusCase, candidate))
		.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
	const deterministicAcceptableCandidateIds = candidates
		.filter(candidate => candidate.deterministicVerdict === "acceptable")
		.map(candidate => candidate.candidateId);
	const evaluatorVsDeterministicDisagreementCandidateIds = candidates
		.filter(candidate => candidate.evaluatorVerdict !== candidate.deterministicVerdict)
		.map(candidate => candidate.candidateId);
	const evaluatorFalseAcceptanceCandidateIds = candidates
		.filter(candidate => candidate.evaluatorVerdict === "acceptable" && candidate.deterministicVerdict === "unacceptable")
		.map(candidate => candidate.candidateId);
	const evaluatorFalseRejectionCandidateIds = candidates
		.filter(candidate => candidate.evaluatorVerdict === "unacceptable" && candidate.deterministicVerdict === "acceptable")
		.map(candidate => candidate.candidateId);
	const continuedCandidateIds = input.override.kind === "candidate" ? [input.override.candidateId] : [];
	const continuedAcceptableCandidateIds = deterministicAcceptableCandidateIds.filter(candidateId => continuedCandidateIds.includes(candidateId));
	const unnecessaryContinuationCandidateIds = continuedCandidateIds.filter(candidateId => !deterministicAcceptableCandidateIds.includes(candidateId));
	const semanticReport = {
		version: 1 as const,
		caseId: input.corpusCase.caseId,
		corpusCaseId: semanticIdentity("context-lineage-pr10-outcome-corpus-case", input.corpusCase),
		override: input.override,
		candidates,
		deterministicAcceptableCandidateIds,
		evaluatorVsDeterministicDisagreementCandidateIds,
		evaluatorFalseAcceptanceCandidateIds,
		evaluatorFalseRejectionCandidateIds,
		falsePruning: deterministicAcceptableCandidateIds.length > 0 && continuedAcceptableCandidateIds.length === 0,
		unnecessaryContinuationCandidateIds,
	};
	return {
		...semanticReport,
		measurementId: semanticIdentity("context-lineage-pr10-structured-outcome-measurement", semanticReport),
	};
}

function measureCandidate(
	corpusCase: ContextLineageOutcomeCorpusCase,
	candidate: ContextLineageStructuredOutcomeMeasurementCandidate,
): ContextLineageStructuredOutcomeMeasurementCandidateResult {
	const result = {
		candidateId: candidate.candidateId,
		candidateArtifactRef: candidate.candidateArtifactRef,
		candidateContentDigest: candidate.candidateContentDigest,
		evaluatorArtifactRef: candidate.evaluatorArtifactRef,
		evaluatorContentDigest: candidate.evaluatorContentDigest,
		evaluatorVerdict: candidate.evaluatorVerdict,
	};
	try {
		const parsed = parseContextLineageStructuredCandidateOutcome(candidate.candidateContent);
		try {
			const corpusAdjudication = adjudicateContextLineageOutcomeCorpus(corpusCase, parsed);
			return { ...result, structuredOutcomeStatus: "valid", deterministicVerdict: corpusAdjudication.verdict, corpusAdjudication };
		} catch {
			return { ...result, structuredOutcomeStatus: "unknown_obligation", deterministicVerdict: "unacceptable" };
		}
	} catch {
		return { ...result, structuredOutcomeStatus: "malformed", deterministicVerdict: "unacceptable" };
	}
}

function validateCase(corpusCase: ContextLineageOutcomeCorpusCase): void {
	if (!corpusCase.caseId || corpusCase.requiredObligationIds.length === 0) throw new Error("Outcome corpus case requires an ID and obligations");
	if (!isUniqueNonEmpty(corpusCase.requiredObligationIds) || !isUniqueNonEmpty(corpusCase.forbiddenObligationIds)) {
		throw new Error("Outcome corpus case obligation IDs must be unique and non-empty");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
}

function isUniqueNonEmpty(values: readonly string[]): boolean {
	return values.every(value => value.length > 0) && new Set(values).size === values.length;
}
