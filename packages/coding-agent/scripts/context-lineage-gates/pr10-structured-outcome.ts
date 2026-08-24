// PR10 structured outcome-corpus measurement. This non-production harness
// generates exactly two isolated candidate declarations, evaluates each in a
// separate clean-room SDK session, and persists raw material only as local
// session artifacts. A manual override is accounting input, never execution.
import {
	CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1,
	type ContextLineageStructuredOutcomeMeasurementOverride,
	contextLineageArtifactContentDigest,
	createCandidateContextLineageTaskRunner,
	createContextLineageEvaluationProvenance,
	evaluateContextLineageStructuredOutcomeMeasurement,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { prompt } from "@oh-my-pi/pi-utils";
import evaluatorPrompt from "../../src/prompts/context-lineage/candidate-structured-outcome-evaluation.md" with {
	type: "text",
};
import type { AgentSession } from "../../src/session/agent-session";

interface CandidateExecution {
	readonly candidateId: string;
	readonly artifactRef: string;
	readonly content: string;
	readonly contentDigest: string;
}

interface EvaluatorExecution {
	readonly artifactRef: string;
	readonly content: string;
	readonly contentDigest: string;
	readonly verdict: "acceptable" | "unacceptable";
}

const corpusCase = selectCorpusCase(process.argv[2]);
const candidateModelPattern = process.argv[3] ?? "gpt-5.4-mini";
const evaluatorModelPattern = process.argv[4] ?? candidateModelPattern;
const overrideArgument = process.argv.slice(5).join(" ").trim() || "stop";

const { session: candidateSession } = await createAgentSession({
	cwd: `${import.meta.dir}/../..`,
	modelPattern: candidateModelPattern,
	thinkingLevel: "off",
	enableLsp: false,
	enableMCP: false,
	disableExtensionDiscovery: true,
});
const { session: evaluatorSession } = await createAgentSession({
	cwd: `${import.meta.dir}/../..`,
	modelPattern: evaluatorModelPattern,
	thinkingLevel: "off",
	enableLsp: false,
	enableMCP: false,
	disableExtensionDiscovery: true,
});

try {
	const candidateModel = candidateSession.model;
	const evaluatorModel = evaluatorSession.model;
	if (!candidateModel || !evaluatorModel)
		throw new Error("PR10 structured outcome gate requires resolved candidate and evaluator models");
	if (!candidateSession.sessionManager.getArtifactManager())
		throw new Error("PR10 structured outcome gate requires a persistent session artifact store");
	const saveArtifact = async (content: string, toolType: string): Promise<string> => {
		const artifactId = await candidateSession.sessionManager.saveArtifact(content, toolType);
		if (!artifactId) throw new Error("PR10 structured outcome gate could not persist an authorized session artifact");
		return `artifact://${artifactId}`;
	};
	const candidateRunner = createCandidateContextLineageTaskRunner({
		session: candidateSession,
		saveArtifact: content => saveArtifact(content, "context-lineage-pr10-structured-candidate"),
	});
	const candidateVariations = [
		[
			{
				id: "declaration_strategy",
				label: "candidate",
				value: "enumerate required obligations and reject forbidden obligations",
			},
		],
		[
			{
				id: "declaration_strategy",
				label: "candidate",
				value: "validate the immutable contract before emitting the declaration",
			},
		],
	] as const;
	const candidateExecutions = await Promise.all(
		candidateVariations.map(async (variation, index) => {
			const execution = await candidateRunner.run({
				assignment: "",
				variation,
				structuredOutcomeCase: {
					outcomeCaseId: corpusCase.caseId,
					requiredObligationIds: corpusCase.requiredObligationIds,
					forbiddenObligationIds: corpusCase.forbiddenObligationIds,
				},
			});
			const content = await readArtifact(candidateSession, execution.artifactRef);
			return {
				candidateId: `candidate-${index + 1}`,
				artifactRef: execution.artifactRef,
				content,
				contentDigest: contextLineageArtifactContentDigest(content),
			} satisfies CandidateExecution;
		}),
	);
	const rubricContent = JSON.stringify({
		caseId: corpusCase.caseId,
		requiredObligationIds: corpusCase.requiredObligationIds,
		forbiddenObligationIds: corpusCase.forbiddenObligationIds,
	});
	const rubricArtifactRef = await saveArtifact(rubricContent, "context-lineage-pr10-structured-rubric");
	const evaluatorExecutions = await Promise.all(
		candidateExecutions.map(candidate =>
			evaluateCandidate(evaluatorSession, candidate.content, corpusCase, saveArtifact),
		),
	);
	const override = parseOverride(overrideArgument, candidateExecutions);
	const provenance = createContextLineageEvaluationProvenance({
		candidate: { provider: candidateModel.provider, model: candidateModel.id },
		evaluator: { provider: evaluatorModel.provider, model: evaluatorModel.id },
		isolation: "separate-session",
		profileId: corpusCase.caseId,
		continuationPolicy: "manual-measurement-only",
	});
	const report = evaluateContextLineageStructuredOutcomeMeasurement({
		corpusCase,
		override,
		candidates: candidateExecutions.map((candidate, index) => {
			const evaluator = evaluatorExecutions[index]!;
			return {
				candidateId: candidate.candidateId,
				candidateArtifactRef: candidate.artifactRef,
				candidateContentDigest: candidate.contentDigest,
				candidateContent: candidate.content,
				evaluatorArtifactRef: evaluator.artifactRef,
				evaluatorContentDigest: evaluator.contentDigest,
				evaluatorVerdict: evaluator.verdict,
			};
		}),
	});
	const reportArtifactRef = await saveArtifact(
		JSON.stringify({
			provenance,
			rubricArtifactRef,
			rubricContentDigest: contextLineageArtifactContentDigest(rubricContent),
			report,
		}),
		"context-lineage-pr10-structured-report",
	);
	await verifyArtifactIntegrity(
		candidateSession,
		rubricArtifactRef,
		rubricContent,
		candidateExecutions,
		evaluatorExecutions,
		reportArtifactRef,
	);
	await candidateSession.sessionManager.ensureOnDisk();
	const sessionFile = candidateSession.sessionManager.getSessionFile();
	if (!sessionFile || !(await Bun.file(sessionFile).exists()))
		throw new Error("PR10 structured outcome gate could not durably retain its session artifacts");
	console.log(
		`PR10 structured measurement=${report.measurementId} case=${report.caseId} corpusCase=${report.corpusCaseId}`,
	);
	console.log(
		`session=${sessionFile} report=${reportArtifactRef} rubricDigest=${contextLineageArtifactContentDigest(rubricContent)}`,
	);
	console.log(
		`override=${override.kind === "candidate" ? `candidate ${override.candidateId}` : "stop"} evaluator=${provenance.evaluatorProfileId}`,
	);
	console.log(
		`disagreement=${report.evaluatorVsDeterministicDisagreementCandidateIds.length} falseAcceptance=${report.evaluatorFalseAcceptanceCandidateIds.length} falseRejection=${report.evaluatorFalseRejectionCandidateIds.length} falsePruning=${report.falsePruning} unnecessaryContinuation=${report.unnecessaryContinuationCandidateIds.length} malformed=${report.candidates.filter(candidate => candidate.structuredOutcomeStatus === "malformed").length} unknownObligation=${report.candidates.filter(candidate => candidate.structuredOutcomeStatus === "unknown_obligation").length}`,
	);
	console.log(
		"Measurement only: the manual override did not invoke continuation, pruning, scheduling, or workspace changes.",
	);
} finally {
	await evaluatorSession.dispose();
	await candidateSession.dispose();
}

async function evaluateCandidate(
	session: AgentSession,
	candidateContent: string,
	corpusCase: (typeof CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1)[number],
	saveArtifact: (content: string, toolType: string) => Promise<string>,
): Promise<EvaluatorExecution> {
	const response = await session.runEphemeralTurn({
		promptText: prompt.render(evaluatorPrompt, {
			outcomeCaseId: corpusCase.caseId,
			requiredObligationIds: corpusCase.requiredObligationIds,
			forbiddenObligationIds: corpusCase.forbiddenObligationIds,
			candidateContent,
		}),
	});
	return {
		artifactRef: await saveArtifact(response.replyText, "context-lineage-pr10-structured-evaluation"),
		content: response.replyText,
		contentDigest: contextLineageArtifactContentDigest(response.replyText),
		verdict: parseEvaluatorVerdict(response.replyText),
	};
}

function parseEvaluatorVerdict(content: string): "acceptable" | "unacceptable" {
	const firstLine = content.split("\n", 1)[0]?.trim().toUpperCase();
	return firstLine === "VERDICT: ACCEPTABLE" ? "acceptable" : "unacceptable";
}

function parseOverride(
	value: string,
	candidates: readonly CandidateExecution[],
): ContextLineageStructuredOutcomeMeasurementOverride {
	if (value === "stop") return { kind: "stop" };
	const candidateId = value.startsWith("candidate ") ? value.slice("candidate ".length).trim() : "";
	if (!candidateId || !candidates.some(candidate => candidate.candidateId === candidateId)) {
		throw new Error(
			`override must be stop or candidate <id>; available IDs: ${candidates.map(candidate => candidate.candidateId).join(", ")}`,
		);
	}
	return { kind: "candidate", candidateId };
}

function selectCorpusCase(caseId: string | undefined): (typeof CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1)[number] {
	const selected = CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1.find(
		candidate => candidate.caseId === (caseId ?? "capability-isolation"),
	);
	if (!selected)
		throw new Error(
			`case must be one of: ${CONTEXT_LINEAGE_PR10_OUTCOME_CORPUS_V1.map(candidate => candidate.caseId).join(", ")}`,
		);
	return selected;
}

async function readArtifact(session: AgentSession, artifactRef: string): Promise<string> {
	const artifactId = artifactRef.startsWith("artifact://") ? artifactRef.slice("artifact://".length) : "";
	const artifactPath = artifactId ? await session.sessionManager.getArtifactPath(artifactId) : null;
	if (!artifactPath) throw new Error("PR10 structured outcome artifact could not be recovered from its session");
	return Bun.file(artifactPath).text();
}

async function verifyArtifactIntegrity(
	session: AgentSession,
	rubricArtifactRef: string,
	rubricContent: string,
	candidates: readonly CandidateExecution[],
	evaluators: readonly EvaluatorExecution[],
	reportArtifactRef: string,
): Promise<void> {
	if (
		contextLineageArtifactContentDigest(await readArtifact(session, rubricArtifactRef)) !==
		contextLineageArtifactContentDigest(rubricContent)
	) {
		throw new Error("PR10 structured outcome rubric artifact no longer matches its digest");
	}
	for (const candidate of candidates) {
		if (
			contextLineageArtifactContentDigest(await readArtifact(session, candidate.artifactRef)) !==
			candidate.contentDigest
		) {
			throw new Error("PR10 structured outcome candidate artifact no longer matches its digest");
		}
	}
	for (const evaluator of evaluators) {
		if (
			contextLineageArtifactContentDigest(await readArtifact(session, evaluator.artifactRef)) !==
			evaluator.contentDigest
		) {
			throw new Error("PR10 structured outcome evaluator artifact no longer matches its digest");
		}
	}
	if (!(await readArtifact(session, reportArtifactRef)))
		throw new Error("PR10 structured outcome report artifact is missing");
}
