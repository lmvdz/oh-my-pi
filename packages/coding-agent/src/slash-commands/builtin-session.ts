import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { settings } from "../config/settings";
import { CONTEXT_LINEAGE_BENCHMARK_CASES } from "../context-lineage/benchmark-cases";
import { registerActiveContextLineageRun, unregisterActiveContextLineageRun } from "../context-lineage/active-runs";
import {
	MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES,
	prepareContextLineageCandidateRubric,
} from "../context-lineage/candidate-rubric";
import {
	createContextLineageCandidateFamily,
	createContextLineageSelectionRecord,
	type ContextLineageCandidateVariation,
} from "../context-lineage/deliberation";
import { contextLineagePlanIdentity } from "../context-lineage/identity";
import {
	createContextLineageBaseSelectionFallback,
	selectContextLineageBase,
	type ContextLineageBaseRejection,
	type ContextLineageBaseSelectionCandidate,
} from "../context-lineage/base-selection";
import { lowerFanoutRequest } from "../context-lineage/lowering";
import { isRepositoryContextManifestIntact, summarizeRepositoryContextManifest } from "../context-lineage/manifest";
import {
	createEphemeralRepositoryPlanningSkillGenerator,
	createEphemeralUnguidedPlanningClaimsGenerator,
	renderContextLineagePlanInspection,
} from "../context-lineage/planning";
import {
	artifactIdFromRef,
	benchmarkRepositoryContextLineage,
	createBlindedCandidateContextLineageReviewer,
	createContextLineageCandidateAdjudicator,
	createArtifactManagerContextLineageOutputVerifier,
	createCandidateContextLineageTaskRunner,
	createContextLineageRunId,
	createSideRequestContextLineageTaskRunner,
	executeContextLineagePlan,
	type ContextLineageExecutionOutcome,
	planRepositoryContextLineage,
	planWayfinderContextLineage,
	prepareRepositoryContextLineage,
} from "../context-lineage/runtime";
import { ContextLineageRunController } from "../context-lineage/run-controller";
import {
	appendContextLineageSessionRecord,
	archiveNamedBaseRecord,
	contextLineageCheckpointRetention,
	createContextLineageCandidateCompletionRecord,
	createContextLineageCandidateCheckpointRecord,
	createContextLineageCandidateCheckpointReplay,
	createContextLineageCandidateAdjudicationRecord,
	createContextLineageCandidateAllocationStopRecord,
	createContextLineageCandidateDiscardRecord,
	createContextLineageCandidateFamilyRecord,
	createContextLineageCandidateReviewRecord,
	createContextLineageCandidateSelectionSessionRecord,
	createContextLineageBaseSelectionFallbackRecord,
	createContextLineageBaseSelectionRecord,
	type ContextLineageExecutionOutput,
	type ContextLineageSessionRecord,
	createNamedBaseRecord,
	discardContextLineageOutput,
	deleteNamedBaseRecord,
	getContextLineageSessionRecords,
	isRepositoryContextManifest,
	namedBaseVersions,
	promoteContextLineageResult,
	resolveContextLineageCandidateFamily,
	summarizeContextLineageSession,
} from "../context-lineage/session";
import { resolveRepositorySnapshot } from "../context-lineage/snapshot";
import type { ContextLineagePlan, LogicalContextCheckpoint, RepositoryContextManifest } from "../context-lineage/types";
import { stageTasks } from "../context-lineage/types";
import { validateContextLineagePlan, validateFanoutRequest } from "../context-lineage/validation";
import type { AgentSession } from "../session/agent-session";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import type { ArtifactManager } from "../session/artifacts";
import { sanitizeAssistantForReparentedHistory } from "../session/messages";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../utils/changelog";
import { formatTokenCount, refreshStatusLine } from "./builtin-modes";
import { buildContextReportText } from "./helpers/context-report";
import { formatDuration } from "./helpers/format";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import { launchStatsDashboard, parseStatsDashboardArgs } from "./helpers/stats-dashboard";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`Could not load saved resets: ${errorMessage(error)}`);
		return;
	}
	if (accounts.length === 0) {
		await output("No Codex accounts found. Use /login to add one.");
		return;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = ["Saved Codex rate-limit resets:"];
		for (const account of accounts) {
			const detail = account.error ? `unavailable (${account.error})` : `${account.availableCount} available`;
			lines.push(`- ${account.label}: ${detail}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Spend one with `/usage reset <account email>` or `/usage reset active`.");
		await output(lines.join("\n"));
		return;
	}
	const wanted = targetArg.toLowerCase();
	const target =
		wanted === "active"
			? accounts.find(account => account.active)
			: accounts.find(
					account =>
						account.label.toLowerCase() === wanted ||
						account.target.email?.toLowerCase() === wanted ||
						account.target.accountId?.toLowerCase() === wanted,
				);
	if (!target) {
		await output(`No Codex account matches "${targetArg}".`);
		return;
	}
	if (target.availableCount <= 0) {
		await output(`${target.label}: no saved resets to spend.`);
		return;
	}
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, target.label));
}

/** Repository-context surfaces stay default-off until the PRD Gate B quality gate passes. */
async function isContextLineageEnabled(runtime: Pick<SlashCommandRuntime, "output">): Promise<boolean> {
	if (settings.get("contextLineage.enabled")) return true;
	await runtime.output(
		"Context Lineage is disabled by default. Enable it with `contextLineage.enabled: true` in settings.",
	);
	return false;
}

async function handleContextLineageRequest(
	args: string,
	cwd: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	if (!(await isContextLineageEnabled(runtime))) return;
	const task = args.trim();
	if (task === "status") {
		const summary = summarizeContextLineageSession(runtime.sessionManager);
		await runtime.output(
			`Context Lineage: ${summary.manifests} manifest(s), ${summary.checkpoints} checkpoint(s), ${summary.plans} persisted plan(s), ${summary.namedBases} named base(s), ${summary.executions} execution(s) (${summary.completedExecutions} completed, ${summary.failedExecutions} failed, ${summary.abortedExecutions} aborted)`,
		);
		return;
	}
	if (task === "ask" || task.startsWith("ask ")) {
		if (!(settings.get("contextLineage.fanout.enabled") ?? true)) {
			await runtime.output("Parallel questions are disabled (contextLineage.fanout.enabled).");
			return;
		}
		const resumeMatch = /\s--resume\s+(\S+)\s*$/.exec(task.slice("ask".length).trim());
		const askArgs = task
			.slice("ask".length)
			.trim()
			.replace(/\s--resume\s+\S+\s*$/, "");
		await handleLineageAskRequest(askArgs, cwd, runtime, resumeMatch?.[1]);
		return;
	}
	if (task === "candidate" || task.startsWith("candidate ")) {
		await handleLineageCandidateRequest(task.slice("candidate".length).trim(), runtime);
		return;
	}
	if (task.startsWith("promote ")) {
		await handleLineagePromoteRequest(task.slice("promote ".length).trim(), runtime);
		return;
	}
	if (task.startsWith("discard ")) {
		const match = /^(\S+)\s+(\d+)$/.exec(task.slice("discard ".length).trim());
		if (!match) {
			await runtime.output("Usage: /lineage discard <run-id> <answer-number>");
			return;
		}
		const [, runId, answerNumberRaw] = match;
		const records = getContextLineageSessionRecords(runtime.sessionManager);
		const run = records.find(
			(record): record is LineageExecutionRecord =>
				record.kind === "execution" && record.runId === runId && record.stageId === undefined,
		);
		const output = run?.outputs[Number(answerNumberRaw) - 1];
		if (!output) {
			await runtime.output(`Run ${runId} has no answer #${answerNumberRaw}.`);
			return;
		}
		try {
			appendContextLineageSessionRecord(
				runtime.sessionManager,
				discardContextLineageOutput({ runId, taskId: output.taskId, records }),
			);
			await runtime.output(`Dismissed answer #${answerNumberRaw}; its artifact and provenance remain available.`);
		} catch (error) {
			await runtime.output(`Could not dismiss answer: ${errorMessage(error)}`);
		}
		return;
	}
	if (task.startsWith("diagnostics")) {
		await handleLineageDiagnosticsRequest(task.slice("diagnostics".length).trim(), runtime);
		return;
	}
	if (task.startsWith("synthesize ")) {
		await handleLineageSynthesisRequest(task.slice("synthesize ".length).trim(), runtime);
		return;
	}
	if (task.startsWith("documentary ")) {
		const match = /^(local|forge)\s+(\S+)\s+::\s+(.+)$/.exec(task.slice("documentary ".length).trim());
		if (!match) {
			await runtime.output("Usage: /lineage documentary <local|forge> <authorized-file> :: <task>");
			return;
		}
		const source = match[1] === "forge" ? "forge" : "local";
		const documentPath = match[2]!;
		const documentaryTask = match[3]!;
		const file = Bun.file(documentPath);
		if (!(await file.exists())) {
			await runtime.output(`Authorized documentary file is unavailable: ${shortenPath(documentPath)}.`);
			return;
		}
		const maxDocumentaryBytes = 64 * 1024;
		if (file.size > maxDocumentaryBytes) {
			await runtime.output(
				`Authorized documentary file exceeds the ${maxDocumentaryBytes}-byte intake limit: ${shortenPath(documentPath)}.`,
			);
			return;
		}
		try {
			const planned = await planRepositoryContextLineage({
				cwd,
				task: documentaryTask.trim(),
				journal: runtime.sessionManager,
				generator: createEphemeralRepositoryPlanningSkillGenerator(runtime.session),
				documentary: {
					documents: [{ source, sourceRef: `${source}://${shortenPath(documentPath)}`, content: await file.text() }],
					maxItems: 1,
					maxExcerptBytes: 8 * 1024,
				},
			});
			if (!planned.valid) {
				const issue =
					planned.validation.phase === "semantic"
						? planned.validation.result.issues[0]?.message
						: planned.validation.error;
				await runtime.output(`Documentary Context Lineage plan rejected: ${issue ?? "unknown validation error"}`);
				return;
			}
			await runtime.output(
				`Persisted documentary-enriched Context Lineage plan ${planned.planId}. ${source} material remains documentary evidence and does not establish current repository state.`,
			);
		} catch (error) {
			await runtime.output(`Could not create documentary Context Lineage plan: ${errorMessage(error)}`);
		}
		return;
	}
	if (task.startsWith("answers")) {
		const runId = task.slice("answers".length).trim();
		const records = getContextLineageSessionRecords(runtime.sessionManager);
		const executions = records.filter(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
				record.kind === "execution" && record.stageId === undefined && record.status === "completed",
		);
		const execution = runId ? executions.find(record => record.runId === runId) : executions.at(-1);
		if (!execution) {
			await runtime.output(runId ? `No completed run matches ${runId}.` : "No completed runs are available.");
			return;
		}
		const planRecord = records.find(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "plan" }> =>
				record.kind === "plan" && record.planId === execution.planId,
		);
		const assignmentByTaskId = new Map<string, string>();
		if (planRecord) {
			for (const stage of planRecord.plan.stages) {
				for (const task of stageTasks(stage)) {
					assignmentByTaskId.set(task.id, task.assignment);
				}
			}
		}
		const lines = [`Run ${execution.runId} (checkpoint ${execution.checkpointId}):`];
		for (const [index, output] of execution.outputs.entries()) {
			const artifactId = artifactIdFromRef(output.artifactRef);
			const artifactPath = artifactId ? await runtime.sessionManager.getArtifactPath(artifactId) : null;
			const preview = artifactPath ? (await Bun.file(artifactPath).text()).split("\n")[0] : "(missing artifact)";
			const question = assignmentByTaskId.get(output.taskId);
			lines.push(
				`${index + 1}. ${output.taskId}${question ? ` — ${truncateToWidth(replaceTabs(question), TRUNCATE_LENGTHS.LINE)}` : ""}`,
			);
			lines.push(`   ${truncateToWidth(replaceTabs(preview), TRUNCATE_LENGTHS.LINE)}`);
			lines.push(`   ${output.artifactRef}${output.cacheStatus ? ` (cache ${output.cacheStatus})` : ""}`);
		}
		await runtime.output(lines.join("\n"));
		return;
	}
	if (task === "base" || task.startsWith("base ")) {
		await handleLineageBaseRequest(task.slice("base".length).trim(), runtime);
		return;
	}
	if (task === "show" || task.startsWith("show ")) {
		const manifestId = task.slice("show".length).trim();
		const manifests = getContextLineageSessionRecords(runtime.sessionManager).flatMap(record =>
			record.kind === "repository_manifest" ? [record.manifest] : [],
		);
		const manifest = manifestId ? manifests.find(candidate => candidate.manifestId === manifestId) : manifests.at(-1);
		if (!manifest) {
			await runtime.output(
				manifestId
					? `No intact Context Lineage manifest matches ${truncateToWidth(replaceTabs(manifestId), TRUNCATE_LENGTHS.CONTENT)}.`
					: "No intact Context Lineage manifest is available. Run `/context <task>` first.",
			);
			return;
		}
		await runtime.output(
			summarizeRepositoryContextManifest(manifest)
				.split("\n")
				.map(line => truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE))
				.join("\n"),
		);
		return;
	}
	if (task === "benchmark" && !(settings.get("contextLineage.plans.enabled") ?? true)) {
		await runtime.output("Benchmark surface is disabled (contextLineage.plans.enabled).");
		return;
	}
	if (task === "benchmark" || task.startsWith("benchmark ")) {
		const benchmarkId = task.slice("benchmark".length).trim();
		if (benchmarkId === "list" || benchmarkId.length === 0) {
			await runtime.output(
				[
					"Context Lineage benchmark cases:",
					...CONTEXT_LINEAGE_BENCHMARK_CASES.map(candidate => `- ${candidate.id}`),
					"Run one with `/lineage benchmark <case-id>`, or the representative corpus with `/lineage benchmark all`.",
				].join("\n"),
			);
			return;
		}
		if (benchmarkId === "all") {
			const successful: Array<{ id: string; scopeDelta: number; verificationDelta: number; traceabilityDelta: number }> = [];
			const rejected: string[] = [];
			try {
				for (const benchmark of CONTEXT_LINEAGE_BENCHMARK_CASES) {
					if (!benchmark.task) {
						rejected.push(`${benchmark.id} (missing task framing)`);
						continue;
					}
					const prepared = await prepareRepositoryContextLineage({
						cwd,
						task: benchmark.task,
						journal: runtime.sessionManager,
					});
					const result = await benchmarkRepositoryContextLineage({
						prepared,
						benchmark,
						journal: runtime.sessionManager,
						groundedGenerator: createEphemeralRepositoryPlanningSkillGenerator(runtime.session),
						unguidedGenerator: createEphemeralUnguidedPlanningClaimsGenerator(runtime.session),
					});
					if (!result.valid) {
						rejected.push(benchmark.id);
						continue;
					}
					successful.push({
						id: benchmark.id,
						scopeDelta: result.run.comparison.scopeRecallDelta,
						verificationDelta: result.run.comparison.verificationRecallDelta,
						traceabilityDelta: result.run.comparison.evidenceTraceabilityDelta,
					});
				}
			} catch (error) {
				await runtime.output(`Could not complete Context Lineage benchmark corpus: ${errorMessage(error)}`);
				return;
			}
			const average = (key: "scopeDelta" | "verificationDelta" | "traceabilityDelta") =>
				successful.length === 0 ? 0 : successful.reduce((total, result) => total + result[key], 0) / successful.length;
			await runtime.output(
				[
					`Context Lineage benchmark corpus: ${successful.length}/${CONTEXT_LINEAGE_BENCHMARK_CASES.length} valid case(s).`,
					...successful.map(
						result =>
							`- ${result.id}: scope Δ ${result.scopeDelta.toFixed(2)}, verification Δ ${result.verificationDelta.toFixed(2)}, traceability Δ ${result.traceabilityDelta.toFixed(2)}`,
					),
					...(rejected.length > 0 ? [`Rejected: ${rejected.join(", ")}`] : []),
					`Mean across valid cases: scope Δ ${average("scopeDelta").toFixed(2)}, verification Δ ${average("verificationDelta").toFixed(2)}, traceability Δ ${average("traceabilityDelta").toFixed(2)}.`,
					"This reports evidence only; it does not change the default-off Context Lineage gate.",
				].join("\n"),
			);
			return;
		}
		const benchmark = CONTEXT_LINEAGE_BENCHMARK_CASES.find(candidate => candidate.id === benchmarkId);
		if (!benchmark) {
			await runtime.output(
				`Usage: /lineage benchmark <case-id>. Available: ${CONTEXT_LINEAGE_BENCHMARK_CASES.map(candidate => candidate.id).join(", ")}`,
			);
			return;
		}
		if (!benchmark.task) {
			await runtime.output(`Context Lineage benchmark ${benchmark.id} has no task framing.`);
			return;
		}
		try {
			const prepared = await prepareRepositoryContextLineage({
				cwd,
				task: benchmark.task,
				journal: runtime.sessionManager,
			});
			const result = await benchmarkRepositoryContextLineage({
				prepared,
				benchmark,
				journal: runtime.sessionManager,
				groundedGenerator: createEphemeralRepositoryPlanningSkillGenerator(runtime.session),
				unguidedGenerator: createEphemeralUnguidedPlanningClaimsGenerator(runtime.session),
			});
			if (!result.valid) {
				const validation = result.run.grounded;
				const reason = validation.phase === "semantic" ? validation.result.issues[0]?.message : validation.error;
				await runtime.output(
					`Context Lineage benchmark rejected its grounded plan; no baseline result was accepted: ${reason ?? "unknown validation error"}`,
				);
				return;
			}
			const comparison = result.run.comparison;
			await runtime.output(
				`Persisted Context Lineage benchmark ${benchmark.id} (${result.benchmarkId}): scope Δ ${comparison.scopeRecallDelta.toFixed(2)}, verification Δ ${comparison.verificationRecallDelta.toFixed(2)}, evidence traceability Δ ${comparison.evidenceTraceabilityDelta.toFixed(2)}.`,
			);
		} catch (error) {
			await runtime.output(`Could not run Context Lineage benchmark: ${errorMessage(error)}`);
		}
		return;
	}
	if (task.startsWith("plan ")) {
		if (task === "plan show" || task.startsWith("plan show ")) {
			const planId = task.slice("plan show".length).trim();
			const plans = getContextLineageSessionRecords(runtime.sessionManager).filter(
				(record): record is LineagePlanRecord => record.kind === "plan",
			);
			const plan = planId ? plans.find(record => record.planId === planId) : plans.at(-1);
			if (!plan) {
				await runtime.output(planId ? `No persisted Context Lineage plan matches ${planId}.` : "No persisted Context Lineage plan is available.");
				return;
			}
			await runtime.output(
				renderContextLineagePlanInspection(plan.plan)
					.split("\n")
					.map(line => truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE))
					.join("\n"),
			);
			return;
		}
		const unguided = /\s--unguided\s*$/.test(task);
		const currentStateOnly = /\s--current-state-only\s*$/.test(task);
		const withRun = /\s--run(\s+--(resume|execute)\s+\S+)?\s*$/.test(task);
		const resumeMatch = /--resume\s+(\S+)\s*$/.exec(task);
		const executePlanId = /--execute\s+(\S+)\s*$/.exec(task)?.[1];
		const resumeRunId = resumeMatch?.[1];
		const planningTask = task
			.slice("plan ".length)
			.replace(/\s--(?:unguided|current-state-only)\b/g, "")
			.replace(/\s--run(\s+--resume\s+\S+)?\s*$/, "")
			.trim();
		if (!planningTask && !resumeRunId) {
			await runtime.output("Usage: /lineage plan <task> [--run] | /lineage plan --run --resume <run-id>");
			return;
		}
		if (resumeRunId) {
			await handleLineagePlanResume(resumeRunId, runtime, Boolean(runtime.sessionManager.getArtifactManager()));
			return;
		}
		if (withRun && executePlanId) {
			await handleLineagePlanExecute(executePlanId, runtime);
			return;
		}
		if (unguided) {
			if (withRun || currentStateOnly) {
				await runtime.output("`--unguided` cannot be combined with `--run` or `--current-state-only`.");
				return;
			}
			try {
				const claims = await createEphemeralUnguidedPlanningClaimsGenerator(runtime.session).generate(planningTask);
				await runtime.output(
					[
						"Unguided planning baseline (no repository manifest was compiled):",
						`Scope: ${claims.scope.join(", ") || "none declared"}`,
						`Verification: ${claims.verification.join(", ") || "none declared"}`,
					].join("\n"),
				);
			} catch (error) {
				await runtime.output(`Could not create unguided baseline: ${errorMessage(error)}`);
			}
			return;
		}
		try {
			const planned = await planRepositoryContextLineage({
				cwd,
				task: planningTask,
				journal: runtime.sessionManager,
				generator: createEphemeralRepositoryPlanningSkillGenerator(runtime.session),
				...(currentStateOnly
					? {
						temporal: undefined,
						adapters: { graphify: "off" as const, scip: "off" as const, requireSnapshotMatch: true },
					}
					: {
						temporal: settings.get("contextLineage.repositoryContext.temporal")
							? { policy: { id: "context-lineage-temporal-v1" } }
							: undefined,
						adapters: {
							graphify: settings.get("contextLineage.repositoryContext.adapters.graphify") ?? "off",
							scip: settings.get("contextLineage.repositoryContext.adapters.scip") ?? "auto",
							requireSnapshotMatch: settings.get("contextLineage.repositoryContext.adapters.requireSnapshotMatch") ?? true,
						},
					}),
			});
			if (!planned.valid) {
				const issue =
					planned.validation.phase === "semantic"
						? planned.validation.result.issues[0]?.message
						: planned.validation.error;
				await runtime.output(`Context Lineage plan rejected: ${issue ?? "unknown validation error"}`);
				return;
			}
			await runtime.output(
				`Persisted frozen Context Lineage ${currentStateOnly ? "current-state-only " : ""}plan ${planned.planId}: ${planned.plan.title} (${planned.plan.stages.length} stage(s)).`,
			);
			if (withRun) {
				const artifacts = runtime.sessionManager.getArtifactManager();
				if (!artifacts) {
					await runtime.output("Cannot run plan: this session has no artifact store.");
					return;
				}
				const runner = createSideRequestContextLineageTaskRunner({
					session: runtime.session,
					saveArtifact: async content =>
						`artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage")}`,
				});
				const outcome = await executeContextLineagePlan({
					manifest: planned.prepared.manifest,
					checkpoint: planned.prepared.checkpoint,
					plan: planned.plan,
					originLeafId: runtime.sessionManager.getLeafId() ?? undefined,
					journal: runtime.sessionManager,
					runner,
					outputVerifier: createArtifactManagerContextLineageOutputVerifier(artifacts),
					concurrency: Number(settings.get("contextLineage.fanout.maxConcurrency")) || undefined,
				});
				await runtime.output(
					`Executed plan ${planned.planId}: ${outcome.status}. Outputs are sidecar artifacts; the parent context is unchanged.`,
				);
			}
		} catch (error) {
			await runtime.output(`Could not create Context Lineage plan: ${errorMessage(error)}`);
		}
		return;
	}
	const prepared = await prepareRepositoryContextLineage({
		cwd,
		task,
		journal: runtime.sessionManager,
		temporal: settings.get("contextLineage.repositoryContext.temporal")
			? { policy: { id: "context-lineage-temporal-v1" } }
			: undefined,
		adapters: {
			graphify: settings.get("contextLineage.repositoryContext.adapters.graphify") ?? "off",
			scip: settings.get("contextLineage.repositoryContext.adapters.scip") ?? "auto",
			requireSnapshotMatch: settings.get("contextLineage.repositoryContext.adapters.requireSnapshotMatch") ?? true,
		},
	});
	await runtime.output(
		`Prepared frozen Context Lineage manifest ${prepared.manifest.manifestId} with ${prepared.manifest.evidence.length} evidence item(s). Checkpoint: ${prepared.checkpoint.checkpointId}`,
	);
	for (const observation of prepared.adapterObservations) {
		const counts = `${observation.evidence.length} candidate(s), ${observation.rejectedCount} rejected`;
		await runtime.output(
			`Adapter ${observation.adapterId}: ${observation.status} (${counts}) — ${observation.detail}`,
		);
	}
}

/** Canonical PR 8A command; `/lineage ask` remains the descriptive alias. */
async function handleFanoutRequest(
	args: string,
	cwd: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	if (!(await isContextLineageEnabled(runtime))) return;
	if (!(settings.get("contextLineage.fanout.enabled") ?? true)) {
		await runtime.output("Parallel questions are disabled (contextLineage.fanout.enabled).");
		return;
	}
	const resumeMatch = /\s--resume\s+(\S+)\s*$/.exec(args);
	const questions = args.replace(/\s--resume\s+\S+\s*$/, "").trim();
	await handleLineageAskRequest(questions, cwd, runtime, resumeMatch?.[1]);
}

/**
 * Parallel Questions headless flow (PRD §9 / PR 4): lower independent
 * questions into a one-stage plan rooted at a fresh frozen manifest and
 * execute them as no-tools side requests. Answers stay in sidecar artifacts.
 */
async function handleLineageAskRequest(
	args: string,
	cwd: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
	resumeRunId?: string,
): Promise<void> {
	const artifacts = runtime.sessionManager.getArtifactManager();
	if (!artifacts) {
		await runtime.output("Cannot run questions: this session has no artifact store.");
		return;
	}
	const records = getContextLineageSessionRecords(runtime.sessionManager);

	// FR24 restart recovery: recover a failed run's base, plan, and completed
	// stages from session records so only unfinished work reruns.
	let resumeState:
		| {
				manifest: RepositoryContextManifest;
				checkpoint: LogicalContextCheckpoint;
				plan: ContextLineagePlan;
				completedStageIds: string[];
				outputs: ContextLineageExecutionOutput[];
		  }
		| undefined;
	if (resumeRunId) {
		const failedRun = records.find(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "execution" }> =>
				record.kind === "execution" && record.runId === resumeRunId && record.stageId === undefined,
		);
		if (failedRun?.status !== "failed" && failedRun?.status !== "completed") {
			await runtime.output(`No resumable Context Lineage run matches ${resumeRunId}.`);
			return;
		}
		const planRecord = records.find(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "plan" }> =>
				record.kind === "plan" && record.planId === failedRun.planId,
		);
		const checkpointRecord = records.find(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "logical_checkpoint" }> =>
				record.kind === "logical_checkpoint" && record.checkpoint.checkpointId === failedRun.checkpointId,
		);
		if (!planRecord || !checkpointRecord) {
			await runtime.output(`Run ${resumeRunId} is missing its persisted plan or checkpoint.`);
			return;
		}
		const completedOutputs = failedRun.outputs;
		resumeState = {
			manifest: findManifestFor(records, planRecord.manifestId)!,
			checkpoint: checkpointRecord.checkpoint,
			plan: planRecord.plan,
			completedStageIds: planRecord.plan.stages
				.filter(stage =>
					stageTasks(stage).every(task =>
						completedOutputs.some(output => output.stageId === stage.id && output.taskId === task.id),
					),
				)
				.map(stage => stage.id),
			outputs: [...completedOutputs],
		};
	}

	const questions = args
		.split("|")
		.map(question => question.trim())
		.filter(question => question.length > 0);
	if (!resumeState && questions.length < 2) {
		await runtime.output(
			"Usage: /lineage ask <question 1> | <question 2> [| …] (2–5 questions) or /lineage ask --resume <run-id>",
		);
		return;
	}
	try {
		const selectedBase = resumeState
			? undefined
			: await selectPersistedContextLineageBase(questions.join("; "), cwd, records, artifacts);
		const prepared = resumeState
			? {
					manifest: resumeState.manifest,
					checkpoint: resumeState.checkpoint,
					manifestEntryId: "",
					checkpointEntryId: "",
				}
			: selectedBase?.selected
				? {
						manifest: selectedBase.candidate.manifest,
						checkpoint: selectedBase.candidate.checkpoint,
						manifestEntryId: "",
						checkpointEntryId: "",
					}
				: await prepareRepositoryContextLineage({
					cwd,
					task: questions.join("; "),
					journal: runtime.sessionManager,
				});
		const lowered = resumeState
			? resumeState.plan
			: lowerFanoutRequest(
					{
						version: 1,
						checkpoint: { type: "current_idle" },
						questions: questions.map(question => ({ question })),
					},
					// Root at the frozen checkpoint, not the raw manifest: parallel
					// questions are checkpoint branching (PRD §3.1), not grounded
					// plan steps, so the FR51 evidence-or-assumption rule does not
					// apply. Provenance survives via checkpoint.repositoryManifestId.
					{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
				);
		if (!resumeState) {
			const validation = validateFanoutRequest(
				{
					version: 1,
					checkpoint: { type: "current_idle" },
					questions: questions.map(question => ({ question })),
				},
				Number(settings.get("contextLineage.fanout.maxItems")) || 5,
			);
			if (!validation.valid) {
				await runtime.output(`Questions rejected: ${validation.issues[0]?.message ?? "unknown error"}`);
				return;
			}
			appendContextLineageSessionRecord(runtime.sessionManager, {
				version: 1,
				kind: "plan",
				plan: lowered,
				planId: contextLineagePlanIdentity(lowered),
				manifestId: prepared.manifest.manifestId,
				checkpointId: prepared.checkpoint.checkpointId,
			});
		}
		const runner = createSideRequestContextLineageTaskRunner({
			session: runtime.session,
			saveArtifact: async content =>
				`artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage")}`,
		});
		const runId = createContextLineageRunId(lowered, prepared.checkpoint);
		if (selectedBase?.selected) {
			appendContextLineageSessionRecord(
				runtime.sessionManager,
				createContextLineageBaseSelectionRecord(selectedBase.selected, runId),
			);
		} else if (selectedBase) {
			appendContextLineageSessionRecord(
				runtime.sessionManager,
				createContextLineageBaseSelectionFallbackRecord(
					createContextLineageBaseSelectionFallback({
						runId,
						taskDigest: selectedBase.taskDigest,
						rejected: selectedBase.rejected,
					}),
				),
			);
		}
		const controller = new ContextLineageRunController(lowered);
		registerActiveContextLineageRun({ sessionId: runtime.session.sessionId, runId, plan: lowered, controller });
		let outcome: ContextLineageExecutionOutcome;
		try {
			outcome = await executeContextLineagePlan({
				manifest: prepared.manifest,
				checkpoint: prepared.checkpoint,
				plan: lowered,
				journal: runtime.sessionManager,
				runner,
				outputVerifier: createArtifactManagerContextLineageOutputVerifier(artifacts),
				originLeafId: runtime.sessionManager.getLeafId() ?? undefined,
				warmPolicy: resumeState ? "off" : settings.get("contextLineage.fanout.warmPolicy") || "off",
				resume: resumeState
					? { completedStageIds: resumeState.completedStageIds, outputs: resumeState.outputs }
					: undefined,
				runId,
				taskSignal: controller.taskSignal,
			});
		} finally {
			unregisterActiveContextLineageRun(runtime.session.sessionId, runId);
		}
		const answers = getContextLineageSessionRecords(runtime.sessionManager)
			.filter(
				(record): record is LineageExecutionRecord =>
					record.kind === "execution" && record.runId === outcome.runId && record.stageId === undefined,
			)
			.flatMap(record => record.outputs);
		const lines = [
			`Parallel questions ${outcome.status}: ${answers.length} answer(s) as sidecar artifacts (input order preserved).`,
			...answers.map(
				(answer, index) =>
					`${index + 1}. ${answer.taskId} -> ${answer.artifactRef}${answer.cacheStatus ? ` (cache ${answer.cacheStatus})` : ""}`,
			),
		];
		await runtime.output(lines.join("\n"));
	} catch (error) {
		await runtime.output(`Could not run questions: ${errorMessage(error)}`);
	}
}

type LineageExecutionRecord = Extract<ContextLineageSessionRecord, { kind: "execution" }>;
type LineagePlanRecord = Extract<ContextLineageSessionRecord, { kind: "plan" }>;
type LineageManifestRecord = Extract<ContextLineageSessionRecord, { kind: "repository_manifest" }>;
type LineageCheckpointRecord = Extract<ContextLineageSessionRecord, { kind: "logical_checkpoint" }>;

const MAX_CONTEXT_LINEAGE_CANDIDATE_LEAVES = 4;
const CONTEXT_LINEAGE_BLINDED_REVIEWER_PROFILE_ID = "context-lineage-blinded-review-v1";
const CANDIDATE_VARIATION_PATTERN = /^(counterfactual|candidate|reviewer_role|context_delta)\/([a-z0-9_.-]{1,64})=(.+)$/i;

/**
 * PR10 controlled reasoning surface. New families refer to a persisted plan
 * task; replaying a family recovers that assignment from the plan rather than
 * retaining a second raw assignment copy in the candidate journal.
 */
async function handleLineageCandidateRequest(
	args: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	const rubricMatch = /^rubric\s+([\s\S]+)$/.exec(args);
	if (rubricMatch) {
		const rubric = prepareContextLineageCandidateRubric(rubricMatch[1]!);
		if (!rubric.valid && rubric.reason === "empty") {
			await runtime.output("Usage: /lineage candidate rubric <bounded evaluation criteria>");
			return;
		}
		if (!rubric.valid) {
			await runtime.output(
				`Candidate rubric exceeds the ${MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES}-byte review limit; it was not saved.`,
			);
			return;
		}
		const artifactId = await runtime.sessionManager.saveArtifact(rubric.content, "context-lineage-candidate-rubric");
		if (!artifactId) {
			await runtime.output("Could not persist candidate rubric: this session has no artifact store.");
			return;
		}
		const artifactRef = `artifact://${artifactId}`;
		await runtime.output(
			`Stored candidate rubric as ${artifactRef}. Use this artifact reference with candidate review, adjudication, or selection; rubric content remains sidecar-only.`,
		);
		return;
	}
	const records = getContextLineageSessionRecords(runtime.sessionManager);
	const inspectMatch = /^inspect\s+(\S+)(?:\s+(\d+))?$/.exec(args);
	if (inspectMatch) {
		const family = resolveContextLineageCandidateFamily(inspectMatch[1]!, records);
		if (!family) {
			await runtime.output(`No Context Lineage candidate family matches ${inspectMatch[1]}.`);
			return;
		}
		const index = inspectMatch[2] === undefined ? undefined : Number(inspectMatch[2]) - 1;
		if (index !== undefined && !family.candidates[index]) {
			await runtime.output(`Candidate family ${family.family.familyId} has no leaf #${index + 1}.`);
			return;
		}
		const candidates = index === undefined ? family.candidates : [family.candidates[index]!];
		const lines = [
			`Candidate family ${family.family.familyId}: plan ${family.family.planId}, task ${family.family.taskId}.`,
			...candidates.map((candidate, candidateIndex) => {
				const number = index === undefined ? candidateIndex + 1 : index + 1;
				const variation = candidate.variation.map(item => `${item.label}/${item.id}=${item.value}`).join(", ");
				return `- ${number}. ${candidate.status}; ${variation}${candidate.artifactRef ? `; ${candidate.artifactRef}` : ""}`;
			}),
			`Selections: ${family.selections.length}.`,
		];
		const selected = index === undefined ? undefined : family.candidates[index];
		if (selected?.artifactRef) {
			const artifactId = artifactIdFromRef(selected.artifactRef);
			const artifactPath = artifactId ? await runtime.sessionManager.getArtifactPath(artifactId) : null;
			if (artifactPath) {
				const preview = (await Bun.file(artifactPath).text()).split("\n")[0] ?? "";
				lines.push(`Preview: ${truncateToWidth(replaceTabs(preview), TRUNCATE_LENGTHS.LINE)}`);
			}
		}
		await runtime.output(lines.join("\n"));
		return;
	}
	const discardMatch = /^discard\s+(\S+)\s+(\d+)$/.exec(args);
	if (discardMatch) {
		const family = resolveContextLineageCandidateFamily(discardMatch[1]!, records);
		const candidate = family?.candidates[Number(discardMatch[2]) - 1];
		if (!family || !candidate) {
			await runtime.output("Usage: /lineage candidate discard <family-id> <candidate-number>");
			return;
		}
		if (candidate.status === "discarded") {
			await runtime.output(`Candidate #${discardMatch[2]} is already discarded.`);
			return;
		}
		appendContextLineageSessionRecord(
			runtime.sessionManager,
			createContextLineageCandidateDiscardRecord({ familyId: family.family.familyId, candidateId: candidate.candidateId }),
		);
		await runtime.output(`Discarded candidate #${discardMatch[2]}; completed artifact evidence remains available.`);
		return;
	}
	const stopMatch = /^stop\s+(\S+)$/.exec(args);
	if (stopMatch) {
		const family = resolveContextLineageCandidateFamily(stopMatch[1]!, records);
		const pending = family?.candidates.filter(candidate => candidate.status === "pending") ?? [];
		if (!family) {
			await runtime.output("Usage: /lineage candidate stop <family-id>");
			return;
		}
		if (pending.length === 0) {
			await runtime.output(`Candidate family ${family.family.familyId} has no pending leaves to stop.`);
			return;
		}
		const stop = createContextLineageCandidateAllocationStopRecord({
			familyId: family.family.familyId,
			candidateIds: pending.map(candidate => candidate.candidateId),
		});
		appendContextLineageSessionRecord(runtime.sessionManager, stop);
		await runtime.output(
			`Stopped future allocation for ${pending.length} pending candidate leaf/leaves in ${family.family.familyId}; completed sidecar artifacts remain available.`,
		);
		return;
	}
	const adjudicateMatch = /^adjudicate\s+(\S+)\s+(artifact:\/\/\S+)\s+::\s+(.+)$/.exec(args);
	if (adjudicateMatch) {
		const family = resolveContextLineageCandidateFamily(adjudicateMatch[1]!, records);
		const reviewIds = adjudicateMatch[3]!.trim().split(/\s+/).filter(Boolean);
		const reviews = reviewIds.map(reviewId => family?.reviews.find(review => review.reviewId === reviewId));
		if (
			!family ||
			reviewIds.length < 2 ||
			new Set(reviewIds).size !== reviewIds.length ||
			reviews.some(review => review === undefined)
		) {
			await runtime.output("Adjudication requires at least two review IDs from one family: /lineage candidate adjudicate <family-id> <rubric-artifact-ref> :: <review-id> <review-id> [<review-id> …]");
			return;
		}
		const rubricContent = await readContextLineageCandidateReviewArtifact(adjudicateMatch[2]!, runtime, "rubric");
		if (rubricContent === undefined) return;
		const reviewContents: string[] = [];
		for (const review of reviews) {
			const content = await readContextLineageCandidateReviewArtifact(review!.reviewArtifactRef, runtime, "review");
			if (content === undefined) return;
			reviewContents.push(content);
		}
		const artifacts = runtime.sessionManager.getArtifactManager();
		if (!artifacts) {
			await runtime.output("Cannot adjudicate candidates: this session has no artifact store.");
			return;
		}
		try {
			const adjudicator = createContextLineageCandidateAdjudicator({
				session: runtime.session,
				saveArtifact: async content =>
					`artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage-candidate-adjudication")}`,
			});
			const result = await adjudicator.run({ rubricContent, reviewContents });
			if (!(await createArtifactManagerContextLineageOutputVerifier(artifacts).verify(result))) {
				throw new Error("candidate adjudication artifact did not verify");
			}
			const adjudication = createContextLineageCandidateAdjudicationRecord({
				familyId: family.family.familyId,
				rubricArtifactRef: adjudicateMatch[2]!,
				reviewArtifactRefs: reviews.map(review => review!.reviewArtifactRef),
				adjudicationArtifactRef: result.artifactRef,
				contentDigest: result.contentDigest,
				evaluatorProfileId: "context-lineage-candidate-adjudication-v1",
			});
			appendContextLineageSessionRecord(runtime.sessionManager, adjudication);
			await runtime.output(
				`Recorded candidate adjudication ${adjudication.adjudicationId} as ${adjudication.adjudicationArtifactRef}; it received only the ${reviews.length} explicitly authorized reviews.`,
			);
		} catch (error) {
			await runtime.output(`Could not adjudicate candidates: ${errorMessage(error)}`);
		}
		return;
	}
	const approveMatch = /^approve\s+(\S+)\s+(\d+)\s+(\S+)$/.exec(args);
	if (approveMatch) {
		const family = resolveContextLineageCandidateFamily(approveMatch[1]!, records);
		const candidate = family?.candidates[Number(approveMatch[2]) - 1];
		const selection = family?.selections.find(record => record.selectionId === approveMatch[3] && record.candidateId === candidate?.candidateId);
		const plan = family
			? records.find((record): record is LineagePlanRecord => record.kind === "plan" && record.planId === family.family.planId)
			: undefined;
		const sourceCheckpoint = plan
			? records.find(
					(record): record is LineageCheckpointRecord =>
						record.kind === "logical_checkpoint" && record.checkpoint.checkpointId === plan.checkpointId,
				)?.checkpoint
			: undefined;
		const sourceStage = plan?.plan.stages.find(stage => stageTasks(stage).some(task => task.id === candidate?.taskId));
		const sourceTask = sourceStage?.mode === "fanout"
			? sourceStage.tasks.find(task => task.id === candidate?.taskId)
			: sourceStage?.mode === "single" && sourceStage.task.id === candidate?.taskId
				? sourceStage.task
				: undefined;
		const completion = candidate
			? records.find(
					(record): record is Extract<ContextLineageSessionRecord, { kind: "candidate_completed" }> =>
						record.kind === "candidate_completed" &&
						record.familyId === family?.family.familyId &&
						record.candidateId === candidate.candidateId &&
						record.artifactRef === candidate.artifactRef,
				)
			: undefined;
		if (!family || !candidate || !selection || !plan || !sourceCheckpoint || !sourceStage || !sourceTask?.output || !completion) {
			await runtime.output(
				"Approval requires a completed selected candidate mapped to a named persisted plan output: /lineage candidate approve <family-id> <candidate-number> <selection-id>",
			);
			return;
		}
		const artifacts = runtime.sessionManager.getArtifactManager();
		if (!artifacts || !(await createArtifactManagerContextLineageOutputVerifier(artifacts).verify(completion))) {
			await runtime.output("Approved candidate artifact is missing or no longer matches its persisted digest.");
			return;
		}
		const approval = createContextLineageCandidateCheckpointRecord({
			familyId: family.family.familyId,
			candidateId: candidate.candidateId,
			selectionId: selection.selectionId,
			planId: plan.planId,
			sourceCheckpoint,
			output: {
				stageId: sourceStage.id,
				taskId: sourceTask.id,
				outputName: sourceTask.output.name,
				contentDigest: completion.contentDigest,
				artifactRef: completion.artifactRef,
			},
		});
		appendContextLineageSessionRecord(runtime.sessionManager, { version: 1, kind: "logical_checkpoint", checkpoint: approval.checkpoint });
		appendContextLineageSessionRecord(runtime.sessionManager, approval);
		await runtime.output(
			`Approved candidate #${approveMatch[2]} as checkpoint ${approval.checkpoint.checkpointId} (${approval.approvalId}). Replay affected descendants with /lineage candidate replay ${approval.approvalId} <run-id>.`,
		);
		return;
	}
	const replayMatch = /^replay\s+(\S+)\s+(\S+)$/.exec(args);
	if (replayMatch) {
		const approval = records.find(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "candidate_checkpoint" }> =>
				record.kind === "candidate_checkpoint" && record.approvalId === replayMatch[1],
		);
		const priorExecution = records.find(
			(record): record is LineageExecutionRecord =>
				record.kind === "execution" && record.runId === replayMatch[2] && record.stageId === undefined && record.status === "completed",
		);
		const plan = approval
			? records.find((record): record is LineagePlanRecord => record.kind === "plan" && record.planId === approval.planId)
			: undefined;
		const manifest = plan ? findManifestFor(records, plan.manifestId) : undefined;
		const artifacts = runtime.sessionManager.getArtifactManager();
		if (!approval || !priorExecution || !plan || !manifest || !artifacts || priorExecution.planId !== plan.planId) {
			await runtime.output("Replay requires an approved candidate checkpoint and a completed run of its source plan: /lineage candidate replay <approval-id> <run-id>");
			return;
		}
		try {
			const replay = createContextLineageCandidateCheckpointReplay({
				plan: plan.plan,
				approvedCheckpoint: approval,
				priorOutputs: priorExecution.outputs,
			});
			const runner = createSideRequestContextLineageTaskRunner({
				session: runtime.session,
				saveArtifact: async content => `artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage")}`,
			});
			const outcome = await executeContextLineagePlan({
				manifest,
				checkpoint: approval.checkpoint,
				plan: plan.plan,
				journal: runtime.sessionManager,
				runner,
				outputVerifier: createArtifactManagerContextLineageOutputVerifier(artifacts),
				originLeafId: runtime.sessionManager.getLeafId() ?? undefined,
				resume: { completedStageIds: replay.completedStageIds, outputs: replay.outputs },
			});
			await runtime.output(
				`Candidate replay ${outcome.status}: reran only ${replay.replayedStageIds.join(", ")} from approved checkpoint ${approval.checkpoint.checkpointId}.`,
			);
		} catch (error) {
			await runtime.output(`Could not replay approved candidate: ${errorMessage(error)}`);
		}
		return;
	}
	const reviewMatch = /^review\s+(\S+)\s+(\d+)\s+(artifact:\/\/\S+)$/.exec(args);
	if (reviewMatch) {
		const family = resolveContextLineageCandidateFamily(reviewMatch[1]!, records);
		const candidate = family?.candidates[Number(reviewMatch[2]) - 1];
		if (!family || !candidate || candidate.status !== "completed" || !candidate.artifactRef) {
			await runtime.output("Review requires a completed candidate: /lineage candidate review <family-id> <candidate-number> <rubric-artifact-ref>");
			return;
		}
		const candidateContent = await readContextLineageCandidateReviewArtifact(
			candidate.artifactRef,
			runtime,
			"candidate",
		);
		const rubricContent = await readContextLineageCandidateReviewArtifact(reviewMatch[3]!, runtime, "rubric");
		if (candidateContent === undefined || rubricContent === undefined) return;
		const artifacts = runtime.sessionManager.getArtifactManager();
		if (!artifacts) {
			await runtime.output("Cannot review candidate: this session has no artifact store.");
			return;
		}
		try {
			const reviewer = createBlindedCandidateContextLineageReviewer({
				session: runtime.session,
				saveArtifact: async content =>
					`artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage-candidate-review")}`,
			});
			const result = await reviewer.run({ candidateContent, rubricContent });
			if (!(await createArtifactManagerContextLineageOutputVerifier(artifacts).verify(result))) {
				throw new Error("blinded review artifact did not verify");
			}
			const review = createContextLineageCandidateReviewRecord({
				familyId: family.family.familyId,
				candidateId: candidate.candidateId,
				candidateArtifactRef: candidate.artifactRef,
				rubricArtifactRef: reviewMatch[3]!,
				reviewArtifactRef: result.artifactRef,
				contentDigest: result.contentDigest,
				reviewerProfileId: CONTEXT_LINEAGE_BLINDED_REVIEWER_PROFILE_ID,
			});
			appendContextLineageSessionRecord(runtime.sessionManager, review);
			await runtime.output(
				`Recorded blinded review ${review.reviewId} for candidate #${reviewMatch[2]} as ${review.reviewArtifactRef}; no sibling candidate content or identity was provided to the reviewer.`,
			);
		} catch (error) {
			await runtime.output(`Could not review candidate: ${errorMessage(error)}`);
		}
		return;
	}
	const selectMatch = /^select\s+(\S+)\s+(\d+)\s+(artifact:\/\/\S+)\s+::\s+([^:]+)\s+::\s+(.+)$/.exec(args);
	const selectAdjudicatedMatch = /^select-adjudicated\s+(\S+)\s+(\d+)\s+(\S+)\s+::\s+([^:]+)\s+::\s+(.+)$/.exec(args);
	if (selectAdjudicatedMatch) {
		const family = resolveContextLineageCandidateFamily(selectAdjudicatedMatch[1]!, records);
		const candidate = family?.candidates[Number(selectAdjudicatedMatch[2]) - 1];
		const adjudication = family?.adjudications.find(record => record.adjudicationId === selectAdjudicatedMatch[3]);
		if (!family || !candidate || candidate.status !== "completed" || !candidate.artifactRef || !adjudication) {
			await runtime.output("Adjudication-backed selection requires a completed candidate and same-family adjudication: /lineage candidate select-adjudicated <family-id> <candidate-number> <adjudication-id> :: <evaluator> :: <explanation>");
			return;
		}
		const selection = createContextLineageSelectionRecord({
			candidateId: candidate.candidateId,
			rubricArtifactRef: adjudication.rubricArtifactRef,
			visibleEvidence: [candidate.artifactRef, adjudication.adjudicationArtifactRef],
			evaluator: selectAdjudicatedMatch[4]!.trim(),
			explanation: selectAdjudicatedMatch[5]!.trim(),
			adjudicationArtifactRef: adjudication.adjudicationArtifactRef,
			authorizedReviewArtifactRefs: adjudication.reviewArtifactRefs,
		});
		appendContextLineageSessionRecord(runtime.sessionManager, createContextLineageCandidateSelectionSessionRecord({ familyId: family.family.familyId, selection }));
		await runtime.output(`Recorded adjudication-backed candidate selection ${selection.selectionId} for candidate #${selectAdjudicatedMatch[2]}.`);
		return;
	}
	if (selectMatch) {
		const family = resolveContextLineageCandidateFamily(selectMatch[1]!, records);
		const candidate = family?.candidates[Number(selectMatch[2]) - 1];
		if (!family || !candidate || candidate.status !== "completed" || !candidate.artifactRef) {
			await runtime.output("Selection requires a completed candidate: /lineage candidate select <family-id> <candidate-number> <rubric-artifact-ref> :: <evaluator> :: <explanation>");
			return;
		}
		const rubricId = artifactIdFromRef(selectMatch[3]!);
		if (!rubricId || !(await runtime.sessionManager.getArtifactPath(rubricId))) {
			await runtime.output(`Rubric artifact ${selectMatch[3]} is unavailable; selection was not recorded.`);
			return;
		}
		const selection = createContextLineageSelectionRecord({
			candidateId: candidate.candidateId,
			rubricArtifactRef: selectMatch[3]!,
			visibleEvidence: [candidate.artifactRef],
			evaluator: selectMatch[4]!.trim(),
			explanation: selectMatch[5]!.trim(),
		});
		appendContextLineageSessionRecord(
			runtime.sessionManager,
			createContextLineageCandidateSelectionSessionRecord({ familyId: family.family.familyId, selection }),
		);
		await runtime.output(`Recorded blinded candidate selection ${selection.selectionId} for candidate #${selectMatch[2]}.`);
		return;
	}
	const resumeMatch = /^run\s+(\S+)$/.exec(args);
	if (resumeMatch) {
		const family = resolveContextLineageCandidateFamily(resumeMatch[1]!, records);
		if (!family) {
			await runtime.output(`No Context Lineage candidate family matches ${resumeMatch[1]}.`);
			return;
		}
		await runContextLineageCandidates(family.family.familyId, runtime);
		return;
	}
	const runMatch = /^run\s+(\S+)\s+(\S+)\s+::\s+(.+)$/.exec(args);
	if (!runMatch) {
		await runtime.output(
			"Usage: /lineage candidate rubric <bounded evaluation criteria>; /lineage candidate run <plan-id> <task-id> :: reviewer_role/role=security | reviewer_role/role=operations; /lineage candidate run <family-id>; /lineage candidate inspect <family-id> [candidate-number]; /lineage candidate discard <family-id> <candidate-number>; /lineage candidate stop <family-id>; /lineage candidate review <family-id> <candidate-number> <rubric-artifact-ref>; /lineage candidate adjudicate <family-id> <rubric-artifact-ref> :: <review-id> <review-id>; /lineage candidate select <family-id> <candidate-number> <rubric-artifact-ref> :: <evaluator> :: <explanation>; /lineage candidate approve <family-id> <candidate-number> <selection-id>; /lineage candidate replay <approval-id> <run-id>",
		);
		return;
	}
	const planRecord = records.find(
		(record): record is LineagePlanRecord => record.kind === "plan" && record.planId === runMatch[1],
	);
	const task = planRecord?.plan.stages.flatMap(stageTasks).find(candidate => candidate.id === runMatch[2]);
	if (!planRecord || !task) {
		await runtime.output(`Candidate run requires a persisted plan and task: ${runMatch[1]} / ${runMatch[2]}.`);
		return;
	}
	let variations: readonly (readonly ContextLineageCandidateVariation[])[];
	try {
		variations = parseContextLineageCandidateVariations(runMatch[3]!);
	} catch (error) {
		await runtime.output(`Candidate variations rejected: ${errorMessage(error)}`);
		return;
	}
	const candidates = createContextLineageCandidateFamily({ taskId: task.id, assignment: task.assignment, variations });
	const family = createContextLineageCandidateFamilyRecord({
		planId: planRecord.planId,
		checkpointId: planRecord.checkpointId,
		taskId: task.id,
		assignmentDigest: candidates[0]!.assignmentDigest,
		candidates,
	});
	appendContextLineageSessionRecord(runtime.sessionManager, family);
	await runContextLineageCandidates(family.familyId, runtime);
}

async function readContextLineageCandidateReviewArtifact(
	artifactRef: string,
	runtime: Pick<SlashCommandRuntime, "sessionManager" | "output">,
	label: "candidate" | "rubric" | "review",
): Promise<string | undefined> {
	const artifactId = artifactIdFromRef(artifactRef);
	const artifactPath = artifactId ? await runtime.sessionManager.getArtifactPath(artifactId) : null;
	if (!artifactPath) {
		await runtime.output(`${label[0]!.toUpperCase()}${label.slice(1)} artifact ${artifactRef} is unavailable.`);
		return undefined;
	}
	const file = Bun.file(artifactPath);
	if (file.size > MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES) {
		await runtime.output(
			`${label[0]!.toUpperCase()}${label.slice(1)} artifact exceeds the ${MAX_CONTEXT_LINEAGE_CANDIDATE_REVIEW_ARTIFACT_BYTES}-byte blinded-review limit.`,
		);
		return undefined;
	}
	return file.text();
}

function parseContextLineageCandidateVariations(source: string): readonly (readonly ContextLineageCandidateVariation[])[] {
	const leaves = source.split("|").map(value => value.trim()).filter(Boolean);
	if (leaves.length < 2 || leaves.length > MAX_CONTEXT_LINEAGE_CANDIDATE_LEAVES) {
		throw new Error(`Candidate runs require 2-${MAX_CONTEXT_LINEAGE_CANDIDATE_LEAVES} declared leaves`);
	}
	return leaves.map((leaf, leafIndex) => {
		const variations = leaf.split("+").map(value => value.trim()).filter(Boolean).map(value => {
			const match = CANDIDATE_VARIATION_PATTERN.exec(value);
			if (!match || match[3]!.trim().length === 0) {
				throw new Error(`Leaf ${leafIndex + 1} must use label/id=value syntax`);
			}
			return { label: match[1]!.toLowerCase() as ContextLineageCandidateVariation["label"], id: match[2]!, value: match[3]!.trim() };
		});
		if (variations.length === 0) throw new Error(`Leaf ${leafIndex + 1} has no declared variation`);
		return variations;
	});
}

async function runContextLineageCandidates(
	familyId: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	const artifacts = runtime.sessionManager.getArtifactManager();
	if (!artifacts) {
		await runtime.output("Cannot run candidates: this session has no artifact store.");
		return;
	}
	const records = getContextLineageSessionRecords(runtime.sessionManager);
	const family = resolveContextLineageCandidateFamily(familyId, records);
	const plan = family
		? records.find((record): record is LineagePlanRecord => record.kind === "plan" && record.planId === family.family.planId)
		: undefined;
	const task = plan?.plan.stages.flatMap(stageTasks).find(candidate => candidate.id === family?.family.taskId);
	if (!family || !plan || !task) {
		await runtime.output(`Candidate family ${familyId} is missing its persisted plan or task.`);
		return;
	}
	const pending = family.candidates.filter(candidate => candidate.status === "pending");
	if (pending.length === 0) {
		await runtime.output(`Candidate family ${familyId} has no pending leaves.`);
		return;
	}
	const runner = createCandidateContextLineageTaskRunner({
		session: runtime.session,
		saveArtifact: async content => `artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage-candidate")}`,
	});
	const verifier = createArtifactManagerContextLineageOutputVerifier(artifacts);
	let completed = 0;
	const failed: string[] = [];
	for (const candidate of pending) {
		const candidateNumber = family.candidates.findIndex(item => item.candidateId === candidate.candidateId) + 1;
		try {
			const result = await runner.run({ assignment: task.assignment, variation: candidate.variation });
			if (!(await verifier.verify(result))) throw new Error("candidate output artifact did not verify");
			appendContextLineageSessionRecord(
				runtime.sessionManager,
				createContextLineageCandidateCompletionRecord({
					familyId: family.family.familyId,
					candidateId: candidate.candidateId,
					contentDigest: result.contentDigest,
					artifactRef: result.artifactRef,
					executionObservation: {
						elapsedMs: result.elapsedMs ?? 0,
						...(result.usage ? { usage: result.usage } : {}),
					},
				}),
			);
			completed++;
		} catch (error) {
			failed.push(`#${candidateNumber}: ${errorMessage(error)}`);
		}
	}
	await runtime.output(
		`Candidate family ${family.family.familyId}: ${completed}/${pending.length} pending leaf/leaves completed as sidecar artifacts; parent context unchanged.${failed.length > 0 ? ` Failed ${failed.join("; ")}` : ""}`,
	);
}

function findManifestFor(
	records: readonly ContextLineageSessionRecord[],
	manifestId: string,
): RepositoryContextManifest | undefined {
	return records.find(
		(record): record is LineageManifestRecord =>
			record.kind === "repository_manifest" && record.manifest.manifestId === manifestId,
	)?.manifest;
}

/** Recover one source-complete persisted manifest and select it only when its frozen snapshot still matches. */
async function selectPersistedContextLineageBase(
	task: string,
	cwd: string,
	records: readonly ContextLineageSessionRecord[],
	artifacts: ArtifactManager,
) {
	const currentSnapshot = await resolveRepositorySnapshot(cwd);
	const candidates = await Promise.all(
		records
			.filter((record): record is LineagePlanRecord => record.kind === "plan")
			.map(async planRecord => {
				const checkpointRecord = records.find(
					(record): record is LineageCheckpointRecord =>
						record.kind === "logical_checkpoint" && record.checkpoint.checkpointId === planRecord.checkpointId,
				);
				const manifestRecord = records.find(
					(record): record is LineageManifestRecord =>
						record.kind === "repository_manifest" && record.manifest.manifestId === planRecord.manifestId,
				);
				if (!checkpointRecord || !manifestRecord) return undefined;
				const restored = await restoreContextLineageManifest(manifestRecord, artifacts);
				const candidate: ContextLineageBaseSelectionCandidate = {
					planId: planRecord.planId,
					plan: planRecord.plan,
					checkpoint: checkpointRecord.checkpoint,
					manifest: restored.manifest,
					evidenceAvailable: restored.evidenceAvailable,
				};
				return candidate;
			}),
	);
	return selectContextLineageBase({
		task,
		currentSnapshot,
		candidates: candidates.filter((candidate): candidate is ContextLineageBaseSelectionCandidate => candidate !== undefined),
	});
}

async function restoreContextLineageManifest(
	record: LineageManifestRecord,
	artifacts: ArtifactManager,
): Promise<{ manifest: RepositoryContextManifest; evidenceAvailable: boolean }> {
	if (!record.manifestArtifactId) return { manifest: record.manifest, evidenceAvailable: hasInlineManifestEvidence(record.manifest) };
	const artifactPath = await artifacts.getPath(record.manifestArtifactId);
	if (!artifactPath) return { manifest: record.manifest, evidenceAvailable: false };
	try {
		const manifest: unknown = await Bun.file(artifactPath).json();
		if (isRepositoryContextManifest(manifest) && isRepositoryContextManifestIntact(manifest)) {
			return { manifest, evidenceAvailable: true };
		}
	} catch {
		// A missing or malformed local artifact makes the base ineligible; never substitute unverified source bytes.
	}
	return { manifest: record.manifest, evidenceAvailable: false };
}

function hasInlineManifestEvidence(manifest: RepositoryContextManifest): boolean {
	return manifest.evidence.every(evidence => evidence.excerpt === undefined || evidence.excerpt.content !== undefined);
}

/** Show provider observations and durable sidecar state without reading answer bytes. */
async function handleLineageDiagnosticsRequest(
	runId: string,
	runtime: Pick<SlashCommandRuntime, "sessionManager" | "output">,
): Promise<void> {
	const records = getContextLineageSessionRecords(runtime.sessionManager);
	const execution = records.find(
		(record): record is LineageExecutionRecord =>
			record.kind === "execution" && record.runId === runId && record.stageId === undefined,
	);
	if (!execution) {
		await runtime.output("Usage: /lineage diagnostics <run-id>");
		return;
	}
	const plan = records.find(
		(record): record is LineagePlanRecord => record.kind === "plan" && record.planId === execution.planId,
	);
	const baseSelection = [...records]
		.reverse()
		.find(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection" }> =>
				record.kind === "base_selection" &&
				(record.runId === runId ||
					(record.runId === undefined &&
						record.selection.planId === execution.planId && record.selection.checkpointId === execution.checkpointId)),
		);
	const baseSelectionFallback = [...records]
		.reverse()
		.find(
			(record): record is Extract<ContextLineageSessionRecord, { kind: "base_selection_fallback" }> =>
				record.kind === "base_selection_fallback" && record.fallback.runId === runId,
		);
	const cacheCounts = new Map<string, number>();
	let observedRequests = 0;
	let elapsedMs = 0;
	let totalTokens = 0;
	let costUsd = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let uncachedInputTokens = 0;
	for (const output of execution.outputs) {
		const status = output.cacheStatus ?? "unknown";
		cacheCounts.set(status, (cacheCounts.get(status) ?? 0) + 1);
		if (!output.executionObservation) continue;
		observedRequests++;
		elapsedMs += output.executionObservation.elapsedMs;
		totalTokens += output.executionObservation.usage?.totalTokens ?? 0;
		costUsd += output.executionObservation.usage?.costUsd ?? 0;
		cacheReadTokens += output.executionObservation.cacheTokens?.readTokens ?? 0;
		cacheWriteTokens += output.executionObservation.cacheTokens?.writeTokens ?? 0;
		uncachedInputTokens += output.executionObservation.cacheTokens?.uncachedInputTokens ?? 0;
	}
	const cacheSummary = [...cacheCounts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([status, count]) => `${status}: ${count}`)
		.join(", ");
	const cacheReuseOutcome = describeContextLineageCacheReuseOutcome({
		observedRequests,
		cacheCounts,
		cacheReadTokens,
		cacheWriteTokens,
		uncachedInputTokens,
	});
	const selectedBaseRejections = baseSelection ? summarizeBaseSelectionRejections(baseSelection.selection.rejected) : "";
	const baseFallbackReasons = baseSelectionFallback
		? summarizeBaseSelectionRejections(baseSelectionFallback.fallback.rejected)
		: "";
	await runtime.output(
		[
			`Parallel Questions diagnostics for ${runId}:`,
			`- Status: ${execution.status}; outputs: ${execution.outputs.length}; parent context: unchanged (sidecar artifacts only)`,
			`- Checkpoint: ${execution.checkpointId}`,
			`- Plan: ${execution.planId}${plan ? ` (${plan.plan.stages.length} stage(s))` : " (record unavailable)"}`,
			...(baseSelection
				? [
						`- Selected persisted context: ${baseSelection.selection.checkpointId}; expected shared prefix ${baseSelection.selection.expectedSharedBytes} bytes (provider-neutral); ${baseSelection.selection.rejected.length} alternative(s) rejected${selectedBaseRejections ? ` (${selectedBaseRejections})` : ""}.`,
					]
				: baseSelectionFallback
					? [
							`- Context base: fresh manifest; ${baseSelectionFallback.fallback.rejected.length} persisted candidate(s) rejected before dispatch${baseFallbackReasons ? ` (${baseFallbackReasons})` : ""}.`,
						]
					: ["- Context base: no durable reuse selection is available."]),
			`- Provider cache observations: ${cacheSummary || "none recorded"}`,
			`- Measured request accounting: ${observedRequests}/${execution.outputs.length} request(s); ${elapsedMs} ms total; ${totalTokens || "no"} reported tokens; ${costUsd > 0 ? `$${costUsd.toFixed(6)}` : "no reported cost"}.`,
			`- Provider-reported cache tokens: ${cacheReadTokens} read, ${cacheWriteTokens} write, ${uncachedInputTokens} uncached input (never inferred from expected prefix bytes).`,
			`- Provider cache reuse outcome: ${cacheReuseOutcome}.`,
			"- Prefix exactness requires a supported-provider encoded-prefix fixture; inspect Gate E status before interpreting cache observations.",
		].join("\n"),
	);
}

/** Report only provider-observed reuse; expected local prefix size is not cache evidence. */
function describeContextLineageCacheReuseOutcome(input: {
	readonly observedRequests: number;
	readonly cacheCounts: ReadonlyMap<string, number>;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly uncachedInputTokens: number;
}): string {
	if (input.observedRequests === 0) return "not measured (no completed request accounting)";
	if (input.cacheReadTokens > 0 || (input.cacheCounts.get("hit") ?? 0) > 0) {
		return "observed (provider reported cache reuse)";
	}
	const hasProviderCacheSignal =
		input.cacheWriteTokens > 0 ||
		input.uncachedInputTokens > 0 ||
		["write", "miss", "unsupported"].some(status => (input.cacheCounts.get(status) ?? 0) > 0);
	return hasProviderCacheSignal
		? "not observed (provider reported no cache read)"
		: "not measured (provider reported no cache observation)";
}

function summarizeBaseSelectionRejections(rejections: readonly ContextLineageBaseRejection[]): string {
	const counts = new Map<string, number>();
	for (const rejection of rejections) counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([reason, count]) => `${reason}: ${count}`)
		.join(", ");
}

/**
 * Create one explicit reducer over completed fan-out artifacts. The source
 * stages are marked complete for this new run, so selection is durable and no
 * independent question is sent again.
 */
async function handleLineageSynthesisRequest(
	runId: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	const artifacts = runtime.sessionManager.getArtifactManager();
	if (!artifacts) {
		await runtime.output("Cannot synthesize: this session has no artifact store.");
		return;
	}
	const records = getContextLineageSessionRecords(runtime.sessionManager);
	const execution = records.find(
		(record): record is LineageExecutionRecord =>
			record.kind === "execution" && record.runId === runId && record.stageId === undefined,
	);
	if (execution?.status !== "completed") {
		await runtime.output(`No completed Context Lineage run matches ${runId}.`);
		return;
	}
	const planRecord = records.find(
		(record): record is LineagePlanRecord => record.kind === "plan" && record.planId === execution.planId,
	);
	const manifest = planRecord ? findManifestFor(records, planRecord.manifestId) : undefined;
	const checkpoint = records.find(
		(record): record is LineageCheckpointRecord =>
			record.kind === "logical_checkpoint" && record.checkpoint.checkpointId === execution.checkpointId,
	)?.checkpoint;
	if (!planRecord || !manifest || !checkpoint) {
		await runtime.output(`Run ${runId} is missing its persisted plan, manifest, or checkpoint.`);
		return;
	}
	const sourceStageIds = planRecord.plan.stages
		.filter(stage => execution.outputs.some(output => output.stageId === stage.id && output.outputName !== undefined))
		.map(stage => stage.id);
	if (sourceStageIds.length === 0) {
		await runtime.output(
			`Run ${runId} has no named output artifacts to synthesize. It was created before named fan-out outputs were available; rerun it first.`,
		);
		return;
	}
	const synthesisId = `synthesis-${records.filter(record => record.kind === "plan").length + 1}`;
	const synthesisPlan: ContextLineagePlan = {
		...planRecord.plan,
		title: `${planRecord.plan.title} synthesis`,
		stages: [
			...planRecord.plan.stages,
			{
				id: synthesisId,
				mode: "synthesis",
				dependsOn: sourceStageIds,
				capabilityRequirements: { workspaceMode: "frozen_read_only" },
				inputs: sourceStageIds.map(stageId => ({ stageId, selection: "successful" })),
				output: "synthesis",
			},
		],
	};
	const validation = validateContextLineagePlan(synthesisPlan, [manifest]);
	if (!validation.valid) {
		await runtime.output(`Could not synthesize run ${runId}: ${validation.issues[0]?.message ?? "invalid synthesis plan"}`);
		return;
	}
	const synthesisPlanId = contextLineagePlanIdentity(synthesisPlan);
	appendContextLineageSessionRecord(runtime.sessionManager, {
		version: 1,
		kind: "plan",
		plan: synthesisPlan,
		planId: synthesisPlanId,
		manifestId: manifest.manifestId,
		checkpointId: checkpoint.checkpointId,
	});
	const runner = createSideRequestContextLineageTaskRunner({
		session: runtime.session,
		saveArtifact: async content => `artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage")}`,
	});
	try {
		const outcome = await executeContextLineagePlan({
			manifest,
			checkpoint,
			plan: synthesisPlan,
			journal: runtime.sessionManager,
			runner,
			outputVerifier: createArtifactManagerContextLineageOutputVerifier(artifacts),
			originLeafId: runtime.sessionManager.getLeafId() ?? undefined,
			resume: { completedStageIds: planRecord.plan.stages.map(stage => stage.id), outputs: execution.outputs },
		});
		const synthesized = getContextLineageSessionRecords(runtime.sessionManager)
			.filter(
				(record): record is LineageExecutionRecord =>
					record.kind === "execution" && record.runId === outcome.runId && record.stageId === undefined,
			)
			.flatMap(record => record.outputs)
			.find(output => output.stageId === synthesisId);
		await runtime.output(
			`Synthesis ${outcome.status}: ${synthesized?.artifactRef ?? "no verified synthesis artifact"}. Original answers remain sidecar artifacts and were not rerun.`,
		);
	} catch (error) {
		await runtime.output(`Could not synthesize run ${runId}: ${errorMessage(error)}`);
	}
}

/**
 * FR24 restart recovery for persisted plans: recover the failed run's
 * manifest/checkpoint/plan and completed stages from session records, then
 * execute only the unfinished stages through the side-request runner.
 */
async function handleLineagePlanResume(
	runId: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
	artifactsOk: boolean,
): Promise<void> {
	if (!artifactsOk) {
		await runtime.output("Cannot resume: this session has no artifact store.");
		return;
	}
	const records = getContextLineageSessionRecords(runtime.sessionManager);
	const failedRun = records.find(
		(record): record is LineageExecutionRecord =>
			record.kind === "execution" && record.runId === runId && record.stageId === undefined,
	);
	if (failedRun?.status !== "failed") {
		await runtime.output(`No failed Context Lineage run matches ${runId}.`);
		return;
	}
	const planRecord = records.find(
		(record): record is LineagePlanRecord => record.kind === "plan" && record.planId === failedRun.planId,
	);
	const manifestRecord = planRecord
		? records.find(
				(record): record is LineageManifestRecord =>
					record.kind === "repository_manifest" && record.manifest.manifestId === planRecord.manifestId,
			)
		: undefined;
	const checkpointRecord = planRecord
		? records.find(
				(record): record is LineageCheckpointRecord =>
					record.kind === "logical_checkpoint" && record.checkpoint.checkpointId === failedRun.checkpointId,
			)
		: undefined;
	if (!planRecord || !manifestRecord || !checkpointRecord) {
		await runtime.output(`Run ${runId} is missing its persisted plan, manifest, or checkpoint.`);
		return;
	}
	if (!isRepositoryContextManifestIntact(manifestRecord.manifest)) {
		await runtime.output(`Run ${runId}'s manifest no longer matches its identity; recompile instead.`);
		return;
	}
	const completedStageIds = records
		.filter(
			(record): record is LineageExecutionRecord =>
				record.kind === "execution" &&
				record.runId === runId &&
				record.stageId !== undefined &&
				record.status === "completed",
		)
		.map(record => record.stageId!);
	const outputs = records
		.filter(
			(record): record is LineageExecutionRecord =>
				record.kind === "execution" && record.runId === runId && record.stageId !== undefined,
		)
		.flatMap(record => record.outputs);
	const runner = createSideRequestContextLineageTaskRunner({
		session: runtime.session,
		saveArtifact: async content =>
			`artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage")}`,
	});
	const outcome = await executeContextLineagePlan({
		manifest: manifestRecord.manifest,
		checkpoint: checkpointRecord.checkpoint,
		plan: planRecord.plan,
		journal: runtime.sessionManager,
		runner,
		outputVerifier: createArtifactManagerContextLineageOutputVerifier(runtime.sessionManager.getArtifactManager()!),
		concurrency: Number(settings.get("contextLineage.fanout.maxConcurrency")) || undefined,
		originLeafId: runtime.sessionManager.getLeafId() ?? undefined,
		resume: { completedStageIds, outputs },
	});
	await runtime.output(
		`Resumed run ${runId}: ${outcome.status}. Completed stages were not rerun; outputs remain sidecar artifacts.`,
	);
}

/**
 * Execute an already-persisted plan (PR 5): recover its manifest/checkpoint
 * from session records, verify integrity, and dispatch fresh through the
 * side-request runner with staggered warm policy.
 */
async function handleLineagePlanExecute(
	planId: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	const artifacts = runtime.sessionManager.getArtifactManager();
	if (!artifacts) {
		await runtime.output("Cannot execute: this session has no artifact store.");
		return;
	}
	const records = getContextLineageSessionRecords(runtime.sessionManager);
	const planRecord = records.find(
		(record): record is LineagePlanRecord => record.kind === "plan" && record.planId === planId,
	);
	if (!planRecord) {
		await runtime.output(`No persisted Context Lineage plan matches ${planId}.`);
		return;
	}
	const manifestRecord = records.find(
		(record): record is LineageManifestRecord =>
			record.kind === "repository_manifest" && record.manifest.manifestId === planRecord.manifestId,
	);
	const checkpointRecord = records.find(
		(record): record is LineageCheckpointRecord =>
			record.kind === "logical_checkpoint" && record.checkpoint.checkpointId === planRecord.checkpointId,
	);
	if (!manifestRecord || !checkpointRecord) {
		await runtime.output(`Plan ${planId} is missing its persisted manifest or checkpoint.`);
		return;
	}
	if (!isRepositoryContextManifestIntact(manifestRecord.manifest)) {
		await runtime.output("Plan manifest no longer matches its identity; recompile instead.");
		return;
	}
	const runner = createSideRequestContextLineageTaskRunner({
		session: runtime.session,
		saveArtifact: async content =>
			`artifact://${await runtime.sessionManager.saveArtifact(content, "context-lineage")}`,
	});
	const outcome = await executeContextLineagePlan({
		manifest: manifestRecord.manifest,
		checkpoint: checkpointRecord.checkpoint,
		plan: planRecord.plan,
		journal: runtime.sessionManager,
		runner,
		outputVerifier: createArtifactManagerContextLineageOutputVerifier(artifacts),
		warmPolicy: "stagger_first",
		originLeafId: runtime.sessionManager.getLeafId() ?? undefined,
	});
	const answers = getContextLineageSessionRecords(runtime.sessionManager)
		.filter(
			(record): record is LineageExecutionRecord =>
				record.kind === "execution" && record.runId === outcome.runId && record.stageId === undefined,
		)
		.flatMap(record => record.outputs);
	await runtime.output(
		[
			`Executed plan ${planId}: ${outcome.status}.`,
			...answers.map(
				(answer, index) =>
					`${index + 1}. ${answer.taskId} -> ${answer.artifactRef}${answer.cacheStatus ? ` (cache ${answer.cacheStatus})` : ""}`,
			),
			"Inspect with /lineage answers; promote with /lineage promote <run-id> <n>.",
		].join("\n"),
	);
}

/**
 * Named-base surface (PR 9): `list` shows active bases, `<name>` names the
 * most recent checkpoint, `archive <name>` tombstones without deleting.
 */
async function handleLineageBaseRequest(
	args: string,
	runtime: Pick<SlashCommandRuntime, "sessionManager" | "output">,
): Promise<void> {
	const records = getContextLineageSessionRecords(runtime.sessionManager);
	if (args === "list" || args.length === 0) {
		const latestByName = new Map<string, Extract<ContextLineageSessionRecord, { kind: "named_base" }>>();
		for (const record of records) {
			if (record.kind === "named_base") latestByName.set(record.name, record);
		}
		const active = [...latestByName.values()].filter(record => record.status === "active");
		if (active.length === 0) {
			await runtime.output("No named Context Lineage bases. Name one with `/lineage base <name>`.");
			return;
		}
		const lines = active
			.sort((left, right) => left.name.localeCompare(right.name))
			.map(base => `- ${base.name}: ${truncateToWidth(replaceTabs(base.checkpointId), TRUNCATE_LENGTHS.LINE)}`);
		await runtime.output(["Named Context Lineage bases:", ...lines].join("\n"));
		return;
	}
	if (args === "retention") {
		const retention = contextLineageCheckpointRetention(records);
		if (retention.length === 0) {
			await runtime.output("No Context Lineage checkpoints have retention records.");
			return;
		}
		await runtime.output(
			[
				"Context Lineage checkpoint retention:",
				...retention.map(reference => {
					const state = reference.collectable
						? "collectable (logical only; use session deletion for physical cleanup)"
						: "retained";
					return `- ${truncateToWidth(replaceTabs(reference.checkpointId), TRUNCATE_LENGTHS.LINE)}: ${reference.activeNames} active name(s), ${reference.plans} plan(s), ${reference.executions} run(s) — ${state}`;
				}),
			].join("\n"),
		);
		return;
	}
	const archiveMatch = /^archive\s+(\S+)$/.exec(args);
	if (archiveMatch) {
		const name = archiveMatch[1]!;
		try {
			const archived = archiveNamedBaseRecord(name, records);
			appendContextLineageSessionRecord(runtime.sessionManager, archived);
			await runtime.output(`Archived Context Lineage base ${name}.`);
		} catch (error) {
			await runtime.output(`Could not archive base: ${errorMessage(error)}`);
		}
		return;
	}
	const deleteMatch = /^delete\s+(\S+)$/.exec(args);
	if (deleteMatch) {
		const name = deleteMatch[1]!;
		try {
			const deleted = deleteNamedBaseRecord(name, records);
			appendContextLineageSessionRecord(runtime.sessionManager, deleted);
			await runtime.output(`Deleted Context Lineage base name ${name}; retained plans and runs still reference its checkpoint.`);
		} catch (error) {
			await runtime.output(`Could not delete base: ${errorMessage(error)}`);
		}
		return;
	}
	const inspectMatch = /^inspect\s+(\S+)$/.exec(args);
	if (inspectMatch) {
		const name = inspectMatch[1]!;
		const versions = namedBaseVersions(name, records);
		if (versions.length === 0) {
			await runtime.output(`No Context Lineage base named ${name}.`);
			return;
		}
		const retention = contextLineageCheckpointRetention(records);
		const lines = versions.map(version => {
			const refs = retention.find(candidate => candidate.checkpointId === version.checkpointId);
			const state = refs?.collectable ? "collectable" : "retained";
			return `- ${version.status}: ${truncateToWidth(replaceTabs(version.checkpointId), TRUNCATE_LENGTHS.LINE)} (${refs?.activeNames ?? 0} active name(s), ${refs?.plans ?? 0} plan(s), ${refs?.executions ?? 0} run(s); ${state})`;
		});
		await runtime.output([`Context Lineage base ${name}:`, ...lines].join("\n"));
		return;
	}
	const name = args.trim();
	const latestCheckpoint = records
		.filter((record): record is LineageCheckpointRecord => record.kind === "logical_checkpoint")
		.map(record => record.checkpoint.checkpointId)
		.at(-1);
	if (!latestCheckpoint) {
		await runtime.output("No Context Lineage checkpoint is available. Run `/lineage <task>` first.");
		return;
	}
	try {
		const named = createNamedBaseRecord({ name, checkpointId: latestCheckpoint, records });
		appendContextLineageSessionRecord(runtime.sessionManager, named);
		await runtime.output(
			`Named Context Lineage base ${name} -> ${truncateToWidth(replaceTabs(latestCheckpoint), TRUNCATE_LENGTHS.LINE)}`,
		);
	} catch (error) {
		await runtime.output(`Could not name base: ${errorMessage(error)}`);
	}
}

/**
 * PR 7 promotion sink: appends the assignment and sanitized answer under the
 * run's captured origin leaf without changing the active leaf.
 */
async function handleLineagePromoteRequest(
	args: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	const match = /^(\S+)\s+(\d+)$/.exec(args.trim());
	if (!match) {
		await runtime.output("Usage: /lineage promote <run-id> <answer-number>");
		return;
	}
	const [, runId, answerNumberRaw] = match;
	const answerNumber = Number(answerNumberRaw);
	const execution = getContextLineageSessionRecords(runtime.sessionManager).find(
		(record): record is LineageExecutionRecord =>
			record.kind === "execution" && record.runId === runId && record.stageId === undefined,
	);
	if (execution?.status !== "completed") {
		await runtime.output(`No completed Context Lineage run matches ${runId}.`);
		return;
	}
	const output = execution.outputs[answerNumber - 1];
	if (!output) {
		await runtime.output(`Run ${runId} has no answer #${answerNumber}.`);
		return;
	}
	if (!execution.originLeafId) {
		await runtime.output(`Run ${runId} was recorded without an origin leaf; promotion would be origin-unsafe.`);
		return;
	}
	const artifactId = artifactIdFromRef(output.artifactRef);
	const artifactPath = artifactId ? await runtime.sessionManager.getArtifactPath(artifactId) : null;
	if (!artifactPath) {
		await runtime.output(`Answer artifact ${output.artifactRef} is missing; cannot promote.`);
		return;
	}
	const answer = await Bun.file(artifactPath).text();
	const sessionManager = runtime.sessionManager;
	const result = await promoteContextLineageResult({
		journal: sessionManager,
		originLeafId: execution.originLeafId,
		assignment: `Promoted answer for ${output.taskId}:`,
		answer,
		answerArtifactRef: output.artifactRef,
		promote: async (assignment, sanitizedAnswer) => {
			const userEntryId = sessionManager.appendMessageToBranch(
				{ role: "user", content: [{ type: "text", text: assignment }], timestamp: Date.now() },
				execution.originLeafId!,
			);
			const assistantEntryId = sessionManager.appendMessageToBranch(
				sanitizeAssistantForReparentedHistory({
					role: "assistant",
					content: [{ type: "text", text: sanitizedAnswer }],
					api: "text",
					provider: "context-lineage",
					model: "sidecar",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				}),
				userEntryId,
			);
			return { sessionId: sessionManager.getSessionId(), leafId: assistantEntryId };
		},
	});
	await runtime.output(
		result.reused
			? `Already promoted (${result.promotionId}); branch leaf ${result.leafId}.`
			: `Promoted to branch leaf ${result.leafId} (${result.promotionId}).`,
	);
}

async function handleWayfinderRequest(
	args: string,
	cwd: string,
	runtime: Pick<SlashCommandRuntime, "session" | "sessionManager" | "output">,
): Promise<void> {
	if (!(await isContextLineageEnabled(runtime))) return;
	const match = /^plan\s+(.+)$/s.exec(args.trim());
	if (!match) {
		await runtime.output("Usage: /wayfinder plan <map-issue-url> <ticket-issue-url> :: <goal> :: <repository task>");
		return;
	}
	const parts = match[1].split("::").map(part => part.trim());
	if (parts.length !== 3 || parts.some(part => part.length === 0)) {
		await runtime.output("Usage: /wayfinder plan <map-issue-url> <ticket-issue-url> :: <goal> :: <repository task>");
		return;
	}
	const issueUrls = parts[0].split(/\s+/);
	if (issueUrls.length !== 2) {
		await runtime.output("Wayfinder planning requires exactly one map issue URL and one ticket issue URL.");
		return;
	}
	try {
		const planned = await planWayfinderContextLineage({
			cwd,
			goal: parts[1],
			mapIssueUrl: issueUrls[0],
			ticketIssueUrl: issueUrls[1],
			task: parts[2],
			journal: runtime.sessionManager,
			generator: createEphemeralRepositoryPlanningSkillGenerator(runtime.session),
		});
		if (!planned.valid) {
			const issue =
				planned.validation.phase === "semantic"
					? planned.validation.result.issues[0]?.message
					: planned.validation.error;
			await runtime.output(`Wayfinder ticket plan rejected: ${issue ?? "unknown validation error"}`);
			return;
		}
		await runtime.output(
			`Persisted Wayfinder ticket plan ${planned.planId} from binding ${planned.prepared.bindingId}. GitHub was read only.`,
		);
	} catch (error) {
		await runtime.output(`Could not plan Wayfinder ticket: ${errorMessage(error)}`);
	}
}

async function handleSessionPinCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	if (session.isStreaming) {
		await output("Cannot pin an account while the session is streaming.");
		return;
	}
	let accountList: SessionOAuthAccountList | undefined;
	try {
		accountList = await session.listCurrentProviderOAuthAccounts();
	} catch (error) {
		await output(`Could not load provider accounts: ${errorMessage(error)}`);
		return;
	}
	if (!accountList) {
		await output("Select a model before pinning a provider account.");
		return;
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
	const providerName = provider?.name ?? accountList.provider;
	const accounts = toSessionPinAccounts(accountList.accounts);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.describeCredentialSource(
			accountList.provider,
			session.sessionId,
		);
		await output(
			source
				? `No stored OAuth accounts for ${providerName}. Current auth comes from ${source}.`
				: `No stored OAuth accounts for ${providerName}. Use /login to add one.`,
		);
		return;
	}

	const selector = arg.trim();
	if (!selector) {
		const lines = [`OAuth accounts for ${providerName}:`];
		for (const account of accounts) {
			lines.push(`${account.position + 1}. ${account.label}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Pin one with `/session pin <number|email|account id>`.");
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(`No ${providerName} account matches "${selector}".`);
		return;
	}
	if (matches.length > 1) {
		await output(
			`"${selector}" matches multiple ${providerName} accounts: ${matches
				.map(account => `${account.position + 1}. ${account.label}`)
				.join(", ")}. Use the account number.`,
		);
		return;
	}
	const account = matches[0];
	if (!account || !session.pinCurrentProviderOAuthAccount(account.credentialId)) {
		await output(`${account?.label ?? selector} is no longer available to pin.`);
		return;
	}
	await output(`Pinned ${account.label} to this session for ${providerName}.`);
}

export const BUILTIN_SESSION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "todo",
		icon: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "expand", description: "Show every phase and task in the HUD" },
			{ name: "collapse", description: "Restore the bounded HUD preview" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "Todos: none";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return `Todos: ${pending + inProgress} open (${inProgress} in progress, ${completed} done)`;
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		icon: "session",
		description: "Session management commands",
		acpDescription: "Show or configure the current session",
		acpInputHint: "[info|delete|pin [account]]",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
			{
				name: "pin",
				description: "Pin the current provider to a stored OAuth account",
				usage: "[account]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			if (verb === "pin") {
				await handleSessionPinCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete|pin [account]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			if (verb === "pin") {
				if (rest) {
					await handleSessionPinCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
					refreshStatusLine(runtime.ctx);
				} else {
					await runtime.ctx.showSessionPinSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus("Usage: /session [info|delete|pin [account]]");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		icon: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) return "Jobs: none";
			return `Jobs: ${snapshot.running.length} running, ${snapshot.recent.length} recent`;
		},
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		icon: "gauge",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		acpInputHint: "[show|reset [account|active]]",
		subcommands: [
			{ name: "show", description: "Show provider usage and limits" },
			{ name: "reset", description: "Spend a saved Codex rate-limit reset", usage: "[account|active]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /usage [show|reset [account|active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /usage [show|reset [account|active]]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "stats",
		icon: "stats",
		description: "Launch the local stats dashboard",
		inlineHint: "[--port <port>] [--host <host>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output("Syncing session files...");
			try {
				const result = await launchStatsDashboard(parsed);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(`Stats dashboard failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
	},
	{
		name: "changelog",
		icon: "news",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: "Show complete changelog" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		icon: "keyboard",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		icon: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0 ? "Tools: none available" : `Tools: ${active} active / ${all} available`;
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		icon: "context",
		description: "Show estimated context usage breakdown",
		acpDescription: "Show context usage",
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return "Context: unavailable";
			return `Context: ${Math.round(usage.percent)}% (${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)})`;
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "lineage",
		description: "Inspect frozen repository context, or create a validated repository plan",
		acpDescription: "Inspect frozen planning context, or create a validated plan",
		allowArgs: true,
		inlineHint:
			"[status|show [id]|base …|benchmark …|plan <task> [--current-state-only|--unguided|--run]|--run --execute <plan-id>|ask <q1> | <q2>|candidate run|answers|promote|discard|synthesize|diagnostics|<task>]",
		handle: async (command, runtime) => {
			await handleContextLineageRequest(command.args, runtime.cwd, runtime);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			if (command.args.trim() === "candidate board") {
				runtime.ctx.showContextLineageCandidateBoard();
				runtime.ctx.editor.setText("");
				return;
			}
			await handleContextLineageRequest(command.args, runtime.ctx.sessionManager.getCwd(), {
				session: runtime.ctx.session,
				sessionManager: runtime.ctx.sessionManager,
				output: text => runtime.ctx.showStatus(text),
			});
		},
	},
	{
		name: "fanout",
		description: "Ask 2–5 independent questions from one frozen checkpoint",
		acpDescription: "Run parallel questions from one frozen checkpoint",
		allowArgs: true,
		inlineHint: "board|<question 1> | <question 2> [| …] [--resume <run-id>]",
		handle: async (command, runtime) => {
			if (command.args.trim() === "board") {
				await runtime.output("The Parallel Questions board is available in the interactive terminal. Use `/lineage answers` here.");
				return commandConsumed();
			}
			await handleFanoutRequest(command.args, runtime.cwd, runtime);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			if (command.args.trim() === "board") {
				runtime.ctx.showContextLineageBoard();
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			void handleFanoutRequest(command.args, runtime.ctx.sessionManager.getCwd(), {
				session: runtime.ctx.session,
				sessionManager: runtime.ctx.sessionManager,
				output: text => runtime.ctx.showStatus(text),
			});
		},
	},
	{
		name: "wayfinder",
		description: "Plan a Wayfinder tracker ticket from frozen repository evidence",
		allowArgs: true,
		inlineHint: "plan <map-url> <ticket-url> :: <goal> :: <task>",
		handle: async (command, runtime) => {
			await handleWayfinderRequest(command.args, runtime.cwd, runtime);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			await handleWayfinderRequest(command.args, runtime.ctx.sessionManager.getCwd(), {
				session: runtime.ctx.session,
				sessionManager: runtime.ctx.sessionManager,
				output: text => runtime.ctx.showStatus(text),
			});
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		icon: "extension",
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		icon: "agents",
		description: "Open the agents hub (per-agent model, prewalk, and advisor)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "git",
		icon: "branch",
		description: "Open the git UI (split diff viewer, staging, commit composer)",
		inlineHint: "[revision]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			runtime.ctx.showGitUi(command.args.trim() || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		icon: "branch",
		description: "Create a new branch from a previous message",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		icon: "branch",
		description: "Create a new fork from a previous message",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		icon: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		icon: "signIn",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? `Login: waiting for ${runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth"} callback`
				: "Login: choose provider",
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		icon: "signOut",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`Unknown OAuth provider: ${providerId}`);
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		icon: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
];
