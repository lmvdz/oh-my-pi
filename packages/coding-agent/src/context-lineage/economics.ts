/**
 * Measured-cost economics (PRD §20.4–§20.5). These are reporting helpers over
 * observed usage: expected compatibility and provider-observed reuse stay
 * separate facts, and ambiguous accounting yields undefined rather than a claim.
 */

/** Inputs to the fan-out shared-prefix cost comparison. */
export interface FanoutCostModel {
	/** Shared prefix tokens S paid by every branch without reuse. */
	readonly sharedTokens: number;
	/** Branch count N. */
	readonly branchCount: number;
	/** Observed number of cache-writing branches k. */
	readonly writerCount: number;
	/** Cache-write price multiplier w. */
	readonly cacheWriteMultiplier: number;
	/** Cache-read price multiplier r. */
	readonly cacheReadMultiplier: number;
	/** Ordinary input price p per token. */
	readonly inputPricePerToken: number;
}

export interface FanoutSharedCost {
	/** N × S × p — every branch pays the full shared prefix. */
	readonly uncached: number;
	/** k × S × w × p + (N − k) × S × r × p — observed cached shared cost. */
	readonly observedCached: number;
	/** observedCached − uncached; negative means reuse saved money. */
	readonly delta: number;
}

/**
 * Compare uncached fan-out shared cost with the observed cached cost
 * (§20.4). Unique suffix and output tokens are added separately by callers;
 * this isolates the shared-prefix economics.
 */
export function fanoutSharedCost(model: FanoutCostModel): FanoutSharedCost {
	const { sharedTokens, branchCount, writerCount, cacheWriteMultiplier, cacheReadMultiplier, inputPricePerToken } =
		model;
	if (writerCount > branchCount) {
		throw new Error("Fan-out cost model writer count cannot exceed branch count");
	}
	const uncached = branchCount * sharedTokens * inputPricePerToken;
	const observedCached =
		writerCount * sharedTokens * cacheWriteMultiplier * inputPricePerToken +
		(branchCount - writerCount) * sharedTokens * cacheReadMultiplier * inputPricePerToken;
	return { uncached, observedCached, delta: observedCached - uncached };
}

/** One stage's contribution to the counterfactual serialization cost (§20.5). */
export interface PlanReuseObservation {
	readonly stageId: string;
	readonly taskCount: number;
	/** Tokens this stage's tasks actually shared via the compiled base. */
	readonly sharedTokens: number;
}

export interface PlanInducedReuseComparison {
	/** Shared tokens placed at the common ancestor, counted once per stage family. */
	readonly sharedTokensAtAncestors: number;
	/** Counterfactual: every task independently serializes all required context. */
	readonly counterfactualTokens: number;
	/** Compiled execution: shared tokens plus per-task unique work. */
	readonly compiledTokens: number;
	/** counterfactualTokens − compiledTokens; negative means the plan added tokens. */
	readonly delta: number;
}

/**
 * Plan-induced reuse (§20.5): compare compiled execution against the
 * counterfactual where every task independently serializes all required
 * context. Ambiguous accounting is the caller's responsibility to exclude —
 * do not claim savings when the counterfactual is unclear.
 */
export function planInducedReuse(input: {
	readonly observations: readonly PlanReuseObservation[];
	/** Unique per-task tokens (assignments, schemas, outputs) in the compiled run. */
	readonly uniqueTokensPerTask: number;
}): PlanInducedReuseComparison {
	const sharedTokensAtAncestors = input.observations.reduce((total, stage) => total + stage.sharedTokens, 0);
	const taskCount = input.observations.reduce((total, stage) => total + stage.taskCount, 0);
	// Counterfactual: each of the T tasks pays its stage's shared context alone.
	const counterfactualTokens = input.observations.reduce(
		(total, stage) => total + stage.taskCount * stage.sharedTokens,
		0,
	);
	const compiledTokens = sharedTokensAtAncestors + taskCount * input.uniqueTokensPerTask;
	return {
		sharedTokensAtAncestors,
		counterfactualTokens,
		compiledTokens,
		delta: counterfactualTokens - compiledTokens,
	};
}
