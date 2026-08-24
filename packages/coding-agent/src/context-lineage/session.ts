import { logger } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type { RepositoryPlanningBenchmarkComparison, RepositoryPlanningBenchmarkReview } from "./benchmark";
import type {
	AdaptiveDeliberationDecision,
	AdaptiveDeliberationObservation,
	AdaptiveDeliberationPolicy,
	ContextLineageCandidate,
	ContextLineageCandidateExecutionObservation,
	ContextLineageCandidateVariation,
	ContextLineageSelectionRecord,
} from "./deliberation";
import { decideAdaptiveDeliberation } from "./deliberation";
import {
	isContextLineageBaseSelection,
	isContextLineageBaseSelectionFallback,
	type ContextLineageBaseSelection,
	type ContextLineageBaseSelectionFallback,
} from "./base-selection";
import {
	evaluateControlledReasoningBenchmark,
	type ControlledReasoningBenchmarkReport,
} from "./controlled-reasoning";
import { canonicalJson, contextLineagePlanIdentity, logicalCheckpointIdentity, semanticIdentity } from "./identity";
import { isRepositoryContextManifestIntact } from "./manifest";
import type {
	ContextLineagePlan,
	LogicalContextCheckpoint,
	RepositoryContextManifest,
	WayfinderContextLineageBinding,
} from "./types";
import { stageTasks } from "./types";
import { validateContextLineagePlan } from "./validation";
import { isWayfinderContextLineageBindingIntact } from "./wayfinder";

export const CONTEXT_LINEAGE_SESSION_ENTRY_TYPE = "context-lineage";

export type ContextLineageSessionRecord =
	| {
			/** Durable start marker; final outcomes remain immutable execution records. */
			readonly version: 1;
			readonly kind: "run_started";
			readonly runId: string;
			readonly planId: string;
			readonly checkpointId: string;
			readonly originLeafId?: string;
	  }
	| {
			readonly version: 1;
			readonly kind: "repository_manifest";
			/** Digest-only manifest projection; excerpt bytes live in the artifact store. */
			readonly manifest: RepositoryContextManifest;
			readonly manifestArtifactId?: string;
	  }
	| { readonly version: 1; readonly kind: "logical_checkpoint"; readonly checkpoint: LogicalContextCheckpoint }
	| {
			readonly version: 1;
			readonly kind: "plan";
			readonly plan: ContextLineagePlan;
			readonly planId: string;
			readonly manifestId: string;
			readonly checkpointId: string;
	  }
	| {
			/** Decision provenance for reuse of an existing planning context by an ad-hoc question. */
			readonly version: 1;
			readonly kind: "base_selection";
			/** Binds selection to its new execution plan when the reused plan differs. */
			readonly runId?: string;
			readonly selection: ContextLineageBaseSelection;
	  }
	| {
			/** Fresh-context decision provenance when no persisted base passed the safety gate. */
			readonly version: 1;
			readonly kind: "base_selection_fallback";
			readonly fallback: ContextLineageBaseSelectionFallback;
	  }
	| {
			readonly version: 1;
			readonly kind: "benchmark";
			readonly benchmarkId: string;
			readonly comparison: RepositoryPlanningBenchmarkComparison;
			/** Reviewer adjudication; required before any default-enablement decision. */
			readonly review?: RepositoryPlanningBenchmarkReview;
			readonly benchmarkCaseId: string;
			readonly manifestId: string;
			readonly checkpointId: string;
			readonly planId: string;
	  }
	| {
			readonly version: 1;
			readonly kind: "execution";
			readonly executionId: string;
			readonly planId: string;
			readonly checkpointId: string;
			/** Groups per-stage progress records with their final run record. */
			readonly runId?: string;
			/** Session leaf captured when the run started; enables origin-safe promotion (PR 7). */
			readonly originLeafId?: string;
			/** Present on per-stage progress records; absent on the final run record. */
			readonly stageId?: string;
			readonly status: "completed" | "failed" | "aborted";
			readonly outputs: readonly ContextLineageExecutionOutput[];
	  }
	| {
			readonly version: 1;
			readonly kind: "named_base";
			readonly namedBaseId: string;
			readonly name: string;
			readonly checkpointId: string;
			/** Append-only tombstones preserve audit history while removing a name from reuse. */
			readonly status: "active" | "archived" | "deleted";
	  }
	| {
			readonly version: 1;
			readonly kind: "promotion";
			readonly promotionId: string;
			/** Explicit origin leaf; promotion never targets the merely-active leaf. */
			readonly originLeafId: string;
			readonly assignmentDigest: string;
			readonly answerDigest: string;
			readonly answerArtifactRef: string;
			readonly sessionId: string;
			readonly leafId: string;
	  }
	| {
			/** Non-destructive result dismissal: completed evidence remains auditable. */
			readonly version: 1;
			readonly kind: "discarded_output";
			readonly discardId: string;
			readonly runId: string;
			readonly taskId: string;
	  }
	| {
			/** Declared-leaf experiment family; assignments never enter session history. */
			readonly version: 1;
			readonly kind: "candidate_family";
			readonly familyId: string;
			readonly planId: string;
			readonly checkpointId: string;
			readonly taskId: string;
			readonly assignmentDigest: string;
			readonly candidates: readonly ContextLineageCandidate[];
	  }
	| {
			/** Candidate output bytes remain in the artifact store, with a durable digest binding. */
			readonly version: 1;
			readonly kind: "candidate_completed";
			readonly completionId: string;
			readonly familyId: string;
			readonly candidateId: string;
			readonly contentDigest: string;
			readonly artifactRef: string;
			readonly executionObservation?: ContextLineageCandidateExecutionObservation;
	  }
	| {
			/** Discard prevents future spend while preserving completed candidate evidence. */
			readonly version: 1;
			readonly kind: "candidate_discarded";
			readonly discardId: string;
			readonly familyId: string;
			readonly candidateId: string;
	  }
	| {
			/** User-directed stop closes every then-pending leaf without deleting completed evidence. */
			readonly version: 1;
			readonly kind: "candidate_allocation_stopped";
			readonly stopId: string;
			readonly familyId: string;
			readonly candidateIds: readonly string[];
			readonly reason: "user";
	  }
	| {
			/** Durable rubric-governed choice; artifact visibility is explicit for audit. */
			readonly version: 1;
			readonly kind: "candidate_selection";
			readonly familyId: string;
			readonly selection: ContextLineageSelectionRecord;
	  }
	| {
			/** Clean-room review output; the reviewer was given one candidate and one rubric only. */
			readonly version: 1;
			readonly kind: "candidate_review";
			readonly reviewId: string;
			readonly familyId: string;
			readonly candidateId: string;
			readonly candidateArtifactRef: string;
			readonly rubricArtifactRef: string;
			readonly reviewArtifactRef: string;
			readonly contentDigest: string;
			readonly reviewerProfileId: string;
	  }
	| {
			/** Explicit approval turns one selected candidate output into a replayable checkpoint generation. */
			readonly version: 1;
			readonly kind: "candidate_checkpoint";
			readonly approvalId: string;
			readonly familyId: string;
			readonly candidateId: string;
			readonly selectionId: string;
			readonly planId: string;
			readonly sourceCheckpointId: string;
			readonly checkpoint: LogicalContextCheckpoint;
			readonly output: ContextLineageExecutionOutput;
	  }
	| {
			/** Adjudication over an explicitly authorized review subset, with disagreement retained in its artifact. */
			readonly version: 1;
			readonly kind: "candidate_adjudication";
			readonly adjudicationId: string;
			readonly familyId: string;
			readonly rubricArtifactRef: string;
			readonly reviewArtifactRefs: readonly string[];
			readonly adjudicationArtifactRef: string;
			readonly contentDigest: string;
			readonly evaluatorProfileId: string;
	  }
	| {
			/** Inspectable hard-budget continuation decision (PR11). */
			readonly version: 1;
			readonly kind: "adaptive_deliberation";
			readonly decisionId: string;
			readonly familyId: string;
			readonly policy: AdaptiveDeliberationPolicy;
			readonly observation: AdaptiveDeliberationObservation;
			readonly decision: AdaptiveDeliberationDecision;
			readonly manual: boolean;
	  }
	| {
			/** Full-depth rubric comparison for false-pruning and needless-deepening measurement. */
			readonly version: 1;
			readonly kind: "controlled_reasoning_benchmark";
			readonly report: ControlledReasoningBenchmarkReport;
	  }
	| { readonly version: 1; readonly kind: "wayfinder_binding"; readonly binding: WayfinderContextLineageBinding };

export type NamedBaseRecord = Extract<ContextLineageSessionRecord, { kind: "named_base" }>;

export interface ContextLineageCandidateFamilyState {
	readonly family: Extract<ContextLineageSessionRecord, { kind: "candidate_family" }>;
	readonly candidates: readonly ContextLineageCandidate[];
	readonly selections: readonly ContextLineageSelectionRecord[];
	readonly reviews: readonly Extract<ContextLineageSessionRecord, { kind: "candidate_review" }>[];
	readonly adjudications: readonly Extract<ContextLineageSessionRecord, { kind: "candidate_adjudication" }>[];
	readonly benchmarks: readonly Extract<ContextLineageSessionRecord, { kind: "controlled_reasoning_benchmark" }>[];
	readonly allocationStops: readonly Extract<ContextLineageSessionRecord, { kind: "candidate_allocation_stopped" }>[];
}

export type ContextLineageCandidateCheckpointRecord = Extract<ContextLineageSessionRecord, { kind: "candidate_checkpoint" }>;

const NAMED_BASE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

/**
 * Name a logical checkpoint for reuse across plans and sessions (PR 9).
 * Idempotent per (name, checkpoint): re-naming the same checkpoint yields the
 * same record instead of a duplicate generation.
 */
export function createNamedBaseRecord(input: {
	readonly name: string;
	readonly checkpointId: string;
	readonly records: readonly ContextLineageSessionRecord[];
}): NamedBaseRecord {
	if (!NAMED_BASE_NAME_PATTERN.test(input.name)) {
		throw new Error(`Context Lineage base name must match ${NAMED_BASE_NAME_PATTERN.source}: ${input.name}`);
	}
	const existing = input.records.find(
		(record): record is NamedBaseRecord =>
			record.kind === "named_base" &&
			record.status === "active" &&
			record.name === input.name &&
			record.checkpointId === input.checkpointId,
	);
	if (existing) return existing;
	const semanticRecord = {
		version: 1 as const,
		kind: "named_base" as const,
		name: input.name,
		checkpointId: input.checkpointId,
		status: "active" as const,
	};
	return { ...semanticRecord, namedBaseId: semanticIdentity("context-lineage-named-base", semanticRecord) };
}

/** Latest record for a name; undefined when unnamed or when the latest generation is archived. */
export function resolveNamedBase(
	name: string,
	records: readonly ContextLineageSessionRecord[],
): NamedBaseRecord | undefined {
	let latest: NamedBaseRecord | undefined;
	for (const record of records) {
		if (record.kind === "named_base" && record.name === name) latest = record;
	}
	return latest?.status === "active" ? latest : undefined;
}

/** Archive the latest active generation of a name without deleting history. */
export function archiveNamedBaseRecord(name: string, records: readonly ContextLineageSessionRecord[]): NamedBaseRecord {
	const latest = resolveNamedBase(name, records);
	if (!latest) throw new Error(`Context Lineage has no active named base: ${name}`);
	const semanticRecord = {
		version: 1 as const,
		kind: "named_base" as const,
		name: latest.name,
		checkpointId: latest.checkpointId,
		status: "archived" as const,
	};
	return { ...semanticRecord, namedBaseId: semanticIdentity("context-lineage-named-base", semanticRecord) };
}

/**
 * Remove a reusable name without rewriting session history. Existing plans and
 * executions retain their checkpoint references; only future name resolution is
 * disabled. This is the safe deletion primitive for an append-only journal.
 */
export function deleteNamedBaseRecord(name: string, records: readonly ContextLineageSessionRecord[]): NamedBaseRecord {
	const latest = resolveNamedBase(name, records);
	if (!latest) throw new Error(`Context Lineage has no active named base: ${name}`);
	const semanticRecord = {
		version: 1 as const,
		kind: "named_base" as const,
		name: latest.name,
		checkpointId: latest.checkpointId,
		status: "deleted" as const,
	};
	return { ...semanticRecord, namedBaseId: semanticIdentity("context-lineage-named-base", semanticRecord) };
}

/** Stable lifecycle history for an inspectable named base. */
export function namedBaseVersions(name: string, records: readonly ContextLineageSessionRecord[]): readonly NamedBaseRecord[] {
	return records.filter((record): record is NamedBaseRecord => record.kind === "named_base" && record.name === name);
}

/**
 * Retention accounting separates live name references from durable plan/run
 * references. A checkpoint is collectable only when neither count is nonzero.
 */
export interface ContextLineageCheckpointRetention {
	readonly checkpointId: string;
	readonly activeNames: number;
	readonly plans: number;
	readonly executions: number;
	readonly collectable: boolean;
}

export function contextLineageCheckpointRetention(
	records: readonly ContextLineageSessionRecord[],
): readonly ContextLineageCheckpointRetention[] {
	const refs = new Map<string, { activeNames: number; plans: number; executions: number }>();
	const entry = (checkpointId: string) => {
		const existing = refs.get(checkpointId) ?? { activeNames: 0, plans: 0, executions: 0 };
		refs.set(checkpointId, existing);
		return existing;
	};
	const latestByName = new Map<string, NamedBaseRecord>();
	for (const record of records) if (record.kind === "named_base") latestByName.set(record.name, record);
	for (const record of latestByName.values()) {
		const counts = entry(record.checkpointId);
		if (record.status === "active") counts.activeNames++;
	}
	for (const record of records) {
		if (record.kind === "logical_checkpoint") entry(record.checkpoint.checkpointId);
		if (record.kind === "plan") entry(record.checkpointId).plans++;
		if (record.kind === "execution" && record.stageId === undefined) entry(record.checkpointId).executions++;
	}
	return [...refs.entries()]
		.map(([checkpointId, counts]) => ({ ...counts, checkpointId, collectable: counts.activeNames === 0 && counts.plans === 0 && counts.executions === 0 }))
		.sort((left, right) => left.checkpointId.localeCompare(right.checkpointId));
}

export type PromotionRecord = Extract<ContextLineageSessionRecord, { kind: "promotion" }>;
export type DiscardedOutputRecord = Extract<ContextLineageSessionRecord, { kind: "discarded_output" }>;

/** Mark a completed sidecar result dismissed without removing its artifact or provenance. */
export function discardContextLineageOutput(input: {
	readonly runId: string;
	readonly taskId: string;
	readonly records: readonly ContextLineageSessionRecord[];
}): DiscardedOutputRecord {
	const run = input.records.find(
		(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
			record.kind === "execution" && record.runId === input.runId && record.stageId === undefined,
	);
	if (!run?.outputs.some(output => output.taskId === input.taskId)) {
		throw new Error(`Context Lineage run ${input.runId} has no output for ${input.taskId}`);
	}
	const semanticRecord = { version: 1 as const, kind: "discarded_output" as const, runId: input.runId, taskId: input.taskId };
	return { ...semanticRecord, discardId: semanticIdentity("context-lineage-discard", semanticRecord) };
}

/**
 * Origin-safe result promotion (PR 7 / FR26–FR28). The caller resolves the
 * origin leaf explicitly — promotion never infers it from the active focus —
 * and the sink appends the assignment plus sanitized answer as a persistent
 * branch. Idempotent per (origin, assignment, answer): a repeated request
 * returns the recorded branch instead of duplicating it.
 */
export async function promoteContextLineageResult(input: {
	readonly journal: ContextLineageSessionJournal;
	readonly originLeafId: string;
	readonly assignment: string;
	readonly answer: string;
	readonly answerArtifactRef: string;
	/** Appends the promoted turn to the origin branch and reports where it landed. */
	readonly promote: (assignment: string, answer: string) => Promise<{ sessionId: string; leafId: string }>;
}): Promise<{ promotionId: string; reused: boolean; sessionId: string; leafId: string }> {
	if (input.originLeafId.length === 0) {
		throw new Error("Context Lineage promotion requires an explicit origin leaf");
	}
	const assignmentDigest = semanticIdentity("context-lineage-assignment", input.assignment);
	const answerDigest = semanticIdentity("context-lineage-answer", input.answer);
	const existing = getContextLineageSessionRecords(input.journal).find(
		(record): record is PromotionRecord =>
			record.kind === "promotion" &&
			record.originLeafId === input.originLeafId &&
			record.assignmentDigest === assignmentDigest &&
			record.answerDigest === answerDigest,
	);
	const existingPromotionId = existing?.promotionId;
	if (existing && existingPromotionId) {
		return { promotionId: existingPromotionId, reused: true, sessionId: existing.sessionId, leafId: existing.leafId };
	}
	const branch = await input.promote(input.assignment, input.answer);
	const semanticRecord = {
		version: 1 as const,
		kind: "promotion" as const,
		originLeafId: input.originLeafId,
		assignmentDigest,
		answerDigest,
		answerArtifactRef: input.answerArtifactRef,
		sessionId: branch.sessionId,
		leafId: branch.leafId,
	};
	const promotionId = semanticIdentity("context-lineage-promotion", semanticRecord);
	logger.debug("lineage.result_promoted", {
		promotion_id: promotionId,
		origin_leaf_id: input.originLeafId,
		session_id: branch.sessionId,
		leaf_id: branch.leafId,
	});
	appendContextLineageSessionRecord(input.journal, { ...semanticRecord, promotionId });
	return { promotionId, reused: false, sessionId: branch.sessionId, leafId: branch.leafId };
}

export interface ContextLineageExecutionOutput {
	readonly stageId: string;
	readonly taskId: string;
	readonly outputName?: string;
	readonly contentDigest: string;
	readonly artifactRef: string;
	/** Provider-reported cache status for this task's request, when observed (FR8). */
	readonly cacheStatus?: "hit" | "write" | "miss" | "unsupported" | "unknown";
	/**
	 * Measured side-request accounting. This is deliberately separate from the
	 * logical output identity: it describes one physical execution, not a new
	 * plan result.
	 */
	readonly executionObservation?: ContextLineageExecutionObservation;
}

/** Digest-safe accounting retained for one physical side request. */
export interface ContextLineageExecutionObservation {
	/** Wall-clock duration measured around the isolated provider request. */
	readonly elapsedMs: number;
	/** Present only when the finalized provider response reported reliable accounting. */
	readonly usage?: {
		readonly totalTokens: number;
		readonly costUsd: number;
	};
	/** Provider-reported cache token counts; request bytes and route identifiers are never retained. */
	readonly cacheTokens?: {
		readonly readTokens?: number;
		readonly writeTokens?: number;
		readonly uncachedInputTokens?: number;
	};
}

export interface ContextLineageExecutionRecordInput {
	readonly planId: string;
	readonly checkpointId: string;
	readonly status: "completed" | "failed" | "aborted";
	readonly outputs: readonly ContextLineageExecutionOutput[];
	readonly runId?: string;
	readonly stageId?: string;
	readonly originLeafId?: string;
}

export interface ContextLineageBenchmarkRecordInput {
	readonly benchmarkCaseId: string;
	readonly manifestId: string;
	readonly checkpointId: string;
	readonly planId: string;
	readonly comparison: RepositoryPlanningBenchmarkComparison;
	readonly review?: RepositoryPlanningBenchmarkReview;
}

export interface ContextLineageSessionSummary {
	readonly manifests: number;
	readonly checkpoints: number;
	readonly plans: number;
	readonly executions: number;
	readonly namedBases: number;
	/** Per-stage progress records; a resumed run skips these stages. */
	readonly stageCompletions: number;
	/** Promotion records; reuse (idempotent repeats) is not double-counted. */
	readonly promotions: number;
	readonly completedExecutions: number;
	readonly failedExecutions: number;
	readonly abortedExecutions: number;
}

interface MutableContextLineageSessionSummary {
	manifests: number;
	checkpoints: number;
	plans: number;
	executions: number;
	namedBases: number;
	stageCompletions: number;
	promotions: number;
	completedExecutions: number;
	failedExecutions: number;
	abortedExecutions: number;
}

/** Minimal session boundary needed to persist inspectable lineage records. */
export interface ContextLineageSessionJournal {
	appendCustomEntry(customType: string, data?: unknown): string;
	getBranch(): SessionEntry[];
	/** Optional artifact sink for source bytes that must not enter session history. */
	saveArtifact?(content: string, toolType: string): Promise<string | undefined>;
	/**
	 * NFR4: force the session file (and every buffered record) durable.
	 * Session files are created lazily on the first assistant message, so
	 * lineage-only flows must flush explicitly or a crash silently drops
	 * their records. Real SessionManagers implement this; test fakes may omit it.
	 */
	ensureOnDisk?(): Promise<void> | void;
}

/** Create the immutable checkpoint that roots execution in one frozen manifest. */
export function createRepositoryManifestCheckpoint(manifest: RepositoryContextManifest): LogicalContextCheckpoint {
	if (!isRepositoryContextManifestIntact(manifest)) {
		throw new Error(`Context Lineage manifest integrity check failed: ${manifest.manifestId}`);
	}
	const checkpoint: LogicalContextCheckpoint = {
		version: 1,
		checkpointId: "",
		origin: "repository_manifest",
		materialization: "repository_manifest",
		securityScopeId: manifest.snapshot.workspaceScopeId,
		workspaceScopeId: manifest.snapshot.workspaceScopeId,
		contentRootHash: manifest.manifestId,
		repositoryManifestId: manifest.manifestId,
		createdAt: Date.now(),
	};
	return { ...checkpoint, checkpointId: logicalCheckpointIdentity(checkpoint) };
}

/**
 * Create the next immutable checkpoint generation from selected upstream
 * outputs (FR22 / PR 6). The extension hash covers the base checkpoint and the
 * canonically serialized output digests, so a changed upstream result versions
 * every descendant while identical selections reuse the same generation.
 */
export function createCheckpointExtensionCheckpoint(input: {
	readonly baseCheckpoint: LogicalContextCheckpoint;
	readonly outputs: readonly ContextLineageExecutionOutput[];
}): LogicalContextCheckpoint {
	if (input.outputs.length === 0) {
		throw new Error("Context Lineage checkpoint extension requires at least one selected output");
	}
	const checkpoint: LogicalContextCheckpoint = {
		version: 1,
		checkpointId: "",
		origin: "checkpoint_extension",
		materialization: "selected_outputs",
		securityScopeId: input.baseCheckpoint.securityScopeId,
		...(input.baseCheckpoint.workspaceScopeId ? { workspaceScopeId: input.baseCheckpoint.workspaceScopeId } : {}),
		contentRootHash: semanticIdentity("checkpoint-extension", {
			baseCheckpointId: input.baseCheckpoint.checkpointId,
			outputs: canonicalJson(canonicalExtensionOutputs(input.outputs)),
		}),
		...(input.baseCheckpoint.repositoryManifestId
			? { repositoryManifestId: input.baseCheckpoint.repositoryManifestId }
			: {}),
		createdAt: Date.now(),
	};
	return { ...checkpoint, checkpointId: logicalCheckpointIdentity(checkpoint) };
}

/** Canonical text a downstream runner can embed for one extension generation. */
export function serializeCheckpointExtensionOutputs(outputs: readonly ContextLineageExecutionOutput[]): string {
	return canonicalJson(canonicalExtensionOutputs(outputs));
}

function canonicalExtensionOutputs(outputs: readonly ContextLineageExecutionOutput[]): unknown[] {
	return outputs
		.map(output => ({
			stageId: output.stageId,
			taskId: output.taskId,
			...(output.outputName ? { outputName: output.outputName } : {}),
			contentDigest: output.contentDigest,
			artifactRef: output.artifactRef,
		}))
		.sort((left, right) => left.stageId.localeCompare(right.stageId) || left.taskId.localeCompare(right.taskId));
}

/** Persist a typed lineage record outside the model-visible conversation. */
export function appendContextLineageSessionRecord(
	journal: ContextLineageSessionJournal,
	record: ContextLineageSessionRecord,
): string {
	const entryId = journal.appendCustomEntry(CONTEXT_LINEAGE_SESSION_ENTRY_TYPE, record);
	// NFR4: lineage records must survive a crash even in sessions that have not
	// produced an assistant message yet (the lazy session-file gate would
	// otherwise never create the file). The rewrite persists every buffered
	// record; SessionManager serializes rewrites internally, so this is safe.
	void journal.ensureOnDisk?.();
	return entryId;
}

/** Create a content-addressed, result-only execution record for a persisted plan checkpoint. */
export function createContextLineageExecutionRecord(
	input: ContextLineageExecutionRecordInput,
): Extract<ContextLineageSessionRecord, { kind: "execution" }> {
	const semanticRecord = {
		version: 1 as const,
		kind: "execution" as const,
		planId: input.planId,
		checkpointId: input.checkpointId,
		...(input.runId ? { runId: input.runId } : {}),
		...(input.stageId ? { stageId: input.stageId } : {}),
		...(input.originLeafId ? { originLeafId: input.originLeafId } : {}),
		status: input.status,
		outputs: input.outputs,
	};
	return {
		...semanticRecord,
		executionId: semanticIdentity("context-lineage-execution", semanticRecord),
	};
}

/** Persist the safe-base decision separately from its eventual run outcome. */
export function createContextLineageBaseSelectionRecord(
	selection: ContextLineageBaseSelection,
	runId?: string,
): Extract<ContextLineageSessionRecord, { kind: "base_selection" }> {
	if (!isContextLineageBaseSelection(selection)) throw new Error("Context Lineage base selection is invalid");
	if (runId !== undefined && runId.length === 0) throw new Error("Context Lineage base selection run ID is invalid");
	return { version: 1, kind: "base_selection", ...(runId ? { runId } : {}), selection };
}

export function createContextLineageBaseSelectionFallbackRecord(
	fallback: ContextLineageBaseSelectionFallback,
): Extract<ContextLineageSessionRecord, { kind: "base_selection_fallback" }> {
	if (!isContextLineageBaseSelectionFallback(fallback)) throw new Error("Context Lineage base selection fallback is invalid");
	return { version: 1, kind: "base_selection_fallback", fallback };
}

/** Durable active-run marker, intentionally separate from final execution outcomes. */
export function createContextLineageRunStartedRecord(input: {
	readonly runId: string;
	readonly planId: string;
	readonly checkpointId: string;
	readonly originLeafId?: string;
}): Extract<ContextLineageSessionRecord, { kind: "run_started" }> {
	return {
		version: 1,
		kind: "run_started",
		runId: input.runId,
		planId: input.planId,
		checkpointId: input.checkpointId,
		...(input.originLeafId ? { originLeafId: input.originLeafId } : {}),
	};
}

/** Create a durable, comparison-only benchmark record beside its grounded plan. */
export function createContextLineageBenchmarkRecord(
	input: ContextLineageBenchmarkRecordInput,
): Extract<ContextLineageSessionRecord, { kind: "benchmark" }> {
	const semanticRecord = {
		version: 1 as const,
		kind: "benchmark" as const,
		benchmarkCaseId: input.benchmarkCaseId,
		manifestId: input.manifestId,
		checkpointId: input.checkpointId,
		planId: input.planId,
		comparison: input.comparison,
		...(input.review ? { review: input.review } : {}),
	};
	return { ...semanticRecord, benchmarkId: semanticIdentity("context-lineage-benchmark", semanticRecord) };
}

/** Persisted candidate family rooted in a validated frozen plan (PR 10). */
export function createContextLineageCandidateFamilyRecord(input: {
	readonly planId: string;
	readonly checkpointId: string;
	readonly taskId: string;
	readonly assignmentDigest: string;
	readonly candidates: readonly ContextLineageCandidate[];
}): Extract<ContextLineageSessionRecord, { kind: "candidate_family" }> {
	if (input.candidates.length < 2) throw new Error("Context Lineage candidate families require at least two leaves");
	if (
		input.candidates.some(
			candidate =>
			candidate.taskId !== input.taskId ||
			candidate.assignmentDigest !== input.assignmentDigest ||
			candidate.status !== "pending" ||
			candidate.artifactRef !== undefined ||
			candidate.executionObservation !== undefined,
		)
	) {
		throw new Error("Candidate family leaves must be pending variants of one declared assignment");
	}
	const candidateIds = new Set(input.candidates.map(candidate => candidate.candidateId));
	if (candidateIds.size !== input.candidates.length) throw new Error("Candidate family leaf identities must be unique");
	const semanticRecord = {
		version: 1 as const,
		kind: "candidate_family" as const,
		planId: input.planId,
		checkpointId: input.checkpointId,
		taskId: input.taskId,
		assignmentDigest: input.assignmentDigest,
		candidates: canonicalCandidateFamily(input.candidates),
	};
	return { ...semanticRecord, familyId: semanticIdentity("context-lineage-candidate-family", semanticRecord) };
}

/** Append-only completion binds one candidate to immutable artifact evidence. */
export function createContextLineageCandidateCompletionRecord(input: {
	readonly familyId: string;
	readonly candidateId: string;
	readonly contentDigest: string;
	readonly artifactRef: string;
	readonly executionObservation?: ContextLineageCandidateExecutionObservation;
}): Extract<ContextLineageSessionRecord, { kind: "candidate_completed" }> {
	if (!input.contentDigest || !input.artifactRef) throw new Error("Candidate completion requires a digest and artifact reference");
	if (input.executionObservation !== undefined && !isCandidateExecutionObservation(input.executionObservation)) {
		throw new Error("Candidate completion requires finite observed execution accounting");
	}
	const semanticRecord = { version: 1 as const, kind: "candidate_completed" as const, ...input };
	return { ...semanticRecord, completionId: semanticIdentity("context-lineage-candidate-completion", semanticRecord) };
}

/** Append-only discard prevents candidate reuse without erasing evidence. */
export function createContextLineageCandidateDiscardRecord(input: {
	readonly familyId: string;
	readonly candidateId: string;
}): Extract<ContextLineageSessionRecord, { kind: "candidate_discarded" }> {
	const semanticRecord = { version: 1 as const, kind: "candidate_discarded" as const, ...input };
	return { ...semanticRecord, discardId: semanticIdentity("context-lineage-candidate-discard", semanticRecord) };
}

/** Atomically stop all currently-pending leaves; completed artifacts remain inspectable. */
export function createContextLineageCandidateAllocationStopRecord(input: {
	readonly familyId: string;
	readonly candidateIds: readonly string[];
}): Extract<ContextLineageSessionRecord, { kind: "candidate_allocation_stopped" }> {
	const candidateIds = [...new Set(input.candidateIds)].sort();
	if (candidateIds.length === 0) throw new Error("Candidate allocation stop requires at least one pending candidate");
	if (candidateIds.some(candidateId => candidateId.length === 0)) {
		throw new Error("Candidate allocation stop requires candidate identities");
	}
	const semanticRecord = { version: 1 as const, kind: "candidate_allocation_stopped" as const, familyId: input.familyId, candidateIds, reason: "user" as const };
	return { ...semanticRecord, stopId: semanticIdentity("context-lineage-candidate-allocation-stop", semanticRecord) };
}

/** Persist a selection only after the selected candidate's completed artifact is in the journal. */
export function createContextLineageCandidateSelectionSessionRecord(input: {
	readonly familyId: string;
	readonly selection: ContextLineageSelectionRecord;
}): Extract<ContextLineageSessionRecord, { kind: "candidate_selection" }> {
	return { version: 1, kind: "candidate_selection", ...input };
}

/** Durable evidence that one bounded clean-room reviewer evaluated one candidate. */
export function createContextLineageCandidateReviewRecord(input: {
	readonly familyId: string;
	readonly candidateId: string;
	readonly candidateArtifactRef: string;
	readonly rubricArtifactRef: string;
	readonly reviewArtifactRef: string;
	readonly contentDigest: string;
	readonly reviewerProfileId: string;
}): Extract<ContextLineageSessionRecord, { kind: "candidate_review" }> {
	for (const [name, value] of Object.entries(input)) {
		if (value.length === 0) throw new Error(`Candidate review requires ${name}`);
	}
	const semanticRecord = { version: 1 as const, kind: "candidate_review" as const, ...input };
	return { ...semanticRecord, reviewId: semanticIdentity("context-lineage-candidate-review", semanticRecord) };
}

/** Explicit approval is the only way a candidate output becomes a replay checkpoint. */
export function createContextLineageCandidateCheckpointRecord(input: {
	readonly familyId: string;
	readonly candidateId: string;
	readonly selectionId: string;
	readonly planId: string;
	readonly sourceCheckpoint: LogicalContextCheckpoint;
	readonly output: ContextLineageExecutionOutput;
}): ContextLineageCandidateCheckpointRecord {
	if (!input.output.outputName) throw new Error("Candidate checkpoint approval requires a named task output");
	const checkpoint = createCheckpointExtensionCheckpoint({ baseCheckpoint: input.sourceCheckpoint, outputs: [input.output] });
	const semanticRecord = {
		version: 1 as const,
		kind: "candidate_checkpoint" as const,
		familyId: input.familyId,
		candidateId: input.candidateId,
		selectionId: input.selectionId,
		planId: input.planId,
		sourceCheckpointId: input.sourceCheckpoint.checkpointId,
		checkpoint,
		output: input.output,
	};
	return { ...semanticRecord, approvalId: semanticIdentity("context-lineage-candidate-checkpoint", semanticRecord) };
}

/** Persist a comparison only when its authorized review set is explicit and non-trivial. */
export function createContextLineageCandidateAdjudicationRecord(input: {
	readonly familyId: string;
	readonly rubricArtifactRef: string;
	readonly reviewArtifactRefs: readonly string[];
	readonly adjudicationArtifactRef: string;
	readonly contentDigest: string;
	readonly evaluatorProfileId: string;
}): Extract<ContextLineageSessionRecord, { kind: "candidate_adjudication" }> {
	if (input.reviewArtifactRefs.length < 2) throw new Error("Candidate adjudication requires at least two review artifacts");
	const reviewArtifactRefs = [...new Set(input.reviewArtifactRefs)].sort();
	if (reviewArtifactRefs.length < 2) throw new Error("Candidate adjudication requires distinct review artifacts");
	for (const [name, value] of Object.entries({ ...input, reviewArtifactRefs: undefined })) {
		if (typeof value === "string" && value.length === 0) throw new Error(`Candidate adjudication requires ${name}`);
	}
	const semanticRecord = { version: 1 as const, kind: "candidate_adjudication" as const, ...input, reviewArtifactRefs };
	return { ...semanticRecord, adjudicationId: semanticIdentity("context-lineage-candidate-adjudication", semanticRecord) };
}

/** Durable explanation of a bounded continuation decision, independent of self-confidence. */
export function createAdaptiveDeliberationRecord(input: {
	readonly familyId: string;
	readonly policy: AdaptiveDeliberationPolicy;
	readonly observation: AdaptiveDeliberationObservation;
	readonly decision: AdaptiveDeliberationDecision;
	readonly manual: boolean;
}): Extract<ContextLineageSessionRecord, { kind: "adaptive_deliberation" }> {
	const semanticRecord = { version: 1 as const, kind: "adaptive_deliberation" as const, ...input };
	return { ...semanticRecord, decisionId: semanticIdentity("context-lineage-adaptive-deliberation", semanticRecord) };
}

/** Persist a full-depth controlled-reasoning measurement beside its candidate family. */
export function createControlledReasoningBenchmarkRecord(
	report: ControlledReasoningBenchmarkReport,
): Extract<ContextLineageSessionRecord, { kind: "controlled_reasoning_benchmark" }> {
	return { version: 1, kind: "controlled_reasoning_benchmark", report };
}

/** A derived checkpoint is executable only when it is an approved checkpoint for that immutable plan. */
export function resolveContextLineageCandidateCheckpoint(
	checkpointId: string,
	planId: string,
	records: readonly ContextLineageSessionRecord[],
): ContextLineageCandidateCheckpointRecord | undefined {
	return records.find(
		(record): record is ContextLineageCandidateCheckpointRecord =>
			record.kind === "candidate_checkpoint" && record.checkpoint.checkpointId === checkpointId && record.planId === planId,
	);
}

export interface ContextLineageCandidateCheckpointReplay {
	/** Completed stages supplied from the prior run or the approved candidate output. */
	readonly completedStageIds: readonly string[];
	readonly outputs: readonly ContextLineageExecutionOutput[];
	/** The only stages dispatched again under the approved checkpoint. */
	readonly replayedStageIds: readonly string[];
}

/**
 * Replace one approved source task output and rerun only its transitive plan
 * descendants. Independent stages and unaffected ancestors remain completed,
 * so replay cannot spend on unrelated work.
 */
export function createContextLineageCandidateCheckpointReplay(input: {
	readonly plan: ContextLineagePlan;
	readonly approvedCheckpoint: ContextLineageCandidateCheckpointRecord;
	readonly priorOutputs: readonly ContextLineageExecutionOutput[];
}): ContextLineageCandidateCheckpointReplay {
	const sourceStage = input.plan.stages.find(stage =>
		stageTasks(stage).some(task => task.id === input.approvedCheckpoint.output.taskId),
	);
	const sourceTask = sourceStage
		? stageTasks(sourceStage).find(task => task.id === input.approvedCheckpoint.output.taskId)
		: undefined;
	if (!sourceStage || !sourceTask?.output || sourceTask.output.name !== input.approvedCheckpoint.output.outputName) {
		throw new Error("Approved candidate output no longer matches a named plan task output");
	}
	const replayed = new Set<string>();
	const pending = [sourceStage.id];
	while (pending.length > 0) {
		const sourceStageId = pending.shift()!;
		for (const stage of input.plan.stages) {
			if (!stage.dependsOn?.includes(sourceStageId) || replayed.has(stage.id)) continue;
			replayed.add(stage.id);
			pending.push(stage.id);
		}
	}
	if (replayed.size === 0) throw new Error("Approved candidate has no affected plan descendants to replay");
	const outputs = input.priorOutputs.filter(
		output =>
			!(
				output.stageId === sourceStage.id &&
				output.taskId === input.approvedCheckpoint.output.taskId
			),
	);
	outputs.push(input.approvedCheckpoint.output);
	return {
		completedStageIds: input.plan.stages.filter(stage => !replayed.has(stage.id)).map(stage => stage.id),
		outputs,
		replayedStageIds: input.plan.stages.filter(stage => replayed.has(stage.id)).map(stage => stage.id),
	};
}

/**
 * Rebuild one candidate family's current state from append-only records. The
 * returned leaf order is the declared experiment order, never completion order.
 */
export function resolveContextLineageCandidateFamily(
	familyId: string,
	records: readonly ContextLineageSessionRecord[],
): ContextLineageCandidateFamilyState | undefined {
	const family = records.find(
		(record): record is Extract<ContextLineageSessionRecord, { kind: "candidate_family" }> =>
			record.kind === "candidate_family" && record.familyId === familyId,
	);
	if (!family) return undefined;
	const candidates = new Map(family.candidates.map(candidate => [candidate.candidateId, candidate]));
	const selections: ContextLineageSelectionRecord[] = [];
	const reviews: Array<Extract<ContextLineageSessionRecord, { kind: "candidate_review" }>> = [];
	const adjudications: Array<Extract<ContextLineageSessionRecord, { kind: "candidate_adjudication" }>> = [];
	const benchmarks: Array<Extract<ContextLineageSessionRecord, { kind: "controlled_reasoning_benchmark" }>> = [];
	const allocationStops: Array<Extract<ContextLineageSessionRecord, { kind: "candidate_allocation_stopped" }>> = [];
	for (const record of records) {
		if (record.kind === "candidate_completed") {
			if (record.familyId !== familyId) continue;
			const candidate = candidates.get(record.candidateId);
			if (candidate?.status === "pending") {
				candidates.set(record.candidateId, {
					...candidate,
					status: "completed",
					artifactRef: record.artifactRef,
					executionObservation: record.executionObservation,
				});
			}
		}
		if (record.kind === "candidate_discarded") {
			if (record.familyId !== familyId) continue;
			const candidate = candidates.get(record.candidateId);
			if (candidate && candidate.status !== "discarded") {
				candidates.set(record.candidateId, { ...candidate, status: "discarded" });
			}
		}
		if (record.kind === "candidate_allocation_stopped") {
			if (record.familyId !== familyId) continue;
			const pending = record.candidateIds.every(candidateId => candidates.get(candidateId)?.status === "pending");
			if (!pending) continue;
			for (const candidateId of record.candidateIds) {
				const candidate = candidates.get(candidateId)!;
				candidates.set(candidateId, { ...candidate, status: "discarded" });
			}
			allocationStops.push(record);
		}
		if (record.kind === "candidate_selection" && record.familyId === familyId) selections.push(record.selection);
		if (record.kind === "candidate_review" && record.familyId === familyId) reviews.push(record);
		if (record.kind === "candidate_adjudication" && record.familyId === familyId) adjudications.push(record);
		if (record.kind === "controlled_reasoning_benchmark" && record.report.familyId === familyId) benchmarks.push(record);
	}
	return {
		family,
		candidates: family.candidates.map(candidate => candidates.get(candidate.candidateId)!),
		selections,
		reviews,
		adjudications,
		benchmarks,
		allocationStops,
	};
}

function canonicalCandidateFamily(candidates: readonly ContextLineageCandidate[]): readonly ContextLineageCandidate[] {
	// Candidate order is an operator-declared experiment order and is rendered by
	// the board. Canonicalize each leaf's variation metadata without sorting leaves.
	return candidates.map(candidate => ({ ...candidate, variation: canonicalCandidateVariations(candidate.variation) }));
}

function canonicalCandidateVariations(
	variations: readonly ContextLineageCandidateVariation[],
): readonly ContextLineageCandidateVariation[] {
	return [...variations].sort((left, right) => left.id.localeCompare(right.id));
}

/** Recover typed lineage records on the active session branch, ignoring foreign custom data. */
export function getContextLineageSessionRecords(journal: ContextLineageSessionJournal): ContextLineageSessionRecord[] {
	const records: ContextLineageSessionRecord[] = [];
	const manifests = new Map<string, RepositoryContextManifest>();
	const checkpoints = new Map<string, LogicalContextCheckpoint>();
	const plans = new Map<string, Extract<ContextLineageSessionRecord, { kind: "plan" }>>();
	const candidateFamilies = new Map<string, Extract<ContextLineageSessionRecord, { kind: "candidate_family" }>>();
	const candidateStates = new Map<string, "pending" | "completed" | "discarded">();
	const candidateArtifacts = new Map<string, string>();
	const candidateReviewArtifacts = new Map<string, string>();
	const candidateSelections = new Map<string, { readonly familyId: string; readonly selection: ContextLineageSelectionRecord }>();
	const candidateAdjudications = new Map<string, Extract<ContextLineageSessionRecord, { kind: "candidate_adjudication" }>>();
	const candidateCheckpoints = new Map<string, ContextLineageCandidateCheckpointRecord>();
	for (const entry of journal.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CONTEXT_LINEAGE_SESSION_ENTRY_TYPE) continue;
		const record = entry.data;
		if (!isContextLineageSessionRecord(record)) continue;
		if (record.kind === "repository_manifest") {
			manifests.set(record.manifest.manifestId, record.manifest);
		} else if (record.kind === "logical_checkpoint") {
			const manifest = record.checkpoint.repositoryManifestId
				? manifests.get(record.checkpoint.repositoryManifestId)
				: undefined;
			if (!manifest) continue;
			if (record.checkpoint.origin === "repository_manifest") {
				// Canonical manifest checkpoints must bind exactly to their manifest.
				if (!isRepositoryManifestCheckpoint(record.checkpoint, manifest)) continue;
			} else if (record.checkpoint.securityScopeId !== manifest.snapshot.workspaceScopeId) {
				// Derived generations (extensions) stay scoped to their root manifest.
				continue;
			}
			checkpoints.set(record.checkpoint.checkpointId, record.checkpoint);
		} else if (record.kind === "plan") {
			const manifest = manifests.get(record.manifestId);
			const checkpoint = checkpoints.get(record.checkpointId);
			if (!manifest || !checkpoint || !isRepositoryManifestCheckpoint(checkpoint, manifest)) continue;
			const validation = validateContextLineagePlan(record.plan, [manifest], {
				// Parallel Questions plans branch from the immutable checkpoint rather
				// than the raw manifest. Recovery must preserve those valid plans so a
				// later question can select their stable provider-visible base.
				allowedBaseSourceTypes: new Set(["repository_manifest", "checkpoint"]),
				allowedWorkspaceModes: new Set(["frozen_read_only"]),
			});
			if (
				!validation.valid ||
				record.plan.stages.some(stage => stage.capabilityRequirements?.workspaceMode !== "frozen_read_only")
			) {
				continue;
			}
			plans.set(record.planId, record);
		} else if (record.kind === "promotion") {
			// Origin-explicit by construction; no lineage cross-reference required.
		} else if (record.kind === "execution") {
			const plan = plans.get(record.planId);
			const approvedReplay = candidateCheckpoints.get(record.checkpointId);
			if (
				!plan ||
				(!(
					plan.checkpointId === record.checkpointId ||
					(approvedReplay?.planId === record.planId && approvedReplay.checkpoint.checkpointId === record.checkpointId)
				) || !checkpoints.has(record.checkpointId))
			) {
				continue;
			}
		} else if (record.kind === "run_started") {
			const plan = plans.get(record.planId);
			const approvedReplay = candidateCheckpoints.get(record.checkpointId);
			if (
				!plan ||
				(!(
					plan.checkpointId === record.checkpointId ||
					(approvedReplay?.planId === record.planId && approvedReplay.checkpoint.checkpointId === record.checkpointId)
				) || !checkpoints.has(record.checkpointId))
			) {
				continue;
			}
		} else if (record.kind === "benchmark") {
			const plan = plans.get(record.planId);
			if (!plan || plan.manifestId !== record.manifestId || plan.checkpointId !== record.checkpointId) continue;
		} else if (record.kind === "named_base") {
			if (!checkpoints.has(record.checkpointId)) continue;
		} else if (record.kind === "wayfinder_binding") {
			if (!isWayfinderContextLineageBindingIntact(record.binding)) continue;
			const manifest = manifests.get(record.binding.manifestId);
			const checkpoint = checkpoints.get(record.binding.checkpointId);
			if (!manifest || !checkpoint || !isRepositoryManifestCheckpoint(checkpoint, manifest)) continue;
		} else if (record.kind === "discarded_output") {
			const execution = records.find(
				(candidate): candidate is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
					candidate.kind === "execution" && candidate.runId === record.runId && candidate.stageId === undefined,
			);
			if (!execution?.outputs.some(output => output.taskId === record.taskId)) continue;
		} else if (record.kind === "candidate_family") {
			const plan = plans.get(record.planId);
			if (
				!plan ||
				plan.checkpointId !== record.checkpointId ||
				!plan.plan.stages.flatMap(stageTasks).some(task => task.id === record.taskId)
			) {
				continue;
			}
			candidateFamilies.set(record.familyId, record);
			for (const candidate of record.candidates) candidateStates.set(candidate.candidateId, "pending");
		} else if (record.kind === "candidate_completed") {
			const family = candidateFamilies.get(record.familyId);
			if (
				!family?.candidates.some(candidate => candidate.candidateId === record.candidateId) ||
				candidateStates.get(record.candidateId) !== "pending" ||
				(record.executionObservation !== undefined && !isCandidateExecutionObservation(record.executionObservation))
			) {
				continue;
			}
			candidateStates.set(record.candidateId, "completed");
			candidateArtifacts.set(record.candidateId, record.artifactRef);
		} else if (record.kind === "candidate_discarded") {
			const family = candidateFamilies.get(record.familyId);
			if (
				!family?.candidates.some(candidate => candidate.candidateId === record.candidateId) ||
				candidateStates.get(record.candidateId) === "discarded"
			) {
				continue;
			}
			candidateStates.set(record.candidateId, "discarded");
		} else if (record.kind === "candidate_allocation_stopped") {
			const family = candidateFamilies.get(record.familyId);
			if (
				!family ||
				record.candidateIds.some(
					candidateId =>
						!family.candidates.some(candidate => candidate.candidateId === candidateId) ||
						candidateStates.get(candidateId) !== "pending",
				)
			) {
				continue;
			}
			for (const candidateId of record.candidateIds) candidateStates.set(candidateId, "discarded");
		} else if (record.kind === "candidate_selection") {
			const family = candidateFamilies.get(record.familyId);
			const artifactRef = candidateArtifacts.get(record.selection.candidateId);
			if (
				!family?.candidates.some(candidate => candidate.candidateId === record.selection.candidateId) ||
				candidateStates.get(record.selection.candidateId) !== "completed" ||
				!artifactRef ||
				!record.selection.visibleEvidence.includes(artifactRef)
			) {
				continue;
			}
			if (record.selection.adjudicationArtifactRef) {
				const adjudication = candidateAdjudications.get(record.selection.adjudicationArtifactRef);
				if (
					adjudication?.familyId !== record.familyId ||
					canonicalJson(adjudication.reviewArtifactRefs) !== canonicalJson(record.selection.authorizedReviewArtifactRefs)
				) {
					continue;
				}
			}
			candidateSelections.set(record.selection.selectionId, { familyId: record.familyId, selection: record.selection });
		} else if (record.kind === "candidate_review") {
			const family = candidateFamilies.get(record.familyId);
			if (
				!family?.candidates.some(candidate => candidate.candidateId === record.candidateId) ||
				candidateStates.get(record.candidateId) !== "completed" ||
				candidateArtifacts.get(record.candidateId) !== record.candidateArtifactRef
			) {
				continue;
			}
			candidateReviewArtifacts.set(record.reviewArtifactRef, record.familyId);
		} else if (record.kind === "candidate_adjudication") {
			if (record.reviewArtifactRefs.some(ref => candidateReviewArtifacts.get(ref) !== record.familyId)) continue;
			candidateAdjudications.set(record.adjudicationArtifactRef, record);
		} else if (record.kind === "adaptive_deliberation") {
			if (!candidateFamilies.has(record.familyId)) continue;
		} else if (record.kind === "controlled_reasoning_benchmark") {
			const family = candidateFamilies.get(record.report.familyId);
			if (
				!family ||
				record.report.outcomes.some(
					outcome =>
						candidateStates.get(outcome.candidateId) !== "completed" ||
						candidateArtifacts.get(outcome.candidateId) !== outcome.artifactRef,
				) ||
				!isControlledReasoningBenchmarkForFamily(record.report, family)
			) {
				continue;
			}
		} else if (record.kind === "candidate_checkpoint") {
			const family = candidateFamilies.get(record.familyId);
			const selection = candidateSelections.get(record.selectionId);
			const sourceCheckpoint = checkpoints.get(record.sourceCheckpointId);
			const plan = plans.get(record.planId);
			if (
				!family ||
				!plan ||
				!sourceCheckpoint ||
				selection?.familyId !== record.familyId ||
				selection.selection.candidateId !== record.candidateId ||
				candidateStates.get(record.candidateId) !== "completed" ||
				candidateArtifacts.get(record.candidateId) !== record.output.artifactRef ||
				record.output.taskId !== family.taskId ||
				!record.output.outputName ||
				record.checkpoint.checkpointId !==
					createCheckpointExtensionCheckpoint({ baseCheckpoint: sourceCheckpoint, outputs: [record.output] }).checkpointId
			) {
				continue;
			}
			candidateCheckpoints.set(record.checkpoint.checkpointId, record);
		}
		records.push(record);
	}
	return records;
}
/**
 * FR38 local signals: reuse (executions rooted at a checkpoint) is reported
 * separately from usefulness signals (completed runs, persisted plans).
 * Reuse count alone is never treated as value.
 */
export interface ContextUtilitySignal {
	readonly checkpointId: string;
	/** Runs dispatched from this checkpoint. */
	readonly executions: number;
	/** Completed runs; failed/aborted runs still count as reuse, not usefulness. */
	readonly completedRuns: number;
	/** Distinct plans persisted against this checkpoint. */
	readonly plans: number;
}

export function contextUtilityByCheckpoint(
	records: readonly ContextLineageSessionRecord[],
): readonly ContextUtilitySignal[] {
	const executions = new Map<string, { runs: number; completed: number }>();
	const plans = new Map<string, Set<string>>();
	for (const record of records) {
		if (record.kind === "execution" && record.stageId === undefined) {
			const entry = executions.get(record.checkpointId) ?? { runs: 0, completed: 0 };
			entry.runs++;
			if (record.status === "completed") entry.completed++;
			executions.set(record.checkpointId, entry);
		}
		if (record.kind === "plan") {
			const ids = plans.get(record.checkpointId) ?? new Set<string>();
			ids.add(record.planId);
			plans.set(record.checkpointId, ids);
		}
	}
	const checkpointIds = new Set([...executions.keys(), ...plans.keys()]);
	return [...checkpointIds].sort().map(checkpointId => ({
		checkpointId,
		executions: executions.get(checkpointId)?.runs ?? 0,
		completedRuns: executions.get(checkpointId)?.completed ?? 0,
		plans: plans.get(checkpointId)?.size ?? 0,
	}));
}

/** Aggregate durable lineage state for user-facing status surfaces without rendering source material. */
export function summarizeContextLineageSession(journal: ContextLineageSessionJournal): ContextLineageSessionSummary {
	const summary: MutableContextLineageSessionSummary = {
		manifests: 0,
		checkpoints: 0,
		plans: 0,
		executions: 0,
		stageCompletions: 0,
		namedBases: 0,
		promotions: 0,
		completedExecutions: 0,
		failedExecutions: 0,
		abortedExecutions: 0,
	};
	const records = getContextLineageSessionRecords(journal);
	for (const record of records) {
		if (record.kind === "repository_manifest") summary.manifests++;
		if (record.kind === "logical_checkpoint") summary.checkpoints++;
		if (record.kind === "plan") summary.plans++;
		if (record.kind === "execution") {
			if (record.stageId !== undefined) {
				summary.stageCompletions++;
				continue;
			}
			summary.executions++;
			if (record.status === "completed") summary.completedExecutions++;
			if (record.status === "failed") summary.failedExecutions++;
			if (record.status === "aborted") summary.abortedExecutions++;
		}
	}
	summary.namedBases = countActiveNamedBases(records);
	summary.promotions = records.filter(record => record.kind === "promotion").length;
	return summary;
}

function isPromotionRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.promotionId !== "string" ||
		typeof value.originLeafId !== "string" ||
		value.originLeafId.length === 0 ||
		typeof value.assignmentDigest !== "string" ||
		typeof value.answerDigest !== "string" ||
		typeof value.answerArtifactRef !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.leafId !== "string"
	) {
		return false;
	}
	const { promotionId: _promotionId, ...semanticRecord } = value;
	return value.promotionId === semanticIdentity("context-lineage-promotion", semanticRecord);
}

/** Named bases are counted by resolvable name, not by raw records. */
function countActiveNamedBases(records: readonly ContextLineageSessionRecord[]): number {
	const latestByName = new Map<string, NamedBaseRecord>();
	for (const record of records) {
		if (record.kind === "named_base") latestByName.set(record.name, record);
	}
	return [...latestByName.values()].filter(record => record.status === "active").length;
}

function isContextLineageSessionRecord(value: unknown): value is ContextLineageSessionRecord {
	if (!isRecord(value) || value.version !== 1 || typeof value.kind !== "string") return false;
	try {
		if (value.kind === "repository_manifest") {
			return isRepositoryContextManifest(value.manifest) && isRepositoryContextManifestIntact(value.manifest);
		}
		if (value.kind === "logical_checkpoint") {
			return (
				isLogicalCheckpoint(value.checkpoint) &&
				value.checkpoint.checkpointId === logicalCheckpointIdentity(value.checkpoint)
			);
		}
		if (value.kind === "plan") {
			return (
				isContextLineagePlan(value.plan) &&
				typeof value.manifestId === "string" &&
				typeof value.checkpointId === "string" &&
				value.planId === contextLineagePlanIdentity(value.plan)
			);
		}
		if (value.kind === "base_selection") {
			return (value.runId === undefined || typeof value.runId === "string") && isContextLineageBaseSelection(value.selection);
		}
		if (value.kind === "base_selection_fallback") return isContextLineageBaseSelectionFallback(value.fallback);
		if (value.kind === "promotion") {
			return isPromotionRecord(value);
	}
		if (value.kind === "discarded_output") {
			if (typeof value.discardId !== "string" || typeof value.runId !== "string" || typeof value.taskId !== "string") return false;
			const { discardId: _discardId, ...semanticRecord } = value;
			return value.discardId === semanticIdentity("context-lineage-discard", semanticRecord);
		}
		if (value.kind === "run_started") {
			return (
				typeof value.runId === "string" &&
				typeof value.planId === "string" &&
				typeof value.checkpointId === "string" &&
				(value.originLeafId === undefined || typeof value.originLeafId === "string")
			);
		}
		if (value.kind === "named_base") return isNamedBaseRecord(value);
		if (value.kind === "wayfinder_binding") {
			return isWayfinderContextLineageBinding(value.binding);
		}
		if (value.kind === "benchmark") return isBenchmarkRecord(value);
		if (value.kind === "candidate_family") return isCandidateFamilyRecord(value);
		if (value.kind === "candidate_completed") return isCandidateCompletionRecord(value);
		if (value.kind === "candidate_discarded") return isCandidateDiscardRecord(value);
		if (value.kind === "candidate_allocation_stopped") return isCandidateAllocationStopRecord(value);
		if (value.kind === "candidate_selection") return isCandidateSelectionRecord(value);
		if (value.kind === "candidate_review") return isCandidateReviewRecord(value);
		if (value.kind === "candidate_checkpoint") return isCandidateCheckpointRecord(value);
		if (value.kind === "candidate_adjudication") return isCandidateAdjudicationRecord(value);
		if (value.kind === "adaptive_deliberation") return isAdaptiveDeliberationRecord(value);
		if (value.kind === "controlled_reasoning_benchmark") return isControlledReasoningBenchmarkRecord(value);
		if (value.kind !== "execution" || !isExecutionRecord(value)) return false;
		const { executionId: _executionId, ...semanticRecord } = value;
		return value.executionId === semanticIdentity("context-lineage-execution", semanticRecord);
	} catch {
		return false;
	}
}

function isCandidateFamilyRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.familyId !== "string" ||
		typeof value.planId !== "string" ||
		typeof value.checkpointId !== "string" ||
		typeof value.taskId !== "string" ||
		typeof value.assignmentDigest !== "string" ||
		!Array.isArray(value.candidates) ||
		value.candidates.length < 2 ||
		!value.candidates.every(isPendingCandidate)
	) {
		return false;
	}
	const candidateIds = new Set(value.candidates.map(candidate => candidate.candidateId));
	if (candidateIds.size !== value.candidates.length) return false;
	if (value.candidates.some(candidate => candidate.taskId !== value.taskId || candidate.assignmentDigest !== value.assignmentDigest)) {
		return false;
	}
	const { familyId: _familyId, ...semanticRecord } = value;
	return value.familyId === semanticIdentity("context-lineage-candidate-family", semanticRecord);
}

function isPendingCandidate(value: unknown): value is ContextLineageCandidate {
	if (!isRecord(value) || value.status !== "pending" || value.artifactRef !== undefined || value.executionObservation !== undefined) return false;
	if (typeof value.candidateId !== "string" || typeof value.taskId !== "string" || typeof value.assignmentDigest !== "string") return false;
	return Array.isArray(value.variation) && value.variation.every(isCandidateVariation);
}

function isCandidateVariation(value: unknown): value is ContextLineageCandidateVariation {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.value === "string" &&
		["counterfactual", "candidate", "reviewer_role", "context_delta"].includes(value.label as string)
	);
}

function isCandidateCompletionRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.completionId !== "string" ||
		typeof value.familyId !== "string" ||
		typeof value.candidateId !== "string" ||
		typeof value.contentDigest !== "string" ||
		typeof value.artifactRef !== "string" ||
		(value.executionObservation !== undefined && !isCandidateExecutionObservation(value.executionObservation))
	) {
		return false;
	}
	const { completionId: _completionId, ...semanticRecord } = value;
	return value.completionId === semanticIdentity("context-lineage-candidate-completion", semanticRecord);
}

function isCandidateExecutionObservation(value: unknown): value is ContextLineageCandidateExecutionObservation {
	if (!isRecord(value) || typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
		return false;
	}
	if (value.usage === undefined) return true;
	return (
		isRecord(value.usage) &&
		typeof value.usage.totalTokens === "number" &&
		Number.isFinite(value.usage.totalTokens) &&
		value.usage.totalTokens > 0 &&
		typeof value.usage.costUsd === "number" &&
		Number.isFinite(value.usage.costUsd) &&
		value.usage.costUsd >= 0
	);
}

function isCandidateDiscardRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (typeof value.discardId !== "string" || typeof value.familyId !== "string" || typeof value.candidateId !== "string") {
		return false;
	}
	const { discardId: _discardId, ...semanticRecord } = value;
	return value.discardId === semanticIdentity("context-lineage-candidate-discard", semanticRecord);
}

function isCandidateAllocationStopRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.stopId !== "string" ||
		typeof value.familyId !== "string" ||
		value.reason !== "user" ||
		!Array.isArray(value.candidateIds) ||
		value.candidateIds.length === 0 ||
		!value.candidateIds.every(candidateId => typeof candidateId === "string" && candidateId.length > 0)
	) {
		return false;
	}
	const candidateIds = [...new Set(value.candidateIds)].sort();
	if (candidateIds.length !== value.candidateIds.length) return false;
	const { stopId: _stopId, ...semanticRecord } = value;
	return value.stopId === semanticIdentity("context-lineage-candidate-allocation-stop", semanticRecord);
}

function isCandidateSelectionRecord(value: Readonly<Record<string, unknown>>): boolean {
	return typeof value.familyId === "string" && isSelectionRecord(value.selection);
}

function isCandidateReviewRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.reviewId !== "string" ||
		typeof value.familyId !== "string" ||
		typeof value.candidateId !== "string" ||
		typeof value.candidateArtifactRef !== "string" ||
		typeof value.rubricArtifactRef !== "string" ||
		typeof value.reviewArtifactRef !== "string" ||
		typeof value.contentDigest !== "string" ||
		typeof value.reviewerProfileId !== "string"
	) {
		return false;
	}
	const { reviewId: _reviewId, ...semanticRecord } = value;
	return value.reviewId === semanticIdentity("context-lineage-candidate-review", semanticRecord);
}

function isCandidateCheckpointRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.approvalId !== "string" ||
		typeof value.familyId !== "string" ||
		typeof value.candidateId !== "string" ||
		typeof value.selectionId !== "string" ||
		typeof value.planId !== "string" ||
		typeof value.sourceCheckpointId !== "string" ||
		!isLogicalCheckpoint(value.checkpoint) ||
		!isExecutionOutput(value.output)
	) {
		return false;
	}
	const { approvalId: _approvalId, ...semanticRecord } = value;
	return value.approvalId === semanticIdentity("context-lineage-candidate-checkpoint", semanticRecord);
}

function isCandidateAdjudicationRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.adjudicationId !== "string" ||
		typeof value.familyId !== "string" ||
		typeof value.rubricArtifactRef !== "string" ||
		!Array.isArray(value.reviewArtifactRefs) ||
		value.reviewArtifactRefs.length < 2 ||
		!value.reviewArtifactRefs.every(ref => typeof ref === "string") ||
		typeof value.adjudicationArtifactRef !== "string" ||
		typeof value.contentDigest !== "string" ||
		typeof value.evaluatorProfileId !== "string"
	) {
		return false;
	}
	const { adjudicationId: _adjudicationId, ...semanticRecord } = value;
	return value.adjudicationId === semanticIdentity("context-lineage-candidate-adjudication", semanticRecord);
}

function isAdaptiveDeliberationRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.decisionId !== "string" ||
		typeof value.familyId !== "string" ||
		!isAdaptivePolicy(value.policy) ||
		!isAdaptiveObservation(value.observation) ||
		!isAdaptiveDecision(value.decision) ||
		typeof value.manual !== "boolean"
	) {
		return false;
	}
	const expected = decideAdaptiveDeliberation(value.policy, value.observation, value.manual);
	if (canonicalJson(expected) !== canonicalJson(value.decision)) return false;
	const { decisionId: _decisionId, ...semanticRecord } = value;
	return value.decisionId === semanticIdentity("context-lineage-adaptive-deliberation", semanticRecord);
}

function isControlledReasoningBenchmarkRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (!isRecord(value.report) || value.report.version !== 1 || typeof value.report.benchmarkId !== "string") return false;
	const report = value.report as unknown as ControlledReasoningBenchmarkReport;
	if (
		typeof report.familyId !== "string" ||
		typeof report.rubricArtifactRef !== "string" ||
		typeof report.rubricContentDigest !== "string" ||
		typeof report.evaluatorProfileId !== "string" ||
		!Array.isArray(report.continuedCandidateIds) ||
		!Array.isArray(report.outcomes)
	) {
		return false;
	}
	return report.outcomes.every(
		outcome =>
			isRecord(outcome) &&
			typeof outcome.candidateId === "string" &&
			typeof outcome.artifactRef === "string" &&
			typeof outcome.candidateContentDigest === "string" &&
			typeof outcome.evaluatorInputDigest === "string" &&
			typeof outcome.evaluationArtifactRef === "string" &&
			typeof outcome.evaluationContentDigest === "string" &&
			(outcome.verdict === "acceptable" || outcome.verdict === "unacceptable"),
	);
}

function isControlledReasoningBenchmarkForFamily(
	report: ControlledReasoningBenchmarkReport,
	family: Extract<ContextLineageSessionRecord, { kind: "candidate_family" }>,
): boolean {
	try {
		const expected = evaluateControlledReasoningBenchmark({
			familyId: report.familyId,
			candidates: family.candidates,
			rubricArtifactRef: report.rubricArtifactRef,
			rubricContentDigest: report.rubricContentDigest,
			evaluatorProfileId: report.evaluatorProfileId,
			continuedCandidateIds: report.continuedCandidateIds,
			outcomes: report.outcomes,
		});
		return canonicalJson(expected) === canonicalJson(report);
	} catch {
		return false;
	}
}

function isAdaptivePolicy(value: unknown): value is AdaptiveDeliberationPolicy {
	if (!isRecord(value) || typeof value.topK !== "number" || !Number.isSafeInteger(value.topK) || value.topK < 1 || !isRecord(value.budget)) return false;
	if (value.disagreementThreshold !== undefined && typeof value.disagreementThreshold !== "number") return false;
	if (value.minimumRubricScore !== undefined && typeof value.minimumRubricScore !== "number") return false;
	return [value.budget.maxRequests, value.budget.maxTokens, value.budget.maxDurationMs, value.budget.maxCostUsd].every(
		item => typeof item === "number" && Number.isFinite(item) && item >= 0,
	);
}

function isAdaptiveObservation(value: unknown): value is AdaptiveDeliberationObservation {
	if (!isRecord(value)) return false;
	return [value.requests, value.tokens, value.elapsedMs, value.costUsd].every(
		item => typeof item === "number" && Number.isFinite(item) && item >= 0,
	) &&
		(value.disagreement === undefined || typeof value.disagreement === "number") &&
		(value.rubricScore === undefined || typeof value.rubricScore === "number");
}

function isAdaptiveDecision(value: unknown): value is AdaptiveDeliberationDecision {
	return (
		isRecord(value) &&
		typeof value.allocate === "boolean" &&
		typeof value.reason === "string" &&
		["manual", "disagreement", "rubric_gap", "budget_exhausted", "no_evaluated_trigger", "threshold_met"].includes(value.reason)
	);
}

function isSelectionRecord(value: unknown): value is ContextLineageSelectionRecord {
	if (
		!isRecord(value) ||
		typeof value.selectionId !== "string" ||
		typeof value.candidateId !== "string" ||
		typeof value.rubricArtifactRef !== "string" ||
		typeof value.evaluator !== "string" ||
		typeof value.explanation !== "string" ||
		!Array.isArray(value.visibleEvidence) ||
		!value.visibleEvidence.every(item => typeof item === "string")
	) {
		return false;
	}
	if (
		(value.adjudicationArtifactRef === undefined) !== (value.authorizedReviewArtifactRefs === undefined) ||
		(value.adjudicationArtifactRef !== undefined && typeof value.adjudicationArtifactRef !== "string") ||
		(value.authorizedReviewArtifactRefs !== undefined &&
			(!Array.isArray(value.authorizedReviewArtifactRefs) ||
				value.authorizedReviewArtifactRefs.length < 2 ||
				!value.authorizedReviewArtifactRefs.every(item => typeof item === "string")))
	) {
		return false;
	}
	const { selectionId: _selectionId, ...semanticRecord } = value;
	return value.selectionId === semanticIdentity("context-lineage-selection", semanticRecord);
}

function isNamedBaseRecord(value: Readonly<Record<string, unknown>>): boolean {
	return (
		typeof value.namedBaseId === "string" &&
		typeof value.name === "string" &&
		NAMED_BASE_NAME_PATTERN.test(value.name) &&
		typeof value.checkpointId === "string" &&
		(value.status === "active" || value.status === "archived" || value.status === "deleted")
	);
}

function isWayfinderContextLineageBinding(value: unknown): value is WayfinderContextLineageBinding {
	return isRecord(value) && isWayfinderContextLineageBindingIntact(value as unknown as WayfinderContextLineageBinding);
}

function isRepositoryManifestCheckpoint(
	checkpoint: LogicalContextCheckpoint,
	manifest: RepositoryContextManifest,
): boolean {
	const canonicalCheckpoint = createRepositoryManifestCheckpoint(manifest);
	return checkpoint.checkpointId === canonicalCheckpoint.checkpointId;
}

/** Minimal safe shape boundary shared by session recovery and local manifest-artifact restoration. */
export function isRepositoryContextManifest(value: unknown): value is RepositoryContextManifest {
	return (
		isRecord(value) &&
		typeof value.manifestId === "string" &&
		isRecord(value.snapshot) &&
		Array.isArray(value.evidence)
	);
}

function isLogicalCheckpoint(value: unknown): value is LogicalContextCheckpoint {
	return isRecord(value) && typeof value.checkpointId === "string" && typeof value.contentRootHash === "string";
}

function isContextLineagePlan(value: unknown): value is ContextLineagePlan {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.title === "string" &&
		Array.isArray(value.bases) &&
		Array.isArray(value.stages)
	);
}

function isExecutionRecord(value: Readonly<Record<string, unknown>>): boolean {
	return (
		typeof value.executionId === "string" &&
		typeof value.planId === "string" &&
		typeof value.checkpointId === "string" &&
		(value.runId === undefined || typeof value.runId === "string") &&
		(value.originLeafId === undefined || typeof value.originLeafId === "string") &&
		(value.stageId === undefined || typeof value.stageId === "string") &&
		["completed", "failed", "aborted"].includes(value.status as string) &&
		Array.isArray(value.outputs) &&
		value.outputs.every(isExecutionOutput)
	);
}

function isBenchmarkRecord(value: Readonly<Record<string, unknown>>): boolean {
	if (
		typeof value.benchmarkId !== "string" ||
		typeof value.benchmarkCaseId !== "string" ||
		typeof value.manifestId !== "string" ||
		typeof value.checkpointId !== "string" ||
		typeof value.planId !== "string" ||
		!isBenchmarkComparison(value.comparison) ||
		(value.review !== undefined && !isBenchmarkReview(value.review))
	) {
		return false;
	}
	const { benchmarkId: _benchmarkId, ...semanticRecord } = value;
	return value.benchmarkId === semanticIdentity("context-lineage-benchmark", semanticRecord);
}

function isBenchmarkComparison(value: unknown): value is RepositoryPlanningBenchmarkComparison {
	return (
		isRecord(value) &&
		isBenchmarkResult(value.grounded) &&
		isBenchmarkResult(value.unguided) &&
		typeof value.scopeRecallDelta === "number" &&
		typeof value.verificationRecallDelta === "number" &&
		typeof value.evidenceTraceabilityDelta === "number"
	);
}

function isBenchmarkReview(value: unknown): value is RepositoryPlanningBenchmarkReview {
	return (
		isRecord(value) &&
		typeof value.reviewerId === "string" &&
		(value.mode === "human" || value.mode === "declared_rule") &&
		typeof value.rulesVersion === "string" &&
		isBenchmarkResult(value.grounded) &&
		isBenchmarkResult(value.unguided)
	);
}

function isBenchmarkResult(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.scopeRecall === "number" &&
		typeof value.verificationRecall === "number" &&
		typeof value.evidenceTraceability === "number" &&
		Array.isArray(value.unsupportedScope) &&
		value.unsupportedScope.every(scope => typeof scope === "string")
	);
}

function isExecutionOutput(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.stageId === "string" &&
		typeof value.taskId === "string" &&
		(value.outputName === undefined || typeof value.outputName === "string") &&
		typeof value.contentDigest === "string" &&
		typeof value.artifactRef === "string" &&
		(value.cacheStatus === undefined ||
			["hit", "write", "miss", "unsupported", "unknown"].includes(value.cacheStatus as string)) &&
		(value.executionObservation === undefined || isExecutionObservation(value.executionObservation))
	);
}

function isExecutionObservation(value: unknown): value is ContextLineageExecutionObservation {
	if (!isRecord(value) || typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
		return false;
	}
	if (value.usage !== undefined) {
		if (
			!isRecord(value.usage) ||
			typeof value.usage.totalTokens !== "number" ||
			!Number.isFinite(value.usage.totalTokens) ||
			value.usage.totalTokens <= 0 ||
			typeof value.usage.costUsd !== "number" ||
			!Number.isFinite(value.usage.costUsd) ||
			value.usage.costUsd < 0
		) {
			return false;
		}
	}
	if (value.cacheTokens === undefined) return true;
	if (!isRecord(value.cacheTokens)) return false;
	return [value.cacheTokens.readTokens, value.cacheTokens.writeTokens, value.cacheTokens.uncachedInputTokens].every(
		tokens => tokens === undefined || (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0),
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
