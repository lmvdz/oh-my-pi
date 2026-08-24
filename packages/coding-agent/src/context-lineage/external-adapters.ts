import * as git from "../utils/git";
import {
	collectGraphifyEvidence,
	GRAPHIFY_EVIDENCE_ADAPTER,
	GRAPHIFY_GRAPH_CANDIDATES,
	parseGraphifyGraph,
} from "./graphify";
import { repositoryManifestIdentity, semanticIdentity } from "./identity";
import { collectScipEvidence, discoverScipIndex, parseScipIndex, SCIP_EVIDENCE_ADAPTER } from "./scip";
import { lineageEvent } from "./telemetry";
import type {
	RepositoryContextManifest,
	RepositoryEvidenceAdapter,
	RepositoryEvidenceRef,
	RepositoryManifestDegradedSource,
	RepositorySnapshot,
} from "./types";

/**
 * §25.5 evidence-adapter modes. `off` never discovers or invokes the adapter;
 * `observe` normalizes and reports candidates without adding them to the plan
 * base; `enabled` allows bounded evidence into the manifest; `auto` (SCIP
 * only) consumes a compatible local artifact when present and otherwise
 * degrades to `observe`'s unavailable outcome. No mode installs, generates,
 * or contacts anything (PR 3A / FR55).
 */
export type ExternalAdapterMode = "off" | "observe" | "enabled";
export type ScipExternalAdapterMode = ExternalAdapterMode | "auto";

export interface ExternalAdapterPolicy {
	/** Graphify `graph.json` adapter; default off (§25.5). */
	readonly graphify?: ExternalAdapterMode;
	/** SCIP/local-index adapter; default auto (consume an existing index when present). */
	readonly scip?: ScipExternalAdapterMode;
	/** Reject artifacts whose source boundary does not match the frozen snapshot (FR56). */
	readonly requireSnapshotMatch?: boolean;
	/** Total adapter-derived items allowed into one manifest under identical budgets. */
	readonly maxAdapterEvidenceItems?: number;
}

export type CollectedExternalAdapterStatus = "included" | "observed" | "rejected" | "unavailable" | "failed";

export interface CollectedExternalEvidence {
	readonly adapterId: string;
	readonly adapterSchemaVersion: string;
	readonly mode: ExternalAdapterMode;
	readonly status: CollectedExternalAdapterStatus;
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly degradedSources: readonly RepositoryManifestDegradedSource[];
	readonly rejectedCount: number;
	readonly artifactDigest?: string;
	readonly detail: string;
}

const DEFAULT_MAX_ADAPTER_EVIDENCE = 8;

/**
 * Discover, read, normalize, and report external evidence under the declared
 * policy. Every failure is contained into an explicit degraded state (NFR16);
 * no path here can throw out of the function.
 */
export async function collectExternalAdapterEvidence(input: {
	readonly repositoryRoot: string;
	readonly snapshot: RepositorySnapshot;
	readonly trackedPaths?: ReadonlySet<string>;
	readonly policy: ExternalAdapterPolicy;
	readonly signal?: AbortSignal;
}): Promise<readonly CollectedExternalEvidence[]> {
	const graphifyMode = input.policy.graphify ?? "off";
	const scipRequestedMode = input.policy.scip ?? "auto";
	const requireSnapshotMatch = input.policy.requireSnapshotMatch ?? true;
	const maxItems = Math.max(0, input.policy.maxAdapterEvidenceItems ?? DEFAULT_MAX_ADAPTER_EVIDENCE);
	if (graphifyMode === "off" && scipRequestedMode === "off") return [];
	const collections: CollectedExternalEvidence[] = [];

	if (graphifyMode !== "off") {
		collections.push(
			await collectGraphify(input.repositoryRoot, input.snapshot, graphifyMode, requireSnapshotMatch, maxItems),
		);
	}
	if (scipRequestedMode !== "off") {
		let trackedPaths = input.trackedPaths;
		if (!trackedPaths) {
			try {
				trackedPaths = new Set(await git.ls.files(input.repositoryRoot, { signal: input.signal }));
			} catch {
				trackedPaths = new Set();
			}
		}
		collections.push(
			await collectScip(
				input.repositoryRoot,
				scipRequestedMode,
				requireSnapshotMatch,
				maxItems,
				trackedPaths,
				input.snapshot,
			),
		);
	}
	return collections;
}

async function collectGraphify(
	repositoryRoot: string,
	snapshot: RepositorySnapshot,
	mode: ExternalAdapterMode,
	requireSnapshotMatch: boolean,
	maxItems: number,
): Promise<CollectedExternalEvidence> {
	lineageEvent("evidence_adapter_started", { adapter_id: GRAPHIFY_EVIDENCE_ADAPTER.adapterId, mode });
	for (const candidatePath of GRAPHIFY_GRAPH_CANDIDATES) {
		const artifactPath = `${repositoryRoot}/${candidatePath}`;
		try {
			const file = Bun.file(artifactPath);
			if (!(await file.exists())) continue;
			const bytes = await file.bytes();
			const parsed = parseGraphifyGraph(bytes);
			const collected = collectGraphifyEvidence({ parsed, snapshot, requireSnapshotMatch, maxEdges: maxItems });
			const status = collectionStatus(mode, collected.degradedSources);
			return finalizeCollection(GRAPHIFY_EVIDENCE_ADAPTER, mode, status, collected, `graph at ${candidatePath}`);
		} catch (error) {
			return failedCollection(GRAPHIFY_EVIDENCE_ADAPTER, mode, error);
		}
	}
	return finalizeUnavailable(
		GRAPHIFY_EVIDENCE_ADAPTER,
		mode,
		`no graphify artifact found (${GRAPHIFY_GRAPH_CANDIDATES.join(", ")})`,
	);
}

async function collectScip(
	repositoryRoot: string,
	requestedMode: "observe" | "enabled" | "auto",
	requireSnapshotMatch: boolean,
	maxItems: number,
	trackedPaths: ReadonlySet<string>,
	snapshot: RepositorySnapshot,
): Promise<CollectedExternalEvidence> {
	// `auto` behaves like `enabled` when a compatible local artifact exists;
	// absence degrades explicitly instead of failing planning (§25.5).
	const mode: ExternalAdapterMode = requestedMode === "observe" ? "observe" : "enabled";
	lineageEvent("evidence_adapter_started", { adapter_id: SCIP_EVIDENCE_ADAPTER.adapterId, mode: requestedMode });
	try {
		const indexPath = await discoverScipIndex(repositoryRoot);
		if (!indexPath) {
			return finalizeUnavailable(SCIP_EVIDENCE_ADAPTER, mode, "no local SCIP index found");
		}
		const bytes = new Uint8Array(await Bun.file(indexPath).arrayBuffer());
		const parsed = parseScipIndex(bytes);
		const collected = collectScipEvidence({
			parsed,
			snapshot,
			trackedPaths,
			requireSnapshotMatch,
			maxDocuments: maxItems,
		});
		const status = collectionStatus(mode, collected.degradedSources);
		return finalizeCollection(SCIP_EVIDENCE_ADAPTER, mode, status, collected, `index at ${indexPath}`);
	} catch (error) {
		return failedCollection(SCIP_EVIDENCE_ADAPTER, mode, error);
	}
}

/**
 * §25.5 outcome mapping: enabled adapters that pass the boundary contribute
 * evidence (`included`); observe-mode runs only report candidates
 * (`observed`); snapshot-mismatched artifacts are `rejected` (FR56).
 */
function collectionStatus(
	mode: ExternalAdapterMode,
	degradedSources: readonly RepositoryManifestDegradedSource[],
): CollectedExternalAdapterStatus {
	if (degradedSources.some(source => source.reason === "unsupported")) return "rejected";
	return mode === "enabled" ? "included" : "observed";
}

interface AdapterCollectorResult {
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly degradedSources: readonly RepositoryManifestDegradedSource[];
	readonly rejectedCount?: number;
	readonly artifactDigest?: string;
}

function finalizeCollection(
	adapter: RepositoryEvidenceAdapter,
	mode: ExternalAdapterMode,
	status: CollectedExternalAdapterStatus,
	result: AdapterCollectorResult,
	detail: string,
): CollectedExternalEvidence {
	const collection: CollectedExternalEvidence = {
		adapterId: adapter.adapterId,
		adapterSchemaVersion: adapter.adapterSchemaVersion,
		mode,
		status,
		evidence: result.evidence,
		degradedSources: result.degradedSources,
		rejectedCount: result.rejectedCount ?? 0,
		...(result.artifactDigest ? { artifactDigest: result.artifactDigest } : {}),
		detail,
	};
	emitCompletionEvents(collection);
	return collection;
}

function finalizeUnavailable(
	adapter: RepositoryEvidenceAdapter,
	mode: ExternalAdapterMode,
	detail: string,
): CollectedExternalEvidence {
	const collection: CollectedExternalEvidence = {
		adapterId: adapter.adapterId,
		adapterSchemaVersion: adapter.adapterSchemaVersion,
		mode,
		status: "unavailable",
		evidence: [],
		degradedSources: [{ extractorId: adapter.adapterId, reason: "unavailable", detail }],
		rejectedCount: 0,
		detail,
	};
	emitCompletionEvents(collection);
	return collection;
}

function failedCollection(
	adapter: RepositoryEvidenceAdapter,
	mode: ExternalAdapterMode,
	error: unknown,
): CollectedExternalEvidence {
	const detail = String(error instanceof Error ? error.message : error);
	const collection: CollectedExternalEvidence = {
		adapterId: adapter.adapterId,
		adapterSchemaVersion: adapter.adapterSchemaVersion,
		mode,
		status: "failed",
		evidence: [],
		degradedSources: [{ extractorId: adapter.adapterId, reason: "failed", detail }],
		rejectedCount: 0,
		detail,
	};
	emitCompletionEvents(collection);
	return collection;
}

/** §20.1 milestone telemetry for adapter outcomes; opaque ids and counts only. */
function emitCompletionEvents(collection: CollectedExternalEvidence): void {
	lineageEvent("evidence_adapter_completed", {
		adapter_id: collection.adapterId,
		status: collection.status,
		evidence_count: collection.evidence.length,
		rejected_count: collection.rejectedCount,
	});
	for (const degraded of collection.degradedSources) {
		lineageEvent("evidence_adapter_degraded", {
			adapter_id: collection.adapterId,
			reason: degraded.reason,
			detail: degraded.detail,
		});
	}
	if (collection.status === "rejected") {
		lineageEvent("evidence_adapter_rejected", { adapter_id: collection.adapterId, detail: collection.detail });
	}
}

/**
 * Fold included adapter evidence into a manifest under its own bounded cap.
 * Observed/rejected/unavailable/failed collections never change the base.
 * The merged retrieval policy records which adapter versions contributed so
 * adapter upgrades explicitly version downstream manifests (R34).
 */
export function mergeExternalEvidence(
	manifest: RepositoryContextManifest,
	collected: readonly CollectedExternalEvidence[],
	maxAdapterEvidenceItems: number,
): RepositoryContextManifest {
	const included = collected.filter(candidate => candidate.status === "included");
	if (included.length === 0) return manifest;
	const sortedEvidence = included
		.flatMap(collection => collection.evidence)
		.sort(compareBySourceRefThenId)
		.slice(0, maxAdapterEvidenceItems);
	const truncated = included.flatMap(collection => collection.evidence).length > maxAdapterEvidenceItems;
	const base = {
		version: 1 as const,
		manifestId: "",
		snapshot: manifest.snapshot,
		taskDigest: manifest.taskDigest,
		retrievalPolicyId: semanticIdentity("merged-retrieval-policy", {
			current: manifest.retrievalPolicyId,
			adapters: included.map(collection => ({
				id: collection.adapterId,
				schema: collection.adapterSchemaVersion,
				maxItems: maxAdapterEvidenceItems,
			})),
		}),
		contextRendererVersion: manifest.contextRendererVersion,
		evidence: [...manifest.evidence, ...sortedEvidence].sort(compareBySourceRefThenId),
		omissions: manifest.omissions,
		degradedSources: [
			...manifest.degradedSources,
			...included.flatMap(collection => collection.degradedSources),
			...(truncated
				? [
						{
							extractorId: "external-adapters",
							reason: "budget_limited" as const,
							detail: `adapter evidence limited to ${maxAdapterEvidenceItems} item(s)`,
						},
					]
				: []),
		].sort(compareDegraded),
	};
	return { ...base, manifestId: repositoryManifestIdentity(base) };
}

function compareBySourceRefThenId(left: RepositoryEvidenceRef, right: RepositoryEvidenceRef): number {
	return left.sourceRef.localeCompare(right.sourceRef) || left.evidenceId.localeCompare(right.evidenceId);
}

function compareDegraded(left: RepositoryManifestDegradedSource, right: RepositoryManifestDegradedSource): number {
	return left.extractorId.localeCompare(right.extractorId) || left.reason.localeCompare(right.reason);
}
