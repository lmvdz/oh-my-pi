import { semanticIdentity } from "./identity";

/** Declared difference between otherwise identical candidate leaves (PR 10). */
export interface ContextLineageCandidateVariation {
	readonly id: string;
	readonly label: "counterfactual" | "candidate" | "reviewer_role" | "context_delta";
	readonly value: string;
}

export interface ContextLineageCandidate {
	readonly candidateId: string;
	readonly taskId: string;
	readonly assignmentDigest: string;
	readonly variation: readonly ContextLineageCandidateVariation[];
	readonly artifactRef?: string;
	/** Observed only after a side request settles; never declared in a family definition. */
	readonly executionObservation?: ContextLineageCandidateExecutionObservation;
	readonly status: "pending" | "completed" | "discarded";
}

/** Final accounting captured from one isolated candidate request. */
export interface ContextLineageCandidateExecutionObservation {
	readonly elapsedMs: number;
	/** Omitted if the finalized provider response had no reliable token accounting. */
	readonly usage?: {
		readonly totalTokens: number;
		readonly costUsd: number;
	};
}

export interface ContextLineageSelectionRecord {
	readonly selectionId: string;
	readonly candidateId: string;
	readonly rubricArtifactRef: string;
	readonly visibleEvidence: readonly string[];
	readonly evaluator: string;
	readonly explanation: string;
	/** Present only when selection is grounded in an explicit authorized adjudication. */
	readonly adjudicationArtifactRef?: string;
	readonly authorizedReviewArtifactRefs?: readonly string[];
}

/**
 * Creates a candidate family only when all leaves share an assignment and vary
 * solely through declared labels. This prevents hidden prompt/context drift
 * from being represented as a counterfactual experiment.
 */
export function createContextLineageCandidateFamily(input: {
	readonly taskId: string;
	readonly assignment: string;
	readonly variations: readonly (readonly ContextLineageCandidateVariation[])[];
}): readonly ContextLineageCandidate[] {
	if (input.variations.length < 2) throw new Error("Context Lineage candidate families require at least two leaves");
	const assignmentDigest = semanticIdentity("context-lineage-candidate-assignment", input.assignment);
	return input.variations.map(variation => {
		validateVariations(variation);
		const candidateId = semanticIdentity("context-lineage-candidate", {
			taskId: input.taskId,
			assignmentDigest,
			variation: canonicalVariations(variation),
		});
		return { candidateId, taskId: input.taskId, assignmentDigest, variation: canonicalVariations(variation), status: "pending" };
	});
}

/** A blinded evaluator view contains only the candidate explicitly assigned to it. */
export function createBlindedCandidateReview(input: {
	readonly candidate: ContextLineageCandidate;
	readonly rubricArtifactRef: string;
}): { readonly candidateId: string; readonly artifactRef?: string; readonly rubricArtifactRef: string } {
	if (input.candidate.status !== "completed") throw new Error("Only completed candidates may be reviewed");
	return {
		candidateId: input.candidate.candidateId,
		...(input.candidate.artifactRef ? { artifactRef: input.candidate.artifactRef } : {}),
		rubricArtifactRef: input.rubricArtifactRef,
	};
}

export function createContextLineageSelectionRecord(input: Omit<ContextLineageSelectionRecord, "selectionId">): ContextLineageSelectionRecord {
	if (input.rubricArtifactRef.length === 0) throw new Error("Candidate selection requires a persisted rubric artifact");
	if (input.evaluator.length === 0 || input.explanation.trim().length === 0) {
		throw new Error("Candidate selection requires evaluator provenance and an explanation");
	}
	if ((input.adjudicationArtifactRef === undefined) !== (input.authorizedReviewArtifactRefs === undefined)) {
		throw new Error("Adjudication-backed selection requires both its artifact and authorized review set");
	}
	if (input.authorizedReviewArtifactRefs && new Set(input.authorizedReviewArtifactRefs).size < 2) {
		throw new Error("Adjudication-backed selection requires at least two authorized reviews");
	}
	const visibleEvidence = [...new Set(input.visibleEvidence)].sort();
	const semantic = {
		...input,
		visibleEvidence,
		...(input.authorizedReviewArtifactRefs
			? { authorizedReviewArtifactRefs: [...new Set(input.authorizedReviewArtifactRefs)].sort() }
			: {}),
	};
	return { ...semantic, selectionId: semanticIdentity("context-lineage-selection", semantic) };
}

export interface AdaptiveDeliberationBudget {
	readonly maxRequests: number;
	readonly maxTokens: number;
	readonly maxDurationMs: number;
	readonly maxCostUsd: number;
}

export interface AdaptiveDeliberationObservation {
	readonly requests: number;
	readonly tokens: number;
	readonly elapsedMs: number;
	readonly costUsd: number;
	/** An independent evaluation signal, not model self-reported confidence. */
	readonly disagreement?: number;
	readonly rubricScore?: number;
}

export interface AdaptiveDeliberationPolicy {
	readonly topK: number;
	readonly disagreementThreshold?: number;
	readonly minimumRubricScore?: number;
	readonly budget: AdaptiveDeliberationBudget;
}

export type AdaptiveDeliberationDecision =
	| { readonly allocate: true; readonly reason: "manual" | "disagreement" | "rubric_gap" }
	| { readonly allocate: false; readonly reason: "budget_exhausted" | "no_evaluated_trigger" | "threshold_met" };

/** Bounded continuation gate. Self-reported confidence intentionally has no input. */
export function decideAdaptiveDeliberation(
	policy: AdaptiveDeliberationPolicy,
	observation: AdaptiveDeliberationObservation,
	manual = false,
): AdaptiveDeliberationDecision {
	validateAdaptivePolicy(policy);
	if (
		observation.requests >= policy.budget.maxRequests ||
		observation.tokens >= policy.budget.maxTokens ||
		observation.elapsedMs >= policy.budget.maxDurationMs ||
		observation.costUsd >= policy.budget.maxCostUsd
	) {
		return { allocate: false, reason: "budget_exhausted" };
	}
	if (manual) return { allocate: true, reason: "manual" };
	if (policy.disagreementThreshold !== undefined && (observation.disagreement ?? 0) >= policy.disagreementThreshold) {
		return { allocate: true, reason: "disagreement" };
	}
	if (policy.minimumRubricScore !== undefined && (observation.rubricScore ?? Infinity) < policy.minimumRubricScore) {
		return { allocate: true, reason: "rubric_gap" };
	}
	return {
		allocate: false,
		reason:
			policy.disagreementThreshold === undefined && policy.minimumRubricScore === undefined
				? "no_evaluated_trigger"
				: "threshold_met",
	};
}

function canonicalVariations(variations: readonly ContextLineageCandidateVariation[]): readonly ContextLineageCandidateVariation[] {
	return [...variations].sort((left, right) => left.id.localeCompare(right.id));
}

function validateVariations(variations: readonly ContextLineageCandidateVariation[]): void {
	const ids = new Set<string>();
	for (const variation of variations) {
		if (variation.id.length === 0 || variation.value.length === 0) throw new Error("Candidate variations require an id and value");
		if (ids.has(variation.id)) throw new Error(`Duplicate candidate variation: ${variation.id}`);
		ids.add(variation.id);
	}
}

function validateAdaptivePolicy(policy: AdaptiveDeliberationPolicy): void {
	if (!Number.isSafeInteger(policy.topK) || policy.topK < 1) throw new Error("Adaptive deliberation topK must be a positive integer");
	if (!Number.isSafeInteger(policy.budget.maxRequests) || policy.budget.maxRequests < 0) {
		throw new Error("Adaptive deliberation maxRequests must be a non-negative safe integer");
	}
	const hasAutomaticTrigger = policy.disagreementThreshold !== undefined || policy.minimumRubricScore !== undefined;
	if (hasAutomaticTrigger && policy.budget.maxRequests === 0) {
		throw new Error("Automatic adaptive deliberation requires a positive hard request bound");
	}
	for (const [name, value] of Object.entries(policy.budget)) {
		if (name === "maxRequests") continue;
		if (!Number.isFinite(value) || value < 0) throw new Error(`Adaptive deliberation ${name} must be non-negative`);
	}
}
