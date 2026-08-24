import { contextLineagePlanIdentity, repositorySnapshotIdentity, semanticIdentity } from "./identity";
import { isRepositoryContextManifestIntact, renderRepositoryContextManifest } from "./manifest";
import type { ContextLineagePlan, LogicalContextCheckpoint, RepositoryContextManifest, RepositorySnapshot } from "./types";

/** A persisted planning base that may safely serve an isolated follow-up question. */
export interface ContextLineageBaseSelectionCandidate {
	readonly planId: string;
	readonly plan: ContextLineagePlan;
	readonly checkpoint: LogicalContextCheckpoint;
	readonly manifest: RepositoryContextManifest;
	/** Source excerpts must be available to recreate the same provider-visible prefix. */
	readonly evidenceAvailable: boolean;
}

/** Digest-safe explanation for a candidate not selected for an ad-hoc question. */
export interface ContextLineageBaseRejection {
	readonly planId: string;
	readonly checkpointId: string;
	readonly reason:
		| "plan_identity_invalid"
		| "manifest_integrity_invalid"
		| "checkpoint_manifest_mismatch"
		| "repository_scope_mismatch"
		| "workspace_scope_mismatch"
		| "snapshot_stale"
		| "evidence_unavailable"
		| "task_not_relevant"
		| "lower_relevance"
		| "smaller_shared_prefix"
		| "plan_id_tiebreak";
}

export interface ContextLineageBaseSelection {
	readonly selectionId: string;
	readonly taskDigest: string;
	readonly planId: string;
	readonly checkpointId: string;
	readonly manifestId: string;
	/** Bounded stable context bytes before the individual question is appended. */
	readonly expectedSharedBytes: number;
	/** Human-readable decision reason; contains no repository source or question bytes. */
	readonly rationale: "semantic_eligibility_then_largest_shared_prefix";
	readonly rejected: readonly ContextLineageBaseRejection[];
}

export type ContextLineageBaseSelectionOutcome =
	| { readonly selected: ContextLineageBaseSelection; readonly candidate: ContextLineageBaseSelectionCandidate }
	| { readonly selected: undefined; readonly taskDigest: string; readonly rejected: readonly ContextLineageBaseRejection[] };

/** Durable explanation for intentionally creating a fresh context instead of reusing a candidate. */
export interface ContextLineageBaseSelectionFallback {
	readonly fallbackId: string;
	readonly runId: string;
	readonly taskDigest: string;
	readonly rejected: readonly ContextLineageBaseRejection[];
}

export function createContextLineageBaseSelectionFallback(input: {
	readonly runId: string;
	readonly taskDigest: string;
	readonly rejected: readonly ContextLineageBaseRejection[];
}): ContextLineageBaseSelectionFallback {
	const fallback = { runId: input.runId, taskDigest: input.taskDigest, rejected: canonicalRejections(input.rejected) };
	return { ...fallback, fallbackId: semanticIdentity("context-lineage-base-selection-fallback", fallback) };
}

export function isContextLineageBaseSelectionFallback(value: unknown): value is ContextLineageBaseSelectionFallback {
	if (!isRecord(value) || typeof value.fallbackId !== "string" || typeof value.runId !== "string" || typeof value.taskDigest !== "string") {
		return false;
	}
	if (!Array.isArray(value.rejected) || !value.rejected.every(isBaseRejection)) return false;
	const { fallbackId: _fallbackId, ...semanticFallback } = value;
	return value.fallbackId === semanticIdentity("context-lineage-base-selection-fallback", semanticFallback);
}

/** Validate a recovered digest-safe selection record before it becomes diagnostic evidence. */
export function isContextLineageBaseSelection(value: unknown): value is ContextLineageBaseSelection {
	if (!isRecord(value)) return false;
	if (
		typeof value.selectionId !== "string" ||
		typeof value.taskDigest !== "string" ||
		typeof value.planId !== "string" ||
		typeof value.checkpointId !== "string" ||
		typeof value.manifestId !== "string" ||
		typeof value.expectedSharedBytes !== "number" ||
		!Number.isSafeInteger(value.expectedSharedBytes) ||
		value.expectedSharedBytes < 0 ||
		value.rationale !== "semantic_eligibility_then_largest_shared_prefix" ||
		!Array.isArray(value.rejected) ||
		!value.rejected.every(isBaseRejection)
	) {
		return false;
	}
	const { selectionId: _selectionId, ...semanticSelection } = value;
	return value.selectionId === semanticIdentity("context-lineage-base-selection", semanticSelection);
}

/**
 * Select an existing frozen planning context only when it is safe to reuse.
 * Relevance and immutable scope are hard gates; cache-efficient shared-prefix
 * size is a tie-breaker among already-safe candidates.
 */
export function selectContextLineageBase(input: {
	readonly task: string;
	readonly currentSnapshot: RepositorySnapshot;
	readonly candidates: readonly ContextLineageBaseSelectionCandidate[];
}): ContextLineageBaseSelectionOutcome {
	const taskDigest = semanticIdentity("context-lineage-ad-hoc-task", input.task);
	const taskTerms = meaningfulTerms(input.task);
	const rejected: ContextLineageBaseRejection[] = [];
	const eligible: Array<{ candidate: ContextLineageBaseSelectionCandidate; relevance: number; expectedSharedBytes: number }> = [];
	for (const candidate of input.candidates) {
		const rejection = firstIneligibility(candidate, input.currentSnapshot);
		if (rejection) {
			rejected.push({ planId: candidate.planId, checkpointId: candidate.checkpoint.checkpointId, reason: rejection });
			continue;
		}
		const relevance = taskRelevance(taskTerms, candidate.plan, candidate.manifest);
		if (relevance === 0) {
			rejected.push({ planId: candidate.planId, checkpointId: candidate.checkpoint.checkpointId, reason: "task_not_relevant" });
			continue;
		}
		eligible.push({
			candidate,
			relevance,
			expectedSharedBytes: new TextEncoder().encode(renderRepositoryContextManifest(candidate.manifest)).byteLength,
		});
	}
	if (eligible.length === 0) return { selected: undefined, taskDigest, rejected: canonicalRejections(rejected) };
	eligible.sort(
		(left, right) =>
			right.relevance - left.relevance ||
			right.expectedSharedBytes - left.expectedSharedBytes ||
			left.candidate.planId.localeCompare(right.candidate.planId),
	);
	const winner = eligible[0]!;
	for (const candidate of eligible.slice(1)) {
		rejected.push({
			planId: candidate.candidate.planId,
			checkpointId: candidate.candidate.checkpoint.checkpointId,
			reason:
				candidate.relevance < winner.relevance
					? "lower_relevance"
					: candidate.expectedSharedBytes < winner.expectedSharedBytes
						? "smaller_shared_prefix"
						: "plan_id_tiebreak",
		});
	}
	const selection = {
		taskDigest,
		planId: winner.candidate.planId,
		checkpointId: winner.candidate.checkpoint.checkpointId,
		manifestId: winner.candidate.manifest.manifestId,
		expectedSharedBytes: winner.expectedSharedBytes,
		rationale: "semantic_eligibility_then_largest_shared_prefix" as const,
		rejected: canonicalRejections(rejected),
	};
	return {
		selected: { ...selection, selectionId: semanticIdentity("context-lineage-base-selection", selection) },
		candidate: winner.candidate,
	};
}

function firstIneligibility(
	candidate: ContextLineageBaseSelectionCandidate,
	currentSnapshot: RepositorySnapshot,
): ContextLineageBaseRejection["reason"] | undefined {
	if (candidate.planId !== contextLineagePlanIdentity(candidate.plan)) return "plan_identity_invalid";
	if (!isRepositoryContextManifestIntact(candidate.manifest)) return "manifest_integrity_invalid";
	if (candidate.checkpoint.repositoryManifestId !== candidate.manifest.manifestId) return "checkpoint_manifest_mismatch";
	if (candidate.manifest.snapshot.repositoryId !== currentSnapshot.repositoryId) return "repository_scope_mismatch";
	if (candidate.checkpoint.workspaceScopeId !== currentSnapshot.workspaceScopeId) return "workspace_scope_mismatch";
	if (repositorySnapshotIdentity(candidate.manifest.snapshot) !== repositorySnapshotIdentity(currentSnapshot)) {
		return "snapshot_stale";
	}
	if (!candidate.evidenceAvailable) return "evidence_unavailable";
	return undefined;
}

function taskRelevance(taskTerms: readonly string[], plan: ContextLineagePlan, manifest: RepositoryContextManifest): number {
	const candidateTerms = new Set<string>();
	for (const stage of plan.stages) {
		for (const task of stage.mode === "fanout" ? stage.tasks : stage.mode === "single" ? [stage.task] : []) {
			for (const term of meaningfulTerms(task.assignment)) candidateTerms.add(term);
		}
	}
	for (const evidence of manifest.evidence) {
		for (const term of meaningfulTerms(evidence.sourceRef)) candidateTerms.add(term);
	}
	return taskTerms.filter(term => candidateTerms.has(term)).length;
}

function meaningfulTerms(value: string): string[] {
	return [...new Set(value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])].sort();
}

function canonicalRejections(rejected: readonly ContextLineageBaseRejection[]): readonly ContextLineageBaseRejection[] {
	return [...rejected].sort(
		(left, right) =>
			left.planId.localeCompare(right.planId) ||
			left.checkpointId.localeCompare(right.checkpointId) ||
			left.reason.localeCompare(right.reason),
	);
}

function isBaseRejection(value: unknown): value is ContextLineageBaseRejection {
	return (
		isRecord(value) &&
		typeof value.planId === "string" &&
		typeof value.checkpointId === "string" &&
		[
			"plan_identity_invalid",
			"manifest_integrity_invalid",
			"checkpoint_manifest_mismatch",
			"repository_scope_mismatch",
			"workspace_scope_mismatch",
			"snapshot_stale",
			"evidence_unavailable",
			"task_not_relevant",
			"lower_relevance",
			"smaller_shared_prefix",
			"plan_id_tiebreak",
		].includes(value.reason as string)
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
