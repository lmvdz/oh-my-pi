import { beforeAll, describe, expect, test } from "bun:test";
import {
	ContextLineageBoardComponent,
	ContextLineageCandidateBoardComponent,
	parseContextLineageQuestionEditorInput,
} from "../../../src/modes/components/context-lineage-board";
import { initTheme } from "../../../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("ContextLineageBoardComponent", () => {
	test("normalizes multiline question-editor input without changing question order", () => {
		expect(parseContextLineageQuestionEditorInput("  first question\n\nsecond question  \r\n third question ")).toEqual([
			"first question",
			"second question",
			"third question",
		]);
	});

	test("keeps durable runs independently navigable and targets actions at the selected run", () => {
		const board = new ContextLineageBoardComponent([
			{
				runId: "run-earlier",
				status: "completed",
				answers: [{ taskId: "one", assignment: "Earlier question", artifactRef: "artifact://1" }],
			},
			{
				runId: "run-latest",
				status: "completed",
				answers: [{ taskId: "two", assignment: "Latest question", artifactRef: "artifact://2" }],
			},
		]);
		const actions: string[] = [];
		board.onAction = (action, run) => actions.push(`${action}:${run.runId}`);

		expect(board.render(120).join("\n")).toContain("Run 2/2 · run-latest");
		board.handleInput("h");
		expect(board.render(120).join("\n")).toContain("Run 1/2 · run-earlier");
		board.handleInput("i");
		board.handleInput("x");

		expect(actions).toEqual(["inspect:run-earlier", "cancel:run-earlier"]);
	});

	test("dispatches every result-management key to the selected durable answer and closes without mutating it", () => {
		const runs = [
			{
				runId: "run-durable",
				status: "completed" as const,
				answers: [
					{ taskId: "one", assignment: "First question", artifactRef: "artifact://1" },
					{ taskId: "two", assignment: "Second question", artifactRef: "artifact://2" },
				],
			},
		];
		const board = new ContextLineageBoardComponent(runs);
		const actions: string[] = [];
		let closed = false;
		board.onAction = (action, run, answerIndex) => actions.push(`${action}:${run.runId}:${answerIndex}`);
		board.onClose = () => {
			closed = true;
		};

		board.handleInput("j");
		for (const key of ["i", "c", "r", "x", "p", "d", "s", "g"]) board.handleInput(key);
		board.handleInput("\u001b");

		expect(actions).toEqual([
			"inspect:run-durable:1",
			"copy:run-durable:1",
			"retry:run-durable:1",
			"cancel:run-durable:1",
			"promote:run-durable:1",
			"discard:run-durable:1",
			"synthesize:run-durable:1",
			"diagnostics:run-durable:1",
		]);
		expect(closed).toBe(true);
		expect(new ContextLineageBoardComponent(runs).render(120).join("\n")).toContain("Second question");
	});

	test("renders candidate artifacts by reference and targets management actions", () => {
		const board = new ContextLineageCandidateBoardComponent([
			{
				familyId: "family-1",
				planId: "plan-1",
				taskId: "review",
				reviewCount: 2,
				adjudicationCount: 1,
				selectionCount: 1,
				candidates: [
					{ candidateId: "candidate-1", status: "completed", variation: "reviewer_role/role=security", artifactRef: "artifact://1" },
					{ candidateId: "candidate-2", status: "discarded", variation: "reviewer_role/role=operations" },
				],
			},
		]);
		const actions: string[] = [];
		board.onAction = (action, family, candidateIndex) => actions.push(`${action}:${family.familyId}:${candidateIndex}`);

		const rendered = board.render(120).join("\n");
		expect(rendered).toContain("reviews 2 · adjudications 1 · selections 1");
		expect(rendered).toContain("artifact://1");
		for (const key of ["u", "i", "c", "r", "d", "x", "v", "a", "s", "p", "y"]) board.handleInput(key);

		expect(actions).toEqual([
			"rubric:family-1:0",
			"inspect:family-1:0",
			"copy:family-1:0",
			"retry:family-1:0",
			"discard:family-1:0",
			"stop:family-1:0",
			"review:family-1:0",
			"adjudicate:family-1:0",
			"select:family-1:0",
			"approve:family-1:0",
			"replay:family-1:0",
		]);
	});
});
