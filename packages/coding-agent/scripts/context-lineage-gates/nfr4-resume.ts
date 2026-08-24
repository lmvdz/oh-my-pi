// NFR4/FR24 live recovery probe: phase A starts a two-stage lineage run and
// SIGKILLs the process once the first durable stage-progress record lands;
// phase B reopens the same session file, rebuilds resume state from persisted
// records, and must complete without rerunning the finished stage.

import * as fs from "node:fs";
import {
	type ContextLineagePlan,
	type ContextLineagePriorOutput,
	type ContextLineageTaskExecutionResult,
	createArtifactManagerContextLineageOutputVerifier,
	executeContextLineagePlan,
	getContextLineageSessionRecords,
	lowerFanoutRequest,
	type PlanStage,
	prepareRepositoryContextLineage,
	semanticIdentity,
	type ContextLineageExecutionOutput,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { SessionEntry } from "../../src/session/session-entries";

const repoRoot = "/tmp/opencode/tier2-scip-repo";
const stateDir = "/tmp/opencode/tier2-resume";
const phase = process.argv[2];


function runnerFor(delayMs: number, log: string[]) {
	const artifacts = new ArtifactManager(`${stateDir}/artifacts-${phase}`);
	let seq = 0;
	return {
		async run(request: {
			readonly task: { readonly id: string; readonly assignment: string };
			readonly priorOutputs: readonly ContextLineagePriorOutput[];
			readonly signal: AbortSignal;
		}): Promise<ContextLineageTaskExecutionResult> {
			const reply = `[${request.task.id}] ${request.task.assignment.slice(0, 40)} (prior: ${request.priorOutputs.length})`;
			log.push(request.task.id);
			await Bun.sleep(delayMs + seq++ * 50);
			if (request.signal.aborted) throw new Error("aborted before completion");
			return {
				contentDigest: semanticIdentity("context-lineage-output", reply),
				artifactRef: `artifact://${await artifacts.save(reply, "context-lineage")}`,
			};
		},
	};
}

function twoStagePlan(checkpointId: string): ContextLineagePlan {
	const lowered = lowerFanoutRequest(
		{
			version: 1,
			checkpoint: { type: "checkpoint", checkpointId },
			questions: [{ question: "Summarize snapshot freezing." }, { question: "Summarize manifest identity." }],
		},
		{ type: "checkpoint", checkpointId },
	);
	const loweredFanout = lowered.stages[0];
	if (loweredFanout?.mode !== "fanout") throw new Error("expected fanout stage");
	// Synthesis consumes NAMED outputs, so each question declares one.
	const fanout = {
		...loweredFanout,
		tasks: loweredFanout.tasks.map((task, index) => ({
			...task,
			output: { name: `summary-${index + 1}`, format: "text" as const },
		})),
	};
	const synthesis: PlanStage = {
		id: "synthesis",
		mode: "synthesis",
		dependsOn: [fanout.id],
		capabilityRequirements: { workspaceMode: "frozen_read_only" },
		inputs: [{ stageId: fanout.id, selection: "successful" }],
		instructions: "Merge the two summaries into one paragraph.",
		output: "merged",
	};
	return { ...lowered, title: "Tier2 resume probe", stages: [fanout, synthesis] };
}

if (phase === "phaseA") {
	fs.rmSync(stateDir, { recursive: true, force: true });
	fs.mkdirSync(stateDir, { recursive: true });
	const { session } = await createAgentSession({
		cwd: repoRoot,
		modelPattern: "gpt-5.4-mini",
		thinkingLevel: "off",
		enableLsp: false,
		enableMCP: false,
		disableExtensionDiscovery: true,
		sessionManager: undefined,
	});
	const prepared = await prepareRepositoryContextLineage({
		cwd: repoRoot,
		task: "context lineage snapshot manifest identity validation runtime",
		journal: session.sessionManager,
	});
	const plan = twoStagePlan(prepared.checkpoint.checkpointId);
	console.log("sessionFile:", session.sessionManager.getSessionFile());
	console.log(
		"stages:",
		JSON.stringify(plan.stages.map(st => ({ id: st.id, mode: st.mode, dependsOn: st.dependsOn ?? [] }))),
	);
	fs.writeFileSync(`${stateDir}/meta.json`, JSON.stringify({ sessionFile: session.sessionManager.getSessionFile() }));
	const runPromise = executeContextLineagePlan({
		manifest: prepared.manifest,
		checkpoint: prepared.checkpoint,
		plan,
		journal: session.sessionManager,
		runner: runnerFor(1500, []),
		outputVerifier: createArtifactManagerContextLineageOutputVerifier(
			new ArtifactManager(`${stateDir}/artifacts-phaseA`),
		),
		concurrency: 2,
	});
	// Kill as soon as the resume marker is durable ON DISK (not just in memory).
	const sessionFile = session.sessionManager.getSessionFile()!;
	const poll = setInterval(() => {
		void Bun.file(sessionFile)
			.text()
			.then(content => {
				if (content.includes('"stageId":"questions"')) {
					clearInterval(poll);
					console.log("stage 'questions' durable on disk; SIGKILL now");
					setTimeout(() => process.kill(process.pid, "SIGKILL"), 10);
				}
			})
			.catch(() => undefined);
	}, 50);
	try {
		await runPromise;
		console.log("run completed before kill (unexpected)");
	} catch (error) {
		console.log("phaseA threw:", String(error).slice(0, 200));
		for (const r of getContextLineageSessionRecords(session.sessionManager)) {
			if (r.kind === "execution")
				console.log("record:", JSON.stringify({ kind: r.kind, stageId: r.stageId, status: r.status }));
			if (r.kind === "plan")
				console.log("plan stages:", r.plan?.stages?.map((st: { id: string }) => st.id).join(","));
		}
	}
	process.exit(0);
}

if (phase === "phaseB") {
	const meta = JSON.parse(await Bun.file(`${stateDir}/meta.json`).text()) as { sessionFile: string };
	const entries: SessionEntry[] = [];
	const journal = {
		appendCustomEntry(customType: string, data?: unknown): string {
			entries.push({
				type: "custom",
				id: `e${entries.length + 1}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
			return `e${entries.length}`;
		},
		getBranch: () => entries,
	};
	void journal;
	const recordsFromDisk = (await Bun.file(meta.sessionFile).text())
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as { type?: string; customType?: string; data?: unknown })
		.filter(
			row =>
				row.type === "custom" && typeof row.customType === "string" && row.customType.startsWith("context-lineage"),
		)
		.map(row => row.data as Record<string, unknown> & { kind: string });
	const runRows = recordsFromDisk.filter(row => row.kind === "execution");
	const completedStageRows = runRows.filter(
		row => typeof row.stageId === "string" && row.status === "completed" && Array.isArray(row.outputs),
	);
	const completedStages = [...new Set(completedStageRows.map(row => row.stageId as string))];
	const resumeOutputs = completedStageRows.flatMap(row => row.outputs as ContextLineageExecutionOutput[]);
	const finalRow = runRows.find(row => row.stageId === undefined);
	console.log("recovered from disk:", { completedStages, status: finalRow?.status, planId: finalRow?.planId });

	const { session } = await createAgentSession({
		cwd: repoRoot,
		modelPattern: "gpt-5.4-mini",
		thinkingLevel: "off",
		enableLsp: false,
		enableMCP: false,
		disableExtensionDiscovery: true,
	});
	const manifestRecord = getContextLineageSessionRecords(session.sessionManager).find(
		r => r.kind === "repository_manifest",
	);
	void manifestRecord;
	// Rebuild the same inputs deterministically from the fixture repo.
	const prepared = await prepareRepositoryContextLineage({
		cwd: repoRoot,
		task: "context lineage snapshot manifest identity validation runtime",
		journal: session.sessionManager,
	});
	const plan = twoStagePlan(prepared.checkpoint.checkpointId);
	const log: string[] = [];
	const outcome = await executeContextLineagePlan({
		manifest: prepared.manifest,
		checkpoint: prepared.checkpoint,
		plan,
		journal: session.sessionManager,
		runner: runnerFor(10, log),
		outputVerifier: createArtifactManagerContextLineageOutputVerifier(
			new ArtifactManager(`${stateDir}/artifacts-phaseB`),
		),
		resume: {
			completedStageIds: completedStages,
			outputs: resumeOutputs,
		},
	});
	console.log("phaseB status:", outcome.status);
	console.log("tasks executed in phase B:", log.join(","));
	const reranFinishedStage = log.some(id => id.startsWith("[q]") || id === "question-1" || id === "question-2");
	console.log("finished stage rerun:", reranFinishedStage ? "YES (bad)" : "no (correct)");
	await session.dispose();
	process.exit(0);
}
console.log("usage: tier2-resume.ts phaseA | phaseB");
