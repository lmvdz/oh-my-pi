/** Digest-safe provider/model identity retained for a PR10 measurement role. */
export interface ContextLineageEvaluationModelIdentity {
	readonly provider: string;
	readonly model: string;
}

export interface ContextLineageEvaluationProvenance {
	readonly candidateProfileId: string;
	readonly evaluatorProfileId: string;
}

/**
 * Builds durable evaluator provenance for controlled-reasoning measurements.
 * A same-session label may never claim a model that differs from the candidate
 * session; a separate session remains explicit even when both sessions use the
 * same model.
 */
export function createContextLineageEvaluationProvenance(input: {
	readonly candidate: ContextLineageEvaluationModelIdentity;
	readonly evaluator: ContextLineageEvaluationModelIdentity;
	readonly isolation: "same-session" | "separate-session";
	readonly profileId: string;
	readonly continuationPolicy: string;
}): ContextLineageEvaluationProvenance {
	validateIdentity(input.candidate, "candidate");
	validateIdentity(input.evaluator, "evaluator");
	if (!input.profileId || !input.continuationPolicy) {
		throw new Error("Context Lineage evaluator provenance requires profile and continuation policy");
	}
	const candidateProfileId = `${input.candidate.provider}/${input.candidate.model}`;
	const evaluatorIdentity = `${input.evaluator.provider}/${input.evaluator.model}`;
	if (input.isolation === "same-session" && candidateProfileId !== evaluatorIdentity) {
		throw new Error("Same-session evaluator provenance must match the candidate model");
	}
	return {
		candidateProfileId,
		evaluatorProfileId: `context-lineage-pr10-full-depth-v1:${input.isolation}:${evaluatorIdentity}:${input.profileId}:${input.continuationPolicy}`,
	};
}

function validateIdentity(identity: ContextLineageEvaluationModelIdentity, role: string): void {
	if (!identity.provider || !identity.model) throw new Error(`Context Lineage ${role} provenance requires provider and model`);
}
