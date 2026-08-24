import { canonicalJson, semanticIdentity } from "./identity";
import type { ContextLineagePlan, PlanStage } from "./types";
import { stageBaseId } from "./types";
import type { ContextLineageValidationOptions } from "./validation";

/** Provider/model/rendering target a prepared prefix is compiled for. */
export interface LineageTargetDescriptor {
	readonly provider: string;
	readonly model: string;
	readonly rendererContractVersion: string;
}

/** One explained group of stages that extend the same prepared prefix (FR19). */
export interface PrefixFamily {
	readonly familyId: string;
	readonly target: LineageTargetDescriptor;
	readonly capabilitySignature: string;
	readonly stageIds: readonly string[];
}

/** A stage that cannot share any family, with the first known divergence (FR20/FR25). */
export interface FamilyDivergence {
	readonly stageId: string;
	readonly reason: string;
}

export interface CompatibilityPartition {
	readonly families: readonly PrefixFamily[];
	readonly divergences: readonly FamilyDivergence[];
}

/**
 * Partition a plan's stages into explained prefix families for one execution
 * target. Stages sharing a base and an identical capability signature join one
 * family; differing requirements form separate families rather than weakening
 * them; requirements unavailable to the caller become explicit divergences.
 */
export function partitionCompatibilityFamilies(input: {
	readonly plan: ContextLineagePlan;
	readonly target: LineageTargetDescriptor;
	readonly options?: ContextLineageValidationOptions;
}): CompatibilityPartition {
	const options = input.options ?? {};
	const families = new Map<string, { stageIds: string[]; capabilitySignature: string }>();
	const divergences: FamilyDivergence[] = [];
	for (const stage of input.plan.stages) {
		const unavailable = firstUnavailableCapability(stage, options);
		if (unavailable) {
			divergences.push({ stageId: stage.id, reason: unavailable });
			continue;
		}
		const signature = capabilitySignature(stage);
		const familyKey = semanticIdentity("prefix-family-key", {
			baseId: stageBaseId(stage) ?? `synthesis:${stage.id}`,
			target: input.target,
			signature,
		});
		const existing = families.get(familyKey);
		if (existing) {
			existing.stageIds.push(stage.id);
			continue;
		}
		families.set(familyKey, { stageIds: [stage.id], capabilitySignature: signature });
	}
	return {
		families: [...families.entries()]
			.map(([familyKey, entry]) => ({
				familyId: semanticIdentity("prefix-family", { key: familyKey }),
				target: input.target,
				capabilitySignature: entry.capabilitySignature,
				stageIds: [...entry.stageIds],
			}))
			.sort((left, right) => left.familyId.localeCompare(right.familyId)),
		divergences: divergences.sort((left, right) => left.stageId.localeCompare(right.stageId)),
	};
}

/** Canonical block-level view of one compiled provider request. */
export interface RequestBlockView {
	readonly kind: string;
	readonly digest: string;
}

export interface PrefixDivergence {
	readonly index: number;
	readonly leftKind?: string;
	readonly rightKind?: string;
	readonly reason: string;
}

/**
 * First-divergence diagnostic (FR3/§12.4): report the earliest provider-visible
 * difference between two compiled request views. Sibling requests legitimately
 * diverge at their leaf boundary; two prepared bases must produce undefined.
 */
export function firstPrefixDivergence(
	left: readonly RequestBlockView[],
	right: readonly RequestBlockView[],
): PrefixDivergence | undefined {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const leftBlock = left[index];
		const rightBlock = right[index];
		if (!leftBlock) {
			// right merely extends the shared prefix; sibling suffixes are expected.
			return undefined;
		}
		if (!rightBlock) {
			return { index, leftKind: leftBlock.kind, reason: "left request extends past the compared prefix" };
		}
		if (leftBlock.kind !== rightBlock.kind) {
			return {
				index,
				leftKind: leftBlock.kind,
				rightKind: rightBlock.kind,
				reason: `block kind changed from ${leftBlock.kind} to ${rightBlock.kind}`,
			};
		}
		if (leftBlock.digest !== rightBlock.digest) {
			return {
				index,
				leftKind: leftBlock.kind,
				rightKind: rightBlock.kind,
				reason: `${leftBlock.kind} block content diverged`,
			};
		}
	}
	return undefined;
}

function capabilitySignature(stage: PlanStage): string {
	const requirements = stage.capabilityRequirements ?? {};
	return canonicalJson({
		securityScope: requirements.securityScope ?? null,
		tools: [...(requirements.tools ?? [])].sort(),
		workspaceMode: requirements.workspaceMode ?? null,
	});
}

function firstUnavailableCapability(stage: PlanStage, options: ContextLineageValidationOptions): string | undefined {
	const requirements = stage.capabilityRequirements ?? {};
	for (const tool of requirements.tools ?? []) {
		if (options.availableTools && !options.availableTools.has(tool)) return `unavailable tool: ${tool}`;
	}
	if (
		requirements.securityScope &&
		options.securityScopes &&
		!options.securityScopes.has(requirements.securityScope)
	) {
		return `unavailable security scope: ${requirements.securityScope}`;
	}
	if (
		requirements.workspaceMode &&
		options.allowedWorkspaceModes &&
		!options.allowedWorkspaceModes.has(requirements.workspaceMode)
	) {
		return `unavailable workspace mode: ${requirements.workspaceMode}`;
	}
	return undefined;
}
