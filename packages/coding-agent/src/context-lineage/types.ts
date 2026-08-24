/** Immutable repository state selected for a Context Lineage manifest. */
export interface RepositorySnapshot {
	readonly version: 1;
	readonly repositoryId: string;
	readonly workspaceScopeId: string;
	readonly headCommit: string;
	readonly overlayDigest?: string;
	readonly untrackedPolicy: "exclude" | "include";
	/** Present when dirty-file hashing exceeded the retrieval policy's budget (NFR9). */
	readonly overlayTruncated?: { readonly limit: number; readonly observed: number };
}

export type RepositoryEvidenceClass =
	| "current_structural"
	| "current_workspace"
	| "maintained_decision"
	| "documentary_observation"
	| "historical_observation"
	| "statistical_relationship"
	| "model_inference";

export type RepositorySnapshotCoverage = "exact_with_overlay" | "head_only" | "unavailable";

export interface RepositoryBitemporalProvenance {
	readonly observedAt?: number;
	readonly validFrom?: string;
	readonly validUntil?: string;
}

export type RepositoryEvidenceStaleness =
	| { readonly state: "fresh" }
	| { readonly state: "stale"; readonly detail: string }
	| { readonly state: "unknown"; readonly detail: string };

/** Versioned extractor declaration; adapters propose evidence but never render or authorize plans. */
export interface RepositoryEvidenceAdapter {
	readonly version: 1;
	readonly adapterId: string;
	readonly adapterSchemaVersion: string;
	readonly sourceKinds: readonly string[];
	readonly sourceAuthority: "current" | "corroborating" | "documentary" | "candidate";
	readonly determinism: "deterministic" | "resolved" | "statistical" | "model_derived";
	readonly snapshotCoverage: RepositorySnapshotCoverage;
	readonly evidenceClasses: readonly RepositoryEvidenceClass[];
	readonly bitemporalProvenance: "supported" | "not_supported";
	readonly staleness: RepositoryEvidenceStaleness;
	readonly degradedState?: RepositoryManifestDegradedSource;
}

export interface RepositoryEvidenceRef {
	readonly evidenceId: string;
	readonly evidenceClass: RepositoryEvidenceClass;
	readonly sourceKind: string;
	readonly sourceRef: string;
	readonly sourceVersion: string;
	readonly adapterId: string;
	readonly adapterSchemaVersion: string;
	readonly determinism: "deterministic" | "resolved" | "statistical" | "model_derived";
	readonly authority: "current" | "corroborating" | "documentary" | "candidate";
	readonly extractionMethod: string;
	readonly inclusionReason: string;
	readonly snapshotCoverage?: RepositorySnapshotCoverage;
	readonly bitemporalProvenance?: RepositoryBitemporalProvenance;
	readonly staleness?: RepositoryEvidenceStaleness;
	readonly sourceDigest?: string;
	/** Frozen source material rendered into the manifest, when this evidence is source-backed. */
	readonly excerpt?: RepositoryEvidenceExcerpt;
}

/** A bounded source excerpt captured at manifest compilation time. */
export interface RepositoryEvidenceExcerpt {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly content?: string;
	readonly contentDigest: string;
	readonly sourceBytes: number;
	readonly truncated: boolean;
}

/** A candidate deliberately excluded from a manifest, with its consumer-visible reason. */
export interface RepositoryManifestOmission {
	readonly sourceRef: string;
	readonly reason: "budget" | "binary" | "not_selected" | "unreadable";
	readonly detail: string;
}

/** An extractor that was unavailable or intentionally not used for this manifest. */
export interface RepositoryManifestDegradedSource {
	readonly extractorId: string;
	readonly reason: "disabled" | "unavailable" | "unsupported" | "failed" | "budget_limited";
	readonly detail: string;
}

export interface RepositoryContextManifest {
	readonly version: 1;
	readonly manifestId: string;
	readonly snapshot: RepositorySnapshot;
	readonly taskDigest: string;
	readonly retrievalPolicyId: string;
	readonly contextRendererVersion: string;
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly omissions: readonly RepositoryManifestOmission[];
	readonly degradedSources: readonly RepositoryManifestDegradedSource[];
}

/** Durable context identity, intentionally distinct from provider cache state. */
export interface LogicalContextCheckpoint {
	readonly version: 1;
	readonly checkpointId: string;
	readonly origin: "current_checkpoint" | "repository_manifest" | "checkpoint_extension";
	readonly materialization: "session" | "repository_manifest" | "selected_outputs";
	readonly securityScopeId: string;
	readonly workspaceScopeId?: string;
	readonly contentRootHash: string;
	readonly repositoryManifestId?: string;
	readonly createdAt: number;
}

/** Target-specific rendering record. Its cache routing key is deliberately absent. */
export interface PreparedPrefix {
	readonly version: 1;
	readonly preparedPrefixId: string;
	readonly checkpointId: string;
	readonly target: { readonly provider: string; readonly model: string };
	readonly rendererContractVersion: string;
	readonly providerContextDigest: string;
	readonly encodedPrefixDigest?: string;
	readonly expectedSharedBytes: number;
	readonly expectedSharedTokens?: number;
	readonly compatibilityProfileVersion: string;
	readonly createdAt: number;
}

export type PlanBaseSource =
	| { readonly type: "current_checkpoint"; readonly leafId?: string }
	| { readonly type: "checkpoint"; readonly checkpointId: string }
	| { readonly type: "repository_manifest"; readonly manifestId: string }
	/** Resolved against session named-base records before validation (PR 9). */
	| { readonly type: "named_base"; readonly name: string };

export interface PlanBase {
	readonly id: string;
	readonly source: PlanBaseSource;
}

export interface PlanEvidenceReference {
	readonly manifestId: string;
	readonly evidenceId: string;
	readonly purpose: "scope" | "constraint" | "dependency" | "rationale" | "verification";
}

export interface PlanUnresolvedAssumption {
	readonly id: string;
	readonly statement: string;
	readonly requiredInspection: string;
}

export interface PlanTask {
	readonly id: string;
	readonly assignment: string;
	readonly evidence?: readonly PlanEvidenceReference[];
	readonly unresolvedAssumptions?: readonly PlanUnresolvedAssumption[];
	readonly output?: { readonly name: string; readonly format: "text" | "markdown" | "json" };
}

export type PlanContextExpression =
	| { readonly type: "base"; readonly baseId: string }
	| {
			readonly type: "extension";
			readonly baseId: string;
			readonly inputs: readonly PlanOutputReference[];
	  };

export interface PlanOutputReference {
	readonly stageId: string;
	readonly output: string;
}

export interface PlanStageBase {
	readonly id: string;
	readonly dependsOn?: readonly string[];
	readonly capabilityRequirements?: PlanCapabilityRequirements;
}

export interface PlanCapabilityRequirements {
	readonly tools?: readonly string[];
	readonly workspaceMode?: "none" | "live_read_only" | "frozen_read_only" | "isolated_write";
	readonly securityScope?: string;
}

export interface FanoutPlanStage extends PlanStageBase {
	readonly mode: "fanout";
	readonly base: PlanContextExpression;
	readonly tasks: readonly PlanTask[];
}

export interface SinglePlanStage extends PlanStageBase {
	readonly mode: "single";
	readonly base: PlanContextExpression;
	readonly task: PlanTask;
}

export interface SynthesisPlanStage extends PlanStageBase {
	readonly mode: "synthesis";
	/** Result selectors consumed by this reducer; each input stage must be a dependency. */
	readonly inputs: readonly PlanResultSelector[];
	readonly instructions?: string;
	/** Output name produced for downstream extension bases. */
	readonly output: string;
}

export type PlanStage = FanoutPlanStage | SinglePlanStage | SynthesisPlanStage;

export interface PlanResultSelector {
	readonly stageId: string;
	/** Restrict the selection to these task ids; absent selects every successful output. */
	readonly taskIds?: readonly string[];
	readonly selection?: "successful" | "explicit";
}

/** Task list of any stage; synthesis stages contribute no leaf tasks. */
export function stageTasks(stage: PlanStage): readonly PlanTask[] {
	return stage.mode === "fanout" ? stage.tasks : stage.mode === "single" ? [stage.task] : [];
}

/** Base id of any base-rooted stage; synthesis stages have none. */
export function stageBaseId(stage: PlanStage): string | undefined {
	return stage.mode === "synthesis" ? undefined : stage.base.baseId;
}

export interface ContextLineagePlan {
	readonly version: 1;
	readonly title: string;
	readonly bases: readonly PlanBase[];
	readonly stages: readonly PlanStage[];
	/** Execution hints; the failure policy changes how stage/task failures propagate. */
	readonly defaults?: PlanExecutionDefaults;
	/** Excluded from semantic identity. */
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface PlanExecutionDefaults {
	readonly concurrency?: number;
	readonly failurePolicy?: PlanFailurePolicy;
}

export type PlanFailurePolicy = "continue_independent" | "stop_dependents" | "stop_plan";

/** Compact user-facing request that lowers into a one-stage lineage plan later. */
export interface FanoutRequest {
	readonly version: 1;
	readonly title?: string;
	readonly checkpoint:
		| { readonly type: "current_idle" }
		| { readonly type: "checkpoint"; readonly checkpointId: string }
		| { readonly type: "leaf"; readonly sessionId: string; readonly leafId: string };
	readonly questions: readonly FanoutQuestion[];
	readonly concurrency?: number;
	readonly resultPolicy?: "sidecar" | "persistent_branches";
	readonly cacheRequirement?: "best_effort" | "exact_prefix_or_baseline" | "exact_prefix_only";
}

export interface FanoutQuestion {
	readonly id?: string;
	readonly title?: string;
	readonly question: string;
}

/** Read-only tracker snapshot used by Campaign's Wayfinder work graph. */
export interface WayfinderIssueReference {
	readonly tracker: "github";
	readonly repository: string;
	readonly number: number;
	readonly url: string;
	readonly title: string;
	readonly state: "open" | "closed";
	readonly labels: readonly string[];
	/** Digest of fetched issue content; raw documentary text stays in a local tracker cache or artifact. */
	readonly bodyDigest?: string;
	readonly updatedAt?: string;
}

/** A read-only bridge between Campaign's goal/issue graph and a frozen planning base. */
export interface WayfinderContextLineageBinding {
	readonly version: 1;
	readonly bindingId: string;
	readonly goalDigest: string;
	readonly mapIssue: WayfinderIssueReference;
	readonly ticketIssue: WayfinderIssueReference;
	readonly manifestId: string;
	readonly checkpointId: string;
}
