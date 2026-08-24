/** PR 12 locality is a bounded tie-breaker, never a replacement for priority or deadlines. */
export interface ContextLineageReadyTask {
	readonly taskId: string;
	readonly semanticPriority: number;
	readonly deadlineAt?: number;
	readonly checkpointId: string;
	readonly localityScore: number;
}

export interface ContextLineageScheduledTask extends ContextLineageReadyTask {
	/** True only when the bounded locality ordering changed this task's baseline position. */
	readonly localityUsed: boolean;
	/** Positions this task was delayed against the semantic-priority/deadline baseline. */
	readonly localityDelaySlots: number;
}

export interface ContextLineageSchedulingOptions {
	/** Zero preserves baseline order; positive values permit only bounded tie-bucket movement. */
	readonly maxLocalityDelaySlots?: number;
}

/**
 * Schedules only within equal-priority, equal-deadline buckets. A locality
 * candidate is accepted only when no task's baseline delay exceeds the caller's
 * declared bound; otherwise that bucket remains in baseline order.
 */
export function scheduleContextLineageReadyTasks(
	tasks: readonly ContextLineageReadyTask[],
	options: ContextLineageSchedulingOptions = {},
): readonly ContextLineageScheduledTask[] {
	const maxLocalityDelaySlots = options.maxLocalityDelaySlots ?? 0;
	if (!Number.isSafeInteger(maxLocalityDelaySlots) || maxLocalityDelaySlots < 0) {
		throw new Error("Context Lineage maxLocalityDelaySlots must be a non-negative safe integer");
	}
	const baseline = [...tasks].sort(compareSemanticBaseline);
	const scheduled: ContextLineageReadyTask[] = [];
	for (const bucket of semanticBuckets(baseline)) {
		const localityCandidate = localityOrder(bucket);
		const candidateDelay = baselineDelays(bucket, localityCandidate);
		scheduled.push(...(candidateDelay.every(delay => delay <= maxLocalityDelaySlots) ? localityCandidate : bucket));
	}
	const baselineIndex = new Map(baseline.map((task, index) => [task.taskId, index]));
	return scheduled.map((task, index) => {
		const originalIndex = baselineIndex.get(task.taskId) ?? index;
		return {
			...task,
			localityUsed: index !== originalIndex,
			localityDelaySlots: Math.max(0, index - originalIndex),
		};
	});
}

function compareSemanticBaseline(left: ContextLineageReadyTask, right: ContextLineageReadyTask): number {
	return (
		right.semanticPriority - left.semanticPriority ||
		(left.deadlineAt ?? Number.POSITIVE_INFINITY) - (right.deadlineAt ?? Number.POSITIVE_INFINITY) ||
		left.taskId.localeCompare(right.taskId)
	);
}

function semanticBuckets(tasks: readonly ContextLineageReadyTask[]): readonly (readonly ContextLineageReadyTask[])[] {
	const buckets: ContextLineageReadyTask[][] = [];
	for (const task of tasks) {
		const last = buckets.at(-1);
		if (
			last === undefined ||
			last[0]!.semanticPriority !== task.semanticPriority ||
			last[0]!.deadlineAt !== task.deadlineAt
		) {
			buckets.push([task]);
		} else {
			last.push(task);
		}
	}
	return buckets;
}

function localityOrder(bucket: readonly ContextLineageReadyTask[]): readonly ContextLineageReadyTask[] {
	const baselineIndex = new Map(bucket.map((task, index) => [task.taskId, index]));
	const scoreByCheckpoint = new Map<string, number>();
	for (const task of bucket) {
		scoreByCheckpoint.set(task.checkpointId, Math.max(scoreByCheckpoint.get(task.checkpointId) ?? 0, task.localityScore));
	}
	return [...bucket].sort((left, right) => {
		const checkpointScoreDelta =
			(scoreByCheckpoint.get(right.checkpointId) ?? 0) - (scoreByCheckpoint.get(left.checkpointId) ?? 0);
		return (
			checkpointScoreDelta ||
			left.checkpointId.localeCompare(right.checkpointId) ||
			right.localityScore - left.localityScore ||
			(baselineIndex.get(left.taskId) ?? 0) - (baselineIndex.get(right.taskId) ?? 0)
		);
	});
}

function baselineDelays(
	baseline: readonly ContextLineageReadyTask[],
	candidate: readonly ContextLineageReadyTask[],
): readonly number[] {
	const baselineIndex = new Map(baseline.map((task, index) => [task.taskId, index]));
	return candidate.map((task, index) => Math.max(0, index - (baselineIndex.get(task.taskId) ?? index)));
}

export interface ConditionalPreparationObservation {
	readonly checkpointId: string;
	readonly preparedAt: number;
	readonly usedAt?: number;
	readonly cancelledAt?: number;
	readonly mode: "observe_only";
}

export interface ConditionalPreparationSummary {
	readonly prepared: number;
	readonly activated: number;
	readonly cancelled: number;
	readonly wasted: number;
}

/** Conditional preparation is tracked but cannot dispatch work in v0.7. */
export function recordConditionalPreparation(input: Omit<ConditionalPreparationObservation, "mode">): ConditionalPreparationObservation {
	if (!Number.isFinite(input.preparedAt)) throw new Error("Conditional preparation preparedAt must be finite");
	if (input.usedAt !== undefined && (!Number.isFinite(input.usedAt) || input.usedAt < input.preparedAt)) {
		throw new Error("Conditional preparation usedAt must be finite and no earlier than preparedAt");
	}
	if (input.cancelledAt !== undefined && (!Number.isFinite(input.cancelledAt) || input.cancelledAt < input.preparedAt)) {
		throw new Error("Conditional preparation cancelledAt must be finite and no earlier than preparedAt");
	}
	if (input.usedAt !== undefined && input.cancelledAt !== undefined) {
		throw new Error("Conditional preparation cannot be both activated and cancelled");
	}
	return { ...input, mode: "observe_only" };
}

/** Reports unused preparation explicitly without authorizing provider work. */
export function summarizeConditionalPreparations(
	observations: readonly ConditionalPreparationObservation[],
	observedAt: number,
): ConditionalPreparationSummary {
	if (!Number.isFinite(observedAt)) throw new Error("Conditional preparation observedAt must be finite");
	let activated = 0;
	let cancelled = 0;
	let wasted = 0;
	for (const observation of observations) {
		if (observation.usedAt !== undefined) activated++;
		else if (observation.cancelledAt !== undefined) cancelled++;
		else if (observation.preparedAt <= observedAt) wasted++;
	}
	return { prepared: observations.length, activated, cancelled, wasted };
}
