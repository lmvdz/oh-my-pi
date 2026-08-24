import { beforeAll, describe, expect, test, vi } from "bun:test";
import {
	contextLineagePlanIdentity,
	createContextLineageCandidateCompletionRecord,
	createContextLineageCandidateFamily,
	createContextLineageCandidateFamilyRecord,
	createContextLineageExecutionRecord,
	createRepositoryManifestCheckpoint,
	getContextLineageSessionRecords,
	lowerFanoutRequest,
	type ContextLineageSessionRecord,
	type RepositoryContextManifest,
	stageTasks,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import {
	ContextLineageBoardComponent,
	ContextLineageCandidateBoardComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/context-lineage-board";
import { registerActiveContextLineageRun, unregisterActiveContextLineageRun } from "../../../src/context-lineage/active-runs";
import { ContextLineageRunController } from "../../../src/context-lineage/run-controller";
import { SelectorController } from "../../../src/modes/controllers/selector-controller";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController Context Lineage board", () => {
	test("does not open Parallel Questions while the parent leaf is busy", () => {
		const showStatus = vi.fn();
		const showOverlay = vi.fn();
		const ctx = {
			session: { isStreaming: true, isCompacting: false, hasPostPromptWork: false },
			showStatus,
			ui: { showOverlay },
		} as unknown as InteractiveModeContext;

		new SelectorController(ctx).showContextLineageBoard();

		expect(showStatus).toHaveBeenCalledWith("Parallel Questions are available from an idle, stable session leaf.");
		expect(showOverlay).not.toHaveBeenCalled();
	});

	test("routes a selected recovered answer to its exact durable command", () => {
		const manifest: RepositoryContextManifest = {
			version: 1,
			manifestId: "manifest-controller-test",
			snapshot: {
				version: 1,
				repositoryId: "repo-controller-test",
				workspaceScopeId: "scope-controller-test",
				headCommit: "abc123",
				untrackedPolicy: "exclude",
			},
			taskDigest: "task-controller-test",
			retrievalPolicyId: "current-state-v1",
			contextRendererVersion: "v1",
			evidence: [
				{
					evidenceId: "evidence-controller-test",
					evidenceClass: "current_structural",
					sourceKind: "file",
					sourceRef: "src/controller.ts",
					sourceVersion: "abc123",
					adapterId: "native",
					adapterSchemaVersion: "v1",
					determinism: "deterministic",
					authority: "current",
					extractionMethod: "read",
					inclusionReason: "controller action contract",
				},
			],
			omissions: [],
			degradedSources: [],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		const plan = lowerFanoutRequest(
			{
				version: 1,
				checkpoint: { type: "current_idle" },
				questions: [{ question: "Recover this durable answer" }, { question: "Keep this sibling isolated" }],
			},
			{ type: "checkpoint", checkpointId: checkpoint.checkpointId },
		);
		const stage = plan.stages[0]!;
		const planId = contextLineagePlanIdentity(plan);
		const records: readonly ContextLineageSessionRecord[] = [
			{ version: 1, kind: "repository_manifest", manifest },
			{ version: 1, kind: "logical_checkpoint", checkpoint },
			{ version: 1, kind: "plan", plan, planId, manifestId: manifest.manifestId, checkpointId: checkpoint.checkpointId },
			createContextLineageExecutionRecord({
				planId,
				checkpointId: checkpoint.checkpointId,
				runId: "run-recovered",
				status: "completed",
				outputs: stageTasks(stage).map((candidate, index) => ({
					stageId: stage.id,
					taskId: candidate.id,
					contentDigest: `answer-digest-${index}`,
					artifactRef: `artifact://answer-${index}`,
				})),
			}),
		];
		let board: ContextLineageBoardComponent | undefined;
		const setText = vi.fn();
		const showOverlay = vi.fn(component => {
			board = component as ContextLineageBoardComponent;
			return { hide: vi.fn() };
		});
		const ctx = {
			session: { isStreaming: false, isCompacting: false, hasPostPromptWork: false, sessionId: "controller-session" },
			sessionManager: {
				getBranch: () => records.map(data => ({ type: "custom" as const, customType: "context-lineage", data })),
			},
			editor: { setText },
			editorContainer: { children: [] },
			ui: { showOverlay, setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		expect(getContextLineageSessionRecords(ctx.sessionManager)).toHaveLength(records.length);
		const controller = new SelectorController(ctx);
		const assertions = [
			["i", "/lineage answers run-recovered"],
			["r", "/fanout --resume run-recovered"],
			["p", "/lineage promote run-recovered 1"],
			["d", "/lineage discard run-recovered 1"],
			["s", "/lineage synthesize run-recovered"],
			["g", "/lineage diagnostics run-recovered"],
		] as const;

		for (const [key, expectedCommand] of assertions) {
			controller.showContextLineageBoard();
			expect(board).toBeDefined();
			expect(board!.render(120).join("\n")).toContain("Recover this durable answer");
			board!.handleInput(key);
			expect(setText).toHaveBeenLastCalledWith(expectedCommand);
		}

		expect(showOverlay).toHaveBeenCalledTimes(assertions.length);

		const activeController = new ContextLineageRunController(plan);
		registerActiveContextLineageRun({
			sessionId: "controller-session",
			runId: "run-active",
			plan,
			controller: activeController,
		});
		try {
			controller.showContextLineageBoard();
			board!.handleInput("x");

			expect(activeController.inspect()).toEqual([
				{ stageId: "questions", taskId: "question-1", state: "cancelled" },
				{ stageId: "questions", taskId: "question-2", state: "queued" },
			]);
			expect(ctx.showStatus).toHaveBeenLastCalledWith("Cancelled Parallel Questions item 1.");
		} finally {
			unregisterActiveContextLineageRun("controller-session", "run-active");
		}
	});

	test("routes recovered Controlled Candidates actions to their durable family", () => {
		const manifest: RepositoryContextManifest = {
			version: 1,
			manifestId: "manifest-candidate-controller-test",
			snapshot: {
				version: 1,
				repositoryId: "repo-candidate-controller-test",
				workspaceScopeId: "scope-candidate-controller-test",
				headCommit: "def456",
				untrackedPolicy: "exclude",
			},
			taskDigest: "task-candidate-controller-test",
			retrievalPolicyId: "current-state-v1",
			contextRendererVersion: "v1",
			evidence: [
				{
					evidenceId: "evidence-candidate-controller-test",
					evidenceClass: "current_structural",
					sourceKind: "file",
					sourceRef: "src/candidate-controller.ts",
					sourceVersion: "def456",
					adapterId: "native",
					adapterSchemaVersion: "v1",
					determinism: "deterministic",
					authority: "current",
					extractionMethod: "read",
					inclusionReason: "candidate controller action contract",
				},
			],
			omissions: [],
			degradedSources: [],
		};
		const checkpoint = createRepositoryManifestCheckpoint(manifest);
		const plan = lowerFanoutRequest(
			{
				version: 1,
				checkpoint: { type: "current_idle" },
				questions: [{ question: "Evaluate candidate replay" }, { question: "Keep sibling comparison isolated" }],
			},
			{ type: "checkpoint", checkpointId: checkpoint.checkpointId },
		);
		const planId = contextLineagePlanIdentity(plan);
		const task = stageTasks(plan.stages[0]!)[0]!;
		const candidates = createContextLineageCandidateFamily({
			taskId: task.id,
			assignment: task.assignment,
			variations: [
				[{ label: "reviewer_role", id: "role", value: "security" }],
				[{ label: "reviewer_role", id: "role", value: "operations" }],
			],
		});
		const family = createContextLineageCandidateFamilyRecord({
			planId,
			checkpointId: checkpoint.checkpointId,
			taskId: task.id,
			assignmentDigest: candidates[0]!.assignmentDigest,
			candidates,
		});
		const records: readonly ContextLineageSessionRecord[] = [
			{ version: 1, kind: "repository_manifest", manifest },
			{ version: 1, kind: "logical_checkpoint", checkpoint },
			{ version: 1, kind: "plan", plan, planId, manifestId: manifest.manifestId, checkpointId: checkpoint.checkpointId },
			family,
			createContextLineageCandidateCompletionRecord({
				familyId: family.familyId,
				candidateId: candidates[0]!.candidateId,
				contentDigest: "candidate-controller-digest",
				artifactRef: "artifact://candidate-controller",
			}),
		];
		let board: ContextLineageCandidateBoardComponent | undefined;
		const setText = vi.fn();
		const showOverlay = vi.fn(component => {
			board = component as ContextLineageCandidateBoardComponent;
			return { hide: vi.fn() };
		});
		const ctx = {
			session: { isStreaming: false, isCompacting: false, hasPostPromptWork: false },
			sessionManager: {
				getBranch: () => records.map(data => ({ type: "custom" as const, customType: "context-lineage", data })),
			},
			editor: { setText },
			editorContainer: { children: [] },
			ui: { showOverlay, setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		expect(getContextLineageSessionRecords(ctx.sessionManager)).toHaveLength(records.length);
		const controller = new SelectorController(ctx);
		const assertions = [
			["u", "/lineage candidate rubric <rubric text>"],
			["i", `/lineage candidate inspect ${family.familyId} 1`],
			["r", `/lineage candidate run ${family.familyId}`],
			["d", `/lineage candidate discard ${family.familyId} 1`],
			["x", `/lineage candidate stop ${family.familyId}`],
			["v", `/lineage candidate review ${family.familyId} 1 <rubric-artifact-ref>`],
			["a", `/lineage candidate adjudicate ${family.familyId} <rubric-artifact-ref> :: <review-id> <review-id>`],
			["s", `/lineage candidate select ${family.familyId} 1 <rubric-artifact-ref> :: <evaluator> :: <explanation>`],
			["p", `/lineage candidate approve ${family.familyId} 1 <selection-id>`],
			["y", "/lineage candidate replay <approval-id> <run-id>"],
		] as const;

		for (const [key, expectedCommand] of assertions) {
			controller.showContextLineageCandidateBoard();
			expect(board).toBeDefined();
			expect(board!.render(120).join("\n")).toContain("reviewer_role/role=security");
			board!.handleInput(key);
			expect(setText).toHaveBeenLastCalledWith(expectedCommand);
		}

		expect(showOverlay).toHaveBeenCalledTimes(assertions.length);
	});
});
