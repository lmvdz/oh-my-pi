import { semanticIdentity } from "./identity";
import type {
	RepositoryEvidenceAdapter,
	RepositoryEvidenceRef,
	RepositoryManifestDegradedSource,
	RepositorySnapshot,
} from "./types";

/**
 * Read-only SCIP / local symbol-index adapter (PR 3A). It consumes an existing
 * index artifact when present (`auto` mode discovers; it never installs,
 * generates, or contacts a service, §25.5). The index proposes versioned
 * symbol-level evidence for the revision it was built against; it never
 * becomes current authority (§34.4) and cannot speak about dirty-overlay facts.
 */
export const SCIP_EVIDENCE_ADAPTER: RepositoryEvidenceAdapter = {
	version: 1,
	adapterId: "scip-index",
	adapterSchemaVersion: "v1",
	sourceKinds: ["scip_index"],
	sourceAuthority: "candidate",
	determinism: "resolved",
	snapshotCoverage: "head_only",
	evidenceClasses: ["current_structural", "statistical_relationship"],
	bitemporalProvenance: "not_supported",
	staleness: { state: "unknown", detail: "SCIP indexes do not record their source revision" },
};

/** Conventional local index locations probed in `auto` discovery order. */
export const SCIP_INDEX_CANDIDATES: readonly string[] = [".scip/index.scip", "index.scip"];

/** First existing conventional index path inside the repository, if any. */
export async function discoverScipIndex(repositoryRoot: string): Promise<string | undefined> {
	for (const candidatePath of SCIP_INDEX_CANDIDATES) {
		const candidate = `${repositoryRoot}/${candidatePath}`;
		try {
			if (!(await Bun.file(candidate).exists())) continue;
			return candidate;
		} catch {}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Minimal protobuf wire-format reading for SCIP Index payloads.
//
// Field numbers follow sourcegraph/scip `scip.proto`:
//   Index    { metadata=1, documents=2, external_symbols=3 }
//   Metadata { version=1, tool_info=2, project_root=3 }
//   ToolInfo { name=1, version=2 }
//   Document { relative_path=1, occurrences=2, symbols=3 }
//   SymbolInformation { symbol=1, relationships=4 }
//   Relationship { symbol=1 }
//   Occurrence { range=1(packed), symbol=2, symbol_roles=3 }
// Unknown fields are skipped generically so schema drift degrades instead of
// crashing (NFR16).
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

interface WireField {
	readonly fieldNo: number;
	readonly wireType: number;
	readonly start: number;
	readonly end: number;
	/** Decoded value when wireType is varint; unused otherwise. */
	readonly varintValue?: bigint;
}

function* iterateFields(bytes: Uint8Array, start: number, end: number): Generator<WireField> {
	let position = start;
	while (position < end) {
		const key = readVarint(bytes, position, end);
		position = key.next;
		const wireType = Number(key.value & 7n);
		const fieldNo = Number(key.value >> 3n);
		if (fieldNo === 0) throw new Error("invalid protobuf field number 0");
		if (wireType === WIRE_VARINT) {
			const value = readVarint(bytes, position, end);
			position = value.next;
			yield { fieldNo, wireType, start: position, end: position, varintValue: value.value };
		} else if (wireType === WIRE_LEN) {
			const length = readVarint(bytes, position, end);
			position = length.next;
			const fieldStart = position;
			const fieldEnd = fieldStart + Number(length.value);
			if (fieldEnd > end) throw new Error("protobuf length-delimited field overruns message");
			position = fieldEnd;
			yield { fieldNo, wireType, start: fieldStart, end: fieldEnd };
		} else if (wireType === WIRE_FIXED32) {
			position += 4;
			if (position > end) throw new Error("protobuf fixed32 field overruns message");
			yield { fieldNo, wireType, start: position - 4, end: position };
		} else if (wireType === WIRE_FIXED64) {
			position += 8;
			if (position > end) throw new Error("protobuf fixed64 field overruns message");
			yield { fieldNo, wireType, start: position - 8, end: position };
		} else {
			throw new Error(`unsupported protobuf wire type ${wireType}`);
		}
	}
}

function readVarint(bytes: Uint8Array, start: number, end: number): { value: bigint; next: number } {
	let value = 0n;
	let shift = 0n;
	let position = start;
	while (position < end) {
		const byte = bytes[position]!;
		value |= BigInt(byte & 0x7f) << shift;
		position++;
		if ((byte & 0x80) === 0) return { value, next: position };
		shift += 7n;
		if (shift > 63n) throw new Error("protobuf varint exceeds 64 bits");
	}
	throw new Error("truncated protobuf varint");
}

function readLengthDelimited(bytes: Uint8Array, field: WireField): Uint8Array {
	return bytes.subarray(field.start, field.end);
}

interface ScipOccurrence {
	readonly symbol: string;
	readonly isDefinition: boolean;
	readonly isImport: boolean;
}

interface ScipRelationship {
	readonly symbol: string;
	readonly isImplementation: boolean;
	readonly isReference: boolean;
	readonly isTypeDefinition: boolean;
	readonly isDefinition: boolean;
}

interface ScipSymbolInformation {
	readonly symbol: string;
	readonly relationships: readonly ScipRelationship[];
}

export interface ScipDocument {
	readonly relativePath: string;
	readonly occurrences: readonly ScipOccurrence[];
	readonly symbols: readonly ScipSymbolInformation[];
}

export interface ParsedScipIndex {
	readonly projectRoot?: string;
	readonly indexerName?: string;
	readonly indexerVersion?: string;
	readonly documents: readonly ScipDocument[];
}

/** Parse one binary SCIP Index payload. Throws on structurally invalid input. */
export function parseScipIndex(bytes: Uint8Array): ParsedScipIndex {
	const end = bytes.length;
	let projectRoot: string | undefined;
	let indexerName: string | undefined;
	let indexerVersion: string | undefined;
	const documents: ScipDocument[] = [];
	for (const field of iterateFields(bytes, 0, end)) {
		if (field.fieldNo === 1 && field.wireType === WIRE_LEN) {
			const metadataBytes = readLengthDelimited(bytes, field);
			for (const metadataField of iterateFields(metadataBytes, 0, metadataBytes.length)) {
				if (metadataField.fieldNo === 2 && metadataField.wireType === WIRE_LEN) {
					const toolBytes = readLengthDelimited(metadataBytes, metadataField);
					for (const toolField of iterateFields(toolBytes, 0, toolBytes.length)) {
						if (toolField.fieldNo === 1 && toolField.wireType === WIRE_LEN)
							indexerName = new TextDecoder().decode(readLengthDelimited(toolBytes, toolField));
						if (toolField.fieldNo === 2 && toolField.wireType === WIRE_LEN)
							indexerVersion = new TextDecoder().decode(readLengthDelimited(toolBytes, toolField));
					}
				}
				if (metadataField.fieldNo === 3 && metadataField.wireType === WIRE_LEN) {
					projectRoot = new TextDecoder().decode(readLengthDelimited(metadataBytes, metadataField));
				}
			}
		} else if (field.fieldNo === 2 && field.wireType === WIRE_LEN) {
			documents.push(parseScipDocument(readLengthDelimited(bytes, field)));
		}
	}
	return {
		...(projectRoot ? { projectRoot } : {}),
		...(indexerName ? { indexerName } : {}),
		...(indexerVersion ? { indexerVersion } : {}),
		documents,
	};
}

function parseScipDocument(bytes: Uint8Array): ScipDocument {
	let relativePath = "";
	const occurrences: ScipOccurrence[] = [];
	const symbols: ScipSymbolInformation[] = [];
	for (const field of iterateFields(bytes, 0, bytes.length)) {
		if (field.fieldNo === 1 && field.wireType === WIRE_LEN) {
			relativePath = new TextDecoder().decode(readLengthDelimited(bytes, field));
		} else if (field.fieldNo === 2 && field.wireType === WIRE_LEN) {
			const occurrenceBytes = readLengthDelimited(bytes, field);
			let symbol: string | undefined;
			let roles = 0;
			for (const occurrenceField of iterateFields(occurrenceBytes, 0, occurrenceBytes.length)) {
				if (occurrenceField.fieldNo === 2 && occurrenceField.wireType === WIRE_LEN) {
					symbol = new TextDecoder().decode(readLengthDelimited(occurrenceBytes, occurrenceField));
				} else if (
					occurrenceField.fieldNo === 3 &&
					occurrenceField.wireType === WIRE_VARINT &&
					occurrenceField.varintValue !== undefined
				) {
					roles |= Number(occurrenceField.varintValue);
				}
			}
			if (symbol) occurrences.push({ symbol, isDefinition: (roles & 0x1) !== 0, isImport: (roles & 0x2) !== 0 });
		} else if (field.fieldNo === 3 && field.wireType === WIRE_LEN) {
			const symbolBytes = readLengthDelimited(bytes, field);
			let symbol = "";
			const relationships: ScipRelationship[] = [];
			for (const symbolField of iterateFields(symbolBytes, 0, symbolBytes.length)) {
				if (symbolField.fieldNo === 1 && symbolField.wireType === WIRE_LEN) {
					symbol = new TextDecoder().decode(readLengthDelimited(symbolBytes, symbolField));
				} else if (symbolField.fieldNo === 4 && symbolField.wireType === WIRE_LEN) {
					const relationshipBytes = readLengthDelimited(symbolBytes, symbolField);
					let relationshipSymbol = "";
					const flags = { reference: false, implementation: false, typeDefinition: false, definition: false };
					for (const relationshipField of iterateFields(relationshipBytes, 0, relationshipBytes.length)) {
						if (relationshipField.fieldNo === 1 && relationshipField.wireType === WIRE_LEN) {
							relationshipSymbol = new TextDecoder().decode(
								readLengthDelimited(relationshipBytes, relationshipField),
							);
						} else if (
							relationshipField.wireType === WIRE_VARINT &&
							relationshipField.varintValue !== undefined
						) {
							const flag = Number(relationshipField.varintValue);
							if (relationshipField.fieldNo === 2) flags.reference = flags.reference || flag !== 0;
							if (relationshipField.fieldNo === 3) flags.implementation = flags.implementation || flag !== 0;
							if (relationshipField.fieldNo === 4) flags.typeDefinition = flags.typeDefinition || flag !== 0;
							if (relationshipField.fieldNo === 5) flags.definition = flags.definition || flag !== 0;
						}
					}
					if (relationshipSymbol) {
						relationships.push({
							symbol: relationshipSymbol,
							isReference: flags.reference,
							isImplementation: flags.implementation,
							isTypeDefinition: flags.typeDefinition,
							isDefinition: flags.definition,
						});
					}
				}
			}
			if (symbol) symbols.push({ symbol, relationships });
		}
	}
	return { relativePath, occurrences, symbols };
}

// ---------------------------------------------------------------------------

export interface CollectedScipEvidence {
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly degradedSources: readonly RepositoryManifestDegradedSource[];
	/** Indexed paths absent from the frozen tracked tree. */
	readonly missingPathCount: number;
	readonly artifactDigest: string;
}

/**
 * Normalize parsed index documents into bounded per-document evidence anchored
 * at repository paths. Documents are sorted by path before budget slicing so
 * truncation stays deterministic regardless of producer ordering.
 */
export function collectScipEvidence(input: {
	readonly parsed: ParsedScipIndex;
	readonly snapshot: RepositorySnapshot;
	/** Tracked paths at the frozen HEAD, used as the corpus consistency boundary. */
	readonly trackedPaths: ReadonlySet<string>;
	readonly requireSnapshotMatch: boolean;
	readonly maxDocuments: number;
}): CollectedScipEvidence {
	const { parsed, snapshot, trackedPaths, requireSnapshotMatch, maxDocuments } = input;
	const artifactDigest = semanticIdentity("scip-index-bytes", {
		...(parsed.projectRoot ? { projectRoot: parsed.projectRoot } : {}),
		...(parsed.indexerName ? { indexerName: parsed.indexerName } : {}),
		...(parsed.indexerVersion ? { indexerVersion: parsed.indexerVersion } : {}),
		documents: [...parsed.documents]
			.map(document => ({
				relativePath: document.relativePath,
				definitions: document.occurrences
					.filter(occurrence => occurrence.isDefinition)
					.map(definition => definition.symbol),
				references: [...countUnique(document.occurrences.filter(occurrence => !occurrence.isDefinition))].sort(),
				relationships: document.symbols.flatMap(symbol =>
					symbol.relationships.map(relationship => `${symbol.symbol}->${relationship.symbol}`),
				),
			}))
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
	});
	const sourceVersion = semanticIdentity("repository-snapshot-ref", snapshot);
	const missingPaths = parsed.documents
		.map(document => document.relativePath)
		.filter(docPath => !trackedPaths.has(docPath));
	const mismatchDetail =
		missingPaths.length > 0 ? `${missingPaths.length} indexed path(s) are absent from the frozen tree` : undefined;
	if (mismatchDetail && requireSnapshotMatch) {
		return {
			evidence: [],
			degradedSources: [
				{
					extractorId: SCIP_EVIDENCE_ADAPTER.adapterId,
					reason: "unsupported",
					detail: `${mismatchDetail}; index revision cannot be verified (requireSnapshotMatch)`,
				},
			],
			missingPathCount: missingPaths.length,
			artifactDigest,
		};
	}
	const staleness: NonNullable<RepositoryEvidenceRef["staleness"]> = mismatchDetail
		? { state: "stale", detail: `${mismatchDetail}; index revision unverifiable` }
		: { state: "unknown", detail: "index does not record its source revision" };
	const sortedDocuments = [...parsed.documents].sort(compareByPath);
	const evidence: RepositoryEvidenceRef[] = [];
	for (const document of sortedDocuments) {
		if (evidence.length >= maxDocuments) break;
		const definitions = document.occurrences.filter(occurrence => occurrence.isDefinition);
		const references = countUnique(document.occurrences.filter(occurrence => !occurrence.isDefinition));
		if (definitions.length === 0 && references.size === 0 && document.symbols.length === 0) continue;
		const relationshipSample = [
			...new Set(
				document.symbols.flatMap(symbol =>
					symbol.relationships.map(
						relationship => `${shortSymbol(symbol.symbol)}->${shortSymbol(relationship.symbol)}`,
					),
				),
			),
		]
			.sort()
			.slice(0, 4);
		const definedSample = definitions
			.map(definition => shortSymbol(definition.symbol))
			.sort()
			.slice(0, 4);
		evidence.push({
			evidenceId: semanticIdentity("scip-document-evidence", {
				artifact: artifactDigest,
				path: document.relativePath,
				definitions: definitions.map(definition => definition.symbol),
				references: [...references].sort(),
				relationships: document.symbols.flatMap(symbol =>
					symbol.relationships.map(relationship => `${symbol.symbol}->${relationship.symbol}`),
				),
			}),
			evidenceClass: "current_structural",
			sourceKind: "scip_index",
			sourceRef: document.relativePath,
			sourceVersion,
			adapterId: SCIP_EVIDENCE_ADAPTER.adapterId,
			adapterSchemaVersion: SCIP_EVIDENCE_ADAPTER.adapterSchemaVersion,
			determinism: SCIP_EVIDENCE_ADAPTER.determinism,
			authority: "candidate",
			extractionMethod: `read-only-scip-index${parsed.indexerName ? ` (${parsed.indexerName}${parsed.indexerVersion ? `@${parsed.indexerVersion}` : ""})` : ""}`,
			inclusionReason:
				`${definitions.length} definition(s), ${references.size} referenced symbol(s)` +
				(definedSample.length > 0 ? ` incl. ${definedSample.join(", ")}` : "") +
				(relationshipSample.length > 0 ? `; relates to ${relationshipSample.join(", ")}` : ""),
			snapshotCoverage: SCIP_EVIDENCE_ADAPTER.snapshotCoverage,
			staleness,
			sourceDigest: artifactDigest,
		});
	}
	const truncated = sortedDocuments.length > maxDocuments;
	return {
		evidence,
		degradedSources: truncated
			? [
					{
						extractorId: SCIP_EVIDENCE_ADAPTER.adapterId,
						reason: "budget_limited",
						detail: `document normalization limited to ${maxDocuments} indexed file(s)`,
					},
				]
			: [],
		missingPathCount: missingPaths.length,
		artifactDigest,
	};
}

function compareByPath(left: ScipDocument, right: ScipDocument): number {
	return left.relativePath.localeCompare(right.relativePath);
}

function countUnique(occurrences: readonly ScipOccurrence[]): Set<string> {
	return new Set(occurrences.map(occurrence => occurrence.symbol));
}

/** Last two descriptor segments keep inclusion reasons readable without full symbol noise. */
function shortSymbol(symbol: string): string {
	if (typeof symbol !== "string") {
		console.log("BADARG", JSON.stringify(symbol));
		console.log(new Error().stack);
	}
	const segments = symbol.split(/(?=[./#[:])/).filter(segment => segment.length > 0);
	return segments.slice(-2).join("");
}
