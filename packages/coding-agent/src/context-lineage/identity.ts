import type {
	ContextLineagePlan,
	LogicalContextCheckpoint,
	PreparedPrefix,
	RepositoryContextManifest,
	RepositoryEvidenceExcerpt,
	RepositorySnapshot,
} from "./types";

/** Canonical JSON for semantic identity material. Object keys are lexicographically ordered. */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new Error(`Cannot canonicalize ${typeof value}`);
}

/** SHA-256 identifier for immutable semantic content. */
export function semanticIdentity(kind: string, value: unknown): string {
	const digest = new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
	return `${kind}:v1:${digest}`;
}

export function repositorySnapshotIdentity(snapshot: RepositorySnapshot): string {
	return semanticIdentity("repository-snapshot", snapshot);
}

/**
 * Excludes the self-referential ID and raw excerpt bytes from manifest identity.
 * Excerpts contribute their digests, so a digest-only persisted record keeps the
 * same identity as the fully materialized manifest (MVP storage rule).
 */
export function repositoryManifestIdentity(manifest: RepositoryContextManifest): string {
	const { manifestId: _manifestId, ...semanticManifest } = manifest;
	return semanticIdentity("repository-manifest", {
		...semanticManifest,
		evidence: semanticManifest.evidence.map(evidence =>
			evidence.excerpt ? { ...evidence, excerpt: excerptIdentityView(evidence.excerpt) } : evidence,
		),
	});
}

function excerptIdentityView(excerpt: RepositoryEvidenceExcerpt): RepositoryEvidenceExcerpt {
	const { content: _content, ...digestView } = excerpt;
	return digestView;
}

/** Excludes display-only metadata from plan identity. */
export function contextLineagePlanIdentity(plan: ContextLineagePlan): string {
	const { metadata: _metadata, ...semanticPlan } = plan;
	return semanticIdentity("context-lineage-plan", semanticPlan);
}

/** Excludes storage identity and observation time from durable checkpoint identity. */
export function logicalCheckpointIdentity(checkpoint: LogicalContextCheckpoint): string {
	const { checkpointId: _checkpointId, createdAt: _createdAt, ...semanticCheckpoint } = checkpoint;
	return semanticIdentity("logical-checkpoint", semanticCheckpoint);
}

/** Excludes storage identity and observation time from prepared-prefix identity. */
export function preparedPrefixIdentity(prefix: PreparedPrefix): string {
	const { preparedPrefixId: _preparedPrefixId, createdAt: _createdAt, ...semanticPrefix } = prefix;
	return semanticIdentity("prepared-prefix", semanticPrefix);
}
