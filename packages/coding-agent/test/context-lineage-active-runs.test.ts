import { afterEach, describe, expect, test } from "bun:test";
import {
	getActiveContextLineageRun,
	getActiveContextLineageRuns,
	registerActiveContextLineageRun,
	unregisterActiveContextLineageRun,
} from "../src/context-lineage/active-runs";
import { ContextLineageRunController } from "../src/context-lineage/run-controller";
import type { ContextLineagePlan } from "../src/context-lineage/types";

const plan: ContextLineagePlan = {
	version: 1,
	title: "Active run",
	bases: [{ id: "repository", source: { type: "repository_manifest", manifestId: "manifest" } }],
	stages: [
		{
			id: "questions",
			mode: "fanout",
			base: { type: "base", baseId: "repository" },
			capabilityRequirements: { workspaceMode: "frozen_read_only" },
			tasks: [{ id: "question", assignment: "Question", evidence: [{ manifestId: "manifest", evidenceId: "evidence", purpose: "scope" }] }],
		},
	],
};

afterEach(() => {
		unregisterActiveContextLineageRun("session-a", "run-a");
});

describe("active Context Lineage runs", () => {
	test("does not expose an active run controller across session boundaries", () => {
		const controller = new ContextLineageRunController(plan);
		registerActiveContextLineageRun({ sessionId: "session-a", runId: "run-a", plan, controller });

		expect(getActiveContextLineageRun("session-b", "run-a")).toBeUndefined();
		expect(getActiveContextLineageRuns("session-b")).toEqual([]);
		expect(getActiveContextLineageRun("session-a", "run-a")?.controller).toBe(controller);
	});

	test("does not let another session unregister an active run", () => {
		const controller = new ContextLineageRunController(plan);
		registerActiveContextLineageRun({ sessionId: "session-a", runId: "run-a", plan, controller });

		unregisterActiveContextLineageRun("session-b", "run-a");

		expect(getActiveContextLineageRun("session-a", "run-a")?.controller).toBe(controller);
	});
});
