// PR10 live full-depth measurement. This is a non-production harness: it
// executes declared variants through the production no-tools candidate runner,
// persists raw bodies only as local session artifacts, and prints reference-
// and digest-safe aggregate metrics. A fixed continuation index is a measured
// control, never a selection authority or automatic-pruning policy.
import {
	createCandidateContextLineageTaskRunner,
	contextLineageArtifactContentDigest,
	contextLineageEvaluatorInputDigest,
	CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES,
	createContextLineageCandidateFamily,
	createContextLineageEvaluationProvenance,
	evaluateControlledReasoningBenchmark,
	evaluateContextLineageDeclaredOutcome,
	semanticIdentity,
	verifyControlledReasoningArtifactIntegrity,
	type ContextLineageCandidateExecutionObservation,
	type ControlledReasoningCandidateOutcome,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../src/session/agent-session";
import assignment from "../../src/prompts/context-lineage/pr10-live-assignment.md" with { type: "text" };
import adapterAssignment from "../../src/prompts/context-lineage/pr10-live-adapter-assignment.md" with { type: "text" };
import adapterRubric from "../../src/prompts/context-lineage/pr10-live-adapter-rubric.md" with { type: "text" };
import capabilityAssignment from "../../src/prompts/context-lineage/pr10-live-capability-assignment.md" with { type: "text" };
import capabilityRubric from "../../src/prompts/context-lineage/pr10-live-capability-rubric.md" with { type: "text" };
import fullDepthEvaluationPrompt from "../../src/prompts/context-lineage/candidate-full-depth-evaluation.md" with { type: "text" };
import preliminaryEvaluationPrompt from "../../src/prompts/context-lineage/candidate-preliminary-evaluation.md" with { type: "text" };
import recoveryAssignment from "../../src/prompts/context-lineage/pr10-live-recovery-assignment.md" with { type: "text" };
import recoveryRubric from "../../src/prompts/context-lineage/pr10-live-recovery-rubric.md" with { type: "text" };
import rubric from "../../src/prompts/context-lineage/pr10-live-rubric.md" with { type: "text" };

interface LiveSampleResult {
	readonly benchmarkId: string;
	readonly candidateProfileId: string;
	readonly evaluatorProfileId: string;
	readonly sessionFile?: string;
	readonly reportArtifactRef: string;
	readonly falsePruning: boolean;
	readonly unnecessaryContinuation: number;
	readonly declaredFalsePruning?: boolean;
	readonly evaluatorFalseAcceptance?: number;
	readonly evaluatorFalseRejection?: number;
	readonly candidateTokens?: number;
	readonly evaluatorTokens?: number;
	readonly elapsedMs: number;
}

interface LiveCandidateExecution {
	readonly candidateId: string;
	readonly artifactRef: string;
	readonly content: string;
	readonly contentDigest: string;
	readonly observation: ContextLineageCandidateExecutionObservation;
}

interface LiveProfile {
	readonly id: "adapter-authority" | "artifact-copy" | "capability-isolation" | "recovery-replay";
	readonly taskId: string;
	readonly assignment: string;
	readonly rubric: string;
	readonly outcomeProfile: (typeof CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES)[keyof typeof CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES];
}

const LIVE_PROFILES: readonly LiveProfile[] = [
	{ id: "adapter-authority", taskId: "external-adapter-authority", assignment: adapterAssignment, rubric: adapterRubric, outcomeProfile: CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES["adapter-authority"] },
	{ id: "artifact-copy", taskId: "session-artifact-copy", assignment, rubric, outcomeProfile: CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES["artifact-copy"] },
	{ id: "capability-isolation", taskId: "parallel-capability-isolation", assignment: capabilityAssignment, rubric: capabilityRubric, outcomeProfile: CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES["capability-isolation"] },
	{ id: "recovery-replay", taskId: "staged-recovery-replay", assignment: recoveryAssignment, rubric: recoveryRubric, outcomeProfile: CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES["recovery-replay"] },
];

const candidateModelPattern = process.argv[2] ?? "gpt-5.4-mini";
const samples = parseSampleCount(process.argv[3]);
const continuationIndex = parseContinuationIndex(process.argv[4]);
const profile = parseProfile(process.argv[5]);
const continuationPolicy = parseContinuationPolicy(process.argv[6]);
const evaluatorModelPattern = process.argv[7]?.trim() || undefined;

type ContinuationPolicy = "fixed-first" | "preliminary-rubric";

const results: LiveSampleResult[] = [];
for (let sample = 1; sample <= samples; sample++) {
	console.log(
		`PR10 ${profile.id}/${continuationPolicy} sample ${sample}/${samples}: creating candidate session (${candidateModelPattern}) and evaluator (${evaluatorModelPattern ?? "same session"})…`,
	);
	results.push(await runSample());
}
printSummary(results);

async function runSample(): Promise<LiveSampleResult> {
	const { session: candidateSession } = await createAgentSession({
		cwd: import.meta.dir + "/../..",
		modelPattern: candidateModelPattern,
		thinkingLevel: "off",
		enableLsp: false,
		enableMCP: false,
		disableExtensionDiscovery: true,
	});
	let evaluatorSession: AgentSession | undefined;
	try {
		if (evaluatorModelPattern) {
			evaluatorSession = (
				await createAgentSession({
					cwd: import.meta.dir + "/../..",
					modelPattern: evaluatorModelPattern,
					thinkingLevel: "off",
					enableLsp: false,
					enableMCP: false,
					disableExtensionDiscovery: true,
				})
			).session;
		}
		const evaluator = evaluatorSession ?? candidateSession;
		const candidateModel = candidateSession.model;
		if (!candidateModel) throw new Error("PR10 live gate requires a resolved candidate model");
		const evaluatorModel = evaluator.model;
		if (!evaluatorModel) throw new Error("PR10 live gate requires a resolved evaluator model");
		const provenance = createContextLineageEvaluationProvenance({
			candidate: { provider: candidateModel.provider, model: candidateModel.id },
			evaluator: { provider: evaluatorModel.provider, model: evaluatorModel.id },
			isolation: evaluatorSession ? "separate-session" : "same-session",
			profileId: profile.id,
			continuationPolicy,
		});
		const artifacts = candidateSession.sessionManager.getArtifactManager();
		if (!artifacts) throw new Error("PR10 live gate requires a persistent session artifact store");
		const saveArtifact = async (content: string, toolType: string): Promise<string> => {
			const artifactId = await candidateSession.sessionManager.saveArtifact(content, toolType);
			if (!artifactId) throw new Error("PR10 live gate could not persist an authorized session artifact");
			return `artifact://${artifactId}`;
		};
		const candidates = createContextLineageCandidateFamily({
			taskId: profile.taskId,
			assignment: profile.assignment,
			variations: [
				[{ id: "approach", label: "candidate", value: "minimal targeted patch" }],
				[{ id: "approach", label: "candidate", value: "defensive migration and regression plan" }],
			],
		});
		const runner = createCandidateContextLineageTaskRunner({
			session: candidateSession,
			saveArtifact: content => saveArtifact(content, "context-lineage-pr10-candidate"),
		});
		const startedAt = performance.now();
		const executions = await Promise.all(
		candidates.map(async candidate => {
				const result = await runner.run({ assignment: profile.assignment, variation: candidate.variation });
				const artifactId = artifactIdFromRef(result.artifactRef);
				const artifactPath = artifactId ? await candidateSession.sessionManager.getArtifactPath(artifactId) : null;
				if (!artifactPath) throw new Error("PR10 candidate output artifact could not be recovered from its session");
				const content = await Bun.file(artifactPath).text();
				return {
					candidateId: candidate.candidateId,
					artifactRef: result.artifactRef,
					content,
					contentDigest: contextLineageArtifactContentDigest(content),
					observation: { elapsedMs: result.elapsedMs ?? 0, ...(result.usage ? { usage: result.usage } : {}) },
				} satisfies LiveCandidateExecution;
			}),
		);
		const outcomes = await Promise.all(
			executions.map(execution =>
				evaluateFullDepth(evaluator, execution.candidateId, execution.artifactRef, execution.content, execution.contentDigest, profile.rubric, profile.outcomeProfile, saveArtifact),
			),
		);
		const preliminary = continuationPolicy === "preliminary-rubric"
			? await Promise.all(executions.map(execution => evaluatePreliminary(evaluator, execution.candidateId, execution.content, profile.rubric, saveArtifact)))
			: [];
		const continuedCandidateId = preliminary.find(item => item.verdict === "acceptable")?.candidateId ?? candidates[continuationIndex]!.candidateId;
		const rubricArtifactRef = await saveArtifact(profile.rubric, "context-lineage-pr10-rubric");
		const report = evaluateControlledReasoningBenchmark({
			familyId: semanticIdentity("context-lineage-pr10-live-family", candidates.map(candidate => candidate.candidateId)),
			candidates,
			rubricArtifactRef,
			rubricContentDigest: contextLineageArtifactContentDigest(profile.rubric),
			evaluatorProfileId: provenance.evaluatorProfileId,
			continuedCandidateIds: [continuedCandidateId],
			outcomes: outcomes.map(outcome => outcome.outcome),
		});
		await verifyControlledReasoningArtifactIntegrity(report, async artifactRef => {
			const artifactPath = await candidateSession.sessionManager.getArtifactPath(artifactIdFromRef(artifactRef) ?? "");
			return artifactPath ? Bun.file(artifactPath).text() : undefined;
		});
		const reportArtifactRef = await saveArtifact(
			JSON.stringify({ ...provenance, continuationPolicy, continuedCandidateId, preliminary, report }),
			"context-lineage-pr10-report",
		);
		// A fresh SDK session may otherwise have no journal file despite saved
		// artifacts. Flush before reporting the session reference so raw bodies
		// remain recoverable under the authorized local session boundary.
		await candidateSession.sessionManager.ensureOnDisk();
		const sessionFile = candidateSession.sessionManager.getSessionFile();
		if (!sessionFile || !(await Bun.file(sessionFile).exists())) {
			throw new Error("PR10 live gate could not durably retain its session artifacts");
		}
		return {
			benchmarkId: report.benchmarkId,
			...provenance,
			sessionFile,
			reportArtifactRef,
			falsePruning: report.result.falsePruning,
			unnecessaryContinuation: report.result.unnecessaryContinuationCandidateIds.length,
			...(report.result.declaredOutcome === undefined
				? {}
				: {
					declaredFalsePruning: report.result.declaredOutcome.falsePruning,
					evaluatorFalseAcceptance: report.result.declaredOutcome.evaluatorFalseAcceptanceCandidateIds.length,
					evaluatorFalseRejection: report.result.declaredOutcome.evaluatorFalseRejectionCandidateIds.length,
				}),
			...sumObservedUsage(executions.map(execution => execution.observation), outcomes.map(outcome => outcome.observation)),
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	} finally {
		await evaluatorSession?.dispose();
		await candidateSession.dispose();
	}
}

async function evaluatePreliminary(session: AgentSession, candidateId: string, candidateContent: string, rubricContent: string, saveArtifact: (content: string, toolType: string) => Promise<string>): Promise<{ readonly candidateId: string; readonly verdict: "acceptable" | "unacceptable"; readonly artifactRef: string }> {
	const response = await session.runEphemeralTurn({ promptText: prompt.render(preliminaryEvaluationPrompt, { rubricContent, candidateContent }) });
	return { candidateId, verdict: parseVerdict(response.replyText), artifactRef: await saveArtifact(response.replyText, "context-lineage-pr10-preliminary-evaluation") };
}

async function evaluateFullDepth(
	session: AgentSession,
	candidateId: string,
	candidateArtifactRef: string,
	candidateContent: string,
	candidateContentDigest: string,
	rubricContent: string,
	declaredOutcomeProfile: (typeof CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES)[keyof typeof CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES],
	saveArtifact: (content: string, toolType: string) => Promise<string>,
): Promise<{ readonly outcome: ControlledReasoningCandidateOutcome; readonly observation: ContextLineageCandidateExecutionObservation }> {
	const startedAt = performance.now();
	const response = await session.runEphemeralTurn({
		promptText: prompt.render(fullDepthEvaluationPrompt, { rubricContent, candidateContent }),
	});
	const evaluationArtifactRef = await saveArtifact(response.replyText, "context-lineage-pr10-full-depth-evaluation");
	const verdict = parseVerdict(response.replyText);
	return {
		outcome: {
			candidateId,
			artifactRef: candidateArtifactRef,
			candidateContentDigest,
			evaluatorInputDigest: contextLineageEvaluatorInputDigest({
				rubricContentDigest: contextLineageArtifactContentDigest(rubricContent),
				candidateContentDigest,
			}),
			evaluationArtifactRef,
			evaluationContentDigest: contextLineageArtifactContentDigest(response.replyText),
			verdict,
			declaredOutcome: evaluateContextLineageDeclaredOutcome(candidateContent, declaredOutcomeProfile),
		},
		observation: { elapsedMs: Math.round(performance.now() - startedAt), ...(response.usage ? { usage: response.usage } : {}) },
	};
}

function parseVerdict(response: string): "acceptable" | "unacceptable" {
	const firstLine = response.split("\n", 1)[0]?.trim().toUpperCase();
	if (firstLine === "VERDICT: ACCEPTABLE") return "acceptable";
	if (firstLine === "VERDICT: UNACCEPTABLE") return "unacceptable";
	throw new Error("PR10 full-depth evaluator did not return the required verdict line");
}

function artifactIdFromRef(ref: string): string | undefined {
	return ref.startsWith("artifact://") ? ref.slice("artifact://".length) : undefined;
}

function sumObservedUsage(
	candidates: readonly ContextLineageCandidateExecutionObservation[],
	evaluators: readonly ContextLineageCandidateExecutionObservation[],
): { readonly candidateTokens?: number; readonly evaluatorTokens?: number } {
	const sum = (observations: readonly ContextLineageCandidateExecutionObservation[]): number | undefined => {
		if (observations.some(observation => observation.usage === undefined)) return undefined;
		return observations.reduce((total, observation) => total + observation.usage!.totalTokens, 0);
	};
	const candidateTokens = sum(candidates);
	const evaluatorTokens = sum(evaluators);
	return { ...(candidateTokens === undefined ? {} : { candidateTokens }), ...(evaluatorTokens === undefined ? {} : { evaluatorTokens }) };
}

function parseSampleCount(value: string | undefined): number {
	if (value === undefined) return 1;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5) throw new Error("sample count must be a safe integer from 1 through 5");
	return parsed;
}

function parseContinuationIndex(value: string | undefined): number {
	if (value === undefined) return 0;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2) throw new Error("continuation index must be 1 or 2");
	return parsed - 1;
}

function parseProfile(value: string | undefined): LiveProfile {
	const profileId = value ?? "artifact-copy";
	const profile = LIVE_PROFILES.find(candidate => candidate.id === profileId);
	if (!profile) throw new Error(`profile must be one of: ${LIVE_PROFILES.map(candidate => candidate.id).join(", ")}`);
	return profile;
}

function parseContinuationPolicy(value: string | undefined): ContinuationPolicy {
	if (value === undefined || value === "fixed-first") return "fixed-first";
	if (value === "preliminary-rubric") return "preliminary-rubric";
	throw new Error("continuation policy must be fixed-first or preliminary-rubric");
}

function printSummary(results: readonly LiveSampleResult[]): void {
	for (const result of results) {
		console.log(
			`PR10 evaluation ${result.benchmarkId} candidate=${result.candidateProfileId} evaluator=${result.evaluatorProfileId} session=${result.sessionFile ?? "unavailable"} report=${result.reportArtifactRef} falsePruning=${result.falsePruning} unnecessaryContinuation=${result.unnecessaryContinuation} declaredFalsePruning=${result.declaredFalsePruning ?? "unreported"} evaluatorFalseAcceptance=${result.evaluatorFalseAcceptance ?? "unreported"} evaluatorFalseRejection=${result.evaluatorFalseRejection ?? "unreported"} candidateTokens=${result.candidateTokens ?? "unreported"} evaluatorTokens=${result.evaluatorTokens ?? "unreported"} elapsedMs=${result.elapsedMs}`,
		);
	}
	const falsePruning = results.filter(result => result.falsePruning).length;
	const unnecessaryContinuation = results.reduce((total, result) => total + result.unnecessaryContinuation, 0);
	const declaredOutcomeSamples = results.filter(result => result.declaredFalsePruning !== undefined);
	const declaredFalsePruning = declaredOutcomeSamples.filter(result => result.declaredFalsePruning).length;
	const evaluatorFalseAcceptance = results.reduce((total, result) => total + (result.evaluatorFalseAcceptance ?? 0), 0);
	const evaluatorFalseRejection = results.reduce((total, result) => total + (result.evaluatorFalseRejection ?? 0), 0);
	console.log(
		`PR10 full-depth summary: policy=${continuationPolicy} samples=${results.length} falsePruning=${falsePruning}/${results.length} unnecessaryContinuation=${unnecessaryContinuation} declaredFalsePruning=${declaredOutcomeSamples.length === 0 ? "unreported" : `${declaredFalsePruning}/${declaredOutcomeSamples.length}`} evaluatorFalseAcceptance=${evaluatorFalseAcceptance} evaluatorFalseRejection=${evaluatorFalseRejection}. This is measurement only; it does not authorize production pruning.`,
	);
}
