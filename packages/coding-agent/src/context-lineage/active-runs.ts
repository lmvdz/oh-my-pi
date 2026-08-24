import type { ContextLineagePlan } from "./types";
import type { ContextLineageRunController } from "./run-controller";

export interface ActiveContextLineageRun {
	readonly sessionId: string;
	readonly runId: string;
	readonly plan: ContextLineagePlan;
	readonly controller: ContextLineageRunController;
}

const activeRuns = new Map<string, ActiveContextLineageRun>();

export function registerActiveContextLineageRun(run: ActiveContextLineageRun): void {
	activeRuns.set(run.runId, run);
}

export function unregisterActiveContextLineageRun(sessionId: string, runId: string): void {
	if (activeRuns.get(runId)?.sessionId === sessionId) activeRuns.delete(runId);
}

export function getActiveContextLineageRun(sessionId: string, runId: string): ActiveContextLineageRun | undefined {
	const run = activeRuns.get(runId);
	return run?.sessionId === sessionId ? run : undefined;
}

export function getActiveContextLineageRuns(sessionId: string): readonly ActiveContextLineageRun[] {
	return [...activeRuns.values()].filter(run => run.sessionId === sessionId);
}
