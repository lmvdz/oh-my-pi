/** Maximum raw rubric size accepted by blind candidate review and adjudication. */
export const MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES = 64 * 1024;

export type ContextLineageCandidateRubricPreparation =
	| { readonly valid: true; readonly content: string }
	| { readonly valid: false; readonly reason: "empty" | "too_large" };

/**
 * Normalizes operator-owned evaluation criteria before they enter the
 * sidecar-only candidate-review workflow. The returned content is transient;
 * callers persist it only through the session artifact store.
 */
export function prepareContextLineageCandidateRubric(source: string): ContextLineageCandidateRubricPreparation {
	const content = source.trim();
	if (content.length === 0) return { valid: false, reason: "empty" };
	if (new TextEncoder().encode(content).byteLength > MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES) {
		return { valid: false, reason: "too_large" };
	}
	return { valid: true, content };
}
