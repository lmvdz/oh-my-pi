import type { ContextLineagePlan, FanoutRequest, PlanBase, PlanTask } from "./types";

/**
 * Deterministically lower a compact parallel-questions request into a one-stage
 * lineage plan (PRD §11.10). Identical requests lower to identical plans; the
 * boundary adds no provider-specific fields, preserves question order, and
 * shares validation with the plan validator: anything rejected by
 * {@link validateFanoutRequest} would also fail plan validation after lowering.
 *
 * Execution hints (concurrency, result policy, cache requirement) ride in plan
 * metadata, which is excluded from semantic plan identity but persisted for the
 * coordinator.
 */
export function lowerFanoutRequest(
	request: FanoutRequest,
	/** Overrides the checkpoint-derived base source (e.g. a frozen repository manifest). */
	resolvedBaseSource?: PlanBase["source"],
): ContextLineagePlan {
	const base: PlanBase = { id: "base", source: resolvedBaseSource ?? lowerCheckpointSource(request.checkpoint) };
	const tasks: PlanTask[] = request.questions.map((question, index) => ({
		id: question.id ?? `question-${index + 1}`,
		assignment: question.question,
		// A durable output name lets a later, explicit synthesis select these
		// sidecar answers without re-running their independent questions.
		output: { name: `answer-${index + 1}`, format: "text" },
	}));
	return {
		version: 1,
		title: request.title ?? "Parallel questions",
		bases: [base],
		stages: [
			{
				id: "questions",
				mode: "fanout",
				base: { type: "base", baseId: base.id },
				capabilityRequirements: { workspaceMode: "frozen_read_only" },
				tasks,
			},
		],
		metadata: {
			...(request.concurrency !== undefined ? { concurrency: String(request.concurrency) } : {}),
			...(request.resultPolicy ? { resultPolicy: request.resultPolicy } : {}),
			...(request.cacheRequirement ? { cacheRequirement: request.cacheRequirement } : {}),
		},
	};
}

function lowerCheckpointSource(checkpoint: FanoutRequest["checkpoint"]): PlanBase["source"] {
	if (checkpoint.type === "current_idle") return { type: "current_checkpoint" };
	if (checkpoint.type === "checkpoint") return { type: "checkpoint", checkpointId: checkpoint.checkpointId };
	return { type: "current_checkpoint", leafId: `${checkpoint.sessionId}:${checkpoint.leafId}` };
}
