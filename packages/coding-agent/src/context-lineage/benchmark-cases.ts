import type { RepositoryPlanningBenchmarkCase } from "./benchmark";

/** PR0 corpus, retained as typed obligations for PR3 comparisons. */
export const CONTEXT_LINEAGE_BENCHMARK_CASES: readonly RepositoryPlanningBenchmarkCase[] = [
	{
		id: "CL-01",
		referenceCommit: "30f92ad986347b38308d856ce17929846a56e3b4",
		task: "Keep date and working-directory context available without invalidating a stable system prompt prefix.",
		requiredScope: [
			"packages/coding-agent/src/system-prompt.ts",
			"packages/coding-agent/src/sdk.ts",
			"packages/coding-agent/src/prompts/system/date-cwd-reminder.md",
			"packages/coding-agent/src/session/agent-session.ts",
			"packages/coding-agent/src/session/date-cwd-reminder.ts",
		],
		requiredVerification: [
			"packages/coding-agent/test/date-cwd-reminder.test.ts",
			"packages/coding-agent/test/agent-session-message-pipeline.test.ts",
			"packages/coding-agent/test/agent-session-tool-rebuild-skip.test.ts",
			"packages/coding-agent/test/system-prompt-dedup.test.ts",
			"packages/coding-agent/test/system-prompt-model.test.ts",
		],
	},
	{
		id: "CL-02",
		referenceCommit: "8dddee7578491c5cc55f5a1d2e72f4de62e1ebf0",
		task: "Preserve referenced artifacts when a session is forked.",
		requiredScope: ["packages/coding-agent/src/session/agent-session.ts"],
		requiredVerification: [
			"packages/coding-agent/test/session/session-manager-fork.test.ts",
			"packages/coding-agent/test/modes/controllers/tan-command-controller.test.ts",
		],
	},
	{
		id: "CL-03",
		referenceCommit: "29e9857a04b4584a88844d43af328e3dbd2ec713",
		task: "Reset Second Thought state at the committed branch transition.",
		requiredScope: ["packages/coding-agent/src/session/agent-session.ts"],
		requiredVerification: ["packages/coding-agent/test/second-thought/integration.test.ts"],
	},
];
