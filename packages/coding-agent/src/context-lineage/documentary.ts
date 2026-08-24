import { repositoryManifestIdentity, semanticIdentity } from "./identity";
import type {
	RepositoryContextManifest,
	RepositoryEvidenceRef,
	RepositoryManifestDegradedSource,
	RepositorySnapshot,
} from "./types";

const DEFAULT_MAX_DOCUMENTARY_EXCERPT_BYTES = 8 * 1024;

/**
 * Read-only local/authorized documentary input for PR 9B evaluation. It is
 * deliberately not a Graphiti client: callers must obtain the artifact under
 * their own authorization, and no network/runtime is required to keep native
 * repository planning available.
 */
export interface DocumentaryEvidenceInput {
	/** Local caller-provided bytes, or an already-authorized forge artifact. */
	readonly source?: "local" | "forge";
	readonly sourceRef: string;
	readonly content: string;
	readonly learnedAt?: number;
	readonly validFrom?: string;
	readonly validUntil?: string;
	readonly supersededBy?: string;
}

export interface DocumentaryEvidenceCollection {
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly degradedSources: readonly RepositoryManifestDegradedSource[];
}

export function collectLocalDocumentaryEvidence(input: {
	readonly snapshot: RepositorySnapshot;
	readonly documents: readonly DocumentaryEvidenceInput[];
	readonly maxItems: number;
	/** Bounded bytes rendered as untrusted documentary context. */
	readonly maxExcerptBytes?: number;
}): DocumentaryEvidenceCollection {
	if (!Number.isSafeInteger(input.maxItems) || input.maxItems < 0) {
		throw new Error("Documentary evidence maxItems must be a non-negative safe integer");
	}
	const maxExcerptBytes = input.maxExcerptBytes ?? DEFAULT_MAX_DOCUMENTARY_EXCERPT_BYTES;
	if (!Number.isSafeInteger(maxExcerptBytes) || maxExcerptBytes < 0) {
		throw new Error("Documentary evidence maxExcerptBytes must be a non-negative safe integer");
	}
	const documents = [...input.documents].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
	const sourceVersion = semanticIdentity("documentary-snapshot", input.snapshot);
	const evidence = documents.slice(0, input.maxItems).map(document => {
		const source = document.source ?? "local";
		const adapterId = source === "forge" ? "forge-documentary-v1" : "local-documentary-v1";
		const sourceDigest = semanticIdentity("documentary-source", document.content);
		const sourceBytes = new TextEncoder().encode(document.content);
		const excerptBytes = sourceBytes.slice(0, maxExcerptBytes);
		const excerptContent = new TextDecoder().decode(excerptBytes);
		return {
			evidenceId: semanticIdentity("repository-documentary-evidence", {
				sourceRef: document.sourceRef,
				sourceVersion,
				sourceDigest,
				...(document.learnedAt === undefined ? {} : { learnedAt: document.learnedAt }),
				...(document.validFrom === undefined ? {} : { validFrom: document.validFrom }),
				...(document.validUntil === undefined ? {} : { validUntil: document.validUntil }),
				...(document.supersededBy === undefined ? {} : { supersededBy: document.supersededBy }),
			}),
			evidenceClass: "documentary_observation" as const,
			sourceKind: source === "forge" ? "forge_document" : "local_document",
			sourceRef: document.sourceRef,
			sourceVersion,
			adapterId,
			adapterSchemaVersion: "v1",
			determinism: "deterministic" as const,
			authority: "documentary" as const,
			extractionMethod: source === "forge" ? "caller-authorized-forge-artifact" : "caller-authorized-local-document",
			inclusionReason: document.supersededBy ? `superseded by ${document.supersededBy}` : "documentary context",
			snapshotCoverage: "unavailable" as const,
			bitemporalProvenance: {
				...(document.learnedAt === undefined ? {} : { observedAt: document.learnedAt }),
				...(document.validFrom === undefined ? {} : { validFrom: document.validFrom }),
				...(document.validUntil === undefined ? {} : { validUntil: document.validUntil }),
			},
			staleness: document.supersededBy
				? ({ state: "stale", detail: `superseded by ${document.supersededBy}` } as const)
				: ({ state: "unknown", detail: "documentary evidence does not establish current repository state" } as const),
			sourceDigest,
			excerpt: {
				path: document.sourceRef,
				startLine: 1,
				endLine: excerptContent.split("\n").length,
				content: excerptContent,
				contentDigest: semanticIdentity("documentary-excerpt", excerptContent),
				sourceBytes: sourceBytes.byteLength,
				truncated: excerptBytes.byteLength < sourceBytes.byteLength,
			},
		};
	});
	return {
		evidence,
		degradedSources:
			documents.length > input.maxItems
				? [
						{
							extractorId: "local-documentary-v1",
							reason: "budget_limited",
							detail: `documentary collection limited to ${input.maxItems} of ${documents.length} item(s)`,
						},
					]
				: [],
	};
}

/** Merge explicitly authorized documentary material without elevating its authority. */
export function mergeDocumentaryEvidence(
	manifest: RepositoryContextManifest,
	collected: DocumentaryEvidenceCollection,
): RepositoryContextManifest {
	const base = {
		version: 1 as const,
		manifestId: "",
		snapshot: manifest.snapshot,
		taskDigest: manifest.taskDigest,
		retrievalPolicyId: semanticIdentity("merged-retrieval-policy", {
			current: manifest.retrievalPolicyId,
			documentary: collected.evidence.map(evidence => evidence.evidenceId),
		}),
		contextRendererVersion: manifest.contextRendererVersion,
		evidence: [...manifest.evidence, ...collected.evidence].sort(
			(left, right) => left.sourceRef.localeCompare(right.sourceRef) || left.evidenceId.localeCompare(right.evidenceId),
		),
		omissions: manifest.omissions,
		degradedSources: [...manifest.degradedSources, ...collected.degradedSources].sort(
			(left, right) => left.extractorId.localeCompare(right.extractorId) || left.reason.localeCompare(right.reason),
		),
	};
	return { ...base, manifestId: repositoryManifestIdentity(base) };
}
