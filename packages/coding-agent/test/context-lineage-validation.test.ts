import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
	adjudicateBenchmarkWithDeclaredRules,
	adjudicateContextLineageOutcomeCorpus,
	appendContextLineageSessionRecord,
	archiveNamedBaseRecord,
	benchmarkRepositoryContextLineage,
	CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES,
	CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1,
	type ContextLineagePlan,
	ContextLineageRunController,
	type ContextLineageSessionRecord,
	collectLocalDocumentaryEvidence,
	collectTemporalEvidence,
	compareRepositoryPlanningBenchmarks,
	compareRepositoryPlanningResults,
	compileCurrentStateRepositoryManifest,
	contextLineageArtifactContentDigest,
	contextLineageCheckpointRetention,
	contextLineageEvaluatorInputDigest,
	contextLineagePlanIdentity,
	contextUtilityByCheckpoint,
	createAdaptiveDeliberationRecord,
	createArtifactManagerContextLineageOutputVerifier,
	createBlindedCandidateContextLineageReviewer,
	createBlindedCandidateReview,
	createCandidateContextLineageTaskRunner,
	createCheckpointExtensionCheckpoint,
	createContextLineageBaseSelectionFallback,
	createContextLineageBenchmarkRecord,
	createContextLineageCandidateAdjudicationRecord,
	createContextLineageCandidateAdjudicator,
	createContextLineageCandidateAllocationStopRecord,
	createContextLineageCandidateCheckpointRecord,
	createContextLineageCandidateCheckpointReplay,
	createContextLineageCandidateCompletionRecord,
	createContextLineageCandidateDiscardRecord,
	createContextLineageCandidateFamily,
	createContextLineageCandidateFamilyRecord,
	createContextLineageCandidateReviewRecord,
	createContextLineageCandidateSelectionSessionRecord,
	createContextLineageExecutionRecord,
	createContextLineageSelectionRecord,
	createControlledReasoningBenchmarkRecord,
	createEphemeralRepositoryPlanningSkillGenerator,
	createNamedBaseRecord,
	createRepositoryContextManifest,
	createRepositoryManifestCheckpoint,
	createRepositoryPreparedPrefix,
	createSideRequestContextLineageTaskRunner,
	createWayfinderContextLineageBinding,
	decideAdaptiveDeliberation,
	deleteNamedBaseRecord,
	discardContextLineageOutput,
	evaluateContextLineageDeclaredOutcome,
	evaluateContextLineageStructuredOutcomeMeasurement,
	evaluateControlledReasoningBenchmark,
	evaluateRepositoryPlanningBenchmark,
	evaluateRepositoryPlanningClaims,
	executeContextLineagePlan,
	FAKE_LINEAGE_PROVIDER,
	FakePrefixCache,
	fanoutSharedCost,
	firstPrefixDivergence,
	getContextLineageSessionRecords,
	inferTemporalRetrievalProfile,
	isRepositoryContextManifestIntact,
	isWayfinderContextLineageBindingIntact,
	type LogicalContextCheckpoint,
	logicalCheckpointIdentity,
	lowerFanoutRequest,
	mergeDocumentaryEvidence,
	mergeTemporalEvidence,
	type PlanFailurePolicy,
	type PreparedPrefix,
	parseContextLineageStructuredCandidateOutcome,
	parseRepositoryPlanningSkillResponse,
	parseUnguidedPlanningClaimsResponse,
	partitionCompatibilityFamilies,
	planInducedReuse,
	planRepositoryContextLineage,
	planWayfinderContextLineage,
	preparedPrefixIdentity,
	prepareRepositoryContextLineage,
	prepareWayfinderContextLineage,
	promoteContextLineageResult,
	type RepositoryContextManifest,
	recordConditionalPreparation,
	renderContextLineagePlanInspection,
	renderRepositoryContextManifest,
	renderRepositoryPlanningSkillRequest,
	renderUnguidedPlanningClaimsRequest,
	repositoryManifestIdentity,
	repositoryOverlayDigest,
	resolveContextLineageCandidateFamily,
	resolveNamedBase,
	resolvePlanNamedBases,
	resolveRepositorySnapshot,
	runRepositoryPlanningBenchmark,
	runRepositoryPlanningSkill,
	scheduleContextLineageReadyTasks,
	selectContextLineageBase,
	semanticIdentity,
	serializeCheckpointExtensionOutputs,
	serializeRepositoryContextManifest,
	stripRepositoryManifestSource,
	summarizeConditionalPreparations,
	summarizeContextLineageSession,
	summarizeRepositoryContextManifest,
	validateContextLineagePlan,
	validateFanoutRequest,
	validateRepositoryPlanningSkillResponse,
	verifyControlledReasoningArtifactIntegrity,
	verifyExactFamily,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { logger, prompt, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import fullDepthEvaluationPrompt from "../src/prompts/context-lineage/candidate-full-depth-evaluation.md" with {
	type: "text",
};
import preliminaryEvaluationPrompt from "../src/prompts/context-lineage/candidate-preliminary-evaluation.md" with {
	type: "text",
};
import structuredOutcomeEvaluationPrompt from "../src/prompts/context-lineage/candidate-structured-outcome-evaluation.md" with {
	type: "text",
};
import type { AgentSession } from "../src/session/agent-session";
import { ArtifactManager } from "../src/session/artifacts";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

const manifest: RepositoryContextManifest = {
	version: 1,
	manifestId: "manifest-1",
	snapshot: {
		version: 1,
		repositoryId: "repo-1",
		workspaceScopeId: "scope-1",
		headCommit: "abc123",
		untrackedPolicy: "exclude",
	},
	taskDigest: "task-1",
	retrievalPolicyId: "current-state-v1",
	contextRendererVersion: "v1",
	evidence: [
		{
			evidenceId: "evidence-1",
			evidenceClass: "current_structural",
			sourceKind: "file",
			sourceRef: "src/example.ts",
			sourceVersion: "abc123",
			adapterId: "native",
			adapterSchemaVersion: "v1",
			determinism: "deterministic",
			authority: "current",
			extractionMethod: "read",
			inclusionReason: "task scope",
		},
	],
	omissions: [],
	degradedSources: [],
};

const checkpoint: LogicalContextCheckpoint = {
	version: 1,
	checkpointId: "checkpoint-1",
	origin: "repository_manifest",
	materialization: "repository_manifest",
	securityScopeId: "scope-1",
	workspaceScopeId: "workspace-1",
	contentRootHash: "content-1",
	repositoryManifestId: "manifest-1",
	createdAt: 1,
};

const prefix: PreparedPrefix = {
	version: 1,
	preparedPrefixId: "prefix-1",
	checkpointId: "checkpoint-1",
	target: { provider: "test", model: "model-1" },
	rendererContractVersion: "v1",
	providerContextDigest: "context-1",
	expectedSharedBytes: 1024,
	compatibilityProfileVersion: "v1",
	createdAt: 1,
};

function plan(overrides: Partial<ContextLineagePlan> = {}): ContextLineagePlan {
	return {
		version: 1,
		title: "Plan",
		bases: [{ id: "base-1", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
		stages: [
			{
				id: "review",
				mode: "fanout",
				base: { type: "base", baseId: "base-1" },
				capabilityRequirements: { workspaceMode: "frozen_read_only" },
				tasks: [
					{
						id: "scope",
						assignment: "Review scope",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
					{
						id: "verify",
						assignment: "Review verification",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "verification" }],
					},
				],
			},
		],
		...overrides,
	};
}

async function createRepositoryFixture(files: Readonly<Record<string, string>>): Promise<TempDir> {
	const tempDir = TempDir.createSync("@omp-context-lineage-repository-");
	for (const [relativePath, content] of Object.entries(files))
		await Bun.write(`${tempDir.path()}/${relativePath}`, content);
	await $`git init --initial-branch=main`.cwd(tempDir.path()).quiet();
	await $`git add .`.cwd(tempDir.path()).quiet();
	await $`git -c user.name=Test -c user.email=test@example.com commit -m fixture`.cwd(tempDir.path()).quiet();
	return tempDir;
}

function executionRecordsOf(
	journal: Parameters<typeof getContextLineageSessionRecords>[0],
	runId?: string,
): Extract<ContextLineageSessionRecord, { kind: "execution" }>[] {
	return getContextLineageSessionRecords(journal).filter(
		(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
			record.kind === "execution" && (runId === undefined || record.runId === runId),
	);
}

describe("Context Lineage plan validation", () => {
	it("accepts a repository-grounded fanout with evidence from its declared manifest", () => {
		const result = validateContextLineagePlan(plan(), [manifest]);
		expect(result).toEqual({ valid: true, issues: [] });
	});

	it("keeps /context diagnostic-only and routes lineage arguments through the dedicated command", () => {
		const context = lookupBuiltinSlashCommand("context");
		expect(context?.allowArgs).toBeUndefined();
		const lineage = lookupBuiltinSlashCommand("lineage");
		expect(lineage?.allowArgs).toBe(true);
		expect(lineage?.inlineHint).toContain("[status|show");
		expect(lineage?.description).toContain("frozen repository context");
		const fanout = lookupBuiltinSlashCommand("fanout");
		expect(fanout?.allowArgs).toBe(true);
		expect(fanout?.inlineHint).toContain("question 1");
	});

	it("reuses a durable compatible base through /fanout and exposes its prefix rationale in diagnostics", async () => {
		using repo = await createRepositoryFixture({
			"src/cache-prefix.ts": "export function cachePrefix() { return 'stable'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const prepared = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const durableBasePlan = lowerFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: [
						{ question: "Review cache prefix behavior" },
						{ question: "Review cache prefix verification" },
					],
				},
				{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
			);
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "plan",
				plan: durableBasePlan,
				planId: contextLineagePlanIdentity(durableBasePlan),
				manifestId: prepared.manifest.manifestId,
				checkpointId: prepared.checkpoint.checkpointId,
			});
			const fanout = lookupBuiltinSlashCommand("fanout");
			const lineage = lookupBuiltinSlashCommand("lineage");
			expect(fanout?.handle).toBeDefined();
			expect(lineage?.handle).toBeDefined();
			const session = {
				sessionId: "context-lineage-base-selection-test",
				async runEphemeralTurn() {
					return { replyText: "sidecar answer" };
				},
			} as unknown as AgentSession;
			const runtime = {
				session,
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd: repo.path(),
				output: async (text: string) => {
					outputs.push(text);
				},
				refreshCommands: async () => {},
				reloadPlugins: async () => {},
			};
			await fanout!.handle!(
				{ name: "fanout", args: "Review cache prefix behavior | Review cache prefix verification", text: "fanout" },
				runtime,
			);
			const records = getContextLineageSessionRecords(manager);
			const selection = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection" }> =>
					record.kind === "base_selection",
			);
			expect(selection).toBeDefined();
			expect(selection!.selection.expectedSharedBytes).toBeGreaterThan(0);
			expect(selection!.selection.checkpointId).toBe(prepared.checkpoint.checkpointId);
			const execution = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
					record.kind === "execution" && record.stageId === undefined && record.status === "completed",
			);
			expect(execution?.runId).toBeDefined();
			await lineage!.handle!({ name: "lineage", args: `diagnostics ${execution!.runId}`, text: "lineage" }, runtime);
			expect(outputs.at(-1)).toContain(`Selected persisted context: ${prepared.checkpoint.checkpointId}`);
			expect(outputs.at(-1)).toContain("expected shared prefix");
		} finally {
			await manager.close();
			resetSettingsForTest();
		}
	});

	it("selects the more task-relevant compatible base through /fanout before considering prefix size", async () => {
		using repo = await createRepositoryFixture({
			"src/engine.ts": "export function cacheEngine() { return 'cache prefix'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const relevant = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const primaryEvidence = relevant.manifest.evidence[0];
			if (!primaryEvidence) throw new Error("expected cache evidence");
			const broaderManifest = createRepositoryContextManifest({
				snapshot: relevant.manifest.snapshot,
				task: "Review cache behavior workflow",
				retrievalPolicy: { id: "current-state-broader-prefix-v1" },
				contextRendererVersion: relevant.manifest.contextRendererVersion,
				evidence: [
					...relevant.manifest.evidence,
					{
						...primaryEvidence,
						evidenceId: `${primaryEvidence.evidenceId}-broader-prefix-extension`,
						inclusionReason: "additional broader prefix evidence",
					},
				],
				omissions: relevant.manifest.omissions,
				degradedSources: relevant.manifest.degradedSources,
			});
			const broaderCheckpoint = createRepositoryManifestCheckpoint(broaderManifest);
			const broaderArtifactId = await manager.saveArtifact(
				serializeRepositoryContextManifest(broaderManifest),
				"context-lineage-manifest",
			);
			if (!broaderArtifactId) throw new Error("expected persisted broader manifest artifact");
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "repository_manifest",
				manifest: stripRepositoryManifestSource(broaderManifest),
				manifestArtifactId: broaderArtifactId,
			});
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "logical_checkpoint",
				checkpoint: broaderCheckpoint,
			});
			const relevantPlan = lowerFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: [
						{ question: "Review cache prefix behavior" },
						{ question: "Review cache prefix verification" },
					],
				},
				{ type: "checkpoint", checkpointId: relevant.checkpoint.checkpointId },
			);
			const broaderPlan = lowerFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: [{ question: "Review cache behavior" }, { question: "Review cache verification" }],
				},
				{ type: "checkpoint", checkpointId: broaderCheckpoint.checkpointId },
			);
			for (const [plan, manifestId, checkpointId] of [
				[relevantPlan, relevant.manifest.manifestId, relevant.checkpoint.checkpointId],
				[broaderPlan, broaderManifest.manifestId, broaderCheckpoint.checkpointId],
			] as const) {
				appendContextLineageSessionRecord(manager, {
					version: 1,
					kind: "plan",
					plan,
					planId: contextLineagePlanIdentity(plan),
					manifestId,
					checkpointId,
				});
			}
			const fanout = lookupBuiltinSlashCommand("fanout");
			const lineage = lookupBuiltinSlashCommand("lineage");
			expect(fanout?.handle).toBeDefined();
			expect(lineage?.handle).toBeDefined();
			const session = {
				sessionId: "context-lineage-base-ranking-test",
				async runEphemeralTurn() {
					return { replyText: "sidecar answer" };
				},
			} as unknown as AgentSession;
			const runtime = {
				session,
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd: repo.path(),
				output: async (text: string) => {
					outputs.push(text);
				},
				refreshCommands: async () => {},
				reloadPlugins: async () => {},
			};
			await fanout!.handle!(
				{ name: "fanout", args: "Review cache prefix behavior | Review cache prefix verification", text: "fanout" },
				runtime,
			);
			const records = getContextLineageSessionRecords(manager);
			const selection = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection" }> =>
					record.kind === "base_selection",
			);
			expect(selection?.selection.planId).toBe(contextLineagePlanIdentity(relevantPlan));
			expect(selection?.selection.rejected).toContainEqual({
				planId: contextLineagePlanIdentity(broaderPlan),
				checkpointId: broaderCheckpoint.checkpointId,
				reason: "lower_relevance",
			});
			const execution = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
					record.kind === "execution" && record.stageId === undefined && record.status === "completed",
			);
			expect(execution?.runId).toBeDefined();
			await lineage!.handle!({ name: "lineage", args: `diagnostics ${execution!.runId}`, text: "lineage" }, runtime);
			expect(outputs.at(-1)).toContain(`Selected persisted context: ${relevant.checkpoint.checkpointId}`);
			expect(outputs.at(-1)).toContain("lower_relevance: 1");
		} finally {
			await manager.close();
			resetSettingsForTest();
		}
	});

	it("selects the larger equally relevant prefix through /fanout after a session restart", async () => {
		using repo = await createRepositoryFixture({
			"src/engine.ts": "export function cacheEngine() { return 'cache prefix'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const smaller = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const primaryEvidence = smaller.manifest.evidence[0];
			if (!primaryEvidence) throw new Error("expected cache evidence");
			const largerManifest = createRepositoryContextManifest({
				snapshot: smaller.manifest.snapshot,
				task: "Review cache prefix workflow",
				retrievalPolicy: { id: "current-state-prefix-expansion-v1" },
				contextRendererVersion: smaller.manifest.contextRendererVersion,
				evidence: [
					...smaller.manifest.evidence,
					{
						...primaryEvidence,
						evidenceId: `${primaryEvidence.evidenceId}-prefix-extension`,
						inclusionReason: "additional stable prefix evidence",
					},
				],
				omissions: smaller.manifest.omissions,
				degradedSources: smaller.manifest.degradedSources,
			});
			const largerCheckpoint = createRepositoryManifestCheckpoint(largerManifest);
			const largerArtifactId = await manager.saveArtifact(
				serializeRepositoryContextManifest(largerManifest),
				"context-lineage-manifest",
			);
			if (!largerArtifactId) throw new Error("expected persisted larger manifest artifact");
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "repository_manifest",
				manifest: stripRepositoryManifestSource(largerManifest),
				manifestArtifactId: largerArtifactId,
			});
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "logical_checkpoint",
				checkpoint: largerCheckpoint,
			});
			const questions = [
				{ question: "Review cache prefix behavior" },
				{ question: "Review cache prefix verification" },
			] as const;
			const smallerPlan = lowerFanoutRequest(
				{ version: 1, checkpoint: { type: "current_idle" }, questions },
				{ type: "checkpoint", checkpointId: smaller.checkpoint.checkpointId },
			);
			const largerPlan = lowerFanoutRequest(
				{ version: 1, checkpoint: { type: "current_idle" }, questions },
				{ type: "checkpoint", checkpointId: largerCheckpoint.checkpointId },
			);
			for (const [plan, manifestId, checkpointId] of [
				[smallerPlan, smaller.manifest.manifestId, smaller.checkpoint.checkpointId],
				[largerPlan, largerManifest.manifestId, largerCheckpoint.checkpointId],
			] as const) {
				appendContextLineageSessionRecord(manager, {
					version: 1,
					kind: "plan",
					plan,
					planId: contextLineagePlanIdentity(plan),
					manifestId,
					checkpointId,
				});
			}
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await manager.close();
			const recoveredManager = await SessionManager.open(sessionFile!, `${repo.path()}/sessions`, undefined, {
				initialCwd: repo.path(),
				suppressBreadcrumb: true,
			});
			try {
				const fanout = lookupBuiltinSlashCommand("fanout");
				const lineage = lookupBuiltinSlashCommand("lineage");
				expect(fanout?.handle).toBeDefined();
				expect(lineage?.handle).toBeDefined();
				const session = {
					sessionId: "context-lineage-base-prefix-ranking-test",
					async runEphemeralTurn() {
						return { replyText: "sidecar answer" };
					},
				} as unknown as AgentSession;
				const runtime = {
					session,
					sessionManager: recoveredManager,
					settings: Settings.isolated(),
					cwd: repo.path(),
					output: async (text: string) => {
						outputs.push(text);
					},
					refreshCommands: async () => {},
					reloadPlugins: async () => {},
				};
				await fanout!.handle!(
					{
						name: "fanout",
						args: "Review cache prefix behavior | Review cache prefix verification",
						text: "fanout",
					},
					runtime,
				);
				const records = getContextLineageSessionRecords(recoveredManager);
				const selection = records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection" }> =>
						record.kind === "base_selection",
				);
				expect(selection?.selection.planId).toBe(contextLineagePlanIdentity(largerPlan));
				expect(selection?.selection.rejected).toContainEqual({
					planId: contextLineagePlanIdentity(smallerPlan),
					checkpointId: smaller.checkpoint.checkpointId,
					reason: "smaller_shared_prefix",
				});
				const execution = records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
						record.kind === "execution" && record.stageId === undefined && record.status === "completed",
				);
				expect(execution?.runId).toBeDefined();
				await lineage!.handle!(
					{ name: "lineage", args: `diagnostics ${execution!.runId}`, text: "lineage" },
					runtime,
				);
				expect(outputs.at(-1)).toContain(`Selected persisted context: ${largerCheckpoint.checkpointId}`);
				expect(outputs.at(-1)).toContain("smaller_shared_prefix: 1");
			} finally {
				await recoveredManager.close();
			}
		} finally {
			resetSettingsForTest();
		}
	});

	it("uses plan identity to break an equal-prefix /fanout selection tie after a session restart", async () => {
		using repo = await createRepositoryFixture({
			"src/engine.ts": "export function cacheEngine() { return 'cache prefix'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const prepared = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const plans = ["a", "b"].map(suffix =>
				lowerFanoutRequest(
					{
						version: 1,
						checkpoint: { type: "current_idle" },
						questions: [
							{ question: `Review cache prefix behavior ${suffix}` },
							{ question: `Review cache prefix verification ${suffix}` },
						],
					},
					{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
				),
			);
			for (const plan of plans) {
				appendContextLineageSessionRecord(manager, {
					version: 1,
					kind: "plan",
					plan,
					planId: contextLineagePlanIdentity(plan),
					manifestId: prepared.manifest.manifestId,
					checkpointId: prepared.checkpoint.checkpointId,
				});
			}
			const [winningPlanId, rejectedPlanId] = plans.map(contextLineagePlanIdentity).sort();
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await manager.close();
			const recoveredManager = await SessionManager.open(sessionFile!, `${repo.path()}/sessions`, undefined, {
				initialCwd: repo.path(),
				suppressBreadcrumb: true,
			});
			try {
				const fanout = lookupBuiltinSlashCommand("fanout");
				const lineage = lookupBuiltinSlashCommand("lineage");
				expect(fanout?.handle).toBeDefined();
				expect(lineage?.handle).toBeDefined();
				const session = {
					sessionId: "context-lineage-base-plan-id-tiebreak-test",
					async runEphemeralTurn() {
						return { replyText: "sidecar answer" };
					},
				} as unknown as AgentSession;
				const runtime = {
					session,
					sessionManager: recoveredManager,
					settings: Settings.isolated(),
					cwd: repo.path(),
					output: async (text: string) => {
						outputs.push(text);
					},
					refreshCommands: async () => {},
					reloadPlugins: async () => {},
				};
				await fanout!.handle!(
					{
						name: "fanout",
						args: "Review cache prefix behavior | Review cache prefix verification",
						text: "fanout",
					},
					runtime,
				);
				const records = getContextLineageSessionRecords(recoveredManager);
				const selection = records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection" }> =>
						record.kind === "base_selection",
				);
				expect(selection?.selection.planId).toBe(winningPlanId);
				expect(selection?.selection.rejected).toContainEqual({
					planId: rejectedPlanId,
					checkpointId: prepared.checkpoint.checkpointId,
					reason: "plan_id_tiebreak",
				});
				const execution = records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
						record.kind === "execution" && record.stageId === undefined && record.status === "completed",
				);
				expect(execution?.runId).toBeDefined();
				await lineage!.handle!(
					{ name: "lineage", args: `diagnostics ${execution!.runId}`, text: "lineage" },
					runtime,
				);
				expect(outputs.at(-1)).toContain("plan_id_tiebreak: 1");
			} finally {
				await recoveredManager.close();
			}
		} finally {
			resetSettingsForTest();
		}
	});

	it("retains plan-based /fanout reuse after named bases are archived or deleted", async () => {
		using repo = await createRepositoryFixture({
			"src/cache-prefix.ts": "export function cachePrefix() { return 'stable'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const prepared = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const durableBasePlan = lowerFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: [
						{ question: "Review cache prefix behavior" },
						{ question: "Review cache prefix verification" },
					],
				},
				{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
			);
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "plan",
				plan: durableBasePlan,
				planId: contextLineagePlanIdentity(durableBasePlan),
				manifestId: prepared.manifest.manifestId,
				checkpointId: prepared.checkpoint.checkpointId,
			});
			const lineage = lookupBuiltinSlashCommand("lineage");
			expect(lineage?.handle).toBeDefined();
			const session = {
				sessionId: "context-lineage-base-lifecycle-test",
				async runEphemeralTurn() {
					return { replyText: "sidecar answer" };
				},
			} as unknown as AgentSession;
			const runtime = {
				session,
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd: repo.path(),
				output: async (text: string) => {
					outputs.push(text);
				},
				refreshCommands: async () => {},
				reloadPlugins: async () => {},
			};
			for (const args of [
				"base archived-base",
				"base deleted-base",
				"base archive archived-base",
				"base delete deleted-base",
				"base inspect archived-base",
				"base inspect deleted-base",
			]) {
				await lineage!.handle!({ name: "lineage", args, text: "lineage" }, runtime);
			}
			expect(outputs.some(output => output.includes("Archived Context Lineage base archived-base."))).toBe(true);
			expect(outputs.some(output => output.includes("Deleted Context Lineage base name deleted-base"))).toBe(true);
			expect(outputs.some(output => output.includes("- archived:"))).toBe(true);
			expect(outputs.some(output => output.includes("- deleted:"))).toBe(true);
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await manager.close();
			const recoveredManager = await SessionManager.open(sessionFile!, `${repo.path()}/sessions`, undefined, {
				initialCwd: repo.path(),
				suppressBreadcrumb: true,
			});
			try {
				const fanout = lookupBuiltinSlashCommand("fanout");
				expect(fanout?.handle).toBeDefined();
				const recoveredRuntime = { ...runtime, sessionManager: recoveredManager };
				await fanout!.handle!(
					{
						name: "fanout",
						args: "Review cache prefix behavior | Review cache prefix verification",
						text: "fanout",
					},
					recoveredRuntime,
				);
				const records = getContextLineageSessionRecords(recoveredManager);
				const selection = records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection" }> =>
						record.kind === "base_selection",
				);
				expect(selection?.selection.planId).toBe(contextLineagePlanIdentity(durableBasePlan));
				expect(records.filter(record => record.kind === "named_base").map(record => record.status)).toEqual([
					"active",
					"active",
					"archived",
					"deleted",
				]);
			} finally {
				await recoveredManager.close();
			}
		} finally {
			resetSettingsForTest();
		}
	});

	it("falls back through /fanout when a durable base's frozen worktree snapshot is stale", async () => {
		using repo = await createRepositoryFixture({
			"src/cache-prefix.ts": "export function cachePrefix() { return 'stable'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const prepared = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const durableBasePlan = lowerFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: [
						{ question: "Review cache prefix behavior" },
						{ question: "Review cache prefix verification" },
					],
				},
				{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
			);
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "plan",
				plan: durableBasePlan,
				planId: contextLineagePlanIdentity(durableBasePlan),
				manifestId: prepared.manifest.manifestId,
				checkpointId: prepared.checkpoint.checkpointId,
			});
			await Bun.write(`${repo.path()}/src/cache-prefix.ts`, "export function cachePrefix() { return 'changed'; }\n");
			const fanout = lookupBuiltinSlashCommand("fanout");
			const lineage = lookupBuiltinSlashCommand("lineage");
			expect(fanout?.handle).toBeDefined();
			expect(lineage?.handle).toBeDefined();
			const session = {
				sessionId: "context-lineage-base-fallback-test",
				async runEphemeralTurn() {
					return { replyText: "sidecar answer" };
				},
			} as unknown as AgentSession;
			const runtime = {
				session,
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd: repo.path(),
				output: async (text: string) => {
					outputs.push(text);
				},
				refreshCommands: async () => {},
				reloadPlugins: async () => {},
			};
			await fanout!.handle!(
				{ name: "fanout", args: "Review cache prefix behavior | Review cache prefix verification", text: "fanout" },
				runtime,
			);
			const records = getContextLineageSessionRecords(manager);
			const fallback = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection_fallback" }> =>
					record.kind === "base_selection_fallback",
			);
			expect(fallback?.fallback.rejected).toContainEqual({
				planId: contextLineagePlanIdentity(durableBasePlan),
				checkpointId: prepared.checkpoint.checkpointId,
				reason: "snapshot_stale",
			});
			const execution = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
					record.kind === "execution" && record.stageId === undefined && record.status === "completed",
			);
			expect(execution?.runId).toBeDefined();
			await lineage!.handle!({ name: "lineage", args: `diagnostics ${execution!.runId}`, text: "lineage" }, runtime);
			expect(outputs.at(-1)).toContain(
				"Context base: fresh manifest; 1 persisted candidate(s) rejected before dispatch (snapshot_stale: 1).",
			);
		} finally {
			await manager.close();
			resetSettingsForTest();
		}
	});

	it("falls back through /fanout when a durable base's source artifact is unavailable", async () => {
		using repo = await createRepositoryFixture({
			"src/cache-prefix.ts": "export function cachePrefix() { return 'stable'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const prepared = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const durableBasePlan = lowerFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: [
						{ question: "Review cache prefix behavior" },
						{ question: "Review cache prefix verification" },
					],
				},
				{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
			);
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "plan",
				plan: durableBasePlan,
				planId: contextLineagePlanIdentity(durableBasePlan),
				manifestId: prepared.manifest.manifestId,
				checkpointId: prepared.checkpoint.checkpointId,
			});
			const manifestRecord = getContextLineageSessionRecords(manager).find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "repository_manifest" }> =>
					record.kind === "repository_manifest" && record.manifest.manifestId === prepared.manifest.manifestId,
			);
			expect(manifestRecord?.manifestArtifactId).toBeDefined();
			const artifactPath = await manager.getArtifactPath(manifestRecord!.manifestArtifactId!);
			expect(artifactPath).not.toBeNull();
			await fs.rm(artifactPath!);
			const fanout = lookupBuiltinSlashCommand("fanout");
			const lineage = lookupBuiltinSlashCommand("lineage");
			expect(fanout?.handle).toBeDefined();
			expect(lineage?.handle).toBeDefined();
			const session = {
				sessionId: "context-lineage-base-artifact-fallback-test",
				async runEphemeralTurn() {
					return { replyText: "sidecar answer" };
				},
			} as unknown as AgentSession;
			const runtime = {
				session,
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd: repo.path(),
				output: async (text: string) => {
					outputs.push(text);
				},
				refreshCommands: async () => {},
				reloadPlugins: async () => {},
			};
			await fanout!.handle!(
				{ name: "fanout", args: "Review cache prefix behavior | Review cache prefix verification", text: "fanout" },
				runtime,
			);
			const records = getContextLineageSessionRecords(manager);
			const fallback = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection_fallback" }> =>
					record.kind === "base_selection_fallback",
			);
			expect(fallback?.fallback.rejected).toContainEqual({
				planId: contextLineagePlanIdentity(durableBasePlan),
				checkpointId: prepared.checkpoint.checkpointId,
				reason: "evidence_unavailable",
			});
			const execution = records.find(
				(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
					record.kind === "execution" && record.stageId === undefined && record.status === "completed",
			);
			expect(execution?.runId).toBeDefined();
			await lineage!.handle!({ name: "lineage", args: `diagnostics ${execution!.runId}`, text: "lineage" }, runtime);
			expect(outputs.at(-1)).toContain(
				"Context base: fresh manifest; 1 persisted candidate(s) rejected before dispatch (evidence_unavailable: 1).",
			);
		} finally {
			await manager.close();
			resetSettingsForTest();
		}
	});

	it("selects a durable source-complete base through /fanout after a session restart", async () => {
		using repo = await createRepositoryFixture({
			"src/cache-prefix.ts": "export function cachePrefix() { return 'stable'; }\n",
		});
		const manager = SessionManager.create(repo.path(), `${repo.path()}/sessions`);
		const outputs: string[] = [];
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: repo.path(),
			overrides: { "contextLineage.enabled": true },
		});
		try {
			await manager.ensureOnDisk();
			const prepared = await prepareRepositoryContextLineage({
				cwd: repo.path(),
				task: "Review cache prefix workflow",
				journal: manager,
			});
			const durableBasePlan = lowerFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: [
						{ question: "Review cache prefix behavior" },
						{ question: "Review cache prefix verification" },
					],
				},
				{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
			);
			appendContextLineageSessionRecord(manager, {
				version: 1,
				kind: "plan",
				plan: durableBasePlan,
				planId: contextLineagePlanIdentity(durableBasePlan),
				manifestId: prepared.manifest.manifestId,
				checkpointId: prepared.checkpoint.checkpointId,
			});
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await manager.close();
			const recoveredManager = await SessionManager.open(sessionFile!, `${repo.path()}/sessions`, undefined, {
				initialCwd: repo.path(),
				suppressBreadcrumb: true,
			});
			try {
				const fanout = lookupBuiltinSlashCommand("fanout");
				const lineage = lookupBuiltinSlashCommand("lineage");
				expect(fanout?.handle).toBeDefined();
				expect(lineage?.handle).toBeDefined();
				const session = {
					sessionId: "context-lineage-base-restart-test",
					async runEphemeralTurn() {
						return { replyText: "sidecar answer", usage: { totalTokens: 120, costUsd: 0.006 } };
					},
				} as unknown as AgentSession;
				const runtime = {
					session,
					sessionManager: recoveredManager,
					settings: Settings.isolated(),
					cwd: repo.path(),
					output: async (text: string) => {
						outputs.push(text);
					},
					refreshCommands: async () => {},
					reloadPlugins: async () => {},
				};
				await fanout!.handle!(
					{
						name: "fanout",
						args: "Review cache prefix behavior | Review cache prefix verification",
						text: "fanout",
					},
					runtime,
				);
				const records = getContextLineageSessionRecords(recoveredManager);
				const selection = records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection" }> =>
						record.kind === "base_selection",
				);
				expect(selection?.selection.checkpointId).toBe(prepared.checkpoint.checkpointId);
				expect(selection?.selection.expectedSharedBytes).toBeGreaterThan(0);
				const execution = records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
						record.kind === "execution" && record.stageId === undefined && record.status === "completed",
				);
				expect(execution?.runId).toBeDefined();
				await lineage!.handle!(
					{ name: "lineage", args: `diagnostics ${execution!.runId}`, text: "lineage" },
					runtime,
				);
				expect(outputs.at(-1)).toContain(`Selected persisted context: ${prepared.checkpoint.checkpointId}`);
				expect(outputs.at(-1)).toContain("expected shared prefix");
				expect(outputs.at(-1)).toContain("provider-neutral");
				expect(outputs.at(-1)).toContain("2/2 request(s);");
				expect(outputs.at(-1)).toContain("240 reported tokens; $0.012000.");
				expect(outputs.at(-1)).toContain("never inferred from expected prefix bytes");
				expect(outputs.at(-1)).toContain(
					"Provider cache reuse outcome: not measured (provider reported no cache observation).",
				);
			} finally {
				await recoveredManager.close();
			}
		} finally {
			resetSettingsForTest();
		}
	});

	it("renders and normalizes a task-only unguided benchmark baseline", () => {
		expect(renderUnguidedPlanningClaimsRequest("Inspect target")).toContain("Inspect target");
		expect(
			parseUnguidedPlanningClaimsResponse(
				JSON.stringify({ scope: ["src/target.ts", "src/target.ts"], verification: ["test/target.test.ts"] }),
			),
		).toEqual({ scope: ["src/target.ts"], verification: ["test/target.test.ts"] });
		expect(() => parseUnguidedPlanningClaimsResponse('{"scope":[]}')).toThrow("scope and verification");
	});

	it("renders a reviewable plan tree with evidence and unresolved inspection work", () => {
		const inspection = renderContextLineagePlanInspection(plan());
		expect(inspection).toContain("- review [fanout]");
		expect(inspection).toContain("evidence: manifest-1/evidence-1 (scope)");
	});

	it("accepts a single JSON code fence without weakening planning validation", () => {
		const response = `\`\`\`json
${JSON.stringify(plan())}
\`\`\``;
		expect(parseRepositoryPlanningSkillResponse(response)).toMatchObject({ valid: true, plan: { title: "Plan" } });
	});

	it("exposes the documented read-only Wayfinder ticket planning command", () => {
		const command = lookupBuiltinSlashCommand("wayfinder");
		expect(command?.allowArgs).toBe(true);
		expect(command?.inlineHint).toBe("plan <map-url> <ticket-url> :: <goal> :: <task>");
	});

	it("rejects missing evidence instead of treating an arbitrary manifest reference as authority", () => {
		const invalid = plan({
			stages: [
				{
					id: "review",
					mode: "single",
					base: { type: "base", baseId: "base-1" },
					task: {
						id: "scope",
						assignment: "Review scope",
						evidence: [{ manifestId: "manifest-1", evidenceId: "missing", purpose: "scope" }],
					},
				},
			],
		});
		expect(validateContextLineagePlan(invalid, [manifest]).issues).toContainEqual({
			path: "tasks.scope.evidence",
			message: "unknown evidence: missing",
		});
	});

	it("rejects evidence from an available but undeclared manifest", () => {
		const otherManifest: RepositoryContextManifest = {
			...manifest,
			manifestId: "manifest-2",
			evidence: [{ ...manifest.evidence[0]!, evidenceId: "evidence-2" }],
		};
		const invalid = plan({
			stages: [
				{
					id: "review",
					mode: "single",
					base: { type: "base", baseId: "base-1" },
					task: {
						id: "scope",
						assignment: "Review scope",
						evidence: [{ manifestId: "manifest-2", evidenceId: "evidence-2", purpose: "scope" }],
					},
				},
			],
		});
		expect(validateContextLineagePlan(invalid, [manifest, otherManifest]).issues).toContainEqual({
			path: "tasks.scope.evidence",
			message: "manifest is not declared by a plan base: manifest-2",
		});
	});

	it("rejects dependency cycles before an executable plan can be dispatched", () => {
		const invalid = plan({
			stages: [
				{
					id: "first",
					dependsOn: ["second"],
					mode: "single",
					base: { type: "base", baseId: "base-1" },
					task: {
						id: "first-task",
						assignment: "First",
						unresolvedAssumptions: [{ id: "a", statement: "Need inspect", requiredInspection: "Inspect source" }],
					},
				},
				{
					id: "second",
					dependsOn: ["first"],
					mode: "single",
					base: { type: "base", baseId: "base-1" },
					task: {
						id: "second-task",
						assignment: "Second",
						unresolvedAssumptions: [{ id: "b", statement: "Need inspect", requiredInspection: "Inspect source" }],
					},
				},
			],
		});
		expect(validateContextLineagePlan(invalid, [manifest]).issues).toContainEqual({
			path: "stages",
			message: "stage dependencies must form a DAG",
		});
	});

	it("keeps display metadata out of plan identity while retaining semantic changes", () => {
		const baseline = contextLineagePlanIdentity(plan());
		const relabeled = contextLineagePlanIdentity(plan({ metadata: { owner: "cli" } }));
		const changed = contextLineagePlanIdentity(plan({ title: "A different task" }));
		expect(relabeled).toBe(baseline);
		expect(changed).not.toBe(baseline);
	});

	it("derives manifest identity from manifest content rather than its stored ID", () => {
		const renamed: RepositoryContextManifest = { ...manifest, manifestId: "manifest-copy" };
		expect(repositoryManifestIdentity(renamed)).toBe(repositoryManifestIdentity(manifest));
	});

	it("accepts a dependent stage only when its immutable upstream output is declared", () => {
		const twoStage = plan({
			stages: [
				{
					id: "inspect",
					mode: "single",
					base: { type: "base", baseId: "base-1" },
					task: {
						id: "inspect-task",
						assignment: "Inspect the scope",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						output: { name: "findings", format: "markdown" },
					},
				},
				{
					id: "plan",
					dependsOn: ["inspect"],
					mode: "single",
					base: { type: "extension", baseId: "base-1", inputs: [{ stageId: "inspect", output: "findings" }] },
					task: {
						id: "plan-task",
						assignment: "Plan the change",
						unresolvedAssumptions: [
							{ id: "a", statement: "Review findings", requiredInspection: "Read findings" },
						],
					},
				},
			],
		});
		expect(validateContextLineagePlan(twoStage, [manifest])).toEqual({ valid: true, issues: [] });
	});

	it("keeps logical checkpoint and prepared-prefix identities independent from storage timestamps", () => {
		expect(logicalCheckpointIdentity({ ...checkpoint, checkpointId: "checkpoint-2", createdAt: 2 })).toBe(
			logicalCheckpointIdentity(checkpoint),
		);
		expect(preparedPrefixIdentity({ ...prefix, preparedPrefixId: "prefix-2", createdAt: 2 })).toBe(
			preparedPrefixIdentity(prefix),
		);
	});

	it("derives provider-neutral prefix diagnostics from rendered bytes without a cache key", () => {
		const first = createRepositoryPreparedPrefix({
			checkpoint,
			target: { provider: "test", model: "model-1" },
			rendererContractVersion: "v1",
			renderedPrefix: "frozen prefix",
			compatibilityProfileVersion: "v1",
		});
		const second = createRepositoryPreparedPrefix({ ...first, checkpoint, renderedPrefix: "frozen prefix" });
		expect(second.preparedPrefixId).toBe(first.preparedPrefixId);
		expect(first).not.toHaveProperty("cacheKey");
		expect(first.expectedSharedBytes).toBe(13);
	});

	it("selects a semantically eligible persisted plan base before considering its shared prefix", () => {
		const candidatePlan = plan();
		const outcome = selectContextLineageBase({
			task: "Review the verification scope",
			currentSnapshot: manifest.snapshot,
			candidates: [
				{
					planId: contextLineagePlanIdentity(candidatePlan),
					plan: candidatePlan,
					checkpoint: createRepositoryManifestCheckpoint(manifest),
					manifest,
					evidenceAvailable: true,
				},
			],
		});
		expect(outcome.selected?.planId).toBe(contextLineagePlanIdentity(candidatePlan));
		expect(outcome.selected?.expectedSharedBytes).toBeGreaterThan(0);
		expect(outcome.selected?.rationale).toBe("semantic_eligibility_then_largest_shared_prefix");
	});

	it("rejects a cache-eligible-looking base when its workspace scope is incompatible", () => {
		const candidatePlan = plan();
		const outcome = selectContextLineageBase({
			task: "Review the verification scope",
			currentSnapshot: { ...manifest.snapshot, workspaceScopeId: "other-workspace" },
			candidates: [
				{
					planId: contextLineagePlanIdentity(candidatePlan),
					plan: candidatePlan,
					checkpoint: createRepositoryManifestCheckpoint(manifest),
					manifest,
					evidenceAvailable: true,
				},
			],
		});
		expect(outcome.selected).toBeUndefined();
		if (outcome.selected) throw new Error("incompatible base must not be selected");
		expect(outcome.rejected).toContainEqual({
			planId: contextLineagePlanIdentity(candidatePlan),
			checkpointId: createRepositoryManifestCheckpoint(manifest).checkpointId,
			reason: "workspace_scope_mismatch",
		});
	});

	it("falls back when no recoverable persisted plan is relevant to the question", () => {
		const candidatePlan = plan();
		const outcome = selectContextLineageBase({
			task: "Configure authentication retry quotas",
			currentSnapshot: manifest.snapshot,
			candidates: [
				{
					planId: contextLineagePlanIdentity(candidatePlan),
					plan: candidatePlan,
					checkpoint: createRepositoryManifestCheckpoint(manifest),
					manifest,
					evidenceAvailable: true,
				},
			],
		});
		expect(outcome.selected).toBeUndefined();
		if (outcome.selected) throw new Error("unrelated base must not be selected");
		expect(outcome.rejected[0]?.reason).toBe("task_not_relevant");
	});

	it("binds a fresh-context fallback decision to one run without retaining the question", () => {
		const fallback = createContextLineageBaseSelectionFallback({
			runId: "run-1",
			taskDigest: semanticIdentity("context-lineage-ad-hoc-task", "Review secret cache behavior"),
			rejected: [{ planId: "plan-1", checkpointId: "checkpoint-1", reason: "task_not_relevant" }],
		});
		expect(fallback.runId).toBe("run-1");
		expect(fallback.rejected[0]?.reason).toBe("task_not_relevant");
		expect(JSON.stringify(fallback)).not.toContain("Review secret cache behavior");
	});

	it("binds a frozen planning base to a labeled Wayfinder map without treating tracker state as source authority", () => {
		const input = {
			goal: "Ship evidence-grounded planning",
			mapIssue: {
				tracker: "github" as const,
				repository: "owner/repository",
				number: 10,
				url: "https://github.com/owner/repository/issues/10",
				title: "Context Lineage campaign",
				state: "open" as const,
				labels: ["campaign", "wayfinder:map"],
			},
			ticketIssue: {
				tracker: "github" as const,
				repository: "owner/repository",
				number: 11,
				url: "https://github.com/owner/repository/issues/11",
				title: "Compile the repository manifest",
				state: "open" as const,
				labels: ["wayfinder:task"],
			},
			manifestId: "manifest-1",
			checkpointId: "checkpoint-1",
		};
		const binding = createWayfinderContextLineageBinding(input);
		const reordered = createWayfinderContextLineageBinding({
			...input,
			mapIssue: { ...input.mapIssue, labels: [...input.mapIssue.labels].reverse() },
		});

		expect(binding.bindingId).toBe(reordered.bindingId);
		expect(binding.goalDigest).not.toContain(input.goal);
		expect(isWayfinderContextLineageBindingIntact(binding)).toBe(true);
		expect(() =>
			createWayfinderContextLineageBinding({
				...input,
				mapIssue: { ...input.mapIssue, labels: ["campaign"] },
			}),
		).toThrow("wayfinder:map");
	});

	it("rejects stage capabilities unavailable to the caller before dispatch", () => {
		const restricted = plan({
			stages: [
				{
					id: "review",
					mode: "single",
					base: { type: "base", baseId: "base-1" },
					capabilityRequirements: { tools: ["write"], securityScope: "secret" },
					task: {
						id: "scope",
						assignment: "Review scope",
						unresolvedAssumptions: [{ id: "a", statement: "Inspect", requiredInspection: "Read source" }],
					},
				},
			],
		});
		const result = validateContextLineagePlan(restricted, [manifest], {
			availableTools: new Set(["read"]),
			securityScopes: new Set(["project"]),
		});
		expect(result.issues).toContainEqual({
			path: "stages.review.capabilities.tools",
			message: "unavailable tool: write",
		});
		expect(result.issues).toContainEqual({
			path: "stages.review.capabilities.securityScope",
			message: "unavailable security scope: secret",
		});
	});

	it("validates independent fanout questions before any session branch is created", () => {
		const valid = validateFanoutRequest({
			version: 1,
			checkpoint: { type: "current_idle" },
			questions: [
				{ id: "scope", question: "What is the change scope?" },
				{ id: "verify", question: "Which tests verify it?" },
			],
			concurrency: 2,
		});
		const invalid = validateFanoutRequest({
			version: 1,
			checkpoint: { type: "current_idle" },
			questions: [
				{ id: "scope", question: "" },
				{ id: "scope", question: "Second" },
			],
			concurrency: 0,
		});

		expect(valid).toEqual({ valid: true, issues: [] });
		expect(invalid.issues).toContainEqual({ path: "questions", message: "duplicate id: scope" });
		expect(invalid.issues).toContainEqual({ path: "questions.0", message: "question must not be empty" });
		expect(invalid.issues).toContainEqual({ path: "concurrency", message: "concurrency must be a positive integer" });
	});

	it("lowers identical fanout requests into identical one-stage plans without provider mechanics", () => {
		const request = {
			version: 1,
			title: "Architecture questions",
			checkpoint: { type: "checkpoint", checkpointId: "checkpoint-1" },
			questions: [
				{ id: "scope", question: "What is the change scope?" },
				{ id: "verify", question: "Which tests verify it?" },
			],
			concurrency: 2,
			resultPolicy: "sidecar",
		} as const;
		const first = lowerFanoutRequest(request);
		const second = lowerFanoutRequest(request);

		expect(contextLineagePlanIdentity(first)).toBe(contextLineagePlanIdentity(second));
		const firstStage = first.stages[0];
		expect(firstStage?.mode).toBe("fanout");
		if (firstStage?.mode !== "fanout") throw new Error("lowered fanout stage expected");
		expect(firstStage.base).toEqual({ type: "base", baseId: "base" });
		expect(firstStage.tasks.map(task => task.id)).toEqual(["scope", "verify"]);
		expect(firstStage.tasks.map(task => task.output?.name)).toEqual(["answer-1", "answer-2"]);
		expect(JSON.stringify(first)).not.toContain("cache");
		expect(first.metadata?.resultPolicy).toBe("sidecar");
		expect(
			validateContextLineagePlan(first, [], {
				allowedBaseSourceTypes: new Set(["current_checkpoint", "checkpoint"]),
			}),
		).toEqual({ valid: true, issues: [] });
	});

	it("accepts an ask run lowered onto a manifest-derived checkpoint under executor validation", () => {
		// Regression: /lineage ask used to root lowered questions at the raw
		// repository_manifest, which FR51 rejects because free-form questions
		// carry no evidence references. Ask plans must root at the checkpoint.
		const lowered = lowerFanoutRequest(
			{
				version: 1,
				checkpoint: { type: "current_idle" },
				questions: [{ question: "What does WidgetRegistry do?" }, { question: "Where is weight scaled?" }],
			},
			{ type: "checkpoint", checkpointId: "manifest-checkpoint-1" },
		);
		const manifest = createRepositoryContextManifest({
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
			evidence: [],
		});
		expect(
			validateContextLineagePlan(lowered, [manifest], {
				allowedBaseSourceTypes: new Set(["repository_manifest", "checkpoint"]),
				allowedWorkspaceModes: new Set(["frozen_read_only"]),
			}),
		).toEqual({ valid: true, issues: [] });
	});

	it("rejects a lowered fanout that would fail shared plan validation", () => {
		const lowered = lowerFanoutRequest({
			version: 1,
			checkpoint: { type: "current_idle" },
			questions: [{ id: "only", question: "A single question" }],
		});
		expect(
			validateContextLineagePlan(lowered, [], {
				allowedBaseSourceTypes: new Set(["current_checkpoint", "checkpoint"]),
			}).issues,
		).toContainEqual({ path: "stages.questions.tasks", message: "fanout stages require at least two tasks" });
	});

	it("creates deterministic checkpoint extension generations from selected outputs", () => {
		const outputs = [
			{
				stageId: "reviews",
				taskId: "security",
				outputName: "approved_review",
				contentDigest: "digest-2",
				artifactRef: "artifact://2",
			},
			{
				stageId: "reviews",
				taskId: "architecture",
				outputName: "approved_review",
				contentDigest: "digest-1",
				artifactRef: "artifact://1",
			},
		];
		const base = createRepositoryManifestCheckpoint(manifest);
		const first = createCheckpointExtensionCheckpoint({ baseCheckpoint: base, outputs });
		const second = createCheckpointExtensionCheckpoint({ baseCheckpoint: base, outputs: [...outputs].reverse() });

		expect(first.checkpointId).toBe(second.checkpointId);
		expect(first.origin).toBe("checkpoint_extension");
		expect(first.materialization).toBe("selected_outputs");
		expect(first.securityScopeId).toBe(base.securityScopeId);
		expect(first.repositoryManifestId).toBe(base.repositoryManifestId);
		expect(first.checkpointId).not.toBe(base.checkpointId);

		const changed = createCheckpointExtensionCheckpoint({
			baseCheckpoint: base,
			outputs: [{ ...outputs[0]!, contentDigest: "digest-3" }],
		});
		expect(changed.checkpointId).not.toBe(first.checkpointId);
		expect(serializeCheckpointExtensionOutputs(outputs)).toBe(
			serializeCheckpointExtensionOutputs([...outputs].reverse()),
		);
		expect(() => createCheckpointExtensionCheckpoint({ baseCheckpoint: base, outputs: [] })).toThrow(
			"requires at least one selected output",
		);
	});

	it("derives a stable overlay digest independent of untracked discovery order", async () => {
		using tempDir = TempDir.createSync("@omp-context-lineage-");
		await Bun.write(`${tempDir.path()}/a.txt`, "a");
		await Bun.write(`${tempDir.path()}/b.txt`, "b");
		const first = await repositoryOverlayDigest(tempDir.path(), "staged", "unstaged", ["b.txt", "a.txt"]);
		const second = await repositoryOverlayDigest(tempDir.path(), "staged", "unstaged", ["a.txt", "b.txt"]);
		expect(first).toBe(second);
	});

	it("binds changed-file content and index state into an overlay digest beyond rendered diff text", async () => {
		const first = await repositoryOverlayDigest(
			"/tmp",
			"[truncated diff]",
			"",
			[],
			[{ path: "src/large.ts", indexBlobId: "index-1", worktreeDigest: "content-1" }],
		);
		const second = await repositoryOverlayDigest(
			"/tmp",
			"[truncated diff]",
			"",
			[],
			[{ path: "src/large.ts", indexBlobId: "index-1", worktreeDigest: "content-2" }],
		);

		expect(second).not.toBe(first);
	});

	it("rejects an unbounded retrieval policy before it can read repository evidence", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });

		await expect(
			compileCurrentStateRepositoryManifest(repository.path(), {
				task: "Inspect target",
				retrievalPolicy: { id: "current-state-v1", maxExcerptBytes: Number.POSITIVE_INFINITY },
				contextRendererVersion: "renderer-v1",
				paths: ["src/target.ts"],
			}),
		).rejects.toThrow("Context Lineage retrieval policy maxExcerptBytes must be a non-negative safe integer");
	});

	it("prepares a frozen manifest and durable checkpoint without creating a model-visible message", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		const entries: SessionEntry[] = [];
		const journal = {
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
		};

		const prepared = await prepareRepositoryContextLineage({
			cwd: repository.path(),
			task: "Inspect target",
			journal,
		});

		expect(prepared.checkpoint.repositoryManifestId).toBe(prepared.manifest.manifestId);
		expect(prepared.checkpoint.contentRootHash).toBe(prepared.manifest.manifestId);
		expect(getContextLineageSessionRecords(journal)).toMatchObject([
			{ kind: "repository_manifest", manifest: { manifestId: prepared.manifest.manifestId } },
			{ kind: "logical_checkpoint", checkpoint: { checkpointId: prepared.checkpoint.checkpointId } },
		]);
	});

	it("integrates explicitly authorized forge documents as bounded non-current planning evidence", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		const entries: SessionEntry[] = [];
		const journal = {
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
		};

		const prepared = await prepareRepositoryContextLineage({
			cwd: repository.path(),
			task: "Inspect target rationale",
			journal,
			documentary: {
				documents: [
					{ source: "forge", sourceRef: "forge://owner/repo/issue/42", content: "Keep target compatible." },
				],
				maxItems: 1,
				maxExcerptBytes: 12,
			},
		});
		const documentary = prepared.manifest.evidence.find(item => item.sourceRef === "forge://owner/repo/issue/42");

		expect(documentary).toMatchObject({
			evidenceClass: "documentary_observation",
			authority: "documentary",
			staleness: { state: "unknown" },
			excerpt: { content: "Keep target ", truncated: true },
		});
		expect(prepared.checkpoint.repositoryManifestId).toBe(prepared.manifest.manifestId);
	});

	it("persists digest-only manifest records and keeps excerpt bytes in the artifact store", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		const entries: SessionEntry[] = [];
		const artifacts: string[] = [];
		const journal = {
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
			async saveArtifact(content: string): Promise<string> {
				artifacts.push(content);
				return `artifact-${artifacts.length}`;
			},
		};

		const prepared = await prepareRepositoryContextLineage({
			cwd: repository.path(),
			task: "Inspect target",
			journal,
		});

		const [record] = getContextLineageSessionRecords(journal);
		expect(record?.kind).toBe("repository_manifest");
		if (record?.kind !== "repository_manifest") return;
		const excerpt = record.manifest.evidence[0]?.excerpt;
		expect(excerpt && "content" in excerpt).toBe(false);
		expect(excerpt?.contentDigest).toBe(prepared.manifest.evidence[0]?.excerpt?.contentDigest);
		expect(record.manifestArtifactId).toBe("artifact-1");
		expect(artifacts[0]).toContain("export const target = true;");
		expect(isRepositoryContextManifestIntact(record.manifest)).toBe(true);
	});

	it("keeps manifest identity stable when excerpt bytes are stripped for storage", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		const manifest = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Inspect target",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});
		const stripped = stripRepositoryManifestSource(manifest);
		expect(stripped.manifestId).toBe(manifest.manifestId);
		expect(repositoryManifestIdentity(stripped)).toBe(repositoryManifestIdentity(manifest));
		expect(renderRepositoryContextManifest(stripped)).toContain("(bytes stored separately)");
	});

	it("caps dirty-file hashing at the declared budget and discloses truncation", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		await Bun.write(`${repository.path()}/dirty1.ts`, "one");
		await Bun.write(`${repository.path()}/dirty2.ts`, "two");

		const snapshot = await resolveRepositorySnapshot(repository.path(), {
			untrackedPolicy: "include",
			maxDirtyFiles: 1,
		});
		expect(snapshot.overlayTruncated).toEqual({ limit: 1, observed: 2 });

		const manifest = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Inspect target",
			retrievalPolicy: { id: "current-state-v1", maxDirtyFiles: 1 },
			contextRendererVersion: "renderer-v1",
			untrackedPolicy: "include",
			paths: ["src/target.ts"],
		});
		expect(manifest.degradedSources).toContainEqual({
			extractorId: "repository-overlay",
			reason: "budget_limited",
			detail: "dirty-file hashing limited to 1 of 2 changed or untracked files",
		});
		expect(summarizeRepositoryContextManifest(manifest)).toContain("Overlay truncated");
	});

	it("binds one resolved Wayfinder map and frontier ticket to the frozen repository dispatch base", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;" });
		const entries: SessionEntry[] = [];
		const journal = {
			appendCustomEntry: (_customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					id: `entry-${entries.length}`,
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: "context-lineage",
					data,
				});
				return `entry-${entries.length - 1}`;
			},
			getBranch: () => entries,
		};
		const prepared = await prepareWayfinderContextLineage({
			cwd: repository.path(),
			task: "Plan target",
			goal: "Ship the target safely",
			mapIssueUrl: "https://github.com/owner/repository/issues/10",
			ticketIssueUrl: "https://github.com/owner/repository/issues/11",
			journal,
			resolver: {
				resolve: async (_cwd, issueUrl) =>
					issueUrl.endsWith("/10")
						? {
								tracker: "github",
								repository: "owner/repository",
								number: 10,
								url: issueUrl,
								title: "Campaign map",
								state: "open",
								labels: ["wayfinder:map"],
							}
						: {
								tracker: "github",
								repository: "owner/repository",
								number: 11,
								url: issueUrl,
								title: "Target task",
								state: "open",
								labels: ["wayfinder:task"],
							},
			},
		});

		expect(prepared.bindingId).toStartWith("wayfinder-context-lineage-binding:v1:");
		expect(getContextLineageSessionRecords(journal).map(record => record.kind)).toEqual([
			"repository_manifest",
			"logical_checkpoint",
			"wayfinder_binding",
		]);
	});

	it("persists a manifest-validated plan after binding its Wayfinder ticket", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;" });
		const entries: SessionEntry[] = [];
		const journal = {
			appendCustomEntry: (_customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					id: `entry-${entries.length}`,
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: "context-lineage",
					data,
				});
				return `entry-${entries.length - 1}`;
			},
			getBranch: () => entries,
		};
		const planned = await planWayfinderContextLineage({
			cwd: repository.path(),
			task: "Plan target",
			goal: "Ship the target safely",
			mapIssueUrl: "https://github.com/owner/repository/issues/10",
			ticketIssueUrl: "https://github.com/owner/repository/issues/11",
			journal,
			resolver: {
				resolve: async (_cwd, issueUrl) => ({
					tracker: "github",
					repository: "owner/repository",
					number: issueUrl.endsWith("/10") ? 10 : 11,
					url: issueUrl,
					title: issueUrl.endsWith("/10") ? "Campaign map" : "Target task",
					state: "open",
					labels: issueUrl.endsWith("/10") ? ["wayfinder:map"] : ["wayfinder:task"],
				}),
			},
			generator: {
				generate: async promptText => {
					const manifestId = /Manifest ID:\n([^\n]+)/.exec(promptText)?.[1];
					if (!manifestId) throw new Error("missing manifest identity");
					return JSON.stringify({
						version: 1,
						title: "Target plan",
						bases: [{ id: "repository", source: { type: "repository_manifest", manifestId } }],
						stages: [
							{
								id: "implementation",
								mode: "single",
								base: { type: "base", baseId: "repository" },
								capabilityRequirements: { workspaceMode: "frozen_read_only" },
								task: {
									id: "inspect",
									assignment: "Inspect the bounded repository evidence.",
									unresolvedAssumptions: [
										{ id: "detail", statement: "Inspect task details", requiredInspection: "Read ticket" },
									],
								},
							},
						],
					});
				},
			},
		});

		expect(planned.valid).toBe(true);
		expect(getContextLineageSessionRecords(journal).map(record => record.kind)).toEqual([
			"repository_manifest",
			"logical_checkpoint",
			"wayfinder_binding",
			"plan",
		]);
	});

	it("accepts only content-addressed execution records when reporting durable lineage status", () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		const validPlan = plan();
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: validPlan,
			planId: contextLineagePlanIdentity(validPlan),
			manifestId: manifest.manifestId,
			checkpointId: checkpoint.checkpointId,
		});
		const execution = createContextLineageExecutionRecord({
			planId: contextLineagePlanIdentity(validPlan),
			checkpointId: checkpoint.checkpointId,
			status: "completed",
			outputs: [
				{
					stageId: "inspect",
					taskId: "inspect-task",
					contentDigest: "output-1",
					artifactRef: "artifact://1",
				},
			],
		});
		appendContextLineageSessionRecord(journal, execution);
		journal.appendCustomEntry("context-lineage", { ...execution, status: "failed" });

		expect(summarizeContextLineageSession(journal)).toMatchObject({
			executions: 1,
			completedExecutions: 1,
			failedExecutions: 0,
		});
	});

	it("verifies a durable result against its session artifact bytes", async () => {
		using artifactsDir = TempDir.createSync("@omp-context-lineage-artifacts-");
		const artifacts = new ArtifactManager(artifactsDir.path());
		const artifactId = await artifacts.save("immutable result", "context-lineage");
		const verifier = createArtifactManagerContextLineageOutputVerifier(artifacts);
		const result = {
			contentDigest: semanticIdentity("context-lineage-output", "immutable result"),
			artifactRef: `artifact://${artifactId}`,
		};

		expect(await verifier.verify(result)).toBe(true);
		expect(await verifier.verify({ ...result, contentDigest: "forged" })).toBe(false);
	});

	it("does not count a self-hashed plan without its intact manifest checkpoint as persisted", () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const forgedPlan = { version: 1 as const, title: "forged", bases: [], stages: [] };
		journal.appendCustomEntry("context-lineage", {
			version: 1,
			kind: "plan",
			plan: forgedPlan,
			planId: contextLineagePlanIdentity(forgedPlan),
			manifestId: manifest.manifestId,
			checkpointId: "missing",
		});

		expect(summarizeContextLineageSession(journal).plans).toBe(0);
	});

	it("executes validated fanout through an injected runner and persists only output references", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const requests: string[] = [];
		const executionCheckpoint = createRepositoryManifestCheckpoint(manifest);
		const executionPlan = plan();
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "logical_checkpoint",
			checkpoint: executionCheckpoint,
		});
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: executionPlan,
			planId: contextLineagePlanIdentity(executionPlan),
			manifestId: manifest.manifestId,
			checkpointId: executionCheckpoint.checkpointId,
		});
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint: executionCheckpoint,
			plan: executionPlan,
			journal,
			runner: {
				async run(request) {
					requests.push(request.task.id);
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
			concurrency: 2,
		});

		expect(outcome.status).toBe("completed");
		expect(requests.sort()).toEqual(["scope", "verify"]);
		const executionRecords = executionRecordsOf(journal, outcome.runId);
		const stageRecords = executionRecords.filter(record => record.stageId !== undefined);
		expect(stageRecords).toHaveLength(1);
		expect(stageRecords[0]).toMatchObject({
			kind: "execution",
			stageId: "review",
			status: "completed",
			outputs: [
				{ taskId: "scope", contentDigest: "digest-scope", artifactRef: "artifact://scope" },
				{ taskId: "verify", contentDigest: "digest-verify", artifactRef: "artifact://verify" },
			],
		});
		const finalRecords = executionRecords.filter(record => record.stageId === undefined);
		expect(finalRecords).toHaveLength(1);
		expect(finalRecords[0]).toMatchObject({ kind: "execution", status: "completed" });
		expect(getContextLineageSessionRecords(journal)).toContainEqual(
			expect.objectContaining({
				kind: "run_started",
				runId: outcome.runId,
				planId: contextLineagePlanIdentity(executionPlan),
				checkpointId: executionCheckpoint.checkpointId,
			}),
		);
	});

	it("passes only declared extension outputs to dependent stages", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const observedInputs = new Map<string, readonly string[]>();
		const sourcePlan: ContextLineagePlan = {
			version: 1,
			title: "Output isolation",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "source",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "source-task",
						assignment: "Inspect source",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						output: { name: "findings", format: "text" },
					},
				},
				{
					id: "independent",
					dependsOn: ["source"],
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "independent-task",
						assignment: "Inspect independently",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "consumer",
					dependsOn: ["source"],
					mode: "single",
					base: { type: "extension", baseId: "repository", inputs: [{ stageId: "source", output: "findings" }] },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "consumer-task",
						assignment: "Use selected findings",
						unresolvedAssumptions: [
							{ id: "a", statement: "Review findings", requiredInspection: "Read artifact" },
						],
					},
				},
			],
		};
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint: createRepositoryManifestCheckpoint(manifest),
			plan: sourcePlan,
			journal,
			runner: {
				async run(request) {
					observedInputs.set(
						request.task.id,
						request.priorOutputs.map(output => output.outputName),
					);
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		expect(outcome.status).toBe("completed");
		expect(observedInputs.get("independent-task")).toEqual([]);
		expect(observedInputs.get("consumer-task")).toEqual(["findings"]);
	});

	it("executes a synthesis stage and feeds its output to a dependent fan-out", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const synthesisPlan: ContextLineagePlan = {
			version: 1,
			title: "Review then plan",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "reviews",
					mode: "fanout",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					tasks: [
						{
							id: "architecture",
							assignment: "Review architecture",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							output: { name: "architecture_review", format: "text" },
						},
						{
							id: "security",
							assignment: "Review security",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							output: { name: "security_review", format: "text" },
						},
					],
				},
				{
					id: "synthesis",
					mode: "synthesis",
					dependsOn: ["reviews"],
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					inputs: [{ stageId: "reviews", selection: "successful" }],
					instructions: "Merge the reviews into one approved review.",
					output: "approved_review",
				},
				{
					id: "planning",
					mode: "fanout",
					dependsOn: ["synthesis"],
					base: {
						type: "extension",
						baseId: "repository",
						inputs: [{ stageId: "synthesis", output: "approved_review" }],
					},
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					tasks: [
						{
							id: "backend",
							assignment: "Plan backend work",
							unresolvedAssumptions: [
								{ id: "a", statement: "Reviews inform scope", requiredInspection: "Read approved review" },
							],
						},
						{
							id: "verification",
							assignment: "Plan verification work",
							unresolvedAssumptions: [
								{ id: "b", statement: "Reviews inform checks", requiredInspection: "Read approved review" },
							],
						},
					],
				},
			],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: synthesisPlan,
			planId: contextLineagePlanIdentity(synthesisPlan),
			manifestId: manifest.manifestId,
			checkpointId: checkpoint.checkpointId,
		});
		const observedInputs = new Map<string, readonly string[]>();
		const assignments: string[] = [];
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: synthesisPlan,
			journal,
			runner: {
				async run(request) {
					observedInputs.set(
						request.task.id,
						request.priorOutputs.map(output => output.outputName),
					);
					assignments.push(request.task.assignment);
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		expect(outcome.status).toBe("completed");
		expect(observedInputs.get("synthesis")).toEqual(["architecture_review", "security_review"]);
		expect(observedInputs.get("backend")).toEqual(["approved_review"]);
		expect(assignments).toContain("Merge the reviews into one approved review.");
		const stageRecords = executionRecordsOf(journal).filter(record => record.stageId !== undefined);
		expect(stageRecords.map(record => record.stageId)).toEqual(["reviews", "synthesis", "planning"]);
	});

	it("rejects a synthesis stage whose inputs bypass declared dependencies", () => {
		const invalidPlan: ContextLineagePlan = {
			version: 1,
			title: "Bad synthesis",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "reviews",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "review-task",
						assignment: "Review",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						output: { name: "review", format: "text" },
					},
				},
				{
					id: "synthesis",
					mode: "synthesis",
					inputs: [{ stageId: "reviews" }],
					output: "approved",
				},
			],
		};
		const result = validateContextLineagePlan(invalidPlan, [manifest]);
		expect(result.valid).toBe(false);
		expect(result.issues).toContainEqual({
			path: "stages.synthesis.dependsOn",
			message: "synthesis must depend on input stage: reviews",
		});
	});
	it("continues independent work when the failure policy tolerates sibling loss", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const tolerantPlan: ContextLineagePlan = {
			version: 1,
			title: "Tolerant",
			defaults: { failurePolicy: "continue_independent" },
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "reviews",
					mode: "fanout",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					tasks: [
						{
							id: "survivor",
							assignment: "Succeed",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							output: { name: "findings", format: "text" },
						},
						{
							id: "crasher",
							assignment: "Fail",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							output: { name: "lost", format: "text" },
						},
					],
				},
				{
					id: "consumer",
					dependsOn: ["reviews"],
					mode: "single",
					base: {
						type: "extension",
						baseId: "repository",
						inputs: [{ stageId: "reviews", output: "findings" }],
					},
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "consumer-task",
						assignment: "Use findings",
						unresolvedAssumptions: [{ id: "a", statement: "s", requiredInspection: "i" }],
					},
				},
			],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: tolerantPlan,
			planId: contextLineagePlanIdentity(tolerantPlan),
			manifestId: manifest.manifestId,
			checkpointId: checkpoint.checkpointId,
		});
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: tolerantPlan,
			journal,
			runner: {
				async run(request) {
					if (request.task.id === "crasher") throw new Error("simulated sibling failure");
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		expect(outcome.status).toBe("completed");
		const outputs = executionRecordsOf(journal)
			.filter(record => record.stageId === "reviews")
			.flatMap(record => record.outputs);
		expect(outputs.map(output => output.taskId)).toEqual(["survivor"]);
	});

	it("terminates with failed status when failure blocking empties the pending queue", async () => {
		// Regression: when the LAST pending stage was blocked downstream of a
		// failed stage, the scheduler re-entered its loop with an empty queue
		// and threw "cannot make dependency progress" instead of reporting a
		// failed run. Completed outputs must still be preserved.
		using repo = await createRepositoryFixture({ "src/target.ts": "export const t = 1;\n" });
		const entries: SessionEntry[] = [];
		const journal = {
			appendCustomEntry(customType: string, data?: unknown): string {
				entries.push({
					type: "custom",
					id: `e${entries.length + 1}`,
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					customType,
					data,
				});
				return `e${entries.length + 1}`;
			},
			getBranch: () => entries,
		};
		const prepared = await prepareRepositoryContextLineage({
			cwd: repo.path(),
			task: "Inspect target",
			journal,
		});
		const lowered = lowerFanoutRequest(
			{
				version: 1,
				checkpoint: { type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
				questions: [{ question: "one" }, { question: "two" }],
			},
			{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
		);
		const plan: ContextLineagePlan = {
			...lowered,
			stages: [
				lowered.stages[0] as Extract<(typeof lowered.stages)[number], { mode: "fanout" }>,
				{
					id: "synthesis",
					mode: "synthesis",
					dependsOn: ["questions"],
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					inputs: [{ stageId: "questions", selection: "successful" }],
					output: "merged",
				},
			],
		};
		using artifactsDir = TempDir.createSync("@omp-lineage-blocked-");
		const artifacts = new ArtifactManager(artifactsDir.path());
		const outcome = await executeContextLineagePlan({
			manifest: prepared.manifest,
			checkpoint: prepared.checkpoint,
			plan,
			journal,
			runner: {
				async run(request) {
					if (request.task.id === "question-1") throw new Error("simulated sibling failure");
					return {
						contentDigest: semanticIdentity("out", request.task.id),
						artifactRef: `artifact://${await artifacts.save(`out-${request.task.id}`, "context-lineage")}`,
					};
				},
			},
			outputVerifier: createArtifactManagerContextLineageOutputVerifier(artifacts),
		});
		expect(outcome.status).toBe("failed");
	});

	it("stops only dependents when a stage fails under the default policy", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const branchedPlan: ContextLineagePlan = {
			version: 1,
			title: "Branched failure",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "failing",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "failing-task",
						assignment: "Fail",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "dependent",
					dependsOn: ["failing"],
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "dependent-task",
						assignment: "Never runs",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "unrelated",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "unrelated-task",
						assignment: "Succeed",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
			],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: branchedPlan,
			planId: contextLineagePlanIdentity(branchedPlan),
			manifestId: manifest.manifestId,
			checkpointId: checkpoint.checkpointId,
		});
		const ranTasks: string[] = [];
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: branchedPlan,
			journal,
			runner: {
				async run(request) {
					ranTasks.push(request.task.id);
					if (request.task.id === "failing-task") throw new Error("simulated failure");
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		expect(outcome.status).toBe("failed");
		expect(ranTasks).toEqual(["failing-task", "unrelated-task"]);
		const stageRecords = executionRecordsOf(journal).filter(record => record.stageId !== undefined);
		expect(stageRecords.map(record => record.stageId)).toEqual(["unrelated"]);
	});

	it("executes a plan rooted at a named_base after resolving it from session records", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(
			journal,
			createNamedBaseRecord({ name: "project-base", checkpointId: checkpoint.checkpointId, records: [] }),
		);
		const namedPlan: ContextLineagePlan = {
			version: 1,
			title: "Named execution",
			bases: [{ id: "base", source: { type: "named_base", name: "project-base" } }],
			stages: [
				{
					id: "s",
					mode: "single",
					base: { type: "base", baseId: "base" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "t",
						assignment: "Work from the named base",
					},
				},
			],
		};

		// Unresolved names fail validation inside the executor.
		await expect(
			executeContextLineagePlan({
				manifest,
				checkpoint,
				plan: { ...namedPlan, bases: [{ id: "base", source: { type: "named_base", name: "missing" } }] },
				journal,
				runner: {
					async run() {
						throw new Error("unreachable");
					},
				},
				outputVerifier: {
					async verify() {
						return true;
					},
				},
			}),
		).rejects.toThrow("unsupported base source: named_base");

		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: namedPlan,
			journal,
			runner: {
				async run(request) {
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});
		expect(outcome.status).toBe("completed");
	});

	it("stagger_first dispatches the first task alone before releasing siblings", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const staggerPlan: ContextLineagePlan = {
			version: 1,
			title: "Staggered",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "questions",
					mode: "fanout",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					tasks: [
						{
							id: "writer",
							assignment: "Write the shared prefix",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
						{
							id: "reader-a",
							assignment: "Read A",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
						{
							id: "reader-b",
							assignment: "Read B",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
					],
				},
			],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		const events: string[] = [];
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: staggerPlan,
			journal,
			warmPolicy: "stagger_first",
			runner: {
				async run(request) {
					events.push(`start:${request.task.id}`);
					if (request.task.id === "writer") {
						await Bun.sleep(5);
						events.push("end:writer");
					}
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		expect(outcome.status).toBe("completed");
		const writerEnd = events.indexOf("end:writer");
		const readerAStart = events.indexOf("start:reader-a");
		const readerBStart = events.indexOf("start:reader-b");
		expect(writerEnd).toBeGreaterThanOrEqual(0);
		expect(readerAStart).toBeGreaterThan(writerEnd);
		expect(readerBStart).toBeGreaterThan(writerEnd);
		expect(events.filter(event => event.startsWith("start:"))).toHaveLength(3);
	});

	it("resolves named_base plan sources from session records before validation", () => {
		const namedPlan: ContextLineagePlan = {
			version: 1,
			title: "Named base plan",
			bases: [{ id: "base", source: { type: "named_base", name: "project-base" } }],
			stages: [
				{
					id: "s",
					mode: "single",
					base: { type: "base", baseId: "base" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "t",
						assignment: "Work from the named base",
					},
				},
			],
		};
		// Unresolved name is rejected rather than silently substituted.
		expect(validateContextLineagePlan(namedPlan, []).issues).toContainEqual({
			path: "bases.base",
			message: "unknown named base: project-base",
		});

		const resolved = resolvePlanNamedBases(namedPlan, [
			{
				version: 1,
				kind: "named_base",
				namedBaseId: "nb-1",
				name: "project-base",
				checkpointId: "checkpoint-9",
				status: "active",
			},
		]);
		expect(resolved.bases[0]?.source).toEqual({ type: "checkpoint", checkpointId: "checkpoint-9" });
		expect(
			validateContextLineagePlan(resolved, [], {
				allowedBaseSourceTypes: new Set(["checkpoint"]),
			}),
		).toEqual({ valid: true, issues: [] });

		// Archived generations do not resolve.
		expect(
			resolvePlanNamedBases(namedPlan, [
				{
					version: 1,
					kind: "named_base",
					namedBaseId: "nb-2",
					name: "project-base",
					checkpointId: "checkpoint-9",
					status: "archived",
				},
			]),
		).toBe(namedPlan);
	});

	it("caps fanout questions at the FR10 first-release limit", () => {
		const request = {
			version: 1,
			checkpoint: { type: "current_idle" },
			questions: [1, 2, 3, 4, 5, 6].map(index => ({ id: `q${index}`, question: `Question ${index}` })),
		} as const;
		const result = validateFanoutRequest(request);
		expect(result.valid).toBe(false);
		expect(result.issues).toContainEqual({
			path: "questions",
			message: "first-release fanout supports at most 5 questions (FR10)",
		});
	});

	it("runs tasks through side requests and persists answers as verifiable artifacts", async () => {
		using artifactsDir = TempDir.createSync("@omp-context-lineage-runner-");
		const artifacts = new ArtifactManager(artifactsDir.path());
		const prompts: string[] = [];
		let call = 0;
		const runner = createSideRequestContextLineageTaskRunner({
			session: {
				async runEphemeralTurn({ promptText }) {
					call++;
					prompts.push(promptText);
					return { replyText: `Answer ${call}` };
				},
			},
			saveArtifact: async content => `artifact://${await artifacts.save(content, "context-lineage")}`,
		});
		const verifier = createArtifactManagerContextLineageOutputVerifier(artifacts);
		const result = await runner.run({
			manifest,
			checkpoint: createRepositoryManifestCheckpoint(manifest),
			plan: plan(),
			signal: new AbortController().signal,
			stage: {
				id: "s",
				mode: "single",
				base: { type: "base", baseId: "b" },
				task: { id: "t1", assignment: "Do the work" },
			},
			task: { id: "t1", assignment: "Do the work" },
			priorOutputs: [
				{
					stageId: "up",
					taskId: "u1",
					outputName: "findings",
					contentDigest: "d-up",
					artifactRef: "artifact://up",
				},
			],
		});

		expect(result.contentDigest).toBe(semanticIdentity("context-lineage-output", "Answer 1"));
		expect(prompts[0]).toContain("Frozen repository evidence:");
		expect(prompts[0]).toContain("src/example.ts");
		expect(prompts[0]).toContain("Do the work");
		expect(prompts[0]).toContain("findings");
		expect(await verifier.verify(result)).toBe(true);
	});

	it("renders sibling questions from one stable frozen-evidence prefix before their assignments", async () => {
		const prompts: string[] = [];
		const runner = createSideRequestContextLineageTaskRunner({
			session: {
				async runEphemeralTurn({ promptText }) {
					prompts.push(promptText);
					return { replyText: "Answer" };
				},
			},
			saveArtifact: async () => "artifact://shared-prefix",
		});
		const tasks = [
			{ id: "q1", assignment: "Find the implementation owner" },
			{ id: "q2", assignment: "Find the verification owner" },
		] as const;
		const stage = { id: "questions", mode: "fanout", base: { type: "base", baseId: "b" }, tasks } as const;
		const context = {
			manifest,
			checkpoint: createRepositoryManifestCheckpoint(manifest),
			plan: plan(),
			signal: new AbortController().signal,
			stage,
			priorOutputs: [],
		} as const;
		await runner.run({ ...context, task: tasks[0] });
		await runner.run({ ...context, task: tasks[1] });

		const assignmentMarker = "Assignment:\n";
		const stablePrefixes = prompts.map(promptText => promptText.slice(0, promptText.indexOf(assignmentMarker)));
		expect(stablePrefixes).toEqual([stablePrefixes[0], stablePrefixes[0]]);
		expect(prompts[0]).toContain("Find the implementation owner");
		expect(prompts[1]).toContain("Find the verification owner");
	});

	it("lowers an ask with a manifest-rooted base for sidecar execution", () => {
		const lowered = lowerFanoutRequest(
			{
				version: 1,
				checkpoint: { type: "current_idle" },
				questions: [{ question: "Which assumptions are weakest?" }, { question: "What should we cut?" }],
			},
			{ type: "repository_manifest", manifestId: "manifest-1" },
		);
		expect(lowered.bases[0]?.source).toEqual({ type: "repository_manifest", manifestId: "manifest-1" });
		const loweredStage = lowered.stages[0];
		if (loweredStage?.mode !== "fanout") throw new Error("lowered fanout stage expected");
		expect(loweredStage.tasks.map(task => task.assignment)).toEqual([
			"Which assumptions are weakest?",
			"What should we cut?",
		]);
	});

	it("emits milestone telemetry events with opaque dimensions and no raw content", async () => {
		const events: Array<{ message: string; context?: Record<string, unknown> }> = [];
		const restore = logger.registerLogSink(event => {
			if (event.message.startsWith("lineage.")) {
				events.push({ message: event.message, context: event.context });
			}
		});
		try {
			using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
			const entries: SessionEntry[] = [];
			const journal = {
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
			};
			await prepareRepositoryContextLineage({ cwd: repository.path(), task: "Inspect target", journal });
			const messages = events.map(event => event.message);
			expect(messages).toContain("lineage.repository_snapshot_frozen");
			expect(messages).toContain("lineage.repository_manifest_created");
			expect(messages).toContain("lineage.checkpoint_created");
			const frozen = events.find(event => event.message === "lineage.repository_snapshot_frozen");
			expect(frozen?.context?.snapshot_id).toMatch(/^repository-snapshot:v1:/);
			expect(JSON.stringify(frozen?.context)).not.toContain("export const target");
		} finally {
			restore();
		}
	});

	it("surfaces provider cache observations distinguishing duplicate writers from hits", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const cache = new FakePrefixCache();
		const fanoutPlan: ContextLineagePlan = {
			version: 1,
			title: "Observed",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "questions",
					mode: "fanout",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					tasks: [
						{
							id: "q1",
							assignment: "Q1",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
						{
							id: "q2",
							assignment: "Q2",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
					],
				},
			],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: fanoutPlan,
			planId: contextLineagePlanIdentity(fanoutPlan),
			manifestId: manifest.manifestId,
			checkpointId: checkpoint.checkpointId,
		});
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: fanoutPlan,
			journal,
			warmPolicy: "stagger_first",
			runner: {
				async run(request) {
					// Same shared prefix for every task: first dispatch writes, rest hit.
					const observation = cache.observe("shared-prefix", 100);
					return {
						contentDigest: `digest-${request.task.id}`,
						artifactRef: `artifact://${request.task.id}`,
						cacheObservation: observation,
						elapsedMs: request.task.id === "q1" ? 120 : 80,
						usage: { totalTokens: 240, costUsd: 0.012 },
					};
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		expect(outcome.status).toBe("completed");
		expect(outcome.cacheObservations.map(observation => observation.status)).toEqual(["write", "hit"]);
		// Observed reuse persists durably on the execution outputs (FR8).
		const persisted = executionRecordsOf(journal)
			.filter(record => record.stageId === undefined)
			.flatMap(record => record.outputs);
		// Both the stage progress record and the final record carry cache status.
		expect(persisted.map(output => output.cacheStatus)).toEqual(["write", "hit"]);
		// A diagnostics view reopened after restart can calculate observed cost,
		// latency, and cache-token reuse without retaining a provider request.
		expect(persisted.map(output => output.executionObservation)).toEqual([
			{ elapsedMs: 120, usage: { totalTokens: 240, costUsd: 0.012 }, cacheTokens: { writeTokens: 100 } },
			{ elapsedMs: 80, usage: { totalTokens: 240, costUsd: 0.012 }, cacheTokens: { readTokens: 100 } },
		]);
	});

	it("flushes lineage records to disk without any assistant message (NFR4 lazy-gate regression)", async () => {
		// Regression: session files are created lazily on the first assistant
		// message, so a compile-only lineage flow that crashed before any model
		// turn silently lost its manifest/checkpoint records. Lineage appends
		// must force durability themselves.
		using dir = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
		const prepared = await prepareRepositoryContextLineage({
			cwd: dir.path(),
			task: "Inspect target",
			journal: manager,
		});
		appendContextLineageSessionRecord(manager, {
			version: 1,
			kind: "named_base",
			name: "durability-probe",
			checkpointId: prepared.checkpoint.checkpointId,
			status: "active",
			namedBaseId: semanticIdentity("probe-base", prepared.checkpoint.checkpointId),
		});
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const onDisk = await Bun.file(sessionFile!).text();
		expect(onDisk).toContain("context-lineage");
		expect(onDisk).toContain(prepared.manifest.manifestId);
		expect(onDisk).toContain("durability-probe");
		await manager.close();
	});

	it("recovers lineage records and artifact references in a forked session (§22.6)", async () => {
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		try {
			using repo = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
			const dir = repo.path();
			const cwd = dir;
			const sourceFile = `${dir}/source.jsonl`;
			const timestamp = new Date().toISOString();
			const header = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			await Bun.write(sourceFile, `${JSON.stringify(header)}\n`);

			const source = await SessionManager.open(sourceFile, dir, undefined, {
				initialCwd: dir,
				suppressBreadcrumb: true,
			});
			const prepared = await prepareRepositoryContextLineage({
				cwd: dir,
				task: "Inspect target",
				journal: source,
			});
			await source.close();

			const forked = await SessionManager.forkFrom(sourceFile, dir, dir, undefined, {
				suppressBreadcrumb: true,
			});
			const recovered = getContextLineageSessionRecords(forked);
			expect(recovered.some(record => record.kind === "repository_manifest")).toBe(true);
			expect(recovered.find(record => record.kind === "logical_checkpoint")?.checkpoint.repositoryManifestId).toBe(
				prepared.manifest.manifestId,
			);

			// Artifact references survive the fork because artifacts are copied with it.
			const artifactPath = await forked.getArtifactPath(
				getContextLineageSessionRecords(forked).find(record => record.kind === "repository_manifest")
					?.manifestArtifactId ?? "",
			);
			if (
				getContextLineageSessionRecords(forked).find(record => record.kind === "repository_manifest")
					?.manifestArtifactId
			) {
				expect(artifactPath).not.toBeNull();
			}
			await forked.close();
		} finally {
			if (previousTermSessionId === undefined) delete process.env.TERM_SESSION_ID;
			else process.env.TERM_SESSION_ID = previousTermSessionId;
		}
	});

	it("keeps plan execution out of the parent model context (FR6/NFR3)", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const executionPlan: ContextLineagePlan = {
			version: 1,
			title: "Isolation",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "s",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "t",
						assignment: "Work",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
			],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: executionPlan,
			planId: contextLineagePlanIdentity(executionPlan),
			manifestId: manifest.manifestId,
			checkpointId: checkpoint.checkpointId,
		});
		await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: executionPlan,
			journal,
			runner: {
				async run(request) {
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		// Only typed lineage records may appear; no model-visible message entries.
		expect(entries.every(entry => entry.type === "custom")).toBe(true);
		expect(entries.some(entry => entry.type === "message")).toBe(false);
	});

	it("aborts mid-run so queued stages never start (FR14)", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const abort = new AbortController();
		const ranTasks: string[] = [];
		const twoStagePlan: ContextLineagePlan = {
			version: 1,
			title: "Abort",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "first",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "first-task",
						assignment: "First",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "second",
					dependsOn: ["first"],
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "second-task",
						assignment: "Second",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
			],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, { version: 1, kind: "logical_checkpoint", checkpoint });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: twoStagePlan,
			planId: contextLineagePlanIdentity(twoStagePlan),
			manifestId: manifest.manifestId,
			checkpointId: checkpoint.checkpointId,
		});
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: twoStagePlan,
			journal,
			runner: {
				async run(request) {
					ranTasks.push(request.task.id);
					if (request.task.id === "second-task") abort.abort();
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
			signal: abort.signal,
		});

		expect(outcome.status).toBe("aborted");
		expect(ranTasks).toEqual(["first-task", "second-task"]);
		// The aborted run's completed first stage is still durably recorded.
		const stageRecords = executionRecordsOf(journal)
			.filter(record => record.stageId !== undefined)
			.map(record => record.stageId);
		expect(stageRecords).toEqual(["first"]);
	});

	it("cancels one fanout item without aborting its sibling (FR14)", async () => {
		const itemAbort = new AbortController();
		itemAbort.abort("cancel selected item");
		const executed: string[] = [];
		const result = await executeContextLineagePlan({
			manifest,
			checkpoint: createRepositoryManifestCheckpoint(manifest),
			plan: {
				version: 1,
				title: "Independent cancellation",
				defaults: { failurePolicy: "continue_independent" },
				bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
				stages: [
					{
						id: "questions",
						mode: "fanout",
						base: { type: "base", baseId: "repository" },
						capabilityRequirements: { workspaceMode: "frozen_read_only" },
						tasks: [
							{
								id: "kept",
								assignment: "Keep",
								evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							},
							{
								id: "cancelled",
								assignment: "Cancel",
								evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							},
						],
					},
				],
			},
			journal: { appendCustomEntry: () => "entry", getBranch: () => [] },
			runner: {
				async run(request) {
					request.signal?.throwIfAborted();
					executed.push(request.task.id);
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
			taskSignal: ({ taskId }) => (taskId === "cancelled" ? itemAbort.signal : undefined),
		});

		expect(result.status).toBe("completed");
		expect(executed).toEqual(["kept"]);
	});

	it("keeps durable cancellation handles for queued fanout task identities", () => {
		const controller = new ContextLineageRunController({
			version: 1,
			title: "Controlled fanout",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "questions",
					mode: "fanout",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					tasks: [
						{
							id: "first",
							assignment: "First",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
						{
							id: "second",
							assignment: "Second",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
					],
				},
			],
		});

		expect(controller.cancel("questions", "second")).toBe(true);
		expect(controller.inspect()).toEqual([
			{ stageId: "questions", taskId: "first", state: "queued" },
			{ stageId: "questions", taskId: "second", state: "cancelled" },
		]);
		expect(controller.taskSignal({ stageId: "questions", taskId: "second" })?.aborted).toBe(true);
	});

	it("emits item attempt telemetry including failures (§20.1)", async () => {
		const events: Array<{ message: string; context?: Record<string, unknown> }> = [];
		const restore = logger.registerLogSink(event => {
			if (event.message.startsWith("lineage.item_attempt")) {
				events.push({ message: event.message, context: event.context });
			}
		});
		try {
			const attemptPlan: ContextLineagePlan = {
				version: 1,
				title: "Attempts",
				bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
				stages: [
					{
						id: "stage",
						mode: "fanout",
						base: { type: "base", baseId: "repository" },
						capabilityRequirements: { workspaceMode: "frozen_read_only" },
						tasks: [
							{
								id: "survivor",
								assignment: "Succeed",
								evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							},
							{
								id: "crasher",
								assignment: "Fail",
								evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
							},
						],
					},
				],
			};
			const checkpoint = createRepositoryManifestCheckpoint(manifest);
			await executeContextLineagePlan({
				manifest,
				checkpoint,
				plan: attemptPlan,
				journal: { appendCustomEntry: () => "e", getBranch: () => [] },
				runner: {
					async run(request) {
						if (request.task.id === "crasher") throw new Error("boom");
						return { contentDigest: `d-${request.task.id}`, artifactRef: `a://${request.task.id}` };
					},
				},
				outputVerifier: {
					async verify() {
						return true;
					},
				},
			});

			const started = events.filter(event => event.message === "lineage.item_attempt_started");
			const completed = events.filter(event => event.message === "lineage.item_attempt_completed");
			const failed = events.filter(event => event.message === "lineage.item_attempt_failed");
			expect(started).toHaveLength(2);
			expect(completed).toHaveLength(1);
			expect(failed).toHaveLength(1);
			expect(completed[0]?.context?.task_id).toBe("survivor");
			expect(failed[0]?.context?.error).toContain("boom");
		} finally {
			restore();
		}
	});

	it("rejects an unknown failure policy before dispatch", () => {
		const badPlan: ContextLineagePlan = {
			version: 1,
			title: "Bad policy",
			defaults: { failurePolicy: "yolo" as PlanFailurePolicy },
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "s",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "t",
						assignment: "A",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
			],
		};
		expect(validateContextLineagePlan(badPlan, [manifest]).issues).toContainEqual({
			path: "defaults.failurePolicy",
			message: "unknown failure policy: yolo",
		});
	});

	it("promotes a result to its explicit origin idempotently with durable provenance", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		let branchCreations = 0;
		const promote = async (assignment: string) => {
			branchCreations++;
			expect(assignment).toBe("Which assumptions are weakest?");
			return { sessionId: "session-origin", leafId: `leaf-${branchCreations}` };
		};
		const shared = {
			journal,
			originLeafId: "leaf-origin-1",
			assignment: "Which assumptions are weakest?",
			answer: "The MVP scope assumption is weakest.",
			answerArtifactRef: "artifact://9",
			promote,
		};

		const first = await promoteContextLineageResult(shared);
		expect(first.reused).toBe(false);
		expect(branchCreations).toBe(1);

		const repeat = await promoteContextLineageResult(shared);
		expect(repeat.reused).toBe(true);
		expect(repeat.promotionId).toBe(first.promotionId);
		expect(branchCreations).toBe(1);

		const changedAnswer = await promoteContextLineageResult({ ...shared, answer: "A different answer." });
		expect(changedAnswer.reused).toBe(false);
		expect(branchCreations).toBe(2);

		const recovered = getContextLineageSessionRecords(journal).filter(record => record.kind === "promotion");
		expect(recovered).toHaveLength(2);
		expect(recovered[0]).toMatchObject({
			promotionId: first.promotionId,
			originLeafId: "leaf-origin-1",
			sessionId: "session-origin",
		});
		expect(summarizeContextLineageSession(journal).promotions).toBe(2);
		await expect(promoteContextLineageResult({ ...shared, originLeafId: "" })).rejects.toThrow(
			"explicit origin leaf",
		);
	});

	it("compares fan-out shared-prefix economics against observed cache behavior", () => {
		const cost = fanoutSharedCost({
			sharedTokens: 1000,
			branchCount: 4,
			writerCount: 1,
			cacheWriteMultiplier: 1.25,
			cacheReadMultiplier: 0.1,
			inputPricePerToken: 2,
		});
		expect(cost.uncached).toBe(8000);
		expect(cost.observedCached).toBe(3100);
		expect(cost.delta).toBe(-4900);
		expect(() =>
			fanoutSharedCost({
				sharedTokens: 10,
				branchCount: 2,
				writerCount: 3,
				cacheWriteMultiplier: 1,
				cacheReadMultiplier: 1,
				inputPricePerToken: 1,
			}),
		).toThrow("cannot exceed branch count");
	});

	it("reports plan-induced reuse against the per-task serialization counterfactual", () => {
		const comparison = planInducedReuse({
			observations: [
				{ stageId: "reviews", taskCount: 3, sharedTokens: 2000 },
				{ stageId: "planning", taskCount: 2, sharedTokens: 3000 },
			],
			uniqueTokensPerTask: 100,
		});
		expect(comparison.sharedTokensAtAncestors).toBe(5000);
		expect(comparison.counterfactualTokens).toBe(3 * 2000 + 2 * 3000);
		expect(comparison.compiledTokens).toBe(5000 + 5 * 100);
		expect(comparison.delta).toBe(comparison.counterfactualTokens - comparison.compiledTokens);
	});

	it("separates checkpoint reuse from usefulness signals per FR38", () => {
		const records: ContextLineageSessionRecord[] = [];
		// The FR38 helper reads records directly; no journal round-trip is needed.

		// Two runs from checkpoint-1 (one failed), one run from checkpoint-2.
		for (const [checkpointId, status] of [
			["checkpoint-1", "completed"],
			["checkpoint-1", "failed"],
			["checkpoint-2", "completed"],
		] as const) {
			records.push({
				...createContextLineageExecutionRecord({
					planId: `plan-${checkpointId}`,
					checkpointId,
					status,
					outputs: [],
				}),
			});
		}
		records.push({
			version: 1,
			kind: "plan",
			plan: { version: 1, title: "P", bases: [], stages: [] },
			planId: "plan-x",
			manifestId: "manifest-1",
			checkpointId: "checkpoint-1",
		});

		const signals = contextUtilityByCheckpoint(records);
		expect(signals).toEqual([
			{ checkpointId: "checkpoint-1", executions: 2, completedRuns: 1, plans: 1 },
			{ checkpointId: "checkpoint-2", executions: 1, completedRuns: 1, plans: 0 },
		]);
	});

	it("partitions stages into explained prefix families without weakening requirements", () => {
		const partitionPlan: ContextLineagePlan = {
			version: 1,
			title: "Families",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "alpha",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "alpha-task",
						assignment: "A",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "beta",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "beta-task",
						assignment: "B",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "gamma",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only", tools: ["write_file"] },
					task: {
						id: "gamma-task",
						assignment: "C",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "delta",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "isolated_write" },
					task: {
						id: "delta-task",
						assignment: "D",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
			],
		};
		const target = { provider: "test", model: "model-1", rendererContractVersion: "v1" };
		const partition = partitionCompatibilityFamilies({
			plan: partitionPlan,
			target,
			options: {
				allowedWorkspaceModes: new Set(["frozen_read_only"]),
				availableTools: new Set<string>(),
			},
		});

		expect(partition.families).toHaveLength(1);
		const readOnlyFamily = partition.families.find(family => family.stageIds.includes("alpha"));
		expect(readOnlyFamily?.stageIds).toEqual(["alpha", "beta"]);
		expect(partition.divergences).toEqual([
			{ stageId: "delta", reason: "unavailable workspace mode: isolated_write" },
			{ stageId: "gamma", reason: "unavailable tool: write_file" },
		]);
		const again = partitionCompatibilityFamilies({
			plan: partitionPlan,
			target,
			options: {
				allowedWorkspaceModes: new Set(["frozen_read_only"]),
				availableTools: new Set<string>(),
			},
		});
		expect(again.families.map(family => family.familyId)).toEqual(partition.families.map(family => family.familyId));
	});

	it("models exact-prefix families, duplicate writers, and expiry against the fake provider", () => {
		const clock = 1000;
		const cache = new FakePrefixCache(() => clock);
		const base = [
			{ kind: "system", digest: "d1" },
			{ kind: "history", digest: "d2" },
		];
		const encoded = FAKE_LINEAGE_PROVIDER.encodePrefix(base);
		const tokens = 4200;

		const first = cache.observe(encoded, tokens, "route-a");
		expect(first.status).toBe("write");
		expect(first.writeTokens).toBe(tokens);
		const sibling = cache.observe(FAKE_LINEAGE_PROVIDER.encodePrefix(base), tokens, "route-a");
		expect(sibling.status).toBe("hit");
		expect(sibling.readTokens).toBe(tokens);

		cache.advanceClock(30_000);
		const stillWarm = cache.observe(encoded, tokens);
		expect(stillWarm.status).toBe("hit");

		cache.clear();
		const cold = cache.observe(encoded, tokens);
		expect(cold.status).toBe("write");

		expect(FAKE_LINEAGE_PROVIDER.encodePrefix([...base])).toBe(encoded);
		expect(FAKE_LINEAGE_PROVIDER.encodePrefix([{ kind: "system", digest: "d1" }])).not.toBe(encoded);
	});

	it("verifies exact families and detects provider-visible rewrites", () => {
		const base = [
			{ kind: "system", digest: "d1" },
			{ kind: "history", digest: "d2" },
		];
		const siblings = [
			[...base, { kind: "leaf", digest: "q1" }],
			[...base, { kind: "leaf", digest: "q2" }],
		];
		expect(verifyExactFamily(base, siblings)).toEqual({ compatible: true });

		const rewritten = [
			[...base, { kind: "leaf", digest: "q1" }],
			[
				{ kind: "system", digest: "d1" },
				{ kind: "developer", digest: "d2" },
				{ kind: "leaf", digest: "q2" },
			],
		];
		const check = verifyExactFamily(base, rewritten);
		expect(check.compatible).toBe(false);
		expect(check.divergence?.index).toBe(1);
		expect(check.divergence?.reason).toContain("diverges from the prepared base");

		const truncated = [[{ kind: "system", digest: "d1" }]];
		expect(verifyExactFamily(base, truncated).divergence?.reason).toContain("shorter than the prepared base");
	});

	it("enriches manifests with bounded rename lineage and churn from git history", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = 1;\n" });
		await Bun.write(`${repository.path()}/src/target.ts`, "export const target = 11;\n");
		await $`git -c user.name=Test -c user.email=test@example.com commit -am churn`.cwd(repository.path()).quiet();
		await $`git mv src/target.ts src/renamed.ts`.cwd(repository.path()).quiet();
		await $`git -c user.name=Test -c user.email=test@example.com commit -m rename`.cwd(repository.path()).quiet();
		await Bun.write(`${repository.path()}/src/renamed.ts`, "export const target = 2;\n");
		await $`git add -A`.cwd(repository.path()).quiet();
		await $`git -c user.name=Test -c user.email=test@example.com commit -m retune`.cwd(repository.path()).quiet();

		const manifest = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Inspect target",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/renamed.ts"],
		});
		const collected = await collectTemporalEvidence({
			repositoryRoot: repository.path(),
			snapshot: manifest.snapshot,
			paths: manifest.evidence.map(evidence => evidence.sourceRef),
			policy: { id: "temporal-v1" },
		});

		const renamed = collected.evidence.find(evidence => evidence.sourceRef === "src/renamed.ts");
		expect(renamed?.evidenceClass).toBe("historical_observation");
		expect(renamed?.inclusionReason).toContain("src/target.ts -> src/renamed.ts");
		expect(renamed?.adapterId).toBe("native-git-temporal");
		expect(renamed?.authority).toBe("corroborating");
		expect(renamed?.bitemporalProvenance?.observedAt).toBeGreaterThan(0);
		expect(collected.degradedSources).toEqual([]);

		const merged = mergeTemporalEvidence(manifest, collected, 5);
		expect(merged.manifestId).not.toBe(manifest.manifestId);
		expect(merged.evidence.some(evidence => evidence.evidenceClass === "historical_observation")).toBe(true);
		expect(merged.evidence.some(evidence => evidence.evidenceClass === "current_structural")).toBe(true);
		expect(isRepositoryContextManifestIntact(merged)).toBe(true);
		const mergedAgain = mergeTemporalEvidence(manifest, collected, 5);
		expect(mergedAgain.manifestId).toBe(merged.manifestId);
	});

	it("degrades explicitly when temporal evidence exceeds its budget", async () => {
		using repository = await createRepositoryFixture({
			"a.ts": "export const a = 1;\n",
			"b.ts": "export const b = 1;\n",
		});
		const manifest = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Inspect a",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["a.ts", "b.ts"],
		});
		const collected = await collectTemporalEvidence({
			repositoryRoot: repository.path(),
			snapshot: manifest.snapshot,
			paths: ["a.ts", "b.ts"],
			policy: { id: "temporal-v1", maxPaths: 1 },
		});
		expect(collected.degradedSources).toEqual([
			{
				extractorId: "native-git-temporal",
				reason: "budget_limited",
				detail: "temporal scan limited to 1 of 2 paths",
			},
		]);
		const merged = mergeTemporalEvidence(manifest, collected, 0);
		expect(merged.degradedSources).toContainEqual({
			extractorId: "native-git-temporal",
			reason: "budget_limited",
			detail: "temporal evidence limited to 0 item(s)",
		});
	});

	it("labels bounded co-change evidence with its commit sample instead of treating it as current structure", async () => {
		using repository = await createRepositoryFixture({
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": "export const b = 1;\n",
		});
		await Bun.write(`${repository.path()}/src/a.ts`, "export const a = 2;\n");
		await Bun.write(`${repository.path()}/src/b.ts`, "export const b = 2;\n");
		await $`git add src/a.ts src/b.ts`.cwd(repository.path()).quiet();
		await $`git -c user.name=Test -c user.email=test@example.com commit -m cochange`.cwd(repository.path()).quiet();
		const snapshot = await resolveRepositorySnapshot(repository.path());
		const collected = await collectTemporalEvidence({
			repositoryRoot: repository.path(),
			snapshot,
			paths: ["src/a.ts"],
			policy: { id: "temporal-v1", maxCoChangesPerPath: 1, profile: "regression" },
		});

		const coChange = collected.evidence.find(evidence => evidence.sourceKind === "git_cochange");
		expect(coChange).toMatchObject({
			evidenceClass: "statistical_relationship",
			authority: "corroborating",
			sourceRef: "src/a.ts <-> src/b.ts",
		});
		expect(coChange?.inclusionReason).toMatch(/^co-change sample: \d+ commit\(s\) \([0-9a-f, ]+\)$/);
	});

	it("selects deterministic bounded temporal profiles from task intent", () => {
		expect(inferTemporalRetrievalProfile("Migrate the deprecated account schema")).toBe("migration");
		expect(inferTemporalRetrievalProfile("Fix the crash regression in sync")).toBe("regression");
		expect(inferTemporalRetrievalProfile("Change the public API contract")).toBe("api_change");
		expect(inferTemporalRetrievalProfile("Refactor the parser")).toBe("refactor");
	});

	it("keeps local documentary context labeled, bounded, and non-current", () => {
		const collected = collectLocalDocumentaryEvidence({
			snapshot: manifest.snapshot,
			maxItems: 1,
			documents: [
				{ sourceRef: "docs/adr/001.md", content: "Use staged migration.", learnedAt: 1, validFrom: "2025-01-01" },
				{ sourceRef: "docs/adr/002.md", content: "Old approach.", supersededBy: "docs/adr/003.md" },
			],
		});
		expect(collected.evidence[0]).toMatchObject({
			evidenceClass: "documentary_observation",
			authority: "documentary",
			snapshotCoverage: "unavailable",
		});
		expect(collected.degradedSources).toContainEqual({
			extractorId: "local-documentary-v1",
			reason: "budget_limited",
			detail: "documentary collection limited to 1 of 2 item(s)",
		});
	});

	it("keeps caller-authorized forge artifacts documentary and non-current", () => {
		const collected = collectLocalDocumentaryEvidence({
			snapshot: manifest.snapshot,
			maxItems: 1,
			documents: [{ source: "forge", sourceRef: "forge://owner/repo/pull/42", content: "Prior review notes." }],
		});

		expect(collected.evidence).toEqual([
			expect.objectContaining({
				sourceKind: "forge_document",
				adapterId: "forge-documentary-v1",
				authority: "documentary",
				extractionMethod: "caller-authorized-forge-artifact",
				snapshotCoverage: "unavailable",
				staleness: expect.objectContaining({ state: "unknown" }),
			}),
		]);
	});

	it("merges bounded authorized documentary excerpts without elevating repository authority", () => {
		const collected = collectLocalDocumentaryEvidence({
			snapshot: manifest.snapshot,
			maxItems: 1,
			maxExcerptBytes: 12,
			documents: [
				{ source: "forge", sourceRef: "forge://owner/repo/issue/42", content: "A documentary rationale." },
			],
		});
		const merged = mergeDocumentaryEvidence(manifest, collected);
		const evidence = merged.evidence.find(item => item.sourceRef === "forge://owner/repo/issue/42");

		expect(evidence).toMatchObject({
			evidenceClass: "documentary_observation",
			authority: "documentary",
			staleness: { state: "unknown" },
			excerpt: { content: "A documentar", truncated: true },
		});
		expect(merged.manifestId).not.toBe(manifest.manifestId);
	});

	it("resumes a failed run from persisted stage completions without rerunning finished stages", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const twoStagePlan: ContextLineagePlan = {
			version: 1,
			title: "Resume",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "source",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "source-task",
						assignment: "Inspect source",
						evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						output: { name: "findings", format: "text" },
					},
				},
				{
					id: "consumer",
					dependsOn: ["source"],
					mode: "single",
					base: { type: "extension", baseId: "repository", inputs: [{ stageId: "source", output: "findings" }] },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "consumer-task",
						assignment: "Use selected findings",
						unresolvedAssumptions: [
							{ id: "a", statement: "Review findings", requiredInspection: "Read artifact" },
						],
					},
				},
			],
		};
		const executionCheckpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "logical_checkpoint",
			checkpoint: executionCheckpoint,
		});
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: twoStagePlan,
			planId: contextLineagePlanIdentity(twoStagePlan),
			manifestId: manifest.manifestId,
			checkpointId: executionCheckpoint.checkpointId,
		});
		const shared = {
			manifest,
			checkpoint: executionCheckpoint,
			plan: twoStagePlan,
			journal,
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		} as const;
		const ranTasks: string[] = [];
		const firstOutcome = await executeContextLineagePlan({
			...shared,
			runner: {
				async run(request) {
					ranTasks.push(request.task.id);
					if (request.task.id === "consumer-task") throw new Error("simulated crash");
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
		});
		expect(firstOutcome.status).toBe("failed");

		const completedStages = executionRecordsOf(journal, firstOutcome.runId)
			.filter(record => record.stageId !== undefined)
			.map(record => record.stageId!);
		const resumeOutputs = executionRecordsOf(journal, firstOutcome.runId).flatMap(record => record.outputs);

		const secondOutcome = await executeContextLineagePlan({
			...shared,
			resume: { completedStageIds: completedStages, outputs: resumeOutputs },
			runner: {
				async run(request) {
					ranTasks.push(request.task.id);
					return { contentDigest: `digest-${request.task.id}`, artifactRef: `artifact://${request.task.id}` };
				},
			},
		});

		expect(secondOutcome.status).toBe("completed");
		expect(ranTasks.filter(taskId => taskId === "source-task")).toHaveLength(1);
	});

	it("retries only the missing fanout item while retaining its completed sibling", async () => {
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		const retried: string[] = [];
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: plan(),
			journal: { appendCustomEntry: () => "entry", getBranch: () => [] },
			resume: {
				completedStageIds: [],
				outputs: [
					{
						stageId: "review",
						taskId: "scope",
						contentDigest: "persisted-scope",
						artifactRef: "artifact://scope",
					},
				],
			},
			runner: {
				async run(request) {
					retried.push(request.task.id);
					return { contentDigest: "new-verify", artifactRef: "artifact://verify" };
				},
			},
			outputVerifier: {
				async verify() {
					return true;
				},
			},
		});

		expect(outcome.status).toBe("completed");
		expect(retried).toEqual(["verify"]);
	});

	it("persists only a manifest-validated plan beside its frozen checkpoint", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		const entries: SessionEntry[] = [];
		const journal = {
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
		};

		const planned = await planRepositoryContextLineage({
			cwd: repository.path(),
			task: "Inspect target",
			journal,
			generator: {
				async generate(request) {
					const manifestId = request.match(/Manifest ID:\n([^\n]+)/)?.[1];
					if (!manifestId) throw new Error("missing manifest ID");
					return JSON.stringify({
						version: 1,
						title: "Inspect target",
						bases: [{ id: "repository", source: { type: "repository_manifest", manifestId } }],
						stages: [
							{
								id: "inspect",
								mode: "single",
								base: { type: "base", baseId: "repository" },
								capabilityRequirements: { workspaceMode: "frozen_read_only" },
								task: {
									id: "inspect-task",
									assignment: "Inspect frozen evidence",
									unresolvedAssumptions: [
										{ id: "a", statement: "Need review", requiredInspection: "Read frozen evidence" },
									],
								},
							},
						],
					});
				},
			},
		});

		expect(planned.valid).toBe(true);
		expect(getContextLineageSessionRecords(journal).map(record => record.kind)).toEqual([
			"repository_manifest",
			"logical_checkpoint",
			"plan",
		]);
	});

	it("freezes bounded source excerpts into canonical manifest bytes", async () => {
		using repository = await createRepositoryFixture({
			"src/target.ts": "export const before = true;\n",
			"src/target-helper.ts": "export const helper = true;\n",
		});
		const request = {
			task: "Update target behavior",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1 },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		} as const;
		const first = await compileCurrentStateRepositoryManifest(repository.path(), request);
		const second = await compileCurrentStateRepositoryManifest(repository.path(), request);
		await Bun.write(`${repository.path()}/src/target.ts`, "export const after = true;\n");

		expect(serializeRepositoryContextManifest(second)).toBe(serializeRepositoryContextManifest(first));
		expect(renderRepositoryContextManifest(first)).toContain("export const before = true;");
		expect(renderRepositoryContextManifest(first)).not.toContain("export const after = true;");
		expect(first.omissions).toContainEqual({
			sourceRef: "src/target-helper.ts",
			reason: "budget",
			detail: "evidence limit 1",
		});
	});

	it("captures dirty current source without rewriting the selected HEAD", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const state = 'head';\n" });
		const headBefore = (await $`git rev-parse HEAD`.cwd(repository.path()).quiet()).text().trim();
		await Bun.write(`${repository.path()}/src/target.ts`, "export const state = 'dirty';\n");

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Update target state",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});
		const headAfter = (await $`git rev-parse HEAD`.cwd(repository.path()).quiet()).text().trim();

		expect(compiled.snapshot.headCommit).toBe(headBefore);
		expect(compiled.snapshot.overlayDigest).toBeDefined();
		expect(renderRepositoryContextManifest(compiled)).toContain("export const state = 'dirty';");
		expect(compiled.evidence[0]).toMatchObject({
			adapterId: "native-current-state",
			snapshotCoverage: "exact_with_overlay",
			staleness: { state: "fresh" },
		});
		expect(headAfter).toBe(headBefore);
	});

	it("includes untracked source only when the declared snapshot policy permits it", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		await Bun.write(`${repository.path()}/notes/target.md`, "Untracked verification note\n");
		const baseRequest = {
			task: "Review target",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["notes/target.md"],
		} as const;

		const excluded = await compileCurrentStateRepositoryManifest(repository.path(), baseRequest);
		const included = await compileCurrentStateRepositoryManifest(repository.path(), {
			...baseRequest,
			untrackedPolicy: "include",
		});

		expect(excluded.evidence.map(evidence => evidence.sourceRef)).not.toContain("notes/target.md");
		expect(included.evidence.map(evidence => evidence.sourceRef)).toContain("notes/target.md");
		expect(included.snapshot.untrackedPolicy).toBe("include");
		expect(included.manifestId).not.toBe(excluded.manifestId);
	});

	it("does not follow a repository symlink while expanding source dependencies", async () => {
		using repository = await createRepositoryFixture({
			"src/target.ts": "export const target = true;\n",
			"src/sibling.ts": "export const sibling = true;\n",
		});
		using external = TempDir.createSync("@omp-context-lineage-external-");
		const externalPath = `${external.path()}/secret.ts`;
		await Bun.write(externalPath, "import { sibling } from './sibling';\nexport const secret = sibling;\n");
		await fs.symlink(externalPath, `${repository.path()}/src/external.ts`);

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Inspect external source",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/external.ts"],
			untrackedPolicy: "include",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).not.toContain("src/external.ts");
		expect(compiled.evidence.map(evidence => evidence.sourceRef)).not.toContain("src/sibling.ts");
		expect(compiled.omissions).toContainEqual({
			sourceRef: "src/external.ts",
			reason: "unreadable",
			detail: "source could not be captured",
		});
		expect(renderRepositoryContextManifest(compiled)).not.toContain("secret = sibling");
	});

	it("records source-excerpt truncation without losing full-source identity", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "first-line\nsecond-line\n" });
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Inspect target",
			retrievalPolicy: { id: "current-state-v1", maxExcerptBytes: 11 },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});
		const evidence = compiled.evidence[0];

		expect(evidence?.excerpt).toMatchObject({
			path: "src/target.ts",
			content: "first-line\n",
			sourceBytes: 23,
			truncated: true,
		});
		expect(evidence?.sourceDigest).not.toBe(evidence?.excerpt?.contentDigest);
	});

	it("includes a selected source file with its package boundary and matching verification candidate", async () => {
		using repository = await createRepositoryFixture({
			"package.json": '{"scripts":{"test":"bun test"}}\n',
			"tsconfig.json": '{"compilerOptions":{"strict":true}}\n',
			"src/target.ts": "export const target = true;\n",
			"test/target.test.ts": "import { target } from '../src/target';\n",
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Change target behavior",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 4 },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toEqual([
			"package.json",
			"src/target.ts",
			"test/target.test.ts",
			"tsconfig.json",
		]);
		expect(compiled.evidence.find(evidence => evidence.sourceRef === "test/target.test.ts")?.inclusionReason).toBe(
			"verification candidate for src/target.ts",
		);
		expect(compiled.evidence.find(evidence => evidence.sourceRef === "package.json")).toMatchObject({
			evidenceClass: "current_workspace",
			sourceKind: "package_manifest",
		});
		expect(renderRepositoryContextManifest(compiled)).toContain("Class: current_workspace");
		expect(compiled.evidence.find(evidence => evidence.sourceRef === "tsconfig.json")).toMatchObject({
			evidenceClass: "current_workspace",
			sourceKind: "configuration_file",
			inclusionReason: "configuration candidate for src/target.ts",
		});
	});

	it("reserves a bounded test whose own content matches the task", async () => {
		using repository = await createRepositoryFixture({
			"src/session-a.ts": "export const sessionFork = true;\n",
			"src/session-b.ts": "export const sessionFork = true;\n",
			"src/session-c.ts": "export const sessionFork = true;\n",
			"src/session-d.ts": "export const sessionFork = true;\n",
			"test/session-fork.test.ts": "export const verifiesSessionForkBehavior = true;\n",
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Preserve session fork behavior",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 4 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toContain("test/session-fork.test.ts");
		expect(compiled.evidence.find(evidence => evidence.sourceRef === "test/session-fork.test.ts")).toMatchObject({
			sourceKind: "test_file",
			inclusionReason: "task terms match verification source content",
		});
	});

	it("scans beyond similarly named tests to reserve a later task-coherent verification file", async () => {
		const files: Record<string, string> = {
			"src/session-owner.ts": "export const fork = () => copySessionArtifacts();\n",
			"test/z-session-artifacts-fork.test.ts": "export const copiesSessionArtifactsIntoFork = true;\n",
		};
		for (let index = 0; index < 20; index++) {
			files[`test/a-session-reference-${index}.test.ts`] = "export const sessionReference = true;\n";
		}
		using repository = await createRepositoryFixture(files);
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Preserve referenced artifacts when a session is forked.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 4 },
			contextRendererVersion: "renderer-v1",
		});

		expect(
			compiled.evidence.find(evidence => evidence.sourceRef === "test/z-session-artifacts-fork.test.ts"),
		).toMatchObject({
			sourceKind: "test_file",
			inclusionReason: "task terms match verification source content",
		});
	});

	it("retains primary task-path matches before ancillary package and verification expansion", async () => {
		using repository = await createRepositoryFixture({
			"package.json": '{"name":"fixture"}\n',
			"tsconfig.json": '{"compilerOptions":{}}\n',
			"src/session-manager.ts": "export const forkSession = true;\n",
			"test/session-manager.test.ts": "export const verifiesFork = true;\n",
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Preserve session fork artifacts",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toEqual(["src/session-manager.ts"]);
	});

	it("keeps a package-scoped retrieval budget inside the invoking workspace", async () => {
		using repository = await createRepositoryFixture({
			"packages/app/src/session-fork.ts": "export const forkSession = true;\n",
			"packages/other/src/session-fork.ts": "export const forkSession = false;\n",
		});
		const compiled = await compileCurrentStateRepositoryManifest(`${repository.path()}/packages/app`, {
			task: "Preserve session fork artifacts",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toEqual(["packages/app/src/session-fork.ts"]);
	});

	it("selects bounded current-source evidence when task terms occur only in source content", async () => {
		using repository = await createRepositoryFixture({
			"src/service.ts": "export const applyPolicy = () => 'frobnicate';\n",
			"src/other.ts": "export const other = true;\n",
		});

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Correct frobnicate behavior",
			retrievalPolicy: { id: "current-state-v1", maxSemanticScanFiles: 2 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.find(evidence => evidence.sourceRef === "src/service.ts")).toMatchObject({
			inclusionReason: "task terms match current source content",
			evidenceClass: "current_structural",
		});
	});

	it("seeds a bounded generic-named source owner from an exact task phrase", async () => {
		using repository = await createRepositoryFixture({
			"src/a-unrelated.ts": "export const unrelated = true;\n",
			"src/z-session-owner.ts": "export const reset = () => secondThought.branchTransition();\n",
		});

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Reset Second Thought state at the committed branch transition.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1, maxSemanticScanFiles: 1 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence).toEqual([
			expect.objectContaining({
				sourceRef: "src/z-session-owner.ts",
				inclusionReason: "task phrase matches current source content",
			}),
		]);
	});

	it("prefers a coherent transition owner over a source that only repeats the feature phrase", async () => {
		using repository = await createRepositoryFixture({
			"src/a-second-thought-view.ts": "export const view = 'Second Thought state';\n",
			"src/z-session-owner.ts": "export const reset = () => secondThought.branchTransition();\n",
		});

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Reset Second Thought state at the committed branch transition.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1, maxSemanticScanFiles: 8 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toEqual(["src/z-session-owner.ts"]);
	});

	it("keeps an exact task-path owner ahead of a supporting phrase hit", async () => {
		using repository = await createRepositoryFixture({
			"src/system-prompt.ts": "export const stable = true;\n",
			"src/a-support.ts": "export const note = 'stable system prompt';\n",
		});

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Keep a stable system prompt.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1, maxSemanticScanFiles: 8 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toEqual(["src/system-prompt.ts"]);
	});

	it("promotes a source where the artifact and fork task terms occur together", async () => {
		using repository = await createRepositoryFixture({
			"src/a-session-view.ts": "export const sessionArtifactView = true;\n",
			"src/z-owner.ts": "export const fork = () => copySessionArtifacts();\n",
		});

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Preserve referenced artifacts when a session is forked.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1, maxSemanticScanFiles: 8 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toEqual(["src/z-owner.ts"]);
	});

	it("seeds task phrases across bounded source directories from a repository-root invocation", async () => {
		using repository = await createRepositoryFixture({
			"packages/aaa/src/unrelated.ts": "export const unrelated = true;\n",
			"packages/app/src/session-owner.ts": "export const reset = () => secondThought.branchTransition();\n",
		});

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Reset Second Thought state at the committed branch transition.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 1, maxSemanticScanFiles: 1 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence[0]).toMatchObject({
			sourceRef: "packages/app/src/session-owner.ts",
			inclusionReason: "task phrase matches current source content",
		});
	});

	it("does not let a loose path match suppress stronger task-relevant source content", async () => {
		using repository = await createRepositoryFixture({
			"src/target-config.ts": "export const config = true;\n",
			"src/service.ts": "export const applyPolicy = () => 'frobnicate';\n",
		});

		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Fix target frobnicate behavior",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 2, maxSemanticScanFiles: 2 },
			contextRendererVersion: "renderer-v1",
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toContain("src/service.ts");
		expect(compiled.evidence.find(evidence => evidence.sourceRef === "src/service.ts")?.inclusionReason).toBe(
			"task terms match current source content",
		);
	});

	it("includes a maintained decision as attributed context instead of current structural truth", async () => {
		using repository = await createRepositoryFixture({
			"src/target.ts": "export const target = true;\n",
			"docs/decisions/architecture.md": "# Target decision\n\nKeep the target API stable.\n",
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Change target behavior",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});
		const decision = compiled.evidence.find(evidence => evidence.sourceRef === "docs/decisions/architecture.md");

		expect(decision).toMatchObject({
			evidenceClass: "maintained_decision",
			sourceKind: "maintained_decision",
			inclusionReason: "maintained decision candidate for src/target.ts",
		});
		expect(renderRepositoryContextManifest(compiled)).toContain("Class: maintained_decision");
	});

	it("renders a source-free manifest inspection with evidence provenance and omission detail", () => {
		const inspection = summarizeRepositoryContextManifest({
			...manifest,
			evidence: [
				{
					...manifest.evidence[0],
					excerpt: {
						path: "src/example.ts",
						startLine: 1,
						endLine: 1,
						content: "secret source",
						contentDigest: "excerpt-digest",
						sourceBytes: 13,
						truncated: true,
					},
				},
			],
			omissions: [{ sourceRef: "src/large.ts", reason: "budget", detail: "excerpt limit" }],
			degradedSources: [{ extractorId: "graphiti", reason: "unavailable", detail: "adapter unavailable" }],
		});

		expect(inspection).toContain("src/example.ts [current_structural; task scope, excerpt truncated]");
		expect(inspection).toContain("Omitted src/large.ts: budget (excerpt limit)");
		expect(inspection).toContain("Degraded graphiti: unavailable (adapter unavailable)");
		expect(inspection).not.toContain("secret source");
	});

	it("adds a source-backed local import as bounded dependency evidence", async () => {
		using repository = await createRepositoryFixture({
			"src/target.ts": 'import { helper } from "./helper";\nexport const target = helper;\n',
			"src/helper.ts": "export const helper = true;\n",
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Change target behavior",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});
		const dependency = compiled.evidence.find(evidence => evidence.sourceRef === "src/helper.ts");

		expect(dependency).toMatchObject({
			evidenceClass: "current_structural",
			inclusionReason: "relative dependency of src/target.ts",
			sourceKind: "workspace_file",
		});
	});

	it("finds an alias-importing test through bounded task content when its filename is generic", async () => {
		using repository = await createRepositoryFixture({
			"src/agent-session.ts":
				'import { SessionManager } from "./session-manager";\nexport const fork = SessionManager;\n',
			"src/session-manager.ts": "export const SessionManager = true;\n",
			"test/controllers/command-controller.test.ts":
				'// Verify fork artifacts.\nimport { SessionManager } from "@fixture/session-manager";\nexport const verifiesArtifactFork = SessionManager;\n',
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Preserve referenced artifacts when a session is forked.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 4, maxSemanticScanFiles: 0 },
			contextRendererVersion: "renderer-v1",
			paths: ["src/agent-session.ts"],
		});

		expect(
			compiled.evidence.find(evidence => evidence.sourceRef === "test/controllers/command-controller.test.ts"),
		).toMatchObject({
			sourceKind: "test_file",
			inclusionReason: "verification imports dependency of src/agent-session.ts",
		});
	});

	it("reserves fork artifact API contract tests without promoting unrelated session consumers", async () => {
		using repository = await createRepositoryFixture({
			"packages/coding-agent/src/agent-session.ts":
				'import { SessionManager } from "./session-manager";\nexport const fork = SessionManager;\n',
			"packages/coding-agent/src/session-manager.ts":
				"export const forkArtifactCopy = true;\nexport const SessionManager = true;\n",
			"packages/coding-agent/test/session-manager-fork.test.ts":
				'import { SessionManager } from "@fixture/session-manager";\nvi.spyOn(SessionManager, "forkFrom");\nconst copyOptions = { copyArtifacts: false };\nvoid copyOptions;\n',
			"packages/coding-agent/test/modes/tan-command-controller.test.ts":
				'import { SessionManager } from "@fixture/session-manager";\nvi.spyOn(SessionManager, "forkFrom");\nconst copyOptions = { copyArtifacts: false };\nvoid copyOptions;\n',
			"packages/coding-agent/test/session-manager-consumer.test.ts":
				'import { SessionManager } from "@fixture/session-manager";\nexport const consumer = SessionManager;\n',
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Preserve referenced artifacts when a session is forked.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 4, maxSemanticScanFiles: 0 },
			contextRendererVersion: "renderer-v1",
			paths: ["packages/coding-agent/src/agent-session.ts"],
		});

		const evidence = compiled.evidence.map(entry => ({ path: entry.sourceRef, reason: entry.inclusionReason }));
		expect(evidence).toEqual(
			expect.arrayContaining([
				{
					path: "packages/coding-agent/test/session-manager-fork.test.ts",
					reason: "verification candidate for fork artifact API contract",
				},
				{
					path: "packages/coding-agent/test/modes/tan-command-controller.test.ts",
					reason: "verification candidate for fork artifact API contract",
				},
			]),
		);
		expect(evidence.map(entry => entry.path)).not.toContain(
			"packages/coding-agent/test/session-manager-consumer.test.ts",
		);

		const unrelatedTask = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Keep the repository prompt stable.",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 4, maxSemanticScanFiles: 0 },
			contextRendererVersion: "renderer-v1",
			paths: ["packages/coding-agent/src/agent-session.ts"],
		});
		const unrelatedPaths = unrelatedTask.evidence.map(entry => entry.sourceRef);
		expect(unrelatedPaths).not.toContain("packages/coding-agent/test/session-manager-fork.test.ts");
		expect(unrelatedPaths).not.toContain("packages/coding-agent/test/modes/tan-command-controller.test.ts");
	});

	it("adds a bounded local caller as dependency evidence and reports a truncated scan", async () => {
		using repository = await createRepositoryFixture({
			"src/target.ts": "export const target = true;\n",
			"src/caller.ts": 'import { target } from "./target";\nexport const caller = target;\n',
			"src/ignored.ts": "export const ignored = true;\n",
		});
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Change target behavior",
			retrievalPolicy: { id: "current-state-v1", maxDependencyScanFiles: 2, maxSemanticScanFiles: 0 },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});

		expect(compiled.evidence.find(evidence => evidence.sourceRef === "src/caller.ts")?.inclusionReason).toBe(
			"relative dependent of src/target.ts",
		);
		expect(compiled.degradedSources).toContainEqual({
			extractorId: "native-relative-imports",
			reason: "budget_limited",
			detail: "dependency scan limited to 2 module files",
		});
	});

	it("continues with native current-state evidence when an optional extractor is unavailable", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" });
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Inspect target",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
			degradedSources: [{ extractorId: "native-symbols", reason: "unavailable", detail: "language server absent" }],
		});

		expect(compiled.evidence.map(evidence => evidence.sourceRef)).toContain("src/target.ts");
		expect(compiled.degradedSources).toContainEqual({
			extractorId: "native-symbols",
			reason: "unavailable",
			detail: "language server absent",
		});
	});

	it("renders a planning-skill request from the immutable manifest rather than live source", async () => {
		using repository = await createRepositoryFixture({ "src/target.ts": "export const before = true;\n" });
		const compiled = await compileCurrentStateRepositoryManifest(repository.path(), {
			task: "Change target behavior",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			paths: ["src/target.ts"],
		});
		await Bun.write(`${repository.path()}/src/target.ts`, "export const after = true;\n");
		const request = renderRepositoryPlanningSkillRequest({ task: "Change target behavior", manifest: compiled });

		expect(request).toContain(compiled.manifestId);
		expect(request).toContain(compiled.evidence[0]!.evidenceId);
		expect(request).toContain(`- E1 | ${compiled.evidence[0]!.sourceRef} => ${compiled.evidence[0]!.evidenceId}`);
		expect(request).toContain("export const before = true;");
		expect(request).not.toContain("export const after = true;");
	});

	it("rejects malformed planning output before semantic plan validation", () => {
		const malformed = parseRepositoryPlanningSkillResponse(
			'{"version":1,"title":"Plan","bases":[],"stages":[{"id":"stage"}]}',
		);
		const valid = parseRepositoryPlanningSkillResponse(
			JSON.stringify({
				version: 1,
				title: "Plan",
				bases: [{ id: "base", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
				stages: [
					{
						id: "stage",
						mode: "single",
						base: { type: "base", baseId: "base" },
						task: {
							id: "task",
							assignment: "Inspect",
							unresolvedAssumptions: [{ id: "a", statement: "Unknown", requiredInspection: "Read source" }],
						},
					},
				],
			}),
		);

		expect(malformed).toEqual({
			valid: false,
			error: "planning response does not match the ContextLineagePlan structure",
		});
		expect(valid.valid).toBe(true);
	});

	it("surfaces a model plan's unknown evidence as a semantic response error", () => {
		const response = JSON.stringify({
			version: 1,
			title: "Plan",
			bases: [{ id: "base", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "stage",
					mode: "single",
					base: { type: "base", baseId: "base" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "task",
						assignment: "Inspect",
						evidence: [{ manifestId: "manifest-1", evidenceId: "missing", purpose: "scope" }],
					},
				},
			],
		});
		const result = validateRepositoryPlanningSkillResponse(response, [manifest]);

		expect(result.valid).toBe(false);
		expect(result).toMatchObject({
			phase: "semantic",
			result: { issues: [{ path: "tasks.task.evidence", message: "unknown evidence: missing" }] },
		});
	});

	it("normalizes an unambiguous evidence ID onto the frozen manifest", () => {
		const response = JSON.stringify({
			version: 1,
			title: "Plan",
			bases: [{ id: "base", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "stage",
					mode: "single",
					base: { type: "base", baseId: "base" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "task",
						assignment: "Inspect",
						evidence: [{ manifestId: "hallucinated-manifest", evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
			],
		});
		const result = validateRepositoryPlanningSkillResponse(response, [manifest]);

		expect(result).toMatchObject({
			valid: true,
			plan: {
				stages: [{ mode: "single", task: { evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1" }] } }],
			},
		});
	});

	it("normalizes a compact evidence alias onto the frozen manifest", () => {
		const response = JSON.stringify({
			version: 1,
			title: "Plan",
			bases: [{ id: "base", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
			stages: [
				{
					id: "stage",
					mode: "single",
					base: { type: "base", baseId: "base" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "task",
						assignment: "Inspect",
						evidence: [{ manifestId: "manifest-1", evidenceId: "E1", purpose: "scope" }],
					},
				},
			],
		});
		const result = validateRepositoryPlanningSkillResponse(response, [manifest]);

		expect(result.valid).toBe(true);
		if (result.phase !== "semantic") throw new Error("expected semantic validation");
		expect(result.plan.stages[0]?.mode === "single" && result.plan.stages[0].task.evidence?.[0]?.evidenceId).toBe(
			"evidence-1",
		);
	});

	it("rejects an empty parsed plan before it can become an execution request", () => {
		const result = validateRepositoryPlanningSkillResponse(
			JSON.stringify({ version: 1, title: "Empty", bases: [], stages: [] }),
			[manifest],
		);

		expect(result).toMatchObject({
			valid: false,
			phase: "semantic",
			result: {
				issues: [
					{ path: "bases", message: "plans require at least one base" },
					{ path: "stages", message: "plans require at least one stage" },
				],
			},
		});
	});

	it("rejects a model plan that selects an undeclared checkpoint base", () => {
		const result = validateRepositoryPlanningSkillResponse(
			JSON.stringify({
				version: 1,
				title: "Cross-session plan",
				bases: [
					{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest-1" } },
					{ id: "foreign", source: { type: "checkpoint", checkpointId: "another-session" } },
				],
				stages: [
					{
						id: "inspect",
						mode: "single",
						base: { type: "base", baseId: "foreign" },
						capabilityRequirements: { workspaceMode: "frozen_read_only" },
						task: {
							id: "inspect-task",
							assignment: "Inspect foreign context",
							evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
						},
					},
				],
			}),
			[manifest],
		);

		expect(result).toMatchObject({
			valid: false,
			phase: "semantic",
			result: { issues: [{ path: "bases.foreign", message: "unsupported base source: checkpoint" }] },
		});
	});

	it("keeps repository planning frozen read-only even when a model requests an isolated workspace", () => {
		const result = validateRepositoryPlanningSkillResponse(
			JSON.stringify({
				...plan(),
				stages: [
					{
						...plan().stages[0],
						capabilityRequirements: { workspaceMode: "isolated_write" },
					},
				],
			}),
			[manifest],
		);

		expect(result).toMatchObject({
			valid: false,
			phase: "semantic",
			result: {
				issues: [
					{
						path: "stages.review.capabilities.workspaceMode",
						message: "unavailable workspace mode: isolated_write",
					},
					{
						path: "stages.review.capabilities.workspaceMode",
						message: "repository planning requires frozen_read_only workspace mode",
					},
				],
			},
		});
	});

	it("rejects a repository plan that omits its frozen workspace declaration", () => {
		const result = validateRepositoryPlanningSkillResponse(
			JSON.stringify({
				...plan(),
				stages: [
					{
						...plan().stages[0],
						capabilityRequirements: undefined,
					},
				],
			}),
			[manifest],
		);

		expect(result).toMatchObject({
			valid: false,
			phase: "semantic",
			result: {
				issues: [
					{
						path: "stages.review.capabilities.workspaceMode",
						message: "repository planning requires frozen_read_only workspace mode",
					},
				],
			},
		});
	});

	it("rejects a manifest whose frozen evidence no longer matches its persisted identity", async () => {
		const canonical = createRepositoryContextManifest({
			snapshot: manifest.snapshot,
			task: "Inspect",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "v1",
			evidence: manifest.evidence,
		});
		const altered = { ...canonical, evidence: [{ ...canonical.evidence[0]!, sourceRef: "src/forged.ts" }] };
		let calls = 0;
		const result = await runRepositoryPlanningSkill(
			{ task: "Inspect", manifest: altered },
			{
				async generate() {
					calls++;
					return JSON.stringify(plan());
				},
			},
		);

		expect(result).toEqual({ valid: false, phase: "manifest", error: "repository manifest integrity check failed" });
		expect(calls).toBe(0);
	});

	it("rejects ambiguous duplicate fanout outputs before an extension can consume them", () => {
		const invalid = plan({
			stages: [
				{
					id: "fanout",
					mode: "fanout",
					base: { type: "base", baseId: "base-1" },
					tasks: [
						{ id: "first", assignment: "First", output: { name: "findings", format: "text" } },
						{ id: "second", assignment: "Second", output: { name: "findings", format: "text" } },
					],
				},
			],
		});

		expect(validateContextLineagePlan(invalid, [manifest]).issues).toContainEqual({
			path: "stages.fanout.outputs",
			message: "duplicate id: findings",
		});
	});

	it("runs an injected planner only through the immutable manifest validation gate", async () => {
		const result = await runRepositoryPlanningSkill(
			{ task: "Inspect", manifest },
			{
				async generate(prompt) {
					expect(prompt).toContain(manifest.manifestId);
					return JSON.stringify({
						version: 1,
						title: "Plan",
						bases: [{ id: "base", source: { type: "repository_manifest", manifestId: "manifest-1" } }],
						stages: [
							{
								id: "stage",
								mode: "single",
								base: { type: "base", baseId: "base" },
								capabilityRequirements: { workspaceMode: "frozen_read_only" },
								task: {
									id: "task",
									assignment: "Inspect",
									evidence: [{ manifestId: "manifest-1", evidenceId: "evidence-1", purpose: "scope" }],
								},
							},
						],
					});
				},
			},
		);

		expect(result.valid).toBe(true);
		expect(result).toMatchObject({ phase: "semantic", plan: { bases: [{ source: { manifestId: "manifest-1" } }] } });
	});

	it("repairs one malformed planning response without retrying semantic validation failures", async () => {
		let calls = 0;
		const result = await runRepositoryPlanningSkill(
			{ task: "Inspect", manifest },
			{
				async generate(promptText) {
					calls++;
					if (calls === 1) return "not json";
					expect(promptText).toContain("Previous response:");
					return JSON.stringify(plan());
				},
			},
		);

		expect(result.valid).toBe(true);
		expect(calls).toBe(2);
	});

	it("adapts an ephemeral model turn through the frozen planning validation gate", async () => {
		const prompts: string[] = [];
		const result = await runRepositoryPlanningSkill(
			{ task: "Review example", manifest },
			createEphemeralRepositoryPlanningSkillGenerator({
				async runEphemeralTurn({ promptText }) {
					prompts.push(promptText);
					return { replyText: JSON.stringify(plan()) };
				},
			}),
		);

		expect(result.valid).toBe(true);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Repository Context Manifest");
	});

	it("benchmarks grounded and unguided generators only after the grounded plan validates", async () => {
		const benchmarkManifest: RepositoryContextManifest = {
			...manifest,
			manifestId: "benchmark-manifest",
			evidence: [
				{ ...manifest.evidence[0]!, evidenceId: "source", sourceRef: "src/target.ts" },
				{ ...manifest.evidence[0]!, evidenceId: "test", sourceRef: "test/target.test.ts" },
			],
		};
		const result = await runRepositoryPlanningBenchmark({
			request: { task: "Plan target", manifest: benchmarkManifest },
			benchmark: { id: "fixture", requiredScope: ["src/target.ts"], requiredVerification: ["test/target.test.ts"] },
			groundedGenerator: {
				async generate() {
					return JSON.stringify({
						version: 1,
						title: "Plan",
						bases: [{ id: "base", source: { type: "repository_manifest", manifestId: "benchmark-manifest" } }],
						stages: [
							{
								id: "stage",
								mode: "single",
								base: { type: "base", baseId: "base" },
								capabilityRequirements: { workspaceMode: "frozen_read_only" },
								task: {
									id: "task",
									assignment: "Plan",
									evidence: [
										{ manifestId: "benchmark-manifest", evidenceId: "source", purpose: "scope" },
										{ manifestId: "benchmark-manifest", evidenceId: "test", purpose: "verification" },
									],
								},
							},
						],
					});
				},
			},
			unguidedGenerator: {
				async generate() {
					return { scope: ["src/target.ts"], verification: [] };
				},
			},
		});

		expect(result).toMatchObject({
			valid: true,
			comparison: { scopeRecallDelta: 0, verificationRecallDelta: 1, evidenceTraceabilityDelta: 1 },
		});
	});

	it("persists a benchmark comparison beside the frozen grounded plan", async () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
			getBranch(): SessionEntry[] {
				return entries;
			},
		};
		const prepared = await prepareRepositoryContextLineage({
			cwd: (await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" })).path(),
			task: "Plan target",
			journal,
		});
		const source = prepared.manifest.evidence[0]!;
		const result = await benchmarkRepositoryContextLineage({
			prepared,
			journal,
			benchmark: { id: "fixture", task: "Plan target", requiredScope: [source.sourceRef], requiredVerification: [] },
			groundedGenerator: {
				async generate() {
					return JSON.stringify({
						version: 1,
						title: "Plan",
						bases: [
							{ id: "base", source: { type: "repository_manifest", manifestId: prepared.manifest.manifestId } },
						],
						stages: [
							{
								id: "stage",
								mode: "single",
								base: { type: "base", baseId: "base" },
								capabilityRequirements: { workspaceMode: "frozen_read_only" },
								task: {
									id: "task",
									assignment: "Plan",
									evidence: [
										{
											manifestId: prepared.manifest.manifestId,
											evidenceId: source.evidenceId,
											purpose: "scope",
										},
									],
								},
							},
						],
					});
				},
			},
			unguidedGenerator: {
				async generate() {
					return { scope: [], verification: [] };
				},
			},
		});

		expect(result).toMatchObject({ valid: true, run: { comparison: { scopeRecallDelta: 1 } } });
		expect(getContextLineageSessionRecords(journal).map(record => record.kind)).toEqual([
			"repository_manifest",
			"logical_checkpoint",
			"plan",
			"benchmark",
		]);
	});

	it("persists an invalid grounded benchmark response as a sidecar artifact", async () => {
		const entries: SessionEntry[] = [];
		const artifacts: string[] = [];
		const journal = {
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
			getBranch(): SessionEntry[] {
				return entries;
			},
			async saveArtifact(content: string): Promise<string> {
				artifacts.push(content);
				return "benchmark-response";
			},
		};
		const prepared = await prepareRepositoryContextLineage({
			cwd: (await createRepositoryFixture({ "src/target.ts": "export const target = true;\n" })).path(),
			task: "Plan target",
			journal,
		});
		const result = await benchmarkRepositoryContextLineage({
			prepared,
			journal,
			benchmark: { id: "fixture", task: "Plan target", requiredScope: [], requiredVerification: [] },
			groundedGenerator: {
				async generate() {
					return "not json";
				},
			},
			unguidedGenerator: {
				async generate() {
					return { scope: [], verification: [] };
				},
			},
		});

		expect(result).toMatchObject({ valid: false, groundedResponseArtifactId: "benchmark-response" });
		expect(artifacts).toContain("not json");
	});

	it("does not run the unguided baseline when grounded planning is invalid", async () => {
		let unguidedCalls = 0;
		const result = await runRepositoryPlanningBenchmark({
			request: { task: "Plan", manifest },
			benchmark: { id: "fixture", requiredScope: [], requiredVerification: [] },
			groundedGenerator: {
				async generate() {
					return "not json";
				},
			},
			unguidedGenerator: {
				async generate() {
					unguidedCalls++;
					return { scope: [], verification: [] };
				},
			},
		});

		expect(result).toMatchObject({ valid: false, grounded: { phase: "parse" } });
		expect(unguidedCalls).toBe(0);
	});

	it("measures plan scope and verification coverage from manifest citations", () => {
		const benchmarkManifest: RepositoryContextManifest = {
			...manifest,
			manifestId: "benchmark-manifest",
			evidence: [
				{ ...manifest.evidence[0]!, evidenceId: "source", sourceRef: "src/target.ts" },
				{ ...manifest.evidence[0]!, evidenceId: "test", sourceRef: "test/target.test.ts" },
			],
		};
		const result = evaluateRepositoryPlanningBenchmark(
			plan({
				bases: [{ id: "base-1", source: { type: "repository_manifest", manifestId: "benchmark-manifest" } }],
				stages: [
					{
						id: "review",
						mode: "fanout",
						base: { type: "base", baseId: "base-1" },
						tasks: [
							{
								id: "scope",
								assignment: "Scope",
								evidence: [{ manifestId: "benchmark-manifest", evidenceId: "source", purpose: "scope" }],
							},
							{
								id: "verify",
								assignment: "Verify",
								evidence: [{ manifestId: "benchmark-manifest", evidenceId: "test", purpose: "verification" }],
							},
						],
					},
				],
			}),
			benchmarkManifest,
			{ id: "fixture", requiredScope: ["src/target.ts"], requiredVerification: ["test/target.test.ts"] },
		);

		expect(result).toEqual({ scopeRecall: 1, verificationRecall: 1, evidenceTraceability: 1, unsupportedScope: [] });
	});

	it("does not misclassify dependency evidence as an unsupported scope claim", () => {
		const benchmarkManifest: RepositoryContextManifest = {
			...manifest,
			manifestId: "purpose-manifest",
			evidence: [
				{ ...manifest.evidence[0]!, evidenceId: "source", sourceRef: "src/target.ts" },
				{ ...manifest.evidence[0]!, evidenceId: "dependency", sourceRef: "src/helper.ts" },
			],
		};
		const result = evaluateRepositoryPlanningBenchmark(
			plan({
				bases: [{ id: "base-1", source: { type: "repository_manifest", manifestId: "purpose-manifest" } }],
				stages: [
					{
						id: "review",
						mode: "single",
						base: { type: "base", baseId: "base-1" },
						task: {
							id: "scope",
							assignment: "Scope",
							evidence: [
								{ manifestId: "purpose-manifest", evidenceId: "source", purpose: "scope" },
								{ manifestId: "purpose-manifest", evidenceId: "dependency", purpose: "dependency" },
							],
						},
					},
				],
			}),
			benchmarkManifest,
			{ id: "fixture", requiredScope: ["src/target.ts"], requiredVerification: [] },
		);

		expect(result).toEqual({ scopeRecall: 1, verificationRecall: 1, evidenceTraceability: 1, unsupportedScope: [] });
	});

	it("compares grounded and unguided plans against the same benchmark obligations", () => {
		const benchmarkManifest: RepositoryContextManifest = {
			...manifest,
			manifestId: "comparison-manifest",
			evidence: [
				{ ...manifest.evidence[0]!, evidenceId: "source", sourceRef: "src/target.ts" },
				{ ...manifest.evidence[0]!, evidenceId: "test", sourceRef: "test/target.test.ts" },
			],
		};
		const grounded = plan({
			bases: [{ id: "base-1", source: { type: "repository_manifest", manifestId: "comparison-manifest" } }],
			stages: [
				{
					id: "review",
					mode: "fanout",
					base: { type: "base", baseId: "base-1" },
					tasks: [
						{
							id: "scope",
							assignment: "Scope",
							evidence: [{ manifestId: "comparison-manifest", evidenceId: "source", purpose: "scope" }],
						},
						{
							id: "verify",
							assignment: "Verify",
							evidence: [{ manifestId: "comparison-manifest", evidenceId: "test", purpose: "verification" }],
						},
					],
				},
			],
		});
		const unguided = plan({
			bases: [{ id: "base-1", source: { type: "repository_manifest", manifestId: "comparison-manifest" } }],
			stages: [
				{
					id: "review",
					mode: "fanout",
					base: { type: "base", baseId: "base-1" },
					tasks: [
						{
							id: "scope",
							assignment: "Scope",
							evidence: [{ manifestId: "comparison-manifest", evidenceId: "source", purpose: "scope" }],
						},
						{
							id: "verify",
							assignment: "Verify",
							unresolvedAssumptions: [{ id: "test", statement: "Unknown", requiredInspection: "Inspect tests" }],
						},
					],
				},
			],
		});
		const comparison = compareRepositoryPlanningBenchmarks(grounded, unguided, benchmarkManifest, {
			id: "fixture",
			requiredScope: ["src/target.ts"],
			requiredVerification: ["test/target.test.ts"],
		});

		expect(comparison.scopeRecallDelta).toBe(0);
		expect(comparison.verificationRecallDelta).toBe(1);
	});

	it("scores unguided reviewer claims independently from manifest-citation availability", () => {
		const benchmark = {
			id: "fixture",
			requiredScope: ["src/target.ts"],
			requiredVerification: ["test/target.test.ts"],
		};
		const unguided = evaluateRepositoryPlanningClaims(
			{ scope: ["src/target.ts"], verification: ["test/target.test.ts"] },
			benchmark,
		);
		const grounded = evaluateRepositoryPlanningClaims(
			{ scope: ["src/target.ts", "src/extra.ts"], verification: [] },
			benchmark,
		);
		const comparison = compareRepositoryPlanningResults(grounded, unguided);

		expect(unguided).toEqual({
			scopeRecall: 1,
			verificationRecall: 1,
			evidenceTraceability: 0,
			unsupportedScope: [],
		});
		expect(comparison.grounded.unsupportedScope).toEqual(["src/extra.ts"]);
		expect(comparison.verificationRecallDelta).toBe(-1);
	});

	it("names, resolves, and archives durable checkpoint bases idempotently", () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const namedCheckpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "logical_checkpoint",
			checkpoint: namedCheckpoint,
		});

		const first = createNamedBaseRecord({
			name: "project-base",
			checkpointId: namedCheckpoint.checkpointId,
			records: getContextLineageSessionRecords(journal),
		});
		appendContextLineageSessionRecord(journal, first);
		const again = createNamedBaseRecord({
			name: "project-base",
			checkpointId: namedCheckpoint.checkpointId,
			records: getContextLineageSessionRecords(journal),
		});
		expect(again).toEqual(first);

		const recovered = getContextLineageSessionRecords(journal);
		expect(resolveNamedBase("project-base", recovered)?.checkpointId).toBe(namedCheckpoint.checkpointId);
		expect(resolveNamedBase("unknown", recovered)).toBeUndefined();

		const evolvedCheckpoint = createCheckpointExtensionCheckpoint({
			baseCheckpoint: checkpoint,
			outputs: [
				{
					stageId: "s",
					taskId: "t",
					outputName: "findings",
					contentDigest: "digest-1",
					artifactRef: "artifact://1",
				},
			],
		});
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "logical_checkpoint",
			checkpoint: evolvedCheckpoint,
		});
		const nextGeneration = createNamedBaseRecord({
			name: "project-base",
			checkpointId: evolvedCheckpoint.checkpointId,
			records: getContextLineageSessionRecords(journal),
		});
		appendContextLineageSessionRecord(journal, nextGeneration);
		expect(nextGeneration.namedBaseId).not.toBe(first.namedBaseId);
		expect(resolveNamedBase("project-base", getContextLineageSessionRecords(journal))?.checkpointId).toBe(
			evolvedCheckpoint.checkpointId,
		);

		appendContextLineageSessionRecord(
			journal,
			archiveNamedBaseRecord("project-base", getContextLineageSessionRecords(journal)),
		);
		expect(resolveNamedBase("project-base", getContextLineageSessionRecords(journal))).toBeUndefined();
		expect(() => archiveNamedBaseRecord("project-base", getContextLineageSessionRecords(journal))).toThrow(
			"no active named base",
		);
		expect(summarizeContextLineageSession(journal).namedBases).toBe(0);
		expect(() =>
			createNamedBaseRecord({ name: "../escape", checkpointId: namedCheckpoint.checkpointId, records: [] }),
		).toThrow("base name must match");
	});

	it("reports the first provider-visible divergence between compiled request views", () => {
		const base = [
			{ kind: "system", digest: "d1" },
			{ kind: "history", digest: "d2" },
		];
		expect(firstPrefixDivergence(base, [...base])).toBeUndefined();
		expect(firstPrefixDivergence(base, [...base, { kind: "leaf", digest: "q1" }])).toBeUndefined();
		const siblingA = [...base, { kind: "leaf", digest: "q1" }];
		const siblingB = [...base, { kind: "leaf", digest: "q2" }];
		expect(firstPrefixDivergence(siblingA, siblingB)).toEqual({
			index: 2,
			leftKind: "leaf",
			rightKind: "leaf",
			reason: "leaf block content diverged",
		});
		expect(
			firstPrefixDivergence([...base, { kind: "leaf", digest: "q1" }], [...base, { kind: "tools", digest: "t" }]),
		).toEqual({
			index: 2,
			leftKind: "leaf",
			rightKind: "tools",
			reason: "block kind changed from leaf to tools",
		});
	});

	it("tombstones a base name while retaining checkpoint references for safe pruning", () => {
		const active = createNamedBaseRecord({ name: "delete-me", checkpointId: "checkpoint-1", records: [] });
		const deleted = deleteNamedBaseRecord("delete-me", [active]);
		expect(resolveNamedBase("delete-me", [active, deleted])).toBeUndefined();
		expect(contextLineageCheckpointRetention([active, deleted])).toEqual([
			{ checkpointId: "checkpoint-1", activeNames: 0, plans: 0, executions: 0, collectable: true },
		]);
	});

	it("dismisses a completed result without deleting its durable artifact evidence", () => {
		const execution = createContextLineageExecutionRecord({
			planId: "plan-1",
			checkpointId: "checkpoint-1",
			runId: "run-1",
			status: "completed",
			outputs: [
				{ stageId: "questions", taskId: "question-1", contentDigest: "digest", artifactRef: "artifact://answer" },
			],
		});
		const discarded = discardContextLineageOutput({ runId: "run-1", taskId: "question-1", records: [execution] });
		expect(discarded).toMatchObject({ kind: "discarded_output", runId: "run-1", taskId: "question-1" });
		expect(execution.outputs[0]?.artifactRef).toBe("artifact://answer");
	});

	it("keeps controlled candidate evaluation blinded and bounds adaptive continuation", () => {
		const candidates = createContextLineageCandidateFamily({
			taskId: "review",
			assignment: "Review migration plan",
			variations: [
				[{ id: "role", label: "reviewer_role", value: "security" }],
				[{ id: "role", label: "reviewer_role", value: "operations" }],
			],
		});
		const completed = { ...candidates[0]!, status: "completed" as const, artifactRef: "artifact://candidate-1" };
		expect(createBlindedCandidateReview({ candidate: completed, rubricArtifactRef: "artifact://rubric" })).toEqual({
			candidateId: completed.candidateId,
			artifactRef: "artifact://candidate-1",
			rubricArtifactRef: "artifact://rubric",
		});
		const selection = createContextLineageSelectionRecord({
			candidateId: completed.candidateId,
			rubricArtifactRef: "artifact://rubric",
			visibleEvidence: ["artifact://candidate-1"],
			evaluator: "declared-rubric-v1",
			explanation: "Cites the required migration verification.",
		});
		expect(selection.selectionId).toMatch(/^context-lineage-selection:v1:/);
		expect(
			decideAdaptiveDeliberation(
				{
					topK: 2,
					disagreementThreshold: 0.3,
					budget: { maxRequests: 3, maxTokens: 1000, maxDurationMs: 10_000, maxCostUsd: 1 },
				},
				{ requests: 1, tokens: 100, elapsedMs: 100, costUsd: 0.1, disagreement: 0.5 },
			),
		).toEqual({ allocate: true, reason: "disagreement" });
		expect(
			decideAdaptiveDeliberation(
				{ topK: 2, budget: { maxRequests: 1, maxTokens: 1000, maxDurationMs: 10_000, maxCostUsd: 1 } },
				{ requests: 1, tokens: 0, elapsedMs: 0, costUsd: 0 },
			),
		).toEqual({ allocate: false, reason: "budget_exhausted" });
		expect(() =>
			decideAdaptiveDeliberation(
				{
					topK: 1,
					disagreementThreshold: 0.5,
					budget: { maxRequests: 0, maxTokens: 1, maxDurationMs: 1, maxCostUsd: 1 },
				},
				{ requests: 0, tokens: 0, elapsedMs: 0, costUsd: 0, disagreement: 1 },
			),
		).toThrow("Automatic adaptive deliberation requires a positive hard request bound");
	});

	it("renders clean-room evaluator turns with only their declared candidate and immutable rubric", () => {
		const rubricContent = "RUBRIC-ONLY-CONTENT";
		const candidateContent = "SELECTED-CANDIDATE-CONTENT";
		const withheldSibling = "WITHHELD-SIBLING-CONTENT";
		const withheldIdentity = "WITHHELD-CANDIDATE-IDENTITY";
		const withheldWorkspace = "WITHHELD-WORKSPACE-CONTENT";
		const withheldHistory = "WITHHELD-SESSION-HISTORY";
		const rubricRendered = [
			prompt.render(preliminaryEvaluationPrompt, { rubricContent, candidateContent }),
			prompt.render(fullDepthEvaluationPrompt, { rubricContent, candidateContent }),
		];
		const structuredRendered = prompt.render(structuredOutcomeEvaluationPrompt, {
			outcomeCaseId: "capability-isolation",
			requiredObligationIds: ["frozen_base"],
			forbiddenObligationIds: ["workspace_access"],
			candidateContent,
		});

		for (const evaluatorInput of rubricRendered) {
			expect(evaluatorInput).toContain(rubricContent);
			expect(evaluatorInput).toContain(candidateContent);
			expect(evaluatorInput).not.toContain(withheldSibling);
			expect(evaluatorInput).not.toContain(withheldIdentity);
			expect(evaluatorInput).not.toContain(withheldWorkspace);
			expect(evaluatorInput).not.toContain(withheldHistory);
		}
		expect(structuredRendered).toContain(candidateContent);
		expect(structuredRendered).toContain("frozen_base");
		expect(structuredRendered).toContain("workspace_access");
		expect(structuredRendered).not.toContain(withheldSibling);
		expect(structuredRendered).not.toContain(withheldIdentity);
		expect(structuredRendered).not.toContain(withheldWorkspace);
		expect(structuredRendered).not.toContain(withheldHistory);
	});

	it("measures false pruning and needless deepening against full-depth rubric outcomes", async () => {
		const candidates = createContextLineageCandidateFamily({
			taskId: "review",
			assignment: "Review migration plan",
			variations: [
				[{ id: "approach", label: "candidate", value: "minimal" }],
				[{ id: "approach", label: "candidate", value: "staged" }],
			],
		});
		const continued = candidates[0]!;
		const viable = candidates[1]!;
		const rubricContentDigest = contextLineageArtifactContentDigest("rubric body");
		const candidateMinimalDigest = contextLineageArtifactContentDigest("minimal body");
		const candidateStagedDigest = contextLineageArtifactContentDigest("staged body");
		const report = evaluateControlledReasoningBenchmark({
			familyId: "family-1",
			candidates,
			rubricArtifactRef: "artifact://rubric",
			rubricContentDigest,
			evaluatorProfileId: "independent-rubric-v1",
			continuedCandidateIds: [continued.candidateId],
			outcomes: [
				{
					candidateId: continued.candidateId,
					artifactRef: "artifact://candidate-minimal",
					candidateContentDigest: candidateMinimalDigest,
					evaluatorInputDigest: contextLineageEvaluatorInputDigest({
						rubricContentDigest,
						candidateContentDigest: candidateMinimalDigest,
					}),
					evaluationArtifactRef: "artifact://evaluation-minimal",
					evaluationContentDigest: contextLineageArtifactContentDigest("minimal evaluation"),
					verdict: "unacceptable",
				},
				{
					candidateId: viable.candidateId,
					artifactRef: "artifact://candidate-staged",
					candidateContentDigest: candidateStagedDigest,
					evaluatorInputDigest: contextLineageEvaluatorInputDigest({
						rubricContentDigest,
						candidateContentDigest: candidateStagedDigest,
					}),
					evaluationArtifactRef: "artifact://evaluation-staged",
					evaluationContentDigest: contextLineageArtifactContentDigest("staged evaluation"),
					verdict: "acceptable",
				},
			],
		});

		expect(report.result).toEqual({
			candidateCount: 2,
			acceptableCandidateIds: [viable.candidateId],
			continuedAcceptableCandidateIds: [],
			prunedAcceptableCandidateIds: [viable.candidateId],
			falsePruning: true,
			unnecessaryContinuationCandidateIds: [continued.candidateId],
		});
		const artifactBodies = new Map([
			["artifact://rubric", "rubric body"],
			["artifact://candidate-minimal", "minimal body"],
			["artifact://candidate-staged", "staged body"],
			["artifact://evaluation-minimal", "minimal evaluation"],
			["artifact://evaluation-staged", "staged evaluation"],
		]);
		await verifyControlledReasoningArtifactIntegrity(report, async artifactRef => artifactBodies.get(artifactRef));
		artifactBodies.set("artifact://evaluation-staged", "substituted evaluation");
		await expect(
			verifyControlledReasoningArtifactIntegrity(report, async artifactRef => artifactBodies.get(artifactRef)),
		).rejects.toThrow("evaluator artifact no longer matches");
		expect(() =>
			evaluateControlledReasoningBenchmark({
				familyId: "family-1",
				candidates,
				rubricArtifactRef: "artifact://rubric",
				rubricContentDigest,
				evaluatorProfileId: "independent-rubric-v1",
				continuedCandidateIds: [continued.candidateId],
				outcomes: [],
			}),
		).toThrow("full-depth outcome");
	});

	it("calibrates full-depth evaluator verdicts against a declared artifact-only outcome contract", () => {
		const candidates = createContextLineageCandidateFamily({
			taskId: "capability-review",
			assignment: "Review capability isolation",
			variations: [
				[{ id: "approach", label: "candidate", value: "isolated" }],
				[{ id: "approach", label: "candidate", value: "leaky" }],
			],
		});
		const profile = CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES["capability-isolation"];
		const acceptableContent =
			"Use a frozen base with no tools and without workspace access. Keep raw answers outside the parent, add a negative test, and cover restart.";
		const rejectedContent =
			"Use a frozen base with no tools. Keep raw answers outside the parent, add a negative test, and cover restart with workspace access.";
		const rubricContentDigest = contextLineageArtifactContentDigest("capability rubric");
		const declaredOutcomes = [
			evaluateContextLineageDeclaredOutcome(acceptableContent, profile),
			evaluateContextLineageDeclaredOutcome(rejectedContent, profile),
		];
		expect(declaredOutcomes.map(outcome => outcome.verdict)).toEqual(["acceptable", "unacceptable"]);
		const report = evaluateControlledReasoningBenchmark({
			familyId: "capability-family",
			candidates,
			rubricArtifactRef: "artifact://rubric",
			rubricContentDigest,
			evaluatorProfileId: "separate-session:evaluator",
			continuedCandidateIds: [candidates[1]!.candidateId],
			outcomes: candidates.map((candidate, index) => {
				const candidateContent = index === 0 ? acceptableContent : rejectedContent;
				const candidateContentDigest = contextLineageArtifactContentDigest(candidateContent);
				return {
					candidateId: candidate.candidateId,
					artifactRef: `artifact://candidate-${index}`,
					candidateContentDigest,
					evaluatorInputDigest: contextLineageEvaluatorInputDigest({
						rubricContentDigest,
						candidateContentDigest,
					}),
					evaluationArtifactRef: `artifact://evaluation-${index}`,
					evaluationContentDigest: contextLineageArtifactContentDigest(`evaluation ${index}`),
					verdict: index === 0 ? ("unacceptable" as const) : ("acceptable" as const),
					declaredOutcome: declaredOutcomes[index]!,
				};
			}),
		});
		expect(report.result.declaredOutcome).toEqual({
			profileId: profile.profileId,
			acceptableCandidateIds: [candidates[0]!.candidateId],
			continuedAcceptableCandidateIds: [],
			falsePruning: true,
			evaluatorFalseAcceptanceCandidateIds: [candidates[1]!.candidateId],
			evaluatorFalseRejectionCandidateIds: [candidates[0]!.candidateId],
		});
	});

	it("accepts explicit opt-in and non-mutating adapter boundaries without requiring one exact phrase", () => {
		const profile = CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES["adapter-authority"];
		const outcome = evaluateContextLineageDeclaredOutcome(
			"Keep the adapter opt-in and non-mutating. Snapshot mismatch must be stale, use a fallback, and add regression tests.",
			profile,
		);
		expect(outcome).toEqual({
			profileId: profile.profileId,
			verdict: "acceptable",
			missingRequiredGroups: [],
			matchedForbiddenTerms: [],
		});
	});

	it("adjudicates immutable structured outcome obligations without relying on candidate wording", () => {
		const corpusCase = CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1.find(
			candidate => candidate.caseId === "recovery-replay",
		);
		if (!corpusCase) throw new Error("expected recovery outcome corpus case");
		const accepted = parseContextLineageStructuredCandidateOutcome(
			JSON.stringify({
				satisfiedObligationIds: corpusCase.requiredObligationIds,
				proposedForbiddenObligationIds: [],
			}),
		);
		const rejected = parseContextLineageStructuredCandidateOutcome(
			JSON.stringify({
				satisfiedObligationIds: corpusCase.requiredObligationIds.filter(id => id !== "descendant_only_replay"),
				proposedForbiddenObligationIds: ["branch_state_merge"],
			}),
		);
		expect(adjudicateContextLineageOutcomeCorpus(corpusCase, accepted)).toMatchObject({
			verdict: "acceptable",
			missingRequiredObligationIds: [],
			proposedForbiddenObligationIds: [],
		});
		expect(adjudicateContextLineageOutcomeCorpus(corpusCase, rejected)).toMatchObject({
			verdict: "unacceptable",
			missingRequiredObligationIds: ["descendant_only_replay"],
			proposedForbiddenObligationIds: ["branch_state_merge"],
		});
		expect(() =>
			parseContextLineageStructuredCandidateOutcome(
				'{"satisfiedObligationIds":["restart_recovery"],"proposedForbiddenObligationIds":["branch_state_merge","branch_state_merge"]}',
			),
		).toThrow("cannot repeat");
		expect(() =>
			adjudicateContextLineageOutcomeCorpus(corpusCase, {
				satisfiedObligationIds: ["invented_obligation"],
				proposedForbiddenObligationIds: [],
			}),
		).toThrow("outside its immutable corpus case");
	});

	it("records malformed structured declarations as unacceptable measurement results instead of aborting the two-candidate sample", () => {
		const corpusCase = CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1.find(
			candidate => candidate.caseId === "capability-isolation",
		);
		if (!corpusCase) throw new Error("expected capability outcome corpus case");
		const acceptedDeclaration = JSON.stringify({
			satisfiedObligationIds: corpusCase.requiredObligationIds,
			proposedForbiddenObligationIds: [],
		});
		const report = evaluateContextLineageStructuredOutcomeMeasurement({
			corpusCase,
			override: { kind: "candidate", candidateId: "candidate-1" },
			candidates: [
				{
					candidateId: "candidate-1",
					candidateArtifactRef: "artifact://candidate-1",
					candidateContentDigest: contextLineageArtifactContentDigest(acceptedDeclaration),
					candidateContent: acceptedDeclaration,
					evaluatorArtifactRef: "artifact://evaluation-1",
					evaluatorContentDigest: contextLineageArtifactContentDigest("VERDICT: ACCEPTABLE"),
					evaluatorVerdict: "acceptable",
				},
				{
					candidateId: "candidate-2",
					candidateArtifactRef: "artifact://candidate-2",
					candidateContentDigest: contextLineageArtifactContentDigest("not-json"),
					candidateContent: "not-json",
					evaluatorArtifactRef: "artifact://evaluation-2",
					evaluatorContentDigest: contextLineageArtifactContentDigest("VERDICT: ACCEPTABLE"),
					evaluatorVerdict: "acceptable",
				},
			],
		});
		expect(
			report.candidates.map(candidate => [
				candidate.candidateId,
				candidate.structuredOutcomeStatus,
				candidate.deterministicVerdict,
			]),
		).toEqual([
			["candidate-1", "valid", "acceptable"],
			["candidate-2", "malformed", "unacceptable"],
		]);
		expect(report.evaluatorFalseAcceptanceCandidateIds).toEqual(["candidate-2"]);
		expect(report.falsePruning).toBe(false);
		expect(report.unnecessaryContinuationCandidateIds).toEqual([]);
	});

	it("recovers only full-depth benchmark reports bound to completed candidate artifacts", () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const rootedCheckpoint = createRepositoryManifestCheckpoint(manifest);
		const persistedPlan = plan();
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "logical_checkpoint",
			checkpoint: rootedCheckpoint,
		});
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: persistedPlan,
			planId: contextLineagePlanIdentity(persistedPlan),
			manifestId: manifest.manifestId,
			checkpointId: rootedCheckpoint.checkpointId,
		});
		const candidates = createContextLineageCandidateFamily({
			taskId: "scope",
			assignment: "Review scope",
			variations: [
				[{ id: "approach", label: "candidate", value: "minimal" }],
				[{ id: "approach", label: "candidate", value: "staged" }],
			],
		});
		const family = createContextLineageCandidateFamilyRecord({
			planId: contextLineagePlanIdentity(persistedPlan),
			checkpointId: rootedCheckpoint.checkpointId,
			taskId: "scope",
			assignmentDigest: candidates[0]!.assignmentDigest,
			candidates,
		});
		appendContextLineageSessionRecord(journal, family);
		for (const [index, candidate] of candidates.entries()) {
			appendContextLineageSessionRecord(
				journal,
				createContextLineageCandidateCompletionRecord({
					familyId: family.familyId,
					candidateId: candidate.candidateId,
					contentDigest: `digest-${index}`,
					artifactRef: `artifact://candidate-${index}`,
				}),
			);
		}
		const report = evaluateControlledReasoningBenchmark({
			familyId: family.familyId,
			candidates,
			rubricArtifactRef: "artifact://rubric",
			rubricContentDigest: contextLineageArtifactContentDigest("rubric body"),
			evaluatorProfileId: "independent-rubric-v1",
			continuedCandidateIds: [candidates[0]!.candidateId],
			outcomes: candidates.map((candidate, index) => ({
				candidateId: candidate.candidateId,
				artifactRef: `artifact://candidate-${index}`,
				candidateContentDigest: contextLineageArtifactContentDigest(`candidate body ${index}`),
				evaluatorInputDigest: contextLineageEvaluatorInputDigest({
					rubricContentDigest: contextLineageArtifactContentDigest("rubric body"),
					candidateContentDigest: contextLineageArtifactContentDigest(`candidate body ${index}`),
				}),
				evaluationArtifactRef: `artifact://evaluation-${index}`,
				evaluationContentDigest: contextLineageArtifactContentDigest(`evaluation body ${index}`),
				verdict: index === 0 ? ("acceptable" as const) : ("unacceptable" as const),
			})),
		});
		appendContextLineageSessionRecord(journal, createControlledReasoningBenchmarkRecord(report));
		const { benchmarkId: _benchmarkId, ...forgedSemanticReport } = {
			...report,
			result: { ...report.result, falsePruning: true },
		};
		journal.appendCustomEntry("context-lineage", {
			version: 1,
			kind: "controlled_reasoning_benchmark",
			report: {
				...forgedSemanticReport,
				benchmarkId: semanticIdentity("context-lineage-controlled-reasoning-benchmark", forgedSemanticReport),
			},
		});

		const recovered = resolveContextLineageCandidateFamily(family.familyId, getContextLineageSessionRecords(journal));
		expect(recovered?.benchmarks.map(record => record.report.benchmarkId)).toEqual([report.benchmarkId]);
	});

	it("recovers only candidate selections backed by the completed candidate artifact", () => {
		const entries: SessionEntry[] = [];
		const journal = {
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
		};
		const rootedCheckpoint = createRepositoryManifestCheckpoint(manifest);
		appendContextLineageSessionRecord(journal, { version: 1, kind: "repository_manifest", manifest });
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "logical_checkpoint",
			checkpoint: rootedCheckpoint,
		});
		appendContextLineageSessionRecord(journal, {
			version: 1,
			kind: "plan",
			plan: plan(),
			planId: contextLineagePlanIdentity(plan()),
			manifestId: manifest.manifestId,
			checkpointId: rootedCheckpoint.checkpointId,
		});
		const candidates = createContextLineageCandidateFamily({
			taskId: "scope",
			assignment: "Review scope",
			variations: [
				[{ id: "role", label: "reviewer_role", value: "security" }],
				[{ id: "role", label: "reviewer_role", value: "operations" }],
				[{ id: "role", label: "reviewer_role", value: "maintainability" }],
			],
		});
		const family = createContextLineageCandidateFamilyRecord({
			planId: contextLineagePlanIdentity(plan()),
			checkpointId: rootedCheckpoint.checkpointId,
			taskId: "scope",
			assignmentDigest: candidates[0]!.assignmentDigest,
			candidates,
		});
		appendContextLineageSessionRecord(journal, family);
		const durableDecision = createAdaptiveDeliberationRecord({
			familyId: family.familyId,
			policy: {
				topK: 2,
				disagreementThreshold: 0.3,
				budget: { maxRequests: 3, maxTokens: 1_000, maxDurationMs: 10_000, maxCostUsd: 1 },
			},
			observation: { requests: 1, tokens: 100, elapsedMs: 100, costUsd: 0.1, disagreement: 0.5 },
			decision: { allocate: true, reason: "disagreement" },
			manual: false,
		});
		appendContextLineageSessionRecord(journal, durableDecision);
		const forgedDecision = {
			...durableDecision,
			decision: { allocate: false as const, reason: "budget_exhausted" as const },
		};
		const { decisionId: _forgedDecisionId, ...forgedDecisionSemanticRecord } = forgedDecision;
		journal.appendCustomEntry("context-lineage", {
			...forgedDecision,
			decisionId: semanticIdentity("context-lineage-adaptive-deliberation", forgedDecisionSemanticRecord),
		});
		const completed = createContextLineageCandidateCompletionRecord({
			familyId: family.familyId,
			candidateId: candidates[0]!.candidateId,
			contentDigest: "digest-a",
			artifactRef: "artifact://candidate-a",
			executionObservation: { elapsedMs: 100, usage: { totalTokens: 200, costUsd: 0.1 } },
		});
		appendContextLineageSessionRecord(journal, completed);
		appendContextLineageSessionRecord(
			journal,
			createContextLineageCandidateReviewRecord({
				familyId: family.familyId,
				candidateId: candidates[0]!.candidateId,
				candidateArtifactRef: "artifact://candidate-a",
				rubricArtifactRef: "artifact://rubric",
				reviewArtifactRef: "artifact://review-a",
				contentDigest: "review-digest-a",
				reviewerProfileId: "context-lineage-blinded-review-v1",
			}),
		);
		const selection = createContextLineageSelectionRecord({
			candidateId: candidates[0]!.candidateId,
			rubricArtifactRef: "artifact://rubric",
			visibleEvidence: ["artifact://candidate-a"],
			evaluator: "declared-rubric-v1",
			explanation: "Selected against the declared rubric.",
		});
		appendContextLineageSessionRecord(
			journal,
			createContextLineageCandidateSelectionSessionRecord({ familyId: family.familyId, selection }),
		);
		appendContextLineageSessionRecord(
			journal,
			createContextLineageCandidateCompletionRecord({
				familyId: family.familyId,
				candidateId: candidates[1]!.candidateId,
				contentDigest: "digest-historic",
				artifactRef: "artifact://candidate-historic",
			}),
		);
		appendContextLineageSessionRecord(
			journal,
			createContextLineageCandidateAllocationStopRecord({
				familyId: family.familyId,
				candidateIds: [candidates[2]!.candidateId],
			}),
		);
		appendContextLineageSessionRecord(
			journal,
			createContextLineageCandidateCompletionRecord({
				familyId: family.familyId,
				candidateId: candidates[2]!.candidateId,
				contentDigest: "digest-b",
				artifactRef: "artifact://candidate-b",
				executionObservation: { elapsedMs: 100 },
			}),
		);

		expect(getContextLineageSessionRecords(journal).map(record => record.kind)).toEqual([
			"repository_manifest",
			"logical_checkpoint",
			"plan",
			"candidate_family",
			"adaptive_deliberation",
			"candidate_completed",
			"candidate_review",
			"candidate_selection",
			"candidate_completed",
			"candidate_allocation_stopped",
		]);
		const recovered = resolveContextLineageCandidateFamily(family.familyId, getContextLineageSessionRecords(journal));
		expect(recovered?.candidates.map(candidate => candidate.status)).toEqual(["completed", "completed", "discarded"]);
		expect(recovered?.candidates[0]?.artifactRef).toBe("artifact://candidate-a");
		expect(recovered?.candidates[0]?.executionObservation).toEqual({
			elapsedMs: 100,
			usage: { totalTokens: 200, costUsd: 0.1 },
		});
		expect(recovered?.candidates[1]?.executionObservation).toBeUndefined();
		expect(recovered?.reviews.map(review => review.reviewArtifactRef)).toEqual(["artifact://review-a"]);
		expect(recovered?.allocationStops.map(stop => stop.candidateIds)).toEqual([[candidates[2]!.candidateId]]);
	});

	it("runs declared candidate variants in isolated side requests", async () => {
		const prompts: string[] = [];
		const artifacts: string[] = [];
		const runner = createCandidateContextLineageTaskRunner({
			session: {
				async runEphemeralTurn({ promptText }) {
					prompts.push(promptText);
					return {
						replyText: `answer-${prompts.length}`,
						usage: { totalTokens: 120 + prompts.length, costUsd: 0.01 * prompts.length },
					};
				},
			},
			saveArtifact: async content => {
				artifacts.push(content);
				return `artifact://candidate-${artifacts.length}`;
			},
		});
		const first = await runner.run({
			assignment: "Review the migration plan",
			variation: [{ id: "role", label: "reviewer_role", value: "security" }],
		});
		const second = await runner.run({
			assignment: "Review the migration plan",
			variation: [{ id: "role", label: "reviewer_role", value: "operations" }],
		});

		expect(first.artifactRef).toBe("artifact://candidate-1");
		expect(second.artifactRef).toBe("artifact://candidate-2");
		expect(first.usage).toEqual({ totalTokens: 121, costUsd: 0.01 });
		expect(second.usage).toEqual({ totalTokens: 122, costUsd: 0.02 });
		expect(first.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(artifacts).toEqual(["answer-1", "answer-2"]);
		expect(prompts[0]).toContain("reviewer_role / role: security");
		expect(prompts[1]).toContain("reviewer_role / role: operations");
		expect(prompts[0]).not.toBe(prompts[1]);
		await runner.run({
			assignment: "Ignored by the structured outcome contract",
			variation: [{ id: "role", label: "reviewer_role", value: "structured" }],
			structuredOutcomeCase: {
				outcomeCaseId: "capability-isolation",
				requiredObligationIds: ["frozen_base"],
				forbiddenObligationIds: ["workspace_access"],
			},
		});
		expect(prompts[2]).toContain("capability-isolation");
		expect(prompts[2]).toContain("satisfiedObligationIds");
		expect(prompts[2]).not.toContain("Ignored by the structured outcome contract");
	});

	it("keeps a blinded reviewer prompt to its one candidate and rubric", async () => {
		const prompts: string[] = [];
		const reviewer = createBlindedCandidateContextLineageReviewer({
			session: {
				async runEphemeralTurn({ promptText }) {
					prompts.push(promptText);
					return { replyText: "The candidate satisfies the stated rubric." };
				},
			},
			saveArtifact: async () => "artifact://review-1",
		});
		const result = await reviewer.run({
			candidateContent: "candidate-a-only",
			rubricContent: "Require a concrete verification step.",
		});

		expect(result.artifactRef).toBe("artifact://review-1");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("candidate-a-only");
		expect(prompts[0]).toContain("Require a concrete verification step.");
		expect(prompts[0]).not.toContain("candidate-b-withheld");
		expect(prompts[0]).not.toContain("context-lineage-candidate");
	});

	it("adjudicates only explicitly authorized reviews while retaining both views", async () => {
		const prompts: string[] = [];
		const adjudicator = createContextLineageCandidateAdjudicator({
			session: {
				async runEphemeralTurn({ promptText }) {
					prompts.push(promptText);
					return { replyText: "Decision: retain the security and operations disagreement." };
				},
			},
			saveArtifact: async () => "artifact://adjudication-1",
		});
		const result = await adjudicator.run({
			rubricContent: "Require an explicit rollback condition.",
			reviewContents: ["Security: reject without a rollback.", "Operations: accept with staged rollout."],
		});
		const record = createContextLineageCandidateAdjudicationRecord({
			familyId: "family-1",
			rubricArtifactRef: "artifact://rubric",
			reviewArtifactRefs: ["artifact://review-security", "artifact://review-operations"],
			adjudicationArtifactRef: result.artifactRef,
			contentDigest: result.contentDigest,
			evaluatorProfileId: "context-lineage-candidate-adjudication-v1",
		});

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Security: reject without a rollback.");
		expect(prompts[0]).toContain("Operations: accept with staged rollout.");
		expect(prompts[0]).not.toContain("withheld review");
		expect(prompts[0]).not.toContain("candidate-1");
		expect(record.reviewArtifactRefs).toEqual(["artifact://review-operations", "artifact://review-security"]);
		expect(record.adjudicationId).toMatch(/^context-lineage-candidate-adjudication:v1:/);
		const selection = createContextLineageSelectionRecord({
			candidateId: "candidate-1",
			rubricArtifactRef: record.rubricArtifactRef,
			visibleEvidence: ["artifact://candidate-1", record.adjudicationArtifactRef],
			evaluator: "human-adjudicator-v1",
			explanation: "Selected after retaining the material disagreement.",
			adjudicationArtifactRef: record.adjudicationArtifactRef,
			authorizedReviewArtifactRefs: record.reviewArtifactRefs,
		});
		expect(selection.authorizedReviewArtifactRefs).toEqual(record.reviewArtifactRefs);
	});

	it("replays only descendants after replacing an approved candidate task output", () => {
		const replayPlan: ContextLineagePlan = {
			version: 1,
			title: "Candidate replay",
			bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: manifest.manifestId } }],
			stages: [
				{
					id: "source",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "candidate-task",
						assignment: "Produce findings",
						output: { name: "findings", format: "text" },
						evidence: [{ manifestId: manifest.manifestId, evidenceId: "evidence-1", purpose: "scope" }],
					},
				},
				{
					id: "consumer",
					mode: "single",
					dependsOn: ["source"],
					base: { type: "extension", baseId: "repository", inputs: [{ stageId: "source", output: "findings" }] },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "consumer-task",
						assignment: "Use findings",
						evidence: [{ manifestId: manifest.manifestId, evidenceId: "evidence-1", purpose: "dependency" }],
					},
				},
				{
					id: "unrelated",
					mode: "single",
					base: { type: "base", baseId: "repository" },
					capabilityRequirements: { workspaceMode: "frozen_read_only" },
					task: {
						id: "unrelated-task",
						assignment: "Remain complete",
						evidence: [{ manifestId: manifest.manifestId, evidenceId: "evidence-1", purpose: "rationale" }],
					},
				},
			],
		};
		const rootedCheckpoint = createRepositoryManifestCheckpoint(manifest);
		const approved = createContextLineageCandidateCheckpointRecord({
			familyId: "family-1",
			candidateId: "candidate-1",
			selectionId: "selection-1",
			planId: contextLineagePlanIdentity(replayPlan),
			sourceCheckpoint: rootedCheckpoint,
			output: {
				stageId: "source",
				taskId: "candidate-task",
				outputName: "findings",
				contentDigest: "approved-digest",
				artifactRef: "artifact://approved",
			},
		});
		const replay = createContextLineageCandidateCheckpointReplay({
			plan: replayPlan,
			approvedCheckpoint: approved,
			priorOutputs: [
				{
					stageId: "source",
					taskId: "candidate-task",
					outputName: "findings",
					contentDigest: "old-digest",
					artifactRef: "artifact://old",
				},
				{
					stageId: "unrelated",
					taskId: "unrelated-task",
					contentDigest: "unrelated",
					artifactRef: "artifact://unrelated",
				},
			],
		});

		expect(replay.replayedStageIds).toEqual(["consumer"]);
		expect(replay.completedStageIds).toEqual(["source", "unrelated"]);
		expect(replay.outputs).toEqual([
			{
				stageId: "unrelated",
				taskId: "unrelated-task",
				contentDigest: "unrelated",
				artifactRef: "artifact://unrelated",
			},
			{
				stageId: "source",
				taskId: "candidate-task",
				outputName: "findings",
				contentDigest: "approved-digest",
				artifactRef: "artifact://approved",
			},
		]);
	});

	it("uses locality only after semantic priority and deadline ordering", () => {
		const scheduled = scheduleContextLineageReadyTasks([
			{ taskId: "urgent", semanticPriority: 2, deadlineAt: 10, checkpointId: "cold", localityScore: 0 },
			{ taskId: "local", semanticPriority: 1, checkpointId: "warm", localityScore: 10 },
			{ taskId: "peer", semanticPriority: 1, checkpointId: "warm", localityScore: 5 },
		]);
		expect(scheduled.map(task => task.taskId)).toEqual(["urgent", "local", "peer"]);
		expect(scheduled[0]?.localityUsed).toBe(false);
		expect(scheduled.every(task => task.localityDelaySlots === 0)).toBe(true);
	});

	it("bounds locality reordering to an equal semantic bucket and reports induced delay", () => {
		const tasks = [
			{ taskId: "a-cold", semanticPriority: 1, checkpointId: "cold", localityScore: 0 },
			{ taskId: "y-warm", semanticPriority: 1, checkpointId: "warm", localityScore: 4 },
			{ taskId: "z-warm", semanticPriority: 1, checkpointId: "warm", localityScore: 5 },
		] as const;
		const bounded = scheduleContextLineageReadyTasks(tasks, { maxLocalityDelaySlots: 1 });
		const accepted = scheduleContextLineageReadyTasks(tasks, { maxLocalityDelaySlots: 2 });

		expect(bounded.map(task => task.taskId)).toEqual(["a-cold", "y-warm", "z-warm"]);
		expect(accepted.map(task => task.taskId)).toEqual(["z-warm", "y-warm", "a-cold"]);
		expect(accepted.at(-1)).toMatchObject({ taskId: "a-cold", localityUsed: true, localityDelaySlots: 2 });
	});

	it("reports activated, cancelled, and unused conditional preparation without enabling dispatch", () => {
		const observations = [
			recordConditionalPreparation({ checkpointId: "used", preparedAt: 1, usedAt: 2 }),
			recordConditionalPreparation({ checkpointId: "cancelled", preparedAt: 1, cancelledAt: 2 }),
			recordConditionalPreparation({ checkpointId: "unused", preparedAt: 1 }),
		];
		expect(summarizeConditionalPreparations(observations, 3)).toEqual({
			prepared: 3,
			activated: 1,
			cancelled: 1,
			wasted: 1,
		});
		expect(() => recordConditionalPreparation({ checkpointId: "invalid", preparedAt: 2, usedAt: 1 })).toThrow(
			"no earlier",
		);
	});

	it("adjudicates near-miss benchmark claims with declared rules and persists the review", () => {
		const benchmark = {
			id: "fixture",
			requiredScope: ["src/target.ts"],
			requiredVerification: ["test/target.test.ts"],
		};
		const review = adjudicateBenchmarkWithDeclaredRules(
			{ scope: ["src/Target.TEST.ts"], verification: [] },
			{ scope: [], verification: ["test\\target.test.ts"] },
			benchmark,
		);
		expect(review.reviewerId).toBe("declared-rule:path-normalization");
		expect(review.mode).toBe("declared_rule");
		expect(review.grounded.scopeRecall).toBe(1);
		expect(review.unguided.verificationRecall).toBe(1);
		expect(review.grounded.unsupportedScope).toEqual([]);

		const record = createContextLineageBenchmarkRecord({
			benchmarkCaseId: benchmark.id,
			manifestId: "manifest-1",
			checkpointId: "checkpoint-1",
			planId: "plan-1",
			comparison: compareRepositoryPlanningResults(review.grounded, review.unguided),
			review,
		});
		// The review is bound into the durable benchmark identity, so tampering with
		// persisted adjudication is detectable by recomputing the record identity.
		const { benchmarkId: _storedId, ...tamperedSemantic } = { ...record, review: { ...review, rulesVersion: "v2" } };
		expect(semanticIdentity("context-lineage-benchmark", tamperedSemantic)).not.toBe(record.benchmarkId);
	});

	it("binds retrieval policy and renderer changes into manifest identity and preserves explicit degradation", () => {
		const baseline = createRepositoryContextManifest({
			snapshot: manifest.snapshot,
			task: "Plan target",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v1",
			evidence: manifest.evidence,
			degradedSources: [{ extractorId: "native-symbols", reason: "unavailable", detail: "index not installed" }],
		});
		const changedPolicy = createRepositoryContextManifest({
			...baseline,
			task: "Plan target",
			retrievalPolicy: { id: "current-state-v1", maxEvidence: 3 },
			contextRendererVersion: "renderer-v1",
			evidence: manifest.evidence,
		});
		const changedRenderer = createRepositoryContextManifest({
			...baseline,
			task: "Plan target",
			retrievalPolicy: { id: "current-state-v1" },
			contextRendererVersion: "renderer-v2",
			evidence: manifest.evidence,
		});

		expect(changedPolicy.manifestId).not.toBe(baseline.manifestId);
		expect(changedRenderer.manifestId).not.toBe(baseline.manifestId);
		expect(baseline.degradedSources).toContainEqual({
			extractorId: "native-symbols",
			reason: "unavailable",
			detail: "index not installed",
		});
		expect(renderRepositoryContextManifest(baseline)).toContain("native-symbols: unavailable (index not installed)");
	});
});
