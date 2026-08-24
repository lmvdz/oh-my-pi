import type {
	RepositoryPlanningSkillGenerator,
	RepositoryPlanningSkillRequest,
	RepositoryPlanningSkillValidation,
} from "./planning";
import { runRepositoryPlanningSkill } from "./planning";
import type { ContextLineagePlan, RepositoryContextManifest } from "./types";
import { stageTasks } from "./types";

export interface RepositoryPlanningBenchmarkCase {
	readonly id: string;
	readonly referenceCommit?: string;
	readonly task?: string;
	readonly requiredScope: readonly string[];
	readonly requiredVerification: readonly string[];
}

export interface RepositoryPlanningBenchmarkResult {
	readonly scopeRecall: number;
	readonly verificationRecall: number;
	/** Fraction of material plan tasks tied to frozen manifest evidence. */
	readonly evidenceTraceability: number;
	readonly unsupportedScope: readonly string[];
}

/** Reviewer-normalized claims from any planning path, including an unguided baseline. */
export interface RepositoryPlanningBenchmarkClaims {
	readonly scope: readonly string[];
	readonly verification: readonly string[];
}

export interface RepositoryPlanningBenchmarkComparison {
	readonly grounded: RepositoryPlanningBenchmarkResult;
	readonly unguided: RepositoryPlanningBenchmarkResult;
	readonly scopeRecallDelta: number;
	readonly verificationRecallDelta: number;
	readonly evidenceTraceabilityDelta: number;
}

/**
 * Reviewer adjudication persisted beside a comparison (PR 3 protocol). The
 * automated scores above are the pre-normalization floor; no default-enablement
 * decision may cite them without an attached review.
 */
export interface RepositoryPlanningBenchmarkReview {
	readonly reviewerId: string;
	readonly mode: "human" | "declared_rule";
	readonly rulesVersion: string;
	readonly grounded: RepositoryPlanningBenchmarkResult;
	readonly unguided: RepositoryPlanningBenchmarkResult;
}

/** v1 declared-rule reviewer: exact, basename-folded, and test/source-equivalent paths. */
export const DECLARED_RULE_REVIEWER_V1: Omit<RepositoryPlanningBenchmarkReview, "grounded" | "unguided"> = {
	reviewerId: "declared-rule:path-normalization",
	mode: "declared_rule",
	rulesVersion: "v1",
};

export interface UnguidedPlanningClaimsGenerator {
	generate(task: string): Promise<RepositoryPlanningBenchmarkClaims>;
}

export type RepositoryPlanningBenchmarkRun =
	| { readonly valid: false; readonly grounded: RepositoryPlanningSkillValidation }
	| {
			readonly valid: true;
			readonly grounded: RepositoryPlanningSkillValidation;
			readonly comparison: RepositoryPlanningBenchmarkComparison;
			readonly review: RepositoryPlanningBenchmarkReview;
	  };

/** Evaluate an evidence-grounded plan against known affected paths and verification obligations. */
export function evaluateRepositoryPlanningBenchmark(
	plan: ContextLineagePlan,
	manifest: RepositoryContextManifest,
	benchmark: RepositoryPlanningBenchmarkCase,
): RepositoryPlanningBenchmarkResult {
	const sourceRefByEvidenceId = new Map(manifest.evidence.map(evidence => [evidence.evidenceId, evidence.sourceRef]));
	const selectedScope = new Set<string>();
	const selectedVerification = new Set<string>();
	for (const stage of plan.stages) {
		const tasks = stageTasks(stage);
		for (const task of tasks) {
			for (const reference of task.evidence ?? []) {
				const sourceRef = sourceRefByEvidenceId.get(reference.evidenceId);
				if (!sourceRef) continue;
				if (reference.purpose === "scope") selectedScope.add(sourceRef);
				if (reference.purpose === "verification") selectedVerification.add(sourceRef);
			}
		}
	}
	const claims = evaluateRepositoryPlanningClaims(
		{ scope: [...selectedScope], verification: [...selectedVerification] },
		benchmark,
	);
	const tasks = plan.stages.flatMap(stage => stageTasks(stage));
	const citedTasks = tasks.filter(task => (task.evidence?.length ?? 0) > 0).length;
	return { ...claims, evidenceTraceability: tasks.length === 0 ? 0 : citedTasks / tasks.length };
}

/** Score normalized claims independently from how a planner obtained them. */
export function evaluateRepositoryPlanningClaims(
	claims: RepositoryPlanningBenchmarkClaims,
	benchmark: RepositoryPlanningBenchmarkCase,
): RepositoryPlanningBenchmarkResult {
	const scope = new Set(claims.scope);
	const verification = new Set(claims.verification);
	return {
		scopeRecall: recall(benchmark.requiredScope, scope),
		verificationRecall: recall(benchmark.requiredVerification, verification),
		evidenceTraceability: 0,
		unsupportedScope: [...scope]
			.filter(
				sourceRef =>
					!benchmark.requiredScope.includes(sourceRef) && !benchmark.requiredVerification.includes(sourceRef),
			)
			.sort(),
	};
}

/** Compare two plans against the same preserved benchmark obligations. */
export function compareRepositoryPlanningBenchmarks(
	groundedPlan: ContextLineagePlan,
	unguidedPlan: ContextLineagePlan,
	manifest: RepositoryContextManifest,
	benchmark: RepositoryPlanningBenchmarkCase,
): RepositoryPlanningBenchmarkComparison {
	const grounded = evaluateRepositoryPlanningBenchmark(groundedPlan, manifest, benchmark);
	const unguided = evaluateRepositoryPlanningBenchmark(unguidedPlan, manifest, benchmark);
	return compareRepositoryPlanningResults(grounded, unguided);
}

/** Compare independently scored planning outcomes. */
export function compareRepositoryPlanningResults(
	grounded: RepositoryPlanningBenchmarkResult,
	unguided: RepositoryPlanningBenchmarkResult,
): RepositoryPlanningBenchmarkComparison {
	return {
		grounded,
		unguided,
		scopeRecallDelta: grounded.scopeRecall - unguided.scopeRecall,
		verificationRecallDelta: grounded.verificationRecall - unguided.verificationRecall,
		evidenceTraceabilityDelta: grounded.evidenceTraceability - unguided.evidenceTraceability,
	};
}

/**
 * Adjudicate near-miss claims with the v1 declared rules: a claimed path counts
 * toward a required path when it is exact, extension-folded, or its test/source
 * equivalent. Unmatched claims stay untouched so they still surface as
 * unsupported scope.
 */
export function adjudicateBenchmarkWithDeclaredRules(
	groundedClaims: RepositoryPlanningBenchmarkClaims,
	unguidedClaims: RepositoryPlanningBenchmarkClaims,
	benchmark: RepositoryPlanningBenchmarkCase,
): RepositoryPlanningBenchmarkReview {
	const requiredPaths = [...benchmark.requiredScope, ...benchmark.requiredVerification];
	return {
		...DECLARED_RULE_REVIEWER_V1,
		grounded: evaluateRepositoryPlanningClaims(normalizeClaimPaths(groundedClaims, requiredPaths), benchmark),
		unguided: evaluateRepositoryPlanningClaims(normalizeClaimPaths(unguidedClaims, requiredPaths), benchmark),
	};
}

function normalizeClaimPaths(
	claims: RepositoryPlanningBenchmarkClaims,
	requiredPaths: readonly string[],
): RepositoryPlanningBenchmarkClaims {
	const requiredByFold = new Map(requiredPaths.map(requiredPath => [foldRequiredPath(requiredPath), requiredPath]));
	const resolve = (claimedPath: string): string => requiredByFold.get(foldRequiredPath(claimedPath)) ?? claimedPath;
	return {
		scope: [...new Set(claims.scope.map(resolve))],
		verification: [...new Set(claims.verification.map(resolve))],
	};
}

/** Extension-folded key that also equates `foo.test.ts`/`foo.spec.ts` with `foo.ts`. */
function foldRequiredPath(candidatePath: string): string {
	return candidatePath
		.replaceAll("\\", "/")
		.toLowerCase()
		.replace(/\.(test|spec)\./, ".")
		.replace(/\.[a-z]+$/, "");
}

/** Run grounded and unguided planning paths against one identical benchmark case. */
export async function runRepositoryPlanningBenchmark(input: {
	readonly request: RepositoryPlanningSkillRequest;
	readonly benchmark: RepositoryPlanningBenchmarkCase;
	readonly groundedGenerator: RepositoryPlanningSkillGenerator;
	readonly unguidedGenerator: UnguidedPlanningClaimsGenerator;
}): Promise<RepositoryPlanningBenchmarkRun> {
	const grounded = await runRepositoryPlanningSkill(input.request, input.groundedGenerator);
	if (!grounded.valid) return { valid: false, grounded };
	const unguidedClaims = await input.unguidedGenerator.generate(input.request.task);
	const groundedResult = evaluateRepositoryPlanningBenchmark(grounded.plan, input.request.manifest, input.benchmark);
	const unguidedResult = evaluateRepositoryPlanningClaims(unguidedClaims, input.benchmark);
	const groundedClaims = planEvidenceClaims(grounded.plan, input.request.manifest);
	return {
		valid: true,
		grounded,
		comparison: compareRepositoryPlanningResults(groundedResult, unguidedResult),
		review: adjudicateBenchmarkWithDeclaredRules(groundedClaims, unguidedClaims, input.benchmark),
	};
}

/** Extract the manifest-cited scope and verification claims a grounded plan asserted. */
function planEvidenceClaims(
	plan: ContextLineagePlan,
	manifest: RepositoryContextManifest,
): RepositoryPlanningBenchmarkClaims {
	const sourceRefByEvidenceId = new Map(manifest.evidence.map(evidence => [evidence.evidenceId, evidence.sourceRef]));
	const scope = new Set<string>();
	const verification = new Set<string>();
	for (const stage of plan.stages) {
		for (const task of stageTasks(stage)) {
			for (const reference of task.evidence ?? []) {
				const sourceRef = sourceRefByEvidenceId.get(reference.evidenceId);
				if (!sourceRef) continue;
				if (reference.purpose === "scope") scope.add(sourceRef);
				if (reference.purpose === "verification") verification.add(sourceRef);
			}
		}
	}
	return { scope: [...scope], verification: [...verification] };
}

function recall(required: readonly string[], selected: ReadonlySet<string>): number {
	if (required.length === 0) return 1;
	return required.filter(sourceRef => selected.has(sourceRef)).length / required.length;
}

// ---------------------------------------------------------------------------
// PR 3A adapter ablation (§PR 3A / §34.7): compare manifest conditions —
// native-only versus adapter-enriched — on the same benchmark obligations and
// budgets. The report separates unique useful evidence from duplicates, stale
// facts, and unsupported-scope growth so adoption decisions cannot be argued
// from raw evidence volume.
// ---------------------------------------------------------------------------

export interface AdapterAblationCondition {
	readonly conditionId: string;
	readonly manifest: RepositoryContextManifest;
}

export interface AdapterAblationCoverage {
	readonly coveredScope: readonly string[];
	readonly coveredVerification: readonly string[];
	/** Claimed paths that satisfy no benchmark obligation. */
	readonly unsupportedScope: readonly string[];
	/** Included adapter evidence explicitly labeled stale. */
	readonly staleFacts: readonly string[];
}

export interface AdapterAblationReport {
	readonly nativeConditionId: string;
	readonly conditions: Readonly<Record<string, AdapterAblationCoverage>>;
	/** Obligation coverage each condition adds beyond the native condition. */
	readonly uniqueUsefulByCondition: Readonly<Record<string, readonly string[]>>;
	/** Obligation coverage an adapter condition shares with the native condition. */
	readonly duplicateWithNative: Readonly<Record<string, readonly string[]>>;
}

export function compareAdapterEvidenceAblations(input: {
	readonly conditions: readonly AdapterAblationCondition[];
	readonly nativeConditionId: string;
	readonly benchmark: RepositoryPlanningBenchmarkCase;
}): AdapterAblationReport {
	const required = new Set([...input.benchmark.requiredScope, ...input.benchmark.requiredVerification]);
	const coverages = new Map<string, AdapterAblationCoverage>();
	for (const condition of input.conditions) {
		const scope = new Set(
			condition.manifest.evidence
				.filter(item => input.benchmark.requiredScope.includes(item.sourceRef))
				.map(item => item.sourceRef),
		);
		const verification = new Set(
			condition.manifest.evidence
				.filter(item => input.benchmark.requiredVerification.includes(item.sourceRef))
				.map(item => item.sourceRef),
		);
		coverages.set(condition.conditionId, {
			coveredScope: [...scope].sort(),
			coveredVerification: [...verification].sort(),
			unsupportedScope: condition.manifest.evidence
				.map(item => item.sourceRef)
				.filter(sourceRef => !required.has(sourceRef))
				.filter((sourceRef, index, all) => all.indexOf(sourceRef) === index)
				.sort(),
			staleFacts: condition.manifest.evidence
				.filter(item => item.staleness?.state === "stale")
				.map(item => item.sourceRef)
				.filter((sourceRef, index, all) => all.indexOf(sourceRef) === index)
				.sort(),
		});
	}
	const nativeCoverage = coverages.get(input.nativeConditionId);
	const nativeSet = new Set([...(nativeCoverage?.coveredScope ?? []), ...(nativeCoverage?.coveredVerification ?? [])]);
	const uniqueUsefulByCondition: Record<string, readonly string[]> = {};
	const duplicateWithNative: Record<string, readonly string[]> = {};
	for (const [conditionId, coverage] of coverages) {
		const coveredSet = [...coverage.coveredScope, ...coverage.coveredVerification];
		if (conditionId === input.nativeConditionId) {
			uniqueUsefulByCondition[conditionId] = [];
			duplicateWithNative[conditionId] = [];
			continue;
		}
		uniqueUsefulByCondition[conditionId] = coveredSet.filter(sourceRef => !nativeSet.has(sourceRef)).sort();
		duplicateWithNative[conditionId] = coveredSet.filter(sourceRef => nativeSet.has(sourceRef)).sort();
	}
	return {
		nativeConditionId: input.nativeConditionId,
		conditions: Object.fromEntries(coverages),
		uniqueUsefulByCondition,
		duplicateWithNative,
	};
}
