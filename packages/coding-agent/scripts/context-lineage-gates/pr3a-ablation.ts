// T3a/T3b: real Graphify artifact (match + mismatch) and the PR 3A ablation
// across native / +scip / +graphify manifest conditions on a benchmark case.
import {
	collectExternalAdapterEvidence,
	compareAdapterEvidenceAblations,
	compileCurrentStateRepositoryManifest,
	createRepositoryContextManifest,
	mergeExternalEvidence,
	type RepositoryPlanningBenchmarkCase,
	resolveRepositorySnapshot,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { $ } from "bun";

const repoRoot = "/tmp/opencode/tier2-scip-repo";

// ---- T3a: craft a realistic graphify-out/graph.json for the fixture repo ----
const head = (await $`git rev-parse HEAD`.cwd(repoRoot).quiet().nothrow().text()).trim();
const graph = {
	schemaVersion: 1,
	builtAtCommit: head,
	extractorVersion: "graphify-handcrafted-1.0",
	nodes: [
		{ id: "file:types", path: "src/types.ts", type: "file" },
		{ id: "file:registry", path: "src/registry.ts", type: "file" },
		{ id: "sym:scale", path: "src/types.ts", type: "symbol" },
		{ id: "sym:registry", path: "src/registry.ts", type: "symbol" },
	],
	edges: [
		{
			source: "file:registry",
			target: "file:types",
			relation: "imports",
			confidence: "EXTRACTED",
			location: { path: "src/registry.ts", startLine: 1 },
		},
		{
			source: "sym:registry",
			target: "sym:scale",
			relation: "calls",
			confidence: "EXTRACTED",
			location: { path: "src/registry.ts", startLine: 12 },
		},
		{ source: "sym:scale", target: "sym:registry", relation: "co_changed_with", confidence: "INFERRED" },
		{ source: "file:types", target: "file:registry", relation: "maybe_coupled", confidence: "AMBIGUOUS" },
	],
};
await Bun.write(`${repoRoot}/graphify-out/graph.json`, JSON.stringify(graph, null, 2));
await Bun.write("/tmp/opencode/tier3-graph-mismatch.json", JSON.stringify({ ...graph, builtAtCommit: "0".repeat(40) }));

const snapshot = await resolveRepositorySnapshot(repoRoot);
console.log("== T3a: Graphify artifact paths ==");
const matched = await collectExternalAdapterEvidence({
	repositoryRoot: repoRoot,
	snapshot,
	policy: { graphify: "enabled", scip: "off", requireSnapshotMatch: true },
});
console.log(
	`match:    ${matched[0]!.status} (${matched[0]!.evidence.length} candidates, ${matched[0]!.rejectedCount} rejected)`,
);
const mismatched = await collectExternalAdapterEvidence({
	repositoryRoot: repoRoot,
	snapshot,
	policy: { graphify: "enabled", scip: "off", requireSnapshotMatch: true },
});
// swap artifact to a wrong-commit build for the second probe
await Bun.write(
	`${repoRoot}/graphify-out/graph.json`,
	await Bun.file("/tmp/opencode/tier3-graph-mismatch.json").text(),
);
const rejected = await collectExternalAdapterEvidence({
	repositoryRoot: repoRoot,
	snapshot,
	policy: { graphify: "enabled", scip: "off", requireSnapshotMatch: true },
});
console.log(
	`mismatch: ${rejected[0]!.status} (${rejected[0]!.evidence.length} included, degraded: ${rejected[0]!.degradedSources[0]?.reason})`,
);
const staleLabeled = await collectExternalAdapterEvidence({
	repositoryRoot: repoRoot,
	snapshot,
	policy: { graphify: "enabled", scip: "off", requireSnapshotMatch: false },
});
console.log(
	`stale-ok: ${staleLabeled[0]!.status}; staleness=${JSON.stringify(staleLabeled[0]!.evidence[0]!.staleness)}`,
);
// restore the matching artifact
await Bun.write(`${repoRoot}/graphify-out/graph.json`, JSON.stringify(graph, null, 2));

// ---- T3b: ablation over three manifest conditions on CL-03 obligations ----
console.log("\n== T3b: PR 3A adapter ablation ==");
const policy = { id: "context-lineage-current-state-v1" };
const nativeManifest = await compileCurrentStateRepositoryManifest(repoRoot, {
	task: "widget registry weight scaling types",
	retrievalPolicy: { ...policy, maxEvidence: 8 },
	contextRendererVersion: "context-lineage-v1",
});
const collections = await collectExternalAdapterEvidence({
	repositoryRoot: repoRoot,
	snapshot: nativeManifest.snapshot,
	policy: { graphify: "enabled", scip: "enabled", requireSnapshotMatch: true, maxAdapterEvidenceItems: 4 },
});
const byId = new Map(collections.map(c => [c.adapterId, c]));
const graphOnly = mergeExternalEvidence(
	nativeManifest,
	byId.has("graphify-graph") ? [byId.get("graphify-graph")!] : [],
	4,
);
const scipOnly = mergeExternalEvidence(nativeManifest, byId.has("scip-index") ? [byId.get("scip-index")!] : [], 4);
const benchmark: RepositoryPlanningBenchmarkCase = {
	id: "T3-fixture",
	requiredScope: ["src/registry.ts"],
	requiredVerification: ["src/types.ts"],
};
const report = compareAdapterEvidenceAblations({
	conditions: [
		{ conditionId: "native", manifest: nativeManifest },
		{ conditionId: "native+graphify", manifest: graphOnly },
		{ conditionId: "native+scip", manifest: scipOnly },
	],
	nativeConditionId: "native",
	benchmark,
});
for (const [id, coverage] of Object.entries(report.conditions)) {
	console.log(
		`${id}: scope=${coverage.coveredScope.join("|") || "—"} verify=${coverage.coveredVerification.join("|") || "—"} unsupported=${coverage.unsupportedScope.length}`,
	);
}
console.log("unique useful vs native:");
for (const [id, unique] of Object.entries(report.uniqueUsefulByCondition))
	console.log(`  ${id}: ${unique.join("|") || "—"}`);
