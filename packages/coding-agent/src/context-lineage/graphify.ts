import { semanticIdentity } from "./identity";
import type {
	RepositoryEvidenceAdapter,
	RepositoryEvidenceRef,
	RepositoryManifestDegradedSource,
	RepositorySnapshot,
} from "./types";

/**
 * Read-only Graphify `graph.json` adapter (PR 3A / FR57 / §34.2). It consumes
 * an existing artifact; it never installs Python, rebuilds a graph, or renders
 * model context. Graphify proposes candidate evidence: `EXTRACTED` edges stay
 * candidate current-structural claims, while `INFERRED`/`AMBIGUOUS` edges can
 * only ever be statistical inspection scope (FR54).
 */
export const GRAPHIFY_EVIDENCE_ADAPTER: RepositoryEvidenceAdapter = {
	version: 1,
	adapterId: "graphify-graph",
	adapterSchemaVersion: "v1",
	sourceKinds: ["graphify_graph"],
	sourceAuthority: "candidate",
	determinism: "resolved",
	snapshotCoverage: "head_only",
	evidenceClasses: ["current_structural", "statistical_relationship"],
	bitemporalProvenance: "not_supported",
	staleness: { state: "fresh" },
};

/** Conventional artifact locations probed in discovery order (§34.2). */
export const GRAPHIFY_GRAPH_CANDIDATES: readonly string[] = ["graphify-out/graph.json", "graph.json"];

/** Confidence classes the adapter boundary accepts (§22.11). */
export type GraphifyConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface GraphifyEdge {
	readonly source: string;
	readonly target: string;
	readonly relation: string;
	readonly confidence: GraphifyConfidence;
	readonly location?: { readonly path?: string; readonly startLine?: number };
}

export interface GraphifyGraph {
	readonly schemaVersion: 1;
	readonly builtAtCommit?: string;
	readonly extractorVersion?: string;
	/** Node id -> repository-relative path, when the artifact declares one. */
	readonly nodePaths: ReadonlyMap<string, string>;
	readonly edges: readonly GraphifyEdge[];
}

export interface ParsedGraphifyGraph {
	readonly graph: GraphifyGraph;
	/** Digest of the raw artifact bytes, preserved on every normalized record. */
	readonly artifactDigest: string;
	/** Edges dropped at the boundary, e.g. for unknown confidence values. */
	readonly rejectedEdgeCount: number;
}

/**
 * Validate and normalize one existing `graph.json`. Unknown schema versions
 * fail at the boundary (R34); edges with unknown confidence values are
 * rejected instead of silently relabeled into a weaker class.
 */
export function parseGraphifyGraph(bytes: Uint8Array): ParsedGraphifyGraph {
	const artifactDigest = semanticIdentity("graphify-graph-bytes", bytes);
	let document: unknown;
	try {
		document = JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new Error(`graphify graph is not valid JSON: ${String(error)}`);
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) {
		throw new Error("graphify graph must be a JSON object");
	}
	const record = document as Record<string, unknown>;
	const schemaVersion = record.schemaVersion ?? record.version;
	if (schemaVersion !== 1 && schemaVersion !== "1") {
		throw new Error(`unsupported graphify graph schema version: ${JSON.stringify(schemaVersion ?? null)}`);
	}
	if (!Array.isArray(record.edges)) throw new Error("graphify graph requires an edges array");
	const nodePaths = new Map<string, string>();
	if (Array.isArray(record.nodes)) {
		for (const node of record.nodes) {
			if (typeof node !== "object" || node === null) continue;
			const nodeRecord = node as Record<string, unknown>;
			if (typeof nodeRecord.id === "string" && typeof nodeRecord.path === "string") {
				nodePaths.set(nodeRecord.id, normalizeRepositoryPath(nodeRecord.path));
			}
		}
	}
	const builtAtCommit = pickString(record.builtAtCommit) ?? pickString(record.built_at_commit);
	const extractorVersion = pickString(record.extractorVersion) ?? pickString(record.extractor_version);
	const edges: GraphifyEdge[] = [];
	let rejectedEdgeCount = 0;
	for (const rawEdge of record.edges) {
		if (typeof rawEdge !== "object" || rawEdge === null) continue;
		const edge = rawEdge as Record<string, unknown>;
		const source = pickString(edge.source);
		const target = pickString(edge.target);
		const confidence = pickString(edge.confidence ?? edge.confidenceClass);
		if (!source || !target) continue;
		if (confidence !== "EXTRACTED" && confidence !== "INFERRED" && confidence !== "AMBIGUOUS") {
			rejectedEdgeCount++;
			continue;
		}
		const relation = pickString(edge.relation) ?? pickString(edge.type) ?? "related";
		const locationRecord =
			typeof edge.location === "object" && edge.location !== null
				? (edge.location as Record<string, unknown>)
				: undefined;
		const locationPath = locationRecord ? pickString(locationRecord.path) : undefined;
		const startLine = locationRecord?.startLine;
		edges.push({
			source,
			target,
			relation,
			confidence,
			...(locationPath
				? {
						location: {
							path: locationPath,
							...(typeof startLine === "number" ? { startLine: Math.trunc(startLine) } : {}),
						},
					}
				: {}),
		});
	}
	return {
		graph: {
			schemaVersion: 1,
			...(builtAtCommit ? { builtAtCommit } : {}),
			...(extractorVersion ? { extractorVersion } : {}),
			nodePaths,
			edges,
		},
		artifactDigest,
		rejectedEdgeCount,
	};
}

export interface CollectedGraphifyEvidence {
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly degradedSources: readonly RepositoryManifestDegradedSource[];
	/** Edges rejected at the boundary or dropped for a missing repository anchor. */
	readonly rejectedCount: number;
	readonly artifactDigest: string;
}

/**
 * Normalize validated graph edges into bounded candidate evidence anchored at
 * repository paths. Canonical sorting before slicing keeps budget truncation
 * deterministic under nondeterministic producer ordering (§22.9).
 */
export function collectGraphifyEvidence(input: {
	readonly parsed: ParsedGraphifyGraph;
	readonly snapshot: RepositorySnapshot;
	/** Reject artifacts built for a different commit instead of staleness-labeling them (FR56). */
	readonly requireSnapshotMatch: boolean;
	readonly maxEdges: number;
}): CollectedGraphifyEvidence {
	const { parsed, snapshot, requireSnapshotMatch, maxEdges } = input;
	const sourceVersion = semanticIdentity("repository-snapshot-ref", snapshot);
	const mismatchDetail =
		parsed.graph.builtAtCommit === undefined
			? undefined
			: parsed.graph.builtAtCommit === snapshot.headCommit
				? undefined
				: `graph was built for commit ${parsed.graph.builtAtCommit}, not the frozen ${snapshot.headCommit}`;
	if (mismatchDetail && requireSnapshotMatch) {
		return {
			evidence: [],
			degradedSources: [
				{
					extractorId: GRAPHIFY_EVIDENCE_ADAPTER.adapterId,
					reason: "unsupported",
					detail: `${mismatchDetail} (requireSnapshotMatch)`,
				},
			],
			rejectedCount: parsed.graph.edges.length,
			artifactDigest: parsed.artifactDigest,
		};
	}
	const staleness: NonNullable<RepositoryEvidenceRef["staleness"]> = mismatchDetail
		? { state: "stale", detail: mismatchDetail }
		: parsed.graph.builtAtCommit === undefined
			? { state: "unknown", detail: "artifact does not state its build commit" }
			: { state: "fresh" };
	const sortedEdges = [...parsed.graph.edges].sort(compareEdges);
	const evidence: RepositoryEvidenceRef[] = [];
	let rejectedCount = 0;
	for (const edge of sortedEdges) {
		if (evidence.length >= maxEdges) break;
		const anchorPath =
			edge.location?.path ?? parsed.graph.nodePaths.get(edge.target) ?? parsed.graph.nodePaths.get(edge.source);
		if (!anchorPath) {
			rejectedCount++;
			continue;
		}
		const locationSuffix = edge.location
			? ` at ${edge.location.path}${edge.location.startLine !== undefined ? `:${edge.location.startLine}` : ""}`
			: "";
		evidence.push({
			evidenceId: semanticIdentity("graphify-edge-evidence", {
				artifact: parsed.artifactDigest,
				source: edge.source,
				target: edge.target,
				relation: edge.relation,
				confidence: edge.confidence,
				...(edge.location ? { location: edge.location } : {}),
			}),
			evidenceClass: edge.confidence === "EXTRACTED" ? "current_structural" : "statistical_relationship",
			sourceKind: "graphify_graph",
			sourceRef: anchorPath,
			sourceVersion,
			adapterId: GRAPHIFY_EVIDENCE_ADAPTER.adapterId,
			adapterSchemaVersion: GRAPHIFY_EVIDENCE_ADAPTER.adapterSchemaVersion,
			determinism: edge.confidence === "EXTRACTED" ? "resolved" : "statistical",
			authority: "candidate",
			extractionMethod: "read-only-graph-json-edge",
			inclusionReason: `${edge.confidence.toLowerCase()} ${edge.relation} edge ${edge.source} -> ${edge.target}${locationSuffix}`,
			snapshotCoverage: GRAPHIFY_EVIDENCE_ADAPTER.snapshotCoverage,
			staleness,
			sourceDigest: parsed.artifactDigest,
		});
	}
	const truncated = sortedEdges.length - rejectedCount > maxEdges;
	return {
		evidence,
		degradedSources: truncated
			? [
					{
						extractorId: GRAPHIFY_EVIDENCE_ADAPTER.adapterId,
						reason: "budget_limited",
						detail: `edge normalization limited to ${maxEdges} of ${sortedEdges.length - rejectedCount} accepted edge(s)`,
					},
				]
			: [],
		rejectedCount: rejectedCount + parsed.rejectedEdgeCount,
		artifactDigest: parsed.artifactDigest,
	};
}

function compareEdges(left: GraphifyEdge, right: GraphifyEdge): number {
	return (
		left.source.localeCompare(right.source) ||
		left.target.localeCompare(right.target) ||
		left.relation.localeCompare(right.relation) ||
		left.confidence.localeCompare(right.confidence)
	);
}

function normalizeRepositoryPath(candidatePath: string): string {
	return candidatePath.replaceAll("\\", "/");
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
