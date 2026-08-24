import * as git from "../utils/git";
import { repositoryManifestIdentity, repositorySnapshotIdentity, semanticIdentity } from "./identity";
import type {
	RepositoryContextManifest,
	RepositoryEvidenceAdapter,
	RepositoryEvidenceRef,
	RepositoryManifestDegradedSource,
	RepositorySnapshot,
} from "./types";

/**
 * Native Git temporal adapter (PR 9A slice): bounded churn and rename lineage
 * derived from commit history. It proposes attributed historical/statistical
 * evidence only; current structural truth always comes from the frozen
 * snapshot (FR48/FR49), and missing or shallow history degrades explicitly
 * instead of failing planning (FR50).
 */
export const NATIVE_TEMPORAL_ADAPTER: RepositoryEvidenceAdapter = {
	version: 1,
	adapterId: "native-git-temporal",
	adapterSchemaVersion: "v1",
	sourceKinds: ["git_history"],
	sourceAuthority: "corroborating",
	determinism: "statistical",
	snapshotCoverage: "exact_with_overlay",
	evidenceClasses: ["historical_observation", "statistical_relationship"],
	bitemporalProvenance: "supported",
	staleness: { state: "fresh" },
};

const DEFAULT_MAX_COMMITS_PER_PATH = 10;
const DEFAULT_MAX_PATHS = 8;
const DEFAULT_MAX_CO_CHANGES_PER_PATH = 3;

export type TemporalRetrievalProfile = "migration" | "regression" | "refactor" | "api_change";

/**
 * Deterministic task-sensitive profile selection. This only changes bounded
 * retrieval policy metadata; it never changes the authority of historical
 * evidence or turns Git observations into current repository facts.
 */
export function inferTemporalRetrievalProfile(task: string): TemporalRetrievalProfile {
	const normalized = task.toLowerCase();
	if (/\b(migrat|upgrade|deprecat|rollout|backfill)\w*/.test(normalized)) return "migration";
	if (/\b(regress|incident|bug|fix|failure|crash)\w*/.test(normalized)) return "regression";
	if (/\b(api|public interface|compatib|contract)\w*/.test(normalized)) return "api_change";
	return "refactor";
}

/** Versioned budget policy for bounded temporal traversal (FR47). */
export interface TemporalRetrievalPolicy {
	readonly id: string;
	readonly maxCommitsPerPath?: number;
	readonly maxPaths?: number;
	/** Bounded statistical neighbours per selected current-state path. */
	readonly maxCoChangesPerPath?: number;
	/** Records why this historical retrieval shape was selected. */
	readonly profile?: TemporalRetrievalProfile;
}

export function temporalRetrievalPolicyIdentity(policy: TemporalRetrievalPolicy): string {
	return semanticIdentity("temporal-retrieval-policy", {
		id: policy.id,
		maxCommitsPerPath: policy.maxCommitsPerPath ?? DEFAULT_MAX_COMMITS_PER_PATH,
		maxPaths: policy.maxPaths ?? DEFAULT_MAX_PATHS,
		maxCoChangesPerPath: policy.maxCoChangesPerPath ?? DEFAULT_MAX_CO_CHANGES_PER_PATH,
		profile: policy.profile ?? "refactor",
	});
}

export interface CollectTemporalEvidenceRequest {
	readonly repositoryRoot: string;
	readonly snapshot: RepositorySnapshot;
	/** Current-state source refs to enrich; examined in canonical order under the path budget. */
	readonly paths: readonly string[];
	readonly policy: TemporalRetrievalPolicy;
	readonly signal?: AbortSignal;
}

export interface CollectedTemporalEvidence {
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly degradedSources: readonly RepositoryManifestDegradedSource[];
	readonly policyId: string;
}

/**
 * Collect bounded churn and rename-lineage observations for the given paths.
 * Rename detection needs the full commit diff, so one bounded tree-history scan
 * is taken and rows are attributed to the examined paths.
 */
export async function collectTemporalEvidence(
	request: CollectTemporalEvidenceRequest,
): Promise<CollectedTemporalEvidence> {
	const maxCommits = request.policy.maxCommitsPerPath ?? DEFAULT_MAX_COMMITS_PER_PATH;
	const maxPaths = request.policy.maxPaths ?? DEFAULT_MAX_PATHS;
	const maxCoChanges = request.policy.maxCoChangesPerPath ?? DEFAULT_MAX_CO_CHANGES_PER_PATH;
	const sortedPaths = [...new Set(request.paths)].sort();
	const examined = sortedPaths.slice(0, maxPaths);
	const sourceVersion = repositorySnapshotIdentity(request.snapshot);
	const observedAt = Date.now();
	const scanLimit = Math.max(maxCommits, maxCommits * Math.max(examined.length, 1));
	let history: { commit: string; status: string; paths: string[] }[];
	try {
		history = await git.log.nameStatus(
			request.repositoryRoot,
			{ ref: request.snapshot.headCommit, limit: scanLimit },
			request.signal,
		);
	} catch {
		return {
			evidence: [],
			degradedSources: temporalDegraded("failed", "git history unavailable"),
			policyId: temporalRetrievalPolicyIdentity(request.policy),
		};
	}
	const evidence: RepositoryEvidenceRef[] = [];
	const historyByCommit = new Map<string, { commit: string; status: string; paths: string[] }[]>();
	for (const entry of history) {
		const entries = historyByCommit.get(entry.commit) ?? [];
		entries.push(entry);
		historyByCommit.set(entry.commit, entries);
	}
	for (const sourceRef of examined) {
		const rows = history.filter(entry => entry.paths.includes(sourceRef));
		const commits = new Set(rows.map(row => row.commit));
		if (commits.size === 0) continue;
		const renameLineage = [
			...new Set(
				rows
					.filter(row => row.status.startsWith("R") && row.paths.length >= 2)
					.map(row =>
						row.paths[1] === sourceRef
							? `${row.paths[0]} -> ${row.paths[1]}`
							: `${row.paths[1]} -> ${row.paths[0]}`,
					),
			),
		].sort();
		evidence.push({
			evidenceId: semanticIdentity("repository-temporal-evidence", {
				path: sourceRef,
				sourceVersion,
				commits: [...commits].sort(),
				renameLineage,
			}),
			evidenceClass: renameLineage.length > 0 ? "historical_observation" : "statistical_relationship",
			sourceKind: "git_history",
			sourceRef,
			sourceVersion,
			adapterId: NATIVE_TEMPORAL_ADAPTER.adapterId,
			adapterSchemaVersion: NATIVE_TEMPORAL_ADAPTER.adapterSchemaVersion,
			determinism: NATIVE_TEMPORAL_ADAPTER.determinism,
			authority: NATIVE_TEMPORAL_ADAPTER.sourceAuthority,
			extractionMethod: "bounded-git-history",
			inclusionReason:
				renameLineage.length > 0
					? `rename lineage: ${renameLineage.join("; ")}`
					: `churn across ${commits.size} commit(s)`,
			snapshotCoverage: NATIVE_TEMPORAL_ADAPTER.snapshotCoverage,
			bitemporalProvenance: { observedAt },
			staleness: { state: "fresh" },
		});
		const coChanges = new Map<string, Set<string>>();
		for (const row of rows) {
			for (const relatedPath of historyByCommit.get(row.commit)?.flatMap(entry => entry.paths) ?? []) {
				if (relatedPath === sourceRef) continue;
				const samples = coChanges.get(relatedPath) ?? new Set<string>();
				samples.add(row.commit);
				coChanges.set(relatedPath, samples);
			}
		}
		for (const [relatedPath, samples] of [...coChanges.entries()]
			.sort(([leftPath, leftSamples], [rightPath, rightSamples]) =>
				rightSamples.size - leftSamples.size || leftPath.localeCompare(rightPath),
			)
			.slice(0, maxCoChanges)) {
			const sampleCommits = [...samples].sort();
			evidence.push({
				evidenceId: semanticIdentity("repository-temporal-cochange", { sourceRef, relatedPath, sourceVersion, sampleCommits }),
				evidenceClass: "statistical_relationship",
				sourceKind: "git_cochange",
				sourceRef: `${sourceRef} <-> ${relatedPath}`,
				sourceVersion,
				adapterId: NATIVE_TEMPORAL_ADAPTER.adapterId,
				adapterSchemaVersion: NATIVE_TEMPORAL_ADAPTER.adapterSchemaVersion,
				determinism: "statistical",
				authority: "corroborating",
				extractionMethod: "bounded-git-cochange",
				inclusionReason: `co-change sample: ${sampleCommits.length} commit(s) (${sampleCommits.join(", ")})`,
				snapshotCoverage: NATIVE_TEMPORAL_ADAPTER.snapshotCoverage,
				bitemporalProvenance: { observedAt },
				staleness: { state: "fresh" },
			});
		}
	}
	return {
		evidence,
		degradedSources:
			sortedPaths.length > examined.length
				? temporalDegraded("budget_limited", `temporal scan limited to ${maxPaths} of ${sortedPaths.length} paths`)
				: [],
		policyId: temporalRetrievalPolicyIdentity(request.policy),
	};
}

function temporalDegraded(reason: "failed" | "budget_limited", detail: string): RepositoryManifestDegradedSource[] {
	return [{ extractorId: NATIVE_TEMPORAL_ADAPTER.adapterId, reason, detail }];
}

/** Rebuild a manifest with temporal evidence appended under its own bounded cap. */
export function mergeTemporalEvidence(
	manifest: RepositoryContextManifest,
	collected: CollectedTemporalEvidence,
	maxTemporalItems: number,
): RepositoryContextManifest {
	const base = {
		version: 1 as const,
		manifestId: "",
		snapshot: manifest.snapshot,
		taskDigest: manifest.taskDigest,
		retrievalPolicyId: semanticIdentity("merged-retrieval-policy", {
			current: manifest.retrievalPolicyId,
			temporal: collected.policyId,
			maxTemporalItems,
		}),
		contextRendererVersion: manifest.contextRendererVersion,
		evidence: [...manifest.evidence, ...collected.evidence.slice(0, maxTemporalItems)].sort(compareBySourceRef),
		omissions: manifest.omissions,
		degradedSources: [
			...manifest.degradedSources,
			...collected.degradedSources,
			...(collected.evidence.length > maxTemporalItems
				? temporalDegraded("budget_limited", `temporal evidence limited to ${maxTemporalItems} item(s)`)
				: []),
		].sort(compareDegraded),
	};
	return { ...base, manifestId: repositoryManifestIdentity(base) };
}

function compareBySourceRef(left: RepositoryEvidenceRef, right: RepositoryEvidenceRef): number {
	return left.sourceRef.localeCompare(right.sourceRef) || left.evidenceId.localeCompare(right.evidenceId);
}

function compareDegraded(left: RepositoryManifestDegradedSource, right: RepositoryManifestDegradedSource): number {
	return left.extractorId.localeCompare(right.extractorId) || left.reason.localeCompare(right.reason);
}
