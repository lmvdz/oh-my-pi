// T4a: real Gate B reviewer packet — grounded (manifest) vs unguided planning
// through the production planning-skill path, scored + adjudicated with the
// declared-rule reviewer. Repeated samples are intentionally independent: a
// favorable one-off provider output must not be used as Gate B evidence.
import {
	CONTEXT_LINEAGE_BENCHMARK_CASES,
	benchmarkRepositoryContextLineage,
	createEphemeralRepositoryPlanningSkillGenerator,
	createEphemeralUnguidedPlanningClaimsGenerator,
	prepareRepositoryContextLineage,
	type RepositoryPlanningBenchmarkCase,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";

const caseId = process.argv[2] ?? "CL-02";
const requestedBenchmarkCase = CONTEXT_LINEAGE_BENCHMARK_CASES.find(c => c.id === caseId);
if (!requestedBenchmarkCase) throw new Error(`unknown benchmark case ${caseId}`);
const benchmarkCase: RepositoryPlanningBenchmarkCase = requestedBenchmarkCase;
const samples = parseSampleCount(process.argv[3]);

interface GateBSample {
	readonly valid: boolean;
	readonly scopeDelta?: number;
	readonly verificationDelta?: number;
	readonly traceabilityDelta?: number;
	readonly reviewerUnsupportedDelta?: number;
}

const results: GateBSample[] = [];
for (let sample = 1; sample <= samples; sample++) {
	console.log(`\n=== ${benchmarkCase.id} sample ${sample}/${samples} ===`);
	results.push(await runSample(sample));
}
printSummary(results);

async function runSample(sample: number): Promise<GateBSample> {
console.log("creating session…");
const { session } = await createAgentSession({
	cwd: import.meta.dir + "/../..",
	modelPattern: "gpt-5.4-mini",
	thinkingLevel: "off",
	enableLsp: false,
	enableMCP: false,
	disableExtensionDiscovery: true,
});
try {
console.log("compiling frozen manifest for this repo…");
const t0 = performance.now();
const prepared = await prepareRepositoryContextLineage({
	cwd: import.meta.dir + "/../..",
	task: benchmarkCase.task ?? benchmarkCase.id,
	journal: session.sessionManager,
});
console.log(
	`manifest ${prepared.manifest.manifestId.slice(0, 44)}… (${prepared.manifest.evidence.length} items, ${(performance.now() - t0).toFixed(0)}ms)`,
);
console.log(
	"selected evidence:",
	prepared.manifest.evidence.map(evidence => `${evidence.sourceKind}:${evidence.sourceRef}`).join(", "),
);
console.log(
	"required omissions:",
	prepared.manifest.omissions
		.filter(omission => [...benchmarkCase.requiredScope, ...benchmarkCase.requiredVerification].includes(omission.sourceRef))
		.map(omission => `${omission.reason}:${omission.sourceRef}`)
		.join(", ") || "none",
);

console.log("running grounded vs unguided planning…");
const result = await benchmarkRepositoryContextLineage({
	prepared,
	benchmark: benchmarkCase,
	journal: session.sessionManager,
	groundedGenerator: createEphemeralRepositoryPlanningSkillGenerator(session),
	unguidedGenerator: createEphemeralUnguidedPlanningClaimsGenerator(session),
});
const run = result.run;

if (!run.valid) {
	console.log(
		"grounded planning FAILED:",
		run.grounded.phase === "semantic" ? run.grounded.result.issues[0]?.message : run.grounded.error,
	);
	printArtifactLocation(session.sessionManager.getSessionFile(), result.groundedResponseArtifactId);
	return { valid: false };
}
const { comparison, review } = run;
for (const [label, r] of [
	["automated/grounded", comparison.grounded],
	["automated/unguided", comparison.unguided],
	["reviewer/grounded", review.grounded],
	["reviewer/unguided", review.unguided],
] as const) {
	console.log(
		`${label}: scopeRecall=${(r.scopeRecall * 100).toFixed(0)}% verifyRecall=${(r.verificationRecall * 100).toFixed(0)}% unsupported=${r.unsupportedScope.length}`,
	);
}
console.log("\nreviewer:", review.reviewerId, review.mode, review.rulesVersion);
console.log(
	"deltas: scope",
	comparison.scopeRecallDelta.toFixed(2),
	"verify",
	comparison.verificationRecallDelta.toFixed(2),
	"traceability",
	comparison.evidenceTraceabilityDelta.toFixed(2),
);
printArtifactLocation(session.sessionManager.getSessionFile(), result.groundedResponseArtifactId);
return {
	valid: true,
	scopeDelta: comparison.scopeRecallDelta,
	verificationDelta: comparison.verificationRecallDelta,
	traceabilityDelta: comparison.evidenceTraceabilityDelta,
	reviewerUnsupportedDelta: review.grounded.unsupportedScope.length - review.unguided.unsupportedScope.length,
};
} finally {
	await session.dispose();
}
}

function parseSampleCount(value: string | undefined): number {
	if (value === undefined) return 1;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
		throw new Error("sample count must be a safe integer from 1 through 10");
	}
	return parsed;
}

function printArtifactLocation(sessionFile: string | undefined, artifactId: string | undefined): void {
	console.log("benchmark session:", sessionFile ?? "unavailable");
	console.log("grounded response artifact:", artifactId ? `artifact://${artifactId}` : "unavailable");
}

function printSummary(samples: readonly GateBSample[]): void {
	const valid = samples.filter(sample => sample.valid);
	const mean = (key: "scopeDelta" | "verificationDelta" | "traceabilityDelta" | "reviewerUnsupportedDelta") =>
		valid.length === 0 ? 0 : valid.reduce((total, sample) => total + (sample[key] ?? 0), 0) / valid.length;
	const noUnsupportedRegression = valid.every(sample => (sample.reviewerUnsupportedDelta ?? 0) <= 0);
	console.log(
		`Gate B stability summary: ${valid.length}/${samples.length} valid; mean scope Δ ${mean("scopeDelta").toFixed(2)}, verification Δ ${mean("verificationDelta").toFixed(2)}, traceability Δ ${mean("traceabilityDelta").toFixed(2)}, reviewer unsupported Δ ${mean("reviewerUnsupportedDelta").toFixed(2)}; no unsupported regression=${noUnsupportedRegression}.`,
	);
}
