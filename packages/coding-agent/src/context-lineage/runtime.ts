import type { ArtifactManager } from "../session/artifacts";
import { mapWithConcurrencyLimitAllSettled, type ParallelSettledResult } from "../task/parallel";
import * as git from "../utils/git";
import { prompt } from "@oh-my-pi/pi-utils";
import sideRequestPrompt from "../prompts/context-lineage/side-request.md" with { type: "text" };
import candidateSideRequestPrompt from "../prompts/context-lineage/candidate-side-request.md" with { type: "text" };
import candidateStructuredOutcomeSideRequestPrompt from "../prompts/context-lineage/candidate-structured-outcome-side-request.md" with { type: "text" };
import candidateReviewPrompt from "../prompts/context-lineage/candidate-review.md" with { type: "text" };
import candidateAdjudicationPrompt from "../prompts/context-lineage/candidate-adjudication.md" with { type: "text" };
import {
	type RepositoryPlanningBenchmarkCase,
	type RepositoryPlanningBenchmarkRun,
	runRepositoryPlanningBenchmark,
	type UnguidedPlanningClaimsGenerator,
} from "./benchmark";
import {
	type CollectedExternalEvidence,
	collectExternalAdapterEvidence,
	type ExternalAdapterPolicy,
	mergeExternalEvidence,
} from "./external-adapters";
import {
	collectLocalDocumentaryEvidence,
	mergeDocumentaryEvidence,
	type DocumentaryEvidenceInput,
} from "./documentary";
import {
	contextLineagePlanIdentity,
	preparedPrefixIdentity,
	repositorySnapshotIdentity,
	semanticIdentity,
} from "./identity";
import {
	type CurrentStateRetrievalPolicy,
	compileCurrentStateRepositoryManifest,
	isRepositoryContextManifestIntact,
	renderRepositoryContextManifest,
	serializeRepositoryContextManifest,
	stripRepositoryManifestSource,
} from "./manifest";
import {
	type RepositoryPlanningSkillGenerator,
	type RepositoryPlanningSkillValidation,
	runRepositoryPlanningSkill,
} from "./planning";
import type { CacheObservation } from "./provider";
import type { ContextLineageCandidateVariation } from "./deliberation";
import {
	appendContextLineageSessionRecord,
	type ContextLineageExecutionObservation,
	type ContextLineageExecutionOutput,
	type ContextLineageSessionJournal,
	type ContextLineageSessionRecord,
	createContextLineageBenchmarkRecord,
	createContextLineageExecutionRecord,
	createContextLineageRunStartedRecord,
	createRepositoryManifestCheckpoint,
	getContextLineageSessionRecords,
	resolveContextLineageCandidateCheckpoint,
} from "./session";
import { lineageEvent } from "./telemetry";
import {
	collectTemporalEvidence,
	inferTemporalRetrievalProfile,
	mergeTemporalEvidence,
	type TemporalRetrievalPolicy,
} from "./temporal";
import type {
	ContextLineagePlan,
	LogicalContextCheckpoint,
	PlanFailurePolicy,
	PlanStage,
	PlanTask,
	PreparedPrefix,
	RepositoryContextManifest,
	SynthesisPlanStage,
} from "./types";
import { stageTasks } from "./types";
import { validateContextLineagePlan } from "./validation";
import {
	createWayfinderContextLineageBinding,
	resolveWayfinderIssuePair,
	type WayfinderIssueResolver,
} from "./wayfinder";

const DEFAULT_RETRIEVAL_POLICY: CurrentStateRetrievalPolicy = {
	id: "context-lineage-current-state-v1",
};
const CONTEXT_RENDERER_VERSION = "context-lineage-v1";

/** Materialize target-visible prefix diagnostics without creating cache-routing state. */
export function createRepositoryPreparedPrefix(input: {
	readonly checkpoint: LogicalContextCheckpoint;
	readonly target: PreparedPrefix["target"];
	readonly rendererContractVersion: string;
	readonly renderedPrefix: string;
	readonly expectedSharedTokens?: number;
	readonly compatibilityProfileVersion: string;
}): PreparedPrefix {
	const prefix: PreparedPrefix = {
		version: 1,
		preparedPrefixId: "",
		checkpointId: input.checkpoint.checkpointId,
		target: input.target,
		rendererContractVersion: input.rendererContractVersion,
		providerContextDigest: semanticIdentity("provider-visible-context", input.renderedPrefix),
		encodedPrefixDigest: semanticIdentity("provider-visible-prefix", input.renderedPrefix),
		expectedSharedBytes: new TextEncoder().encode(input.renderedPrefix).byteLength,
		...(input.expectedSharedTokens === undefined ? {} : { expectedSharedTokens: input.expectedSharedTokens }),
		compatibilityProfileVersion: input.compatibilityProfileVersion,
		createdAt: Date.now(),
	};
	const identified = { ...prefix, preparedPrefixId: preparedPrefixIdentity(prefix) };
	lineageEvent("prepared_prefix_created", {
		prepared_prefix_id: identified.preparedPrefixId,
		checkpoint_id: identified.checkpointId,
		target: `${identified.target.provider}/${identified.target.model}`,
		expected_shared_bytes: identified.expectedSharedBytes,
	});
	return identified;
}

export interface PrepareRepositoryContextLineageRequest {
	readonly cwd: string;
	readonly task: string;
	readonly journal: ContextLineageSessionJournal;
	readonly signal?: AbortSignal;
	/**
	 * Optional per-item cancellation boundary. The coordinator keeps scheduling
	 * siblings with the run signal while each dispatched task receives its own
	 * combined signal, so cancelling one item cannot abort unrelated work.
	 */
	readonly taskSignal?: (input: { readonly stageId: string; readonly taskId: string }) => AbortSignal | undefined;
	/** Opt-in bounded Git history enrichment (PR 9A slice); absent keeps current-state only. */
	readonly temporal?: { readonly policy: TemporalRetrievalPolicy; readonly maxItems?: number };
	/** Explicit local or pre-authorized forge documents; never causes network retrieval. */
	readonly documentary?: {
		readonly documents: readonly DocumentaryEvidenceInput[];
		readonly maxItems?: number;
		readonly maxExcerptBytes?: number;
	};
	/**
	 * External evidence adapters (PR 3A): read-only Graphify/SCIP normalization
	 * under §25.5 modes. Absent keeps native-only compilation (FR55).
	 */
	readonly adapters?: ExternalAdapterPolicy;
}

export interface PreparedRepositoryContextLineage {
	readonly manifest: RepositoryContextManifest;
	readonly checkpoint: LogicalContextCheckpoint;
	readonly manifestEntryId: string;
	readonly checkpointEntryId: string;
	/**
	 * Per-adapter outcomes for inspection surfaces; observed-only candidates
	 * never entered the manifest base (§25.5 observe mode).
	 */
	readonly adapterObservations: readonly CollectedExternalEvidence[];
}

export interface PrepareWayfinderContextLineageRequest extends PrepareRepositoryContextLineageRequest {
	readonly goal: string;
	readonly mapIssueUrl: string;
	readonly ticketIssueUrl: string;
	readonly resolver?: WayfinderIssueResolver;
}

export interface PreparedWayfinderContextLineage extends PreparedRepositoryContextLineage {
	readonly bindingId: string;
	readonly bindingEntryId: string;
}

export type PlannedWayfinderContextLineage =
	| {
			readonly valid: false;
			readonly prepared: PreparedWayfinderContextLineage;
			readonly validation: RepositoryPlanningSkillValidation;
	  }
	| {
			readonly valid: true;
			readonly prepared: PreparedWayfinderContextLineage;
			readonly plan: ContextLineagePlan;
			readonly planId: string;
			readonly planEntryId: string;
	  };

export type PlannedRepositoryContextLineage =
	| {
			readonly valid: false;
			readonly prepared: PreparedRepositoryContextLineage;
			readonly validation: RepositoryPlanningSkillValidation;
	  }
	| {
			readonly valid: true;
			readonly prepared: PreparedRepositoryContextLineage;
			readonly plan: ContextLineagePlan;
			readonly planId: string;
			readonly planEntryId: string;
	  };

export type PersistedRepositoryPlanningBenchmarkRun =
	| {
			readonly valid: false;
			readonly prepared: PreparedRepositoryContextLineage;
			readonly run: RepositoryPlanningBenchmarkRun;
			/** Sidecar reference to a failed or rejected grounded response, if available. */
			readonly groundedResponseArtifactId?: string;
	  }
	| {
			readonly valid: true;
			readonly prepared: PreparedRepositoryContextLineage;
			readonly run: Extract<RepositoryPlanningBenchmarkRun, { valid: true }>;
			readonly planId: string;
			readonly planEntryId: string;
			readonly benchmarkId: string;
			readonly benchmarkEntryId: string;
			/** Sidecar reference to the raw model plan behind the persisted comparison. */
			readonly groundedResponseArtifactId?: string;
	  };

export interface ContextLineageTaskExecutionResult {
	readonly contentDigest: string;
	readonly artifactRef: string;
	/** Provider-reported cache observation when the runner can capture one (FR8). */
	readonly cacheObservation?: CacheObservation;
	/** Real side-request usage, omitted when the provider did not report token accounting. */
	readonly usage?: ContextLineageSideRequestUsage;
	/** Wall-clock duration measured around the isolated provider request. */
	readonly elapsedMs?: number;
}

export interface ContextLineageOutputVerifier {
	verify(result: ContextLineageTaskExecutionResult): Promise<boolean>;
}

/** Verify a result against a concrete session artifact without retaining its text in the lineage journal. */
export function createArtifactManagerContextLineageOutputVerifier(
	artifacts: ArtifactManager,
): ContextLineageOutputVerifier {
	return {
		async verify(result): Promise<boolean> {
			const artifactId = artifactIdFromRef(result.artifactRef);
			if (!artifactId) return false;
			const artifactPath = await artifacts.getPath(artifactId);
			if (!artifactPath) return false;
			try {
				const content = await Bun.file(artifactPath).text();
				return result.contentDigest === semanticIdentity("context-lineage-output", content);
			} catch {
				return false;
			}
		},
	};
}

export interface ContextLineagePriorOutput {
	readonly stageId: string;
	readonly taskId: string;
	readonly outputName: string;
	readonly contentDigest: string;
	readonly artifactRef: string;
}

export interface ContextLineageTaskExecutionRequest {
	readonly manifest: RepositoryContextManifest;
	readonly checkpoint: LogicalContextCheckpoint;
	readonly plan: ContextLineagePlan;
	readonly stage: PlanStage;
	readonly task: PlanTask;
	readonly priorOutputs: readonly ContextLineagePriorOutput[];
	readonly signal: AbortSignal;
}

export interface ContextLineageTaskRunner {
	run(request: ContextLineageTaskExecutionRequest): Promise<ContextLineageTaskExecutionResult>;
}

export interface ExecuteContextLineagePlanRequest {
	readonly manifest: RepositoryContextManifest;
	readonly checkpoint: LogicalContextCheckpoint;
	readonly plan: ContextLineagePlan;
	readonly journal: ContextLineageSessionJournal;
	/** Dispatches one task as an isolated no-tools side request (PR 4/5). */
	readonly runner: ContextLineageTaskRunner;
	readonly outputVerifier: ContextLineageOutputVerifier;
	readonly concurrency?: number;
	readonly signal?: AbortSignal;
	/** Item-specific cancellation boundary; sibling scheduling retains the run signal. */
	readonly taskSignal?: (input: { readonly stageId: string; readonly taskId: string }) => AbortSignal | undefined;
	/** Overrides the plan's defaults.failurePolicy for this run. */
	readonly failurePolicy?: PlanFailurePolicy;
	/** Session leaf captured for origin-safe promotion (PR 7). */
	readonly originLeafId?: string;
	/**
	 * Warm coordination (§18.3). `stagger_first` dispatches the first task of
	 * each stage alone so its cache write lands before siblings read; `off`
	 * (default) dispatches by ordinary concurrency.
	 */
	readonly warmPolicy?: "off" | "stagger_first";
	/** Preallocated identity for a live run controller. */
	readonly runId?: string;
	/**
	 * Completed stage outputs recovered from persisted per-stage progress
	 * records; listed stages are skipped instead of rerun (NFR4 restart recovery).
	 */
	readonly resume?: {
		readonly completedStageIds: readonly string[];
		readonly outputs: readonly ContextLineageExecutionOutput[];
	};
}

export interface ContextLineageExecutionOutcome {
	readonly status: "completed" | "failed" | "aborted";
	readonly executionId: string;
	readonly executionEntryId: string;
	readonly runId: string;
	/** Provider-reported observations per task, in completion order (FR8). */
	readonly cacheObservations: readonly CacheObservation[];
}

/** Compile and durably root a read-only planning context without dispatching an agent. */
export async function prepareRepositoryContextLineage(
	request: PrepareRepositoryContextLineageRequest,
): Promise<PreparedRepositoryContextLineage> {
	let manifest = await compileCurrentStateRepositoryManifest(request.cwd, {
		task: request.task,
		retrievalPolicy: DEFAULT_RETRIEVAL_POLICY,
		contextRendererVersion: CONTEXT_RENDERER_VERSION,
		untrackedPolicy: "exclude",
		signal: request.signal,
	});
	// PR 3A: external evidence adapters run before temporal enrichment so
	// history always decorates the adapter-inclusive base, never the reverse.
	let adapterObservations: readonly CollectedExternalEvidence[] = [];
	if (request.adapters) {
		const repositoryRoot = await git.repo.root(request.cwd, request.signal);
		if (!repositoryRoot) throw new Error(`Context Lineage requires a Git repository: ${request.cwd}`);
		adapterObservations = await collectExternalAdapterEvidence({
			repositoryRoot,
			snapshot: manifest.snapshot,
			policy: request.adapters,
			signal: request.signal,
		});
		const merged = mergeExternalEvidence(
			manifest,
			adapterObservations,
			request.adapters.maxAdapterEvidenceItems ?? 8,
		);
		lineageEvent("repository_evidence_selected", {
			manifest_id: merged.manifestId,
			native_count: manifest.evidence.length,
			adapter_count: merged.evidence.length - manifest.evidence.length,
			observed_only_count: adapterObservations
				.filter(observation => observation.status === "observed")
				.reduce((total, observation) => total + observation.evidence.length, 0),
			included_adapters: adapterObservations
				.filter(observation => observation.status === "included")
				.map(observation => observation.adapterId),
		});
		manifest = merged;
	}
	if (request.temporal) {
		const repositoryRoot = await git.repo.root(request.cwd, request.signal);
		if (!repositoryRoot) throw new Error(`Context Lineage requires a Git repository: ${request.cwd}`);
		lineageEvent("evidence_adapter_started", {
			adapter_id: "native-git-temporal",
			manifest_id: manifest.manifestId,
			path_count: manifest.evidence.length,
		});
		const temporalPolicy: TemporalRetrievalPolicy = {
			...request.temporal.policy,
			profile: request.temporal.policy.profile ?? inferTemporalRetrievalProfile(request.task),
		};
		const collected = await collectTemporalEvidence({
			repositoryRoot,
			snapshot: manifest.snapshot,
			paths: manifest.evidence.map(evidence => evidence.sourceRef),
			policy: temporalPolicy,
			signal: request.signal,
		});
		lineageEvent("evidence_adapter_completed", {
			adapter_id: "native-git-temporal",
			evidence_count: collected.evidence.length,
			degraded_count: collected.degradedSources.length,
		});
		for (const degraded of collected.degradedSources) {
			lineageEvent("evidence_adapter_degraded", {
				adapter_id: degraded.extractorId,
				reason: degraded.reason,
				detail: degraded.detail,
			});
		}
		manifest = mergeTemporalEvidence(manifest, collected, request.temporal.maxItems ?? 5);
	}
	if (request.documentary) {
		const collected = collectLocalDocumentaryEvidence({
			snapshot: manifest.snapshot,
			documents: request.documentary.documents,
			maxItems: request.documentary.maxItems ?? 4,
			maxExcerptBytes: request.documentary.maxExcerptBytes,
		});
		lineageEvent("evidence_adapter_completed", {
			adapter_id: "authorized-documentary",
			evidence_count: collected.evidence.length,
			degraded_count: collected.degradedSources.length,
		});
		manifest = mergeDocumentaryEvidence(manifest, collected);
	}
	lineageEvent("repository_snapshot_frozen", {
		snapshot_id: repositorySnapshotIdentity(manifest.snapshot),
		manifest_id: manifest.manifestId,
		retrieval_policy_id: manifest.retrievalPolicyId,
		evidence_class_counts: manifest.evidence.reduce<Record<string, number>>((counts, evidence) => {
			counts[evidence.evidenceClass] = (counts[evidence.evidenceClass] ?? 0) + 1;
			return counts;
		}, {}),
		degraded_source_count: manifest.degradedSources.length,
		omission_count: manifest.omissions.length,
	});
	lineageEvent("repository_manifest_created", {
		manifest_id: manifest.manifestId,
		snapshot_id: repositorySnapshotIdentity(manifest.snapshot),
		renderer_version: manifest.contextRendererVersion,
		evidence_count: manifest.evidence.length,
	});
	const strippedManifest = await stripRepositoryManifestForSession(manifest, request.journal);
	const manifestEntryId = appendContextLineageSessionRecord(request.journal, {
		version: 1,
		kind: "repository_manifest",
		manifest: strippedManifest.manifest,
		...(strippedManifest.artifactId ? { manifestArtifactId: strippedManifest.artifactId } : {}),
	});
	const checkpoint = createRepositoryManifestCheckpoint(manifest);
	if (manifest.degradedSources.length > 0) {
		lineageEvent("repository_manifest_degraded", {
			manifest_id: manifest.manifestId,
			degraded_count: manifest.degradedSources.length,
			extractors: manifest.degradedSources.map(source => source.extractorId),
		});
	}
	lineageEvent("checkpoint_created", {
		checkpoint_id: checkpoint.checkpointId,
		origin: checkpoint.origin,
		repository_manifest_id: checkpoint.repositoryManifestId,
	});
	const checkpointEntryId = appendContextLineageSessionRecord(request.journal, {
		version: 1,
		kind: "logical_checkpoint",
		checkpoint,
	});
	return { manifest, checkpoint, manifestEntryId, checkpointEntryId, adapterObservations };
}

/**
 * MVP storage rule: session records stay digest-only. The fully rendered
 * manifest (including excerpt bytes) is persisted once in the session artifact
 * store and referenced by artifact ID; session history never carries source.
 */
async function stripRepositoryManifestForSession(
	manifest: RepositoryContextManifest,
	journal: ContextLineageSessionJournal,
): Promise<{ manifest: RepositoryContextManifest; artifactId?: string }> {
	const artifactId = await journal.saveArtifact?.(
		serializeRepositoryContextManifest(manifest),
		"context-lineage-manifest",
	);
	return { manifest: stripRepositoryManifestSource(manifest), ...(artifactId ? { artifactId } : {}) };
}

/**
 * Resolve the Campaign work-graph nodes once, then bind their read-only
 * documentary snapshot to a newly frozen repository planning base.
 */
export async function prepareWayfinderContextLineage(
	request: PrepareWayfinderContextLineageRequest,
): Promise<PreparedWayfinderContextLineage> {
	const [issues, prepared] = await Promise.all([
		resolveWayfinderIssuePair({
			cwd: request.cwd,
			mapIssueUrl: request.mapIssueUrl,
			ticketIssueUrl: request.ticketIssueUrl,
			resolver: request.resolver,
			signal: request.signal,
		}),
		prepareRepositoryContextLineage(request),
	]);
	const binding = createWayfinderContextLineageBinding({
		goal: request.goal,
		mapIssue: issues.mapIssue,
		ticketIssue: issues.ticketIssue,
		manifestId: prepared.manifest.manifestId,
		checkpointId: prepared.checkpoint.checkpointId,
	});
	const bindingEntryId = appendContextLineageSessionRecord(request.journal, {
		version: 1,
		kind: "wayfinder_binding",
		binding,
	});
	return { ...prepared, bindingId: binding.bindingId, bindingEntryId };
}

/** Generate a manifest-validated repository plan for one already-resolved Campaign ticket. */
export async function planWayfinderContextLineage(
	request: PrepareWayfinderContextLineageRequest & { readonly generator: RepositoryPlanningSkillGenerator },
): Promise<PlannedWayfinderContextLineage> {
	const prepared = await prepareWayfinderContextLineage(request);
	const validation = await runRepositoryPlanningSkill(
		{ task: request.task, manifest: prepared.manifest },
		request.generator,
	);
	if (!validation.valid) return { valid: false, prepared, validation };
	const planId = contextLineagePlanIdentity(validation.plan);
	const planEntryId = appendContextLineageSessionRecord(request.journal, {
		version: 1,
		kind: "plan",
		plan: validation.plan,
		planId,
		manifestId: prepared.manifest.manifestId,
		checkpointId: prepared.checkpoint.checkpointId,
	});
	return { valid: true, prepared, plan: validation.plan, planId, planEntryId };
}

/** Generate and persist a plan only after it validates against the frozen manifest checkpoint. */
export async function planRepositoryContextLineage(
	request: PrepareRepositoryContextLineageRequest & { readonly generator: RepositoryPlanningSkillGenerator },
): Promise<PlannedRepositoryContextLineage> {
	const prepared = await prepareRepositoryContextLineage(request);
	const validation = await runRepositoryPlanningSkill(
		{ task: request.task, manifest: prepared.manifest },
		request.generator,
	);
	if (!validation.valid) return { valid: false, prepared, validation };
	const planId = contextLineagePlanIdentity(validation.plan);
	lineageEvent("plan_validated", {
		plan_id: planId,
		manifest_id: prepared.manifest.manifestId,
		stage_count: validation.plan.stages.length,
	});
	const planEntryId = appendContextLineageSessionRecord(request.journal, {
		version: 1,
		kind: "plan",
		plan: validation.plan,
		planId,
		manifestId: prepared.manifest.manifestId,
		checkpointId: prepared.checkpoint.checkpointId,
	});
	return { valid: true, prepared, plan: validation.plan, planId, planEntryId };
}

/**
 * Run the same benchmark task through grounded and unguided paths, then retain
 * the valid grounded plan and comparison as session sidecars for review.
 */
export async function benchmarkRepositoryContextLineage(input: {
	readonly prepared: PreparedRepositoryContextLineage;
	readonly benchmark: RepositoryPlanningBenchmarkCase;
	readonly journal: ContextLineageSessionJournal;
	readonly groundedGenerator: RepositoryPlanningSkillGenerator;
	readonly unguidedGenerator: UnguidedPlanningClaimsGenerator;
}): Promise<PersistedRepositoryPlanningBenchmarkRun> {
	const task = input.benchmark.task;
	if (!task) throw new Error(`Context Lineage benchmark ${input.benchmark.id} has no task framing`);
	const run = await runRepositoryPlanningBenchmark({
		request: { task, manifest: input.prepared.manifest },
		benchmark: input.benchmark,
		groundedGenerator: input.groundedGenerator,
		unguidedGenerator: input.unguidedGenerator,
	});
	const response = run.grounded.phase === "manifest" ? undefined : run.grounded.response;
	const groundedResponseArtifactId = response
		? await input.journal.saveArtifact?.(response, "context-lineage-benchmark-plan")
		: undefined;
	if (!run.valid || run.grounded.phase !== "semantic" || !run.grounded.valid) {
		return { valid: false, prepared: input.prepared, run, ...(groundedResponseArtifactId ? { groundedResponseArtifactId } : {}) };
	}
	const planId = contextLineagePlanIdentity(run.grounded.plan);
	const planEntryId = appendContextLineageSessionRecord(input.journal, {
		version: 1,
		kind: "plan",
		plan: run.grounded.plan,
		planId,
		manifestId: input.prepared.manifest.manifestId,
		checkpointId: input.prepared.checkpoint.checkpointId,
	});
	const record = createContextLineageBenchmarkRecord({
		benchmarkCaseId: input.benchmark.id,
		manifestId: input.prepared.manifest.manifestId,
		checkpointId: input.prepared.checkpoint.checkpointId,
		planId,
		comparison: run.comparison,
		review: run.review,
	});
	const benchmarkEntryId = appendContextLineageSessionRecord(input.journal, record);
	return {
		valid: true,
		prepared: input.prepared,
		run,
		planId,
		planEntryId,
		benchmarkId: record.benchmarkId,
		benchmarkEntryId,
		...(groundedResponseArtifactId ? { groundedResponseArtifactId } : {}),
	};
}

/**
 * Execute a validated plan through an injected runner. Raw task output never
 * returns to the parent context: runners persist it separately and return a
 * digest plus an artifact reference for durable lineage only.
 */
export async function executeContextLineagePlan(
	request: ExecuteContextLineagePlanRequest,
): Promise<ContextLineageExecutionOutcome> {
	if (!isRepositoryContextManifestIntact(request.manifest)) {
		throw new Error("Context Lineage manifest integrity check failed before execution");
	}
	const canonicalCheckpoint = createRepositoryManifestCheckpoint(request.manifest);
	const records = getContextLineageSessionRecords(request.journal);
	const approvedCandidateCheckpoint = resolveContextLineageCandidateCheckpoint(
		request.checkpoint.checkpointId,
		contextLineagePlanIdentity(request.plan),
		records,
	);
	const isManifestCheckpoint =
		request.checkpoint.checkpointId === canonicalCheckpoint.checkpointId &&
		request.checkpoint.repositoryManifestId === request.manifest.manifestId &&
		request.checkpoint.contentRootHash === request.manifest.manifestId &&
		request.checkpoint.securityScopeId === request.manifest.snapshot.workspaceScopeId &&
		request.checkpoint.workspaceScopeId === request.manifest.snapshot.workspaceScopeId &&
		request.checkpoint.origin === "repository_manifest" &&
		request.checkpoint.materialization === "repository_manifest";
	const isApprovedCandidateCheckpoint =
		approvedCandidateCheckpoint?.checkpoint.checkpointId === request.checkpoint.checkpointId &&
		request.checkpoint.repositoryManifestId === request.manifest.manifestId &&
		request.checkpoint.securityScopeId === request.manifest.snapshot.workspaceScopeId &&
		request.checkpoint.workspaceScopeId === request.manifest.snapshot.workspaceScopeId &&
		request.checkpoint.origin === "checkpoint_extension" &&
		request.checkpoint.materialization === "selected_outputs";
	if (!isManifestCheckpoint && !isApprovedCandidateCheckpoint) {
		throw new Error("Context Lineage checkpoint does not belong to the supplied manifest");
	}
	// Named-base sources resolve from session records; unresolvable names fail
	// validation below instead of silently substituting a base (PR 9).
	const plan = resolvePlanNamedBases(
		request.plan,
		records.filter(record => record.kind === "named_base"),
	);
	const validation = validateContextLineagePlan(plan, [request.manifest], {
		allowedBaseSourceTypes: new Set(["repository_manifest", "checkpoint"]),
		allowedWorkspaceModes: new Set(["frozen_read_only"]),
	});
	if (!validation.valid)
		throw new Error(`Context Lineage plan is invalid: ${validation.issues[0]?.message ?? "unknown error"}`);
	lineageEvent("plan_validated", {
		plan_id: contextLineagePlanIdentity(plan),
		stage_count: plan.stages.length,
	});
	if (plan.stages.some(stage => stage.capabilityRequirements?.workspaceMode !== "frozen_read_only")) {
		throw new Error("Context Lineage execution requires every stage to declare frozen_read_only workspace mode");
	}

	const signal = request.signal ?? new AbortController().signal;
	const concurrency = request.concurrency ?? 4;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new Error("Context Lineage execution concurrency must be a positive safe integer");
	}
	const runId = request.runId ?? createContextLineageRunId(plan, request.checkpoint);
	appendContextLineageSessionRecord(
		request.journal,
		createContextLineageRunStartedRecord({
			runId,
			planId: contextLineagePlanIdentity(plan),
			checkpointId: request.checkpoint.checkpointId,
			originLeafId: request.originLeafId,
		}),
	);
	const outputs: ContextLineageExecutionOutput[] = [...(request.resume?.outputs ?? [])];
	const cacheObservations: CacheObservation[] = [];
	const completed = new Set<string>(request.resume?.completedStageIds ?? []);
	const failedOrBlocked = new Set<string>();
	const pending = [...plan.stages];
	const failurePolicy = request.failurePolicy ?? plan.defaults?.failurePolicy ?? "stop_dependents";
	lineageEvent("run_started", {
		run_id: runId,
		plan_id: contextLineagePlanIdentity(plan),
		checkpoint_id: request.checkpoint.checkpointId,
		fanout_width: plan.stages.reduce(
			(max, stage) => Math.max(max, stage.mode === "fanout" ? stage.tasks.length : 1),
			0,
		),
		warm_policy: request.warmPolicy ?? "off",
		failure_policy: failurePolicy,
		stage_count: plan.stages.length,
	});
	let status: ContextLineageExecutionOutcome["status"] = signal.aborted ? "aborted" : "completed";

	while (pending.length > 0 && (status === "completed" || failurePolicy !== "stop_plan")) {
		// Block stages downstream of failures before checking readiness (§21.5).
		for (let i = pending.length - 1; i >= 0; i--) {
			if ((pending[i]!.dependsOn ?? []).some(dependency => failedOrBlocked.has(dependency))) {
				failedOrBlocked.add(pending.splice(i, 1)[0]!.id);
			}
		}
		const index = pending.findIndex(stage => (stage.dependsOn ?? []).every(dependency => completed.has(dependency)));
		if (index < 0) {
			// §21.5: the pre-pass may block the last pending stages downstream of
			// a failure; terminate with their outputs preserved instead of throwing.
			if (pending.length === 0) break;
			throw new Error("Context Lineage plan cannot make dependency progress");
		}
		const stage = pending.splice(index, 1)[0]!;
		if (completed.has(stage.id)) continue;
		lineageEvent("stage_ready", { run_id: runId, plan_id: contextLineagePlanIdentity(plan), stage_id: stage.id });
		if (stage.mode === "synthesis") {
			const priorOutputs = selectSynthesisInputs(stage, outputs);
			const syntheticTask: PlanTask = {
				id: stage.id,
				assignment: stage.instructions ?? "Synthesize the selected upstream outputs.",
				output: { name: stage.output, format: "text" },
			};
			const result = await request.runner.run({
				manifest: request.manifest,
				checkpoint: request.checkpoint,
				plan,
				stage,
				task: syntheticTask,
				priorOutputs,
				signal,
			});
			if (!result.contentDigest)
				throw new Error(`Context Lineage task ${syntheticTask.id} returned no content digest`);
			if (!result.artifactRef)
				throw new Error(`Context Lineage task ${syntheticTask.id} returned no artifact reference`);
			if (!(await request.outputVerifier.verify(result))) {
				throw new Error(`Context Lineage task ${syntheticTask.id} returned an unverified artifact reference`);
			}
			if (result.cacheObservation) cacheObservations.push(result.cacheObservation);
			const observation = executionObservation(result);
			outputs.push({
				stageId: stage.id,
				taskId: syntheticTask.id,
				outputName: stage.output,
				contentDigest: result.contentDigest,
				artifactRef: result.artifactRef,
				...(observation ? { executionObservation: observation } : {}),
				...(result.cacheObservation ? { cacheStatus: result.cacheObservation.status } : {}),
			});
			completed.add(stage.id);
			lineageEvent("synthesis_created", {
				run_id: runId,
				plan_id: contextLineagePlanIdentity(plan),
				stage_id: stage.id,
				output_name: stage.output,
				input_count: priorOutputs.length,
			});
			await appendStageProgressRecord(request, contextLineagePlanIdentity(plan), stage.id, outputs, runId);
			continue;
		}
		// A resumed fan-out stage preserves completed siblings and dispatches only
		// task identities that have no verified prior output. This is what makes a
		// retry of one cancelled/failed item safe instead of duplicating answers.
		const completedTaskIds = new Set(outputs.filter(output => output.stageId === stage.id).map(output => output.taskId));
		const tasks = stageTasks(stage).filter(task => !completedTaskIds.has(task.id));
		if (tasks.length === 0) {
			completed.add(stage.id);
			continue;
		}
		const priorOutputs = selectStageInputs(stage, outputs);
		const runTask = async (task: PlanTask, _index: number, taskSignal: AbortSignal) => {
			const itemSignal = request.taskSignal?.({ stageId: stage.id, taskId: task.id });
			const executionSignal = itemSignal ? AbortSignal.any([taskSignal, itemSignal]) : taskSignal;
			const attemptDimensions = {
				run_id: runId,
				plan_id: contextLineagePlanIdentity(plan),
				stage_id: stage.id,
				task_id: task.id,
			};
			lineageEvent("item_attempt_started", attemptDimensions);
			try {
				const result = await request.runner.run({
					manifest: request.manifest,
					checkpoint: request.checkpoint,
					plan,
					stage,
					task,
					priorOutputs,
					signal: executionSignal,
				});
				if (!result.contentDigest) throw new Error(`Context Lineage task ${task.id} returned no content digest`);
				if (!result.artifactRef) throw new Error(`Context Lineage task ${task.id} returned no artifact reference`);
				if (!(await request.outputVerifier.verify(result))) {
					throw new Error(`Context Lineage task ${task.id} returned an unverified artifact reference`);
				}
				if (result.cacheObservation) cacheObservations.push(result.cacheObservation);
				lineageEvent("item_attempt_completed", attemptDimensions);
				return { task, result, cacheStatus: result.cacheObservation?.status };
			} catch (error) {
				lineageEvent("item_attempt_failed", { ...attemptDimensions, error: String(error) });
				throw error;
			}
		};
		const warmPolicy = request.warmPolicy ?? "off";
		let settled: ParallelSettledResult<{ task: PlanTask; result: ContextLineageTaskExecutionResult }>;
		if (warmPolicy === "stagger_first" && tasks.length > 1) {
			// §18.3 stagger_first: the first task writes the shared prefix alone;
			// siblings release after it settles instead of racing it.
			const firstSettled = await mapWithConcurrencyLimitAllSettled([tasks[0]!], 1, runTask, signal);
			const rest = tasks.slice(1);
			const restSettled = await mapWithConcurrencyLimitAllSettled(rest, concurrency, runTask, signal);
			settled = {
				results: [...firstSettled.results, ...restSettled.results],
				aborted: firstSettled.aborted || restSettled.aborted,
			};
		} else {
			settled = await mapWithConcurrencyLimitAllSettled([...tasks], concurrency, runTask, signal);
		}
		pushStageOutputs(stage, settled, outputs);
		if (settled.aborted || signal.aborted) {
			status = "aborted";
		} else if (settled.results.some(result => result?.status === "rejected")) {
			if (failurePolicy === "continue_independent") {
				// §21.5: keep successful sibling outputs; dependents try with what survived.
				completed.add(stage.id);
				await appendStageProgressRecord(request, contextLineagePlanIdentity(plan), stage.id, outputs, runId);
			} else if (failurePolicy === "stop_plan") {
				failedOrBlocked.add(stage.id);
				status = "failed";
			} else {
				failedOrBlocked.add(stage.id);
			}
		} else {
			completed.add(stage.id);
			await appendStageProgressRecord(request, contextLineagePlanIdentity(plan), stage.id, outputs, runId);
		}
	}
	if (status === "completed" && failedOrBlocked.size > 0) status = "failed";
	const execution = createContextLineageExecutionRecord({
		planId: contextLineagePlanIdentity(plan),
		checkpointId: request.checkpoint.checkpointId,
		status,
		outputs,
		runId,
		originLeafId: request.originLeafId,
	});
	const executionEntryId = appendContextLineageSessionRecord(request.journal, execution);
	lineageEvent("plan_compiled", {
		run_id: runId,
		plan_id: contextLineagePlanIdentity(plan),
		checkpoint_id: request.checkpoint.checkpointId,
		status,
		completed_stage_count: completed.size,
		blocked_stage_count: failedOrBlocked.size,
	});
	for (const observation of cacheObservations) {
		lineageEvent("prefix_observed", {
			run_id: runId,
			status: observation.status,
			read_tokens: observation.readTokens,
			write_tokens: observation.writeTokens,
		});
	}
	return {
		status,
		executionId: execution.executionId,
		executionEntryId,
		runId,
		cacheObservations,
	};
}

export function createContextLineageRunId(plan: ContextLineagePlan, checkpoint: LogicalContextCheckpoint): string {
	return semanticIdentity("context-lineage-run", {
		planId: contextLineagePlanIdentity(plan),
		checkpointId: checkpoint.checkpointId,
		startedAt: Date.now(),
	});
}

/**
 * §20.1 milestone events are emitted through `telemetry.ts` so every surface
 * shares one boundary: opaque identifiers and counts — never raw prompts,
 * assignments, answers, credentials, or unscoped hashes.
 */

/** Collect fulfilled task outputs of one stage into the run output set. */
function pushStageOutputs(
	stage: PlanStage,
	settled: {
		results: (PromiseSettledResult<{ task: PlanTask; result: ContextLineageTaskExecutionResult }> | undefined)[];
	},
	outputs: ContextLineageExecutionOutput[],
): void {
	for (const result of settled.results) {
		if (result?.status !== "fulfilled") continue;
		const observation = executionObservation(result.value.result);
		outputs.push({
			stageId: stage.id,
			taskId: result.value.task.id,
			...(result.value.task.output ? { outputName: result.value.task.output.name } : {}),
			contentDigest: result.value.result.contentDigest,
			artifactRef: result.value.result.artifactRef,
			...(result.value.result.cacheObservation ? { cacheStatus: result.value.result.cacheObservation.status } : {}),
			...(observation ? { executionObservation: observation } : {}),
		});
	}
}

/** Keep physical provider measurements durable without retaining provider request identifiers or bytes. */
function executionObservation(result: ContextLineageTaskExecutionResult): ContextLineageExecutionObservation | undefined {
	if (result.elapsedMs === undefined || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) return undefined;
	const cacheTokens = result.cacheObservation
		? {
				...(result.cacheObservation.readTokens === undefined ? {} : { readTokens: result.cacheObservation.readTokens }),
				...(result.cacheObservation.writeTokens === undefined ? {} : { writeTokens: result.cacheObservation.writeTokens }),
				...(result.cacheObservation.uncachedInputTokens === undefined
					? {}
					: { uncachedInputTokens: result.cacheObservation.uncachedInputTokens }),
			}
		: undefined;
	return {
		elapsedMs: result.elapsedMs,
		...(result.usage ? { usage: result.usage } : {}),
		...(cacheTokens && Object.keys(cacheTokens).length > 0 ? { cacheTokens } : {}),
	};
}

/**
 * Rewrite named_base plan sources into concrete checkpoint sources using the
 * latest active session records (PR 9). Unresolvable names are left untouched
 * so validation reports them instead of silently substituting a base.
 */
export function resolvePlanNamedBases(
	plan: ContextLineagePlan,
	records: readonly ContextLineageSessionRecord[],
): ContextLineagePlan {
	const latestByName = new Map<string, string>();
	for (const record of records) {
		if (record.kind === "named_base" && record.status === "active") {
			latestByName.set(record.name, record.checkpointId);
		}
	}
	let changed = false;
	const bases = plan.bases.map(base => {
		if (base.source.type !== "named_base" || !latestByName.has(base.source.name)) return base;
		changed = true;
		return {
			...base,
			source: { type: "checkpoint" as const, checkpointId: latestByName.get(base.source.name)! },
		};
	});
	return changed ? { ...plan, bases } : plan;
}

/**
 * PR 4/5 headless task runner: dispatches each task as a no-tools side
 * request through the session's ephemeral turn boundary and persists the raw
 * answer to the artifact store. The parent context is never touched; only
 * the digest and artifact reference travel through lineage records.
 */
export interface SideRequestRunnerSession {
	runEphemeralTurn(args: {
		readonly promptText: string;
		readonly signal?: AbortSignal;
	}): Promise<{
		readonly replyText: string;
		/** Token/cost accounting from the finalized provider response, never an estimate. */
		readonly usage?: ContextLineageSideRequestUsage;
	}>;
}

/** Finalized provider accounting available to bounded adaptive continuation. */
export interface ContextLineageSideRequestUsage {
	readonly totalTokens: number;
	readonly costUsd: number;
}

function observedSideRequestUsage(reply: { readonly usage?: ContextLineageSideRequestUsage }):
	| { readonly usage: ContextLineageSideRequestUsage }
	| Record<string, never> {
	if (!reply.usage || reply.usage.totalTokens <= 0) return {};
	return { usage: reply.usage };
}

export function createSideRequestContextLineageTaskRunner(input: {
	readonly session: SideRequestRunnerSession;
	/** Persists raw answer bytes and returns an `artifact://<id>` reference. */
	readonly saveArtifact: (content: string) => Promise<string>;
	readonly signal?: AbortSignal;
}): ContextLineageTaskRunner {
	return {
		async run(request) {
			const promptText = prompt.render(sideRequestPrompt, {
				repositoryManifest: renderRepositoryContextManifest(request.manifest),
				assignment: request.task.assignment,
				priorOutputs: request.priorOutputs,
			});
			const signal = input.signal ? AbortSignal.any([input.signal, request.signal]) : request.signal;
			const startedAt = performance.now();
			const reply = await input.session.runEphemeralTurn({ promptText, signal });
			const contentDigest = semanticIdentity("context-lineage-output", reply.replyText);
			const artifactRef = await input.saveArtifact(reply.replyText);
			return { contentDigest, artifactRef, elapsedMs: Math.round(performance.now() - startedAt), ...observedSideRequestUsage(reply) };
		},
	};
}

/**
 * PR10 candidate execution uses the same isolated no-tools boundary as plan
 * tasks, but makes every intended variant explicit in a static prompt
 * template. Candidate output is persisted only as a sidecar artifact.
 */
export function createCandidateContextLineageTaskRunner(input: {
	readonly session: SideRequestRunnerSession;
	readonly saveArtifact: (content: string) => Promise<string>;
	readonly signal?: AbortSignal;
}): {
	run(request: {
		readonly assignment: string;
		readonly variation: readonly ContextLineageCandidateVariation[];
		readonly structuredOutcomeCase?: {
			readonly outcomeCaseId: string;
			readonly requiredObligationIds: readonly string[];
			readonly forbiddenObligationIds: readonly string[];
		};
		readonly signal?: AbortSignal;
	}): Promise<ContextLineageTaskExecutionResult>;
} {
	return {
		async run(request) {
			const promptText = request.structuredOutcomeCase
				? prompt.render(candidateStructuredOutcomeSideRequestPrompt, {
					outcomeCaseId: request.structuredOutcomeCase.outcomeCaseId,
					requiredObligationIds: request.structuredOutcomeCase.requiredObligationIds,
					forbiddenObligationIds: request.structuredOutcomeCase.forbiddenObligationIds,
					variation: request.variation,
				})
				: prompt.render(candidateSideRequestPrompt, {
					assignment: request.assignment,
					variation: request.variation,
				});
			const signal = input.signal
				? request.signal
					? AbortSignal.any([input.signal, request.signal])
					: input.signal
				: request.signal;
			const startedAt = performance.now();
			const reply = await input.session.runEphemeralTurn({ promptText, ...(signal ? { signal } : {}) });
			const contentDigest = semanticIdentity("context-lineage-output", reply.replyText);
			const artifactRef = await input.saveArtifact(reply.replyText);
			return { contentDigest, artifactRef, elapsedMs: Math.round(performance.now() - startedAt), ...observedSideRequestUsage(reply) };
		},
	};
}

/**
 * Runs one clean-room candidate review. The caller supplies precisely one
 * candidate artifact and one rubric artifact; no sibling content, IDs, tools,
 * workspace access, or session history are exposed to the reviewer turn.
 */
export function createBlindedCandidateContextLineageReviewer(input: {
	readonly session: SideRequestRunnerSession;
	readonly saveArtifact: (content: string) => Promise<string>;
	readonly signal?: AbortSignal;
}): {
	run(request: {
		readonly candidateContent: string;
		readonly rubricContent: string;
		readonly signal?: AbortSignal;
	}): Promise<ContextLineageTaskExecutionResult>;
} {
	return {
		async run(request) {
			const promptText = prompt.render(candidateReviewPrompt, {
				candidateContent: request.candidateContent,
				rubricContent: request.rubricContent,
			});
			const signal = input.signal
				? request.signal
					? AbortSignal.any([input.signal, request.signal])
					: input.signal
				: request.signal;
			const startedAt = performance.now();
			const reply = await input.session.runEphemeralTurn({ promptText, ...(signal ? { signal } : {}) });
			const contentDigest = semanticIdentity("context-lineage-output", reply.replyText);
			const artifactRef = await input.saveArtifact(reply.replyText);
			return { contentDigest, artifactRef, elapsedMs: Math.round(performance.now() - startedAt), ...observedSideRequestUsage(reply) };
		},
	};
}

/**
 * Adjudicates an explicit review set. Review content is supplied in declared
 * order; withheld reviews and candidate identities are never rendered.
 */
export function createContextLineageCandidateAdjudicator(input: {
	readonly session: SideRequestRunnerSession;
	readonly saveArtifact: (content: string) => Promise<string>;
	readonly signal?: AbortSignal;
}): {
	run(request: {
		readonly rubricContent: string;
		readonly reviewContents: readonly string[];
		readonly signal?: AbortSignal;
	}): Promise<ContextLineageTaskExecutionResult>;
} {
	return {
		async run(request) {
			if (request.reviewContents.length < 2) throw new Error("Candidate adjudication requires at least two authorized reviews");
			const promptText = prompt.render(candidateAdjudicationPrompt, {
				rubricContent: request.rubricContent,
				reviewContents: request.reviewContents,
			});
			const signal = input.signal
				? request.signal
					? AbortSignal.any([input.signal, request.signal])
					: input.signal
				: request.signal;
			const startedAt = performance.now();
			const reply = await input.session.runEphemeralTurn({ promptText, ...(signal ? { signal } : {}) });
			const contentDigest = semanticIdentity("context-lineage-output", reply.replyText);
			const artifactRef = await input.saveArtifact(reply.replyText);
			return { contentDigest, artifactRef, elapsedMs: Math.round(performance.now() - startedAt), ...observedSideRequestUsage(reply) };
		},
	};
}

/**
 * NFR4/FR24: durable per-stage progress lets a restarted run skip this stage.
 * The flush is awaited before the next stage starts, so a crash between stages
 * always leaves the completed stage recoverable on disk.
 */
async function appendStageProgressRecord(
	request: ExecuteContextLineagePlanRequest,
	planId: string,
	stageId: string,
	outputs: readonly ContextLineageExecutionOutput[],
	runId: string,
): Promise<void> {
	lineageEvent("stage_completed", {
		run_id: runId,
		plan_id: planId,
		stage_id: stageId,
		output_count: outputs.filter(output => output.stageId === stageId).length,
	});
	appendContextLineageSessionRecord(request.journal, {
		...createContextLineageExecutionRecord({
			planId,
			checkpointId: request.checkpoint.checkpointId,
			status: "completed",
			outputs: outputs.filter(output => output.stageId === stageId),
			runId,
			stageId,
		}),
	});
	await request.journal.ensureOnDisk?.();
}

/** Collect the immutable upstream outputs a synthesis stage reduces over. */
function selectSynthesisInputs(
	stage: SynthesisPlanStage,
	outputs: readonly ContextLineageExecutionOutput[],
): readonly ContextLineagePriorOutput[] {
	const selected: ContextLineagePriorOutput[] = [];
	for (const selector of stage.inputs) {
		const candidates = outputs.filter(
			output =>
				output.stageId === selector.stageId &&
				output.outputName !== undefined &&
				(selector.taskIds === undefined || selector.taskIds.includes(output.taskId)),
		);
		selected.push(
			...candidates.map(output => ({
				stageId: output.stageId,
				taskId: output.taskId,
				outputName: output.outputName!,
				contentDigest: output.contentDigest,
				artifactRef: output.artifactRef,
			})),
		);
	}
	if (selected.length === 0) {
		throw new Error(`Context Lineage synthesis stage ${stage.id} has no available inputs`);
	}
	return selected;
}

function selectStageInputs(
	stage: PlanStage,
	outputs: readonly {
		stageId: string;
		taskId: string;
		outputName?: string;
		contentDigest: string;
		artifactRef: string;
	}[],
): readonly ContextLineagePriorOutput[] {
	if (stage.mode === "synthesis") return [];
	if (stage.base.type === "base") return [];
	return stage.base.inputs.map(input => {
		const output = outputs.find(
			candidate => candidate.stageId === input.stageId && candidate.outputName === input.output,
		);
		if (!output?.artifactRef || !output.outputName) {
			throw new Error(`Context Lineage extension input is unavailable: ${input.stageId}.${input.output}`);
		}
		return {
			stageId: output.stageId,
			taskId: output.taskId,
			outputName: output.outputName,
			contentDigest: output.contentDigest,
			artifactRef: output.artifactRef,
		};
	});
}

export function artifactIdFromRef(artifactRef: string): string | undefined {
	const match = /^artifact:\/\/(\d+)$/.exec(artifactRef);
	return match?.[1];
}
