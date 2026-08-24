import { stageTasks, type ContextLineagePlan } from "./types";

export type ContextLineageTaskCancellationState = "queued" | "cancelled";

export interface ContextLineageTaskCancellation {
	readonly stageId: string;
	readonly taskId: string;
	readonly state: ContextLineageTaskCancellationState;
}

/**
 * Stable per-task abort ownership for one validated plan run. The coordinator
 * receives its signals through `taskSignal`; a UI may cancel a queued or
 * running task by its durable stage/task identity without aborting siblings.
 */
export class ContextLineageRunController {
	#controllers = new Map<string, AbortController>();

	constructor(plan: ContextLineagePlan) {
		for (const stage of plan.stages) {
			for (const task of stageTasks(stage)) {
				this.#controllers.set(taskKey(stage.id, task.id), new AbortController());
			}
		}
	}

	taskSignal = (input: { readonly stageId: string; readonly taskId: string }): AbortSignal | undefined =>
		this.#controllers.get(taskKey(input.stageId, input.taskId))?.signal;

	cancel(stageId: string, taskId: string, reason: unknown = "Context Lineage task cancelled"): boolean {
		const controller = this.#controllers.get(taskKey(stageId, taskId));
		if (!controller || controller.signal.aborted) return false;
		controller.abort(reason);
		return true;
	}

	inspect(): readonly ContextLineageTaskCancellation[] {
		return [...this.#controllers.entries()]
			.map(([key, controller]) => {
				const [stageId, taskId] = key.split("\u0000") as [string, string];
				return { stageId, taskId, state: controller.signal.aborted ? ("cancelled" as const) : ("queued" as const) };
			})
			.sort((left, right) => left.stageId.localeCompare(right.stageId) || left.taskId.localeCompare(right.taskId));
	}
}

function taskKey(stageId: string, taskId: string): string {
	return `${stageId}\u0000${taskId}`;
}
