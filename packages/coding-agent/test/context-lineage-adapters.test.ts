import { describe, expect, it } from "bun:test";
import {
	collectExternalAdapterEvidence,
	collectGraphifyEvidence,
	collectScipEvidence,
	compareAdapterEvidenceAblations,
	compileCurrentStateRepositoryManifest,
	createRepositoryContextManifest,
	discoverScipIndex,
	mergeExternalEvidence,
	parseGraphifyGraph,
	parseScipIndex,
	prepareRepositoryContextLineage,
	resolveRepositorySnapshot,
	semanticIdentity,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { SessionEntry } from "../src/session/session-entries";

async function createRepositoryFixture(files: Readonly<Record<string, string>>): Promise<TempDir> {
	const tempDir = TempDir.createSync("@omp-context-lineage-adapter-");
	for (const [relativePath, content] of Object.entries(files))
		await Bun.write(`${tempDir.path()}/${relativePath}`, content);
	await $`git init --initial-branch=main`.cwd(tempDir.path()).quiet();
	await $`git add .`.cwd(tempDir.path()).quiet();
	await $`git -c user.name=Test -c user.email=test@example.com commit -m fixture`.cwd(tempDir.path()).quiet();
	return tempDir;
}

async function headCommit(repositoryRoot: string): Promise<string> {
	const result = await $`git rev-parse HEAD`.cwd(repositoryRoot).quiet().nothrow();
	return result.text().trim();
}

function graphifyGraphBytes(options: {
	readonly builtAtCommit?: string;
	readonly edges?: readonly Record<string, unknown>[];
	readonly schemaVersion?: unknown;
}): Uint8Array {
	const document = {
		schemaVersion: options.schemaVersion ?? 1,
		extractorVersion: "graphify-test-1",
		...(options.builtAtCommit === undefined ? {} : { builtAtCommit: options.builtAtCommit }),
		nodes: [
			{ id: "file:a", path: "src/a.ts" },
			{ id: "file:b", path: "src/b.ts" },
		],
		edges: options.edges ?? [
			{
				source: "file:a",
				target: "file:b",
				relation: "imports",
				confidence: "EXTRACTED",
				location: { path: "src/a.ts", startLine: 3 },
			},
		],
	};
	return new TextEncoder().encode(JSON.stringify(document));
}

// Minimal protobuf writer mirroring scip.proto field numbers so the parser is
// exercised against an independent encoding of the wire format.
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((total, part) => total + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function encodeVarint(value: number): Uint8Array {
	const bytes: number[] = [];
	let current = value;
	do {
		let byte = current & 0x7f;
		current >>>= 7;
		if (current > 0) byte |= 0x80;
		bytes.push(byte);
	} while (current > 0);
	return new Uint8Array(bytes);
}

function tagBytes(fieldNo: number, wireType: number): Uint8Array {
	return encodeVarint((fieldNo << 3) | wireType);
}

function lengthDelimited(fieldNo: number, payload: Uint8Array): Uint8Array {
	return concatBytes([tagBytes(fieldNo, 2), encodeVarint(payload.length), payload]);
}

function varintField(fieldNo: number, value: number): Uint8Array {
	return concatBytes([tagBytes(fieldNo, 0), encodeVarint(value)]);
}

function utf8Bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

interface ScipFixtureDocument {
	readonly relativePath: string;
	readonly occurrences?: readonly { readonly symbol: string; readonly roles?: number }[];
	readonly definedSymbols?: readonly { readonly symbol: string; readonly implementsOf?: string }[];
}

function buildScipIndex(options: {
	readonly projectRoot?: string;
	readonly indexerName?: string;
	readonly indexerVersion?: string;
	readonly documents: readonly ScipFixtureDocument[];
	readonly includeUnknownField?: boolean;
}): Uint8Array {
	const metadataParts: Uint8Array[] = [];
	if (options.indexerName || options.indexerVersion) {
		const toolInfo: Uint8Array[] = [
			...(options.indexerName ? [lengthDelimited(1, utf8Bytes(options.indexerName))] : []),
			...(options.indexerVersion ? [lengthDelimited(2, utf8Bytes(options.indexerVersion))] : []),
		];
		metadataParts.push(lengthDelimited(2, concatBytes(toolInfo)));
	}
	if (options.projectRoot) metadataParts.push(lengthDelimited(3, utf8Bytes(options.projectRoot)));
	const indexParts: Uint8Array[] = [
		...(metadataParts.length > 0 ? [lengthDelimited(1, concatBytes(metadataParts))] : []),
	];
	for (const document of options.documents) {
		const documentParts: Uint8Array[] = [lengthDelimited(1, utf8Bytes(document.relativePath))];
		for (const occurrence of document.occurrences ?? []) {
			documentParts.push(
				lengthDelimited(
					2,
					concatBytes([
						lengthDelimited(2, utf8Bytes(occurrence.symbol)),
						...(occurrence.roles === undefined ? [] : [varintField(3, occurrence.roles)]),
					]),
				),
			);
		}
		for (const symbol of document.definedSymbols ?? []) {
			const symbolParts: Uint8Array[] = [lengthDelimited(1, utf8Bytes(symbol.symbol))];
			if (symbol.implementsOf)
				symbolParts.push(
					lengthDelimited(4, concatBytes([lengthDelimited(1, utf8Bytes(symbol.implementsOf)), varintField(3, 1)])),
				);
			documentParts.push(lengthDelimited(3, concatBytes(symbolParts)));
		}
		indexParts.push(lengthDelimited(2, concatBytes(documentParts)));
	}
	if (options.includeUnknownField) indexParts.push(varintField(15, 7));
	return concatBytes(indexParts);
}

describe("Context Lineage Graphify adapter", () => {
	it("preserves provenance and keeps candidate authority for an artifact matching the frozen commit", async () => {
		using repository = await createRepositoryFixture({
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": 'import { a } from "./a";\n',
		});
		const root = repository.path();
		const snapshot = await resolveRepositorySnapshot(root);
		const bytes = graphifyGraphBytes({ builtAtCommit: await headCommit(root) });
		const parsed = parseGraphifyGraph(bytes);
		const collected = collectGraphifyEvidence({ parsed, snapshot, requireSnapshotMatch: true, maxEdges: 10 });
		expect(collected.evidence).toHaveLength(1);
		const evidence = collected.evidence[0]!;
		expect(evidence.evidenceClass).toBe("current_structural");
		expect(evidence.authority).toBe("candidate");
		expect(evidence.determinism).toBe("resolved");
		expect(evidence.sourceKind).toBe("graphify_graph");
		expect(evidence.sourceRef).toBe("src/a.ts");
		expect(evidence.staleness).toEqual({ state: "fresh" });
		expect(evidence.sourceDigest).toBe(parsed.artifactDigest);
		expect(evidence.inclusionReason).toContain("extracted imports edge file:a -> file:b at src/a.ts:3");
	});

	it("never normalizes INFERRED or AMBIGUOUS edges into current structural facts", async () => {
		const snapshot = {
			version: 1 as const,
			repositoryId: "r",
			workspaceScopeId: "w",
			headCommit: "c0",
			untrackedPolicy: "exclude" as const,
		};
		const parsed = parseGraphifyGraph(
			graphifyGraphBytes({
				builtAtCommit: "c0",
				edges: [
					{ source: "file:a", target: "file:b", relation: "co_changed", confidence: "INFERRED" },
					{ source: "file:b", target: "file:a", relation: "maybe_calls", confidence: "AMBIGUOUS" },
				],
			}),
		);
		const collected = collectGraphifyEvidence({ parsed, snapshot, requireSnapshotMatch: false, maxEdges: 10 });
		expect(collected.evidence.map(item => item.evidenceClass)).toEqual([
			"statistical_relationship",
			"statistical_relationship",
		]);
		expect(collected.evidence.every(item => item.authority === "candidate")).toBe(true);
		expect(collected.evidence.every(item => item.determinism === "statistical")).toBe(true);
	});

	it("rejects edges with unknown confidence values instead of relabeling them", async () => {
		const snapshot = {
			version: 1 as const,
			repositoryId: "r",
			workspaceScopeId: "w",
			headCommit: "c0",
			untrackedPolicy: "exclude" as const,
		};
		const parsed = parseGraphifyGraph(
			graphifyGraphBytes({
				builtAtCommit: "c0",
				edges: [
					{ source: "file:a", target: "file:b", relation: "imports", confidence: "EXTRACTED" },
					{ source: "file:b", target: "file:a", relation: "imports", confidence: "PROBABLY" },
				],
			}),
		);
		const collected = collectGraphifyEvidence({ parsed, snapshot, requireSnapshotMatch: false, maxEdges: 10 });
		expect(collected.rejectedCount).toBe(1);
		expect(collected.evidence).toHaveLength(1);
	});

	it("rejects artifacts built for another commit under requireSnapshotMatch and staleness-labels them otherwise", async () => {
		const snapshot = {
			version: 1 as const,
			repositoryId: "r",
			workspaceScopeId: "w",
			headCommit: "head",
			untrackedPolicy: "exclude" as const,
		};
		const parsed = parseGraphifyGraph(graphifyGraphBytes({ builtAtCommit: "older-commit" }));
		const rejected = collectGraphifyEvidence({ parsed, snapshot, requireSnapshotMatch: true, maxEdges: 10 });
		expect(rejected.evidence).toHaveLength(0);
		expect(rejected.degradedSources[0]).toMatchObject({ reason: "unsupported" });
		expect(rejected.rejectedCount).toBe(parsed.graph.edges.length);

		const labeled = collectGraphifyEvidence({ parsed, snapshot, requireSnapshotMatch: false, maxEdges: 10 });
		expect(labeled.evidence.length).toBeGreaterThan(0);
		expect(labeled.evidence[0]!.staleness?.state).toBe("stale");
	});

	it("labels artifacts that do not state their build commit with unknown staleness", async () => {
		const snapshot = {
			version: 1 as const,
			repositoryId: "r",
			workspaceScopeId: "w",
			headCommit: "head",
			untrackedPolicy: "exclude" as const,
		};
		const parsed = parseGraphifyGraph(graphifyGraphBytes({}));
		const collected = collectGraphifyEvidence({ parsed, snapshot, requireSnapshotMatch: true, maxEdges: 10 });
		expect(collected.evidence[0]!.staleness).toEqual({
			state: "unknown",
			detail: "artifact does not state its build commit",
		});
	});

	it("fails unknown schema versions at the boundary", () => {
		expect(() => parseGraphifyGraph(graphifyGraphBytes({ schemaVersion: 2 }))).toThrow(
			"unsupported graphify graph schema version",
		);
	});

	it("normalizes to identical evidence regardless of producer record order", async () => {
		using repository = await createRepositoryFixture({ "src/a.ts": "a\n" });
		const snapshot = await resolveRepositorySnapshot(repository.path());
		const edges = [
			{
				source: "file:a",
				target: "file:b",
				relation: "imports",
				confidence: "EXTRACTED",
				location: { path: "src/a.ts" },
			},
			{
				source: "file:b",
				target: "file:a",
				relation: "calls",
				confidence: "INFERRED",
				location: { path: "src/b.ts" },
			},
		];
		const forward = parseGraphifyGraph(graphifyGraphBytes({ builtAtCommit: "c0", edges }));
		const reversed = parseGraphifyGraph(graphifyGraphBytes({ builtAtCommit: "c0", edges: [...edges].reverse() }));
		const forwardResult = collectGraphifyEvidence({
			parsed: forward,
			snapshot,
			requireSnapshotMatch: true,
			maxEdges: 10,
		});
		const reversedResult = collectGraphifyEvidence({
			parsed: reversed,
			snapshot,
			requireSnapshotMatch: true,
			maxEdges: 10,
		});
		expect(reversedResult.evidence.map(item => item.evidenceId)).toEqual(
			forwardResult.evidence.map(item => item.evidenceId),
		);
	});
});

describe("Context Lineage SCIP adapter", () => {
	it("parses binary indexes preserving documents, definitions, references, and relationships", async () => {
		const index = buildScipIndex({
			projectRoot: "file:///repo",
			indexerName: "scip-test",
			indexerVersion: "9.9",
			documents: [
				{
					relativePath: "src/a.ts",
					definedSymbols: [
						{
							symbol: "scip-ts `test pkg` 1.0/src/a.ts/foo().",
							implementsOf: "scip-ts `test pkg` 1.0/src/b.ts/bar().",
						},
					],
				},
				{ relativePath: "src/b.ts", occurrences: [{ symbol: "scip-ts `test pkg` 1.0/src/b.ts/bar().", roles: 1 }] },
			],
			includeUnknownField: true,
		});
		const parsed = parseScipIndex(index);
		expect(parsed.projectRoot).toBe("file:///repo");
		expect(parsed.indexerName).toBe("scip-test");
		expect(parsed.indexerVersion).toBe("9.9");
		expect(parsed.documents).toHaveLength(2);
		const docA = parsed.documents.find(document => document.relativePath === "src/a.ts")!;
		const definedSymbol = docA.symbols[0]!;
		const relationship = definedSymbol.relationships[0]!;
		// Extract primitives before asserting: bun matchers may leave placeholder
		// objects inside the received structure they inspect.
		const symbolName = String(definedSymbol.symbol);
		const relationshipSymbolName = String(relationship.symbol);
		expect(symbolName).toContain("/foo().");
		expect(relationshipSymbolName).toContain("/bar().");
		expect(relationship.isImplementation).toBe(true);
		const docB = parsed.documents.find(document => document.relativePath === "src/b.ts")!;
		expect(docB.occurrences[0]?.isDefinition).toBe(true);

		const snapshot = {
			version: 1 as const,
			repositoryId: "r",
			workspaceScopeId: "w",
			headCommit: "c0",
			untrackedPolicy: "exclude" as const,
		};
		const collected = collectScipEvidence({
			parsed,
			snapshot,
			trackedPaths: new Set(["src/a.ts", "src/b.ts"]),
			requireSnapshotMatch: true,
			maxDocuments: 10,
		});
		expect(collected.missingPathCount).toBe(0);
		expect(collected.evidence.map(item => item.sourceRef).sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(collected.evidence.every(item => item.adapterId === "scip-index")).toBe(true);
		expect(collected.evidence[0]!.inclusionReason).toContain("definition(s)");
		expect(collected.evidence.some(item => item.inclusionReason.includes("relates to"))).toBe(true);
	});

	it("discloses unverifiable revision staleness for indexes consistent with the frozen tree", async () => {
		const index = buildScipIndex({
			documents: [{ relativePath: "src/a.ts", occurrences: [{ symbol: "scip local 1", roles: 1 }] }],
		});
		const parsed = parseScipIndex(index);
		const collected = collectScipEvidence({
			parsed,
			snapshot: {
				version: 1,
				repositoryId: "r",
				workspaceScopeId: "w",
				headCommit: "c0",
				untrackedPolicy: "exclude",
			},
			trackedPaths: new Set(["src/a.ts"]),
			requireSnapshotMatch: true,
			maxDocuments: 10,
		});
		expect(collected.evidence[0]!.staleness?.state).toBe("unknown");
		expect(collected.evidence[0]!.staleness?.state === "unknown").toBe(true);
	});

	it("rejects indexes inconsistent with the frozen tree under requireSnapshotMatch and stale-labels them otherwise", async () => {
		const index = buildScipIndex({
			documents: [{ relativePath: "src/gone.ts", occurrences: [{ symbol: "scip local 1", roles: 1 }] }],
		});
		const parsed = parseScipIndex(index);
		const base = {
			parsed,
			snapshot: {
				version: 1 as const,
				repositoryId: "r",
				workspaceScopeId: "w",
				headCommit: "c0",
				untrackedPolicy: "exclude" as const,
			},
			trackedPaths: new Set(["src/a.ts"]),
		};
		const rejected = collectScipEvidence({ ...base, requireSnapshotMatch: true, maxDocuments: 10 });
		expect(rejected.evidence).toHaveLength(0);
		expect(rejected.degradedSources[0]).toMatchObject({ reason: "unsupported" });

		const labeled = collectScipEvidence({ ...base, requireSnapshotMatch: false, maxDocuments: 10 });
		expect(labeled.evidence[0]!.staleness?.state).toBe("stale");
	});

	it("auto-discovers conventional index locations only when present", async () => {
		using empty = await createRepositoryFixture({ "README.md": "x\n" });
		expect(await discoverScipIndex(empty.path())).toBeUndefined();
		using indexed = await createRepositoryFixture({ "README.md": "x\n" });
		await Bun.write(`${indexed.path()}/.scip/index.scip`, new Uint8Array([0]));
		expect(await discoverScipIndex(indexed.path())).toBe(`${indexed.path()}/.scip/index.scip`);
	});
});

describe("Context Lineage external adapter orchestration", () => {
	function createJournal() {
		const entries: SessionEntry[] = [];
		return {
			appendCustomEntry(customType: string, data?: unknown): string {
				const id = `entry-${entries.length + 1}`;
				entries.push({
					type: "custom",
					id,
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					customType,
					data,
				});
				return id;
			},
			getBranch: () => entries,
			async saveArtifact(): Promise<string | undefined> {
				return undefined;
			},
		};
	}

	it("includes enabled adapter evidence while native-only compilation stays untouched", async () => {
		using repository = await createRepositoryFixture({
			"src/target.ts": "export const target = 1;\n",
		});
		const root = repository.path();
		const nativeManifest = await compileCurrentStateRepositoryManifest(root, {
			task: "target",
			retrievalPolicy: { id: "context-lineage-current-state-v1" },
			contextRendererVersion: "context-lineage-v1",
		});
		await Bun.write(`${root}/graphify-out/graph.json`, graphifyGraphBytes({ builtAtCommit: await headCommit(root) }));
		const journal = await createJournal();
		const prepared = await prepareRepositoryContextLineage({
			cwd: root,
			task: "target",
			journal,
			adapters: { graphify: "enabled", scip: "off" },
		});
		expect(prepared.manifest.manifestId).not.toBe(nativeManifest.manifestId);
		expect(prepared.manifest.evidence.some(item => item.adapterId === "graphify-graph")).toBe(true);
		expect(prepared.adapterObservations[0]).toMatchObject({
			adapterId: "graphify-graph",
			status: "included",
			evidence: expect.any(Array),
		});
		// Native evidence items survive unchanged; only adapter rows were appended.
		expect(prepared.manifest.evidence.filter(item => item.adapterId !== "graphify-graph")).toEqual([
			...nativeManifest.evidence,
		]);
	});

	it("observe mode reports candidates without adding them to the plan base", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = 1;\n" });
		const root = repository.path();
		await Bun.write(`${root}/graphify-out/graph.json`, graphifyGraphBytes({ builtAtCommit: await headCommit(root) }));
		const journal = await createJournal();
		const observed = await prepareRepositoryContextLineage({
			cwd: root,
			task: "target",
			journal,
			adapters: { graphify: "observe", scip: "off" },
		});
		const native = await prepareRepositoryContextLineage({ cwd: root, task: "target", journal });
		expect(observed.manifest.manifestId).toBe(native.manifest.manifestId);
		expect(observed.adapterObservations[0]?.status).toBe("observed");
		expect(observed.adapterObservations[0]?.evidence.length).toBeGreaterThan(0);
	});

	it("performs no discovery when every adapter mode is off", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = 1;\n" });
		const root = repository.path();
		await Bun.write(`${root}/graphify-out/graph.json`, graphifyGraphBytes({ builtAtCommit: await headCommit(root) }));
		await Bun.write(`${root}/index.scip`, new Uint8Array([0x00]));
		const collections = await collectExternalAdapterEvidence({
			repositoryRoot: root,
			snapshot: await resolveRepositorySnapshot(root),
			policy: { graphify: "off", scip: "off" },
		});
		expect(collections).toHaveLength(0);
	});

	it("degrades explicitly when artifacts are absent and leaves the manifest identical to the native one", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = 1;\n" });
		const root = repository.path();
		const journal = await createJournal();
		const native = await prepareRepositoryContextLineage({ cwd: root, task: "target", journal });
		const degraded = await prepareRepositoryContextLineage({
			cwd: root,
			task: "target",
			journal,
			adapters: { graphify: "enabled", scip: "enabled" },
		});
		expect(degraded.manifest.manifestId).toBe(native.manifest.manifestId);
		expect(degraded.adapterObservations.map(observation => observation.status)).toEqual([
			"unavailable",
			"unavailable",
		]);
		expect(degraded.adapterObservations.every(observation => observation.detail.length > 0)).toBe(true);
	});

	it("contains malformed artifact failures without blocking planning", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = 1;\n" });
		const root = repository.path();
		await Bun.write(`${root}/graphify-out/graph.json`, "<not json>");
		const journal = await createJournal();
		const prepared = await prepareRepositoryContextLineage({
			cwd: root,
			task: "target",
			journal,
			adapters: { graphify: "enabled", scip: "off" },
		});
		expect(prepared.adapterObservations[0]).toMatchObject({
			status: "failed",
			detail: expect.stringContaining("JSON"),
		});
		expect(prepared.manifest.evidence.some(item => item.adapterId === "graphify-graph")).toBe(false);
	});

	it("caps merged adapter evidence under the declared budget with an explicit degraded record", () => {
		const snapshot = {
			version: 1 as const,
			repositoryId: "r",
			workspaceScopeId: "w",
			headCommit: "c0",
			untrackedPolicy: "exclude" as const,
		};
		const base = createRepositoryContextManifest({
			snapshot,
			task: "t",
			retrievalPolicy: { id: "p" },
			contextRendererVersion: "v1",
			evidence: [],
		});
		const evidence = ["src/one.ts", "src/two.ts", "src/three.ts"].map(sourceRef => ({
			evidenceId: semanticIdentity("adapter-evidence", sourceRef),
			evidenceClass: "current_structural" as const,
			sourceKind: "graphify_graph",
			sourceRef,
			sourceVersion: "v",
			adapterId: "graphify-graph",
			adapterSchemaVersion: "v1",
			determinism: "resolved" as const,
			authority: "candidate" as const,
			extractionMethod: "read-only-graph-json-edge",
			inclusionReason: "test",
			staleness: { state: "fresh" as const },
		}));
		const collection = {
			adapterId: "graphify-graph",
			adapterSchemaVersion: "v1",
			mode: "enabled" as const,
			status: "included" as const,
			evidence,
			degradedSources: [],
			rejectedCount: 0,
			detail: "test",
		};
		const merged = mergeExternalEvidence(base, [collection], 2);
		expect(merged.evidence.filter(item => item.adapterId === "graphify-graph")).toHaveLength(2);
		expect(merged.degradedSources.some(source => source.reason === "budget_limited")).toBe(true);
		// Changing the adapter budget versions the manifest identity explicitly.
		const widened = mergeExternalEvidence(base, [collection], 3);
		expect(widened.manifestId).not.toBe(merged.manifestId);
	});
});

describe("Context Lineage adapter ablation comparison", () => {
	it("separates unique useful coverage from duplicates and unsupported scope", () => {
		const benchmark = {
			id: "case",
			requiredScope: ["src/a.ts"],
			requiredVerification: ["test/a.test.ts"],
		};
		const evidenceFor = (sourceRefs: readonly string[], stale = false) =>
			sourceRefs.map(sourceRef => ({
				evidenceId: semanticIdentity("evidence", sourceRef),
				evidenceClass: "current_structural" as const,
				sourceKind: "workspace_file",
				sourceRef,
				sourceVersion: "v",
				adapterId: "native-current-state",
				adapterSchemaVersion: "v1",
				determinism: "deterministic" as const,
				authority: "current" as const,
				extractionMethod: "bounded-file-capture",
				inclusionReason: "test",
				...(stale ? { staleness: { state: "stale" as const, detail: "old commit" } } : {}),
			}));
		const makeManifest = (sourceRefs: readonly string[], stale = false) =>
			createRepositoryContextManifest({
				snapshot: {
					version: 1,
					repositoryId: "r",
					workspaceScopeId: "w",
					headCommit: "c0",
					untrackedPolicy: "exclude",
				},
				task: "t",
				retrievalPolicy: { id: "p" },
				contextRendererVersion: "v1",
				evidence: evidenceFor(sourceRefs, stale),
			});
		const report = compareAdapterEvidenceAblations({
			conditions: [
				{ conditionId: "native", manifest: makeManifest(["src/a.ts"]) },
				{
					conditionId: "native+graphify",
					manifest: makeManifest(["src/a.ts", "test/a.test.ts", "docs/unrelated.md"], true),
				},
			],
			nativeConditionId: "native",
			benchmark,
		});
		expect(report.uniqueUsefulByCondition["native+graphify"]).toEqual(["test/a.test.ts"]);
		expect(report.duplicateWithNative["native+graphify"]).toEqual(["src/a.ts"]);
		expect(report.conditions["native+graphify"]?.unsupportedScope).toEqual(["docs/unrelated.md"]);
		expect(report.conditions["native+graphify"]?.staleFacts).toEqual([
			"docs/unrelated.md",
			"src/a.ts",
			"test/a.test.ts",
		]);
	});
});
