import type {
	ContextLineagePlan,
	FanoutRequest,
	PlanBaseSource,
	PlanCapabilityRequirements,
	PlanStage,
	PlanTask,
	RepositoryContextManifest,
} from "./types";
import { stageBaseId, stageTasks } from "./types";

export interface ContextLineageValidationIssue {
	readonly path: string;
	readonly message: string;
}

export interface ContextLineageValidationResult {
	readonly issues: readonly ContextLineageValidationIssue[];
	readonly valid: boolean;
}

export interface ContextLineageValidationOptions {
	readonly availableTools?: ReadonlySet<string>;
	readonly securityScopes?: ReadonlySet<string>;
	readonly allowedBaseSourceTypes?: ReadonlySet<PlanBaseSource["type"]>;
	readonly allowedWorkspaceModes?: ReadonlySet<NonNullable<PlanCapabilityRequirements["workspaceMode"]>>;
	/** Known named bases (name → checkpointId); required to validate named_base sources. */
	readonly namedBases?: ReadonlyMap<string, string>;
}

/** Validate the compact parallel-question request before it lowers into a logical plan. */
export function validateFanoutRequest(request: FanoutRequest, maxQuestions = 5): ContextLineageValidationResult {
	const issues: ContextLineageValidationIssue[] = [];
	if (request.questions.length < 2) {
		issues.push({ path: "questions", message: "fanout requests require at least two questions" });
	}
	if (request.questions.length > maxQuestions) {
		issues.push({
			path: "questions",
			message: `first-release fanout supports at most ${maxQuestions} questions (FR10)`,
		});
	}
	if (request.concurrency !== undefined && (!Number.isInteger(request.concurrency) || request.concurrency < 1)) {
		issues.push({ path: "concurrency", message: "concurrency must be a positive integer" });
	}
	const ids = new Set<string>();
	for (const [index, question] of request.questions.entries()) {
		if (question.id) addUnique(ids, question.id, "questions", issues);
		if (question.question.trim().length === 0) {
			issues.push({ path: `questions.${index}`, message: "question must not be empty" });
		}
	}
	return { valid: issues.length === 0, issues };
}

/** Validate the executable subset of the v1 plan contract without dispatching it. */
export function validateContextLineagePlan(
	plan: ContextLineagePlan,
	manifests: readonly RepositoryContextManifest[],
	options: ContextLineageValidationOptions = {},
): ContextLineageValidationResult {
	const issues: ContextLineageValidationIssue[] = [];
	const baseIds = new Set<string>();
	const manifestIds = new Set(manifests.map(manifest => manifest.manifestId));
	const declaredManifestIds = new Set<string>();
	const evidenceIdsByManifest = new Map(
		manifests.map(manifest => [manifest.manifestId, new Set(manifest.evidence.map(evidence => evidence.evidenceId))]),
	);
	if (
		plan.defaults?.failurePolicy &&
		!["continue_independent", "stop_dependents", "stop_plan"].includes(plan.defaults.failurePolicy)
	) {
		issues.push({
			path: "defaults.failurePolicy",
			message: `unknown failure policy: ${plan.defaults.failurePolicy}`,
		});
	}
	if (plan.bases.length === 0) issues.push({ path: "bases", message: "plans require at least one base" });
	if (plan.stages.length === 0) issues.push({ path: "stages", message: "plans require at least one stage" });
	for (const base of plan.bases) {
		if (!addUnique(baseIds, base.id, "bases", issues)) continue;
		if (options.allowedBaseSourceTypes && !options.allowedBaseSourceTypes.has(base.source.type)) {
			issues.push({ path: `bases.${base.id}`, message: `unsupported base source: ${base.source.type}` });
		}
		if (base.source.type === "repository_manifest" && !manifestIds.has(base.source.manifestId)) {
			issues.push({ path: `bases.${base.id}`, message: `unknown repository manifest: ${base.source.manifestId}` });
		}
		if (base.source.type === "repository_manifest") declaredManifestIds.add(base.source.manifestId);
		if (base.source.type === "named_base") {
			const resolved = options.namedBases?.get(base.source.name);
			if (resolved === undefined) {
				issues.push({ path: `bases.${base.id}`, message: `unknown named base: ${base.source.name}` });
			}
		}
	}

	const stageIds = new Set<string>();
	const taskIds = new Set<string>();
	const outputNames = new Set<string>();
	for (const stage of plan.stages) {
		addUnique(stageIds, stage.id, "stages", issues);
		const baseId = stageBaseId(stage);
		if (baseId !== undefined && !baseIds.has(baseId)) {
			issues.push({ path: `stages.${stage.id}.base`, message: `unknown base: ${baseId}` });
		}
		const tasks = stageTasks(stage);
		if (stage.mode === "fanout" && tasks.length < 2) {
			issues.push({ path: `stages.${stage.id}.tasks`, message: "fanout stages require at least two tasks" });
		}
		validateCapabilities(stage.id, stage.capabilityRequirements, options, issues);
		for (const task of tasks) {
			if (task.output) addUnique(outputNames, task.output.name, `stages.${stage.id}.outputs`, issues);
			validateTask(task, plan, stage, taskIds, declaredManifestIds, evidenceIdsByManifest, issues);
		}
		if (stage.mode === "synthesis") {
			addUnique(outputNames, stage.output, `stages.${stage.id}.outputs`, issues);
			if (stage.inputs.length === 0) {
				issues.push({ path: `stages.${stage.id}.inputs`, message: "synthesis stages require at least one input" });
			}
		}
	}

	for (const stage of plan.stages) {
		for (const dependency of stage.dependsOn ?? []) {
			if (!stageIds.has(dependency)) {
				issues.push({ path: `stages.${stage.id}.dependsOn`, message: `unknown stage: ${dependency}` });
			}
		}
		if (stage.mode !== "synthesis" && stage.base.type === "extension") {
			for (const input of stage.base.inputs) {
				const source = byId(plan.stages, input.stageId);
				if (!source || !stageProducesOutput(source, input.output)) {
					issues.push({
						path: `stages.${stage.id}.base.inputs`,
						message: `unknown stage output: ${input.stageId}.${input.output}`,
					});
				}
				if (!(stage.dependsOn ?? []).includes(input.stageId)) {
					issues.push({
						path: `stages.${stage.id}.dependsOn`,
						message: `stage extension must depend on output stage: ${input.stageId}`,
					});
				}
			}
		}
		if (stage.mode === "synthesis") {
			for (const selector of stage.inputs) {
				if (!byId(plan.stages, selector.stageId)) {
					issues.push({
						path: `stages.${stage.id}.inputs`,
						message: `unknown synthesis input stage: ${selector.stageId}`,
					});
				}
				if (!(stage.dependsOn ?? []).includes(selector.stageId)) {
					issues.push({
						path: `stages.${stage.id}.dependsOn`,
						message: `synthesis must depend on input stage: ${selector.stageId}`,
					});
				}
			}
		}
	}
	if (hasCycle(plan.stages)) issues.push({ path: "stages", message: "stage dependencies must form a DAG" });
	return { valid: issues.length === 0, issues };
}

function validateCapabilities(
	stageId: string,
	requirements: PlanStage["capabilityRequirements"],
	options: ContextLineageValidationOptions,
	issues: ContextLineageValidationIssue[],
): void {
	for (const tool of requirements?.tools ?? []) {
		if (options.availableTools && !options.availableTools.has(tool)) {
			issues.push({ path: `stages.${stageId}.capabilities.tools`, message: `unavailable tool: ${tool}` });
		}
	}
	if (
		requirements?.securityScope &&
		options.securityScopes &&
		!options.securityScopes.has(requirements.securityScope)
	) {
		issues.push({
			path: `stages.${stageId}.capabilities.securityScope`,
			message: `unavailable security scope: ${requirements.securityScope}`,
		});
	}
	if (
		requirements?.workspaceMode &&
		options.allowedWorkspaceModes &&
		!options.allowedWorkspaceModes.has(requirements.workspaceMode)
	) {
		issues.push({
			path: `stages.${stageId}.capabilities.workspaceMode`,
			message: `unavailable workspace mode: ${requirements.workspaceMode}`,
		});
	}
}

function validateTask(
	task: PlanTask,
	plan: ContextLineagePlan,
	stage: PlanStage,
	taskIds: Set<string>,
	declaredManifestIds: Set<string>,
	evidenceIdsByManifest: ReadonlyMap<string, ReadonlySet<string>>,
	issues: ContextLineageValidationIssue[],
): void {
	addUnique(taskIds, task.id, `stages.${stage.id}.tasks`, issues);
	for (const reference of task.evidence ?? []) {
		if (!declaredManifestIds.has(reference.manifestId)) {
			issues.push({
				path: `tasks.${task.id}.evidence`,
				message: `manifest is not declared by a plan base: ${reference.manifestId}`,
			});
		} else if (!evidenceIdsByManifest.get(reference.manifestId)?.has(reference.evidenceId)) {
			issues.push({ path: `tasks.${task.id}.evidence`, message: `unknown evidence: ${reference.evidenceId}` });
		}
	}
	if (
		stageRootsInRepositoryManifest(plan, stage) &&
		(task.evidence?.length ?? 0) === 0 &&
		(task.unresolvedAssumptions?.length ?? 0) === 0
	) {
		issues.push({
			path: `tasks.${task.id}`,
			message: "repository-grounded tasks require evidence or an unresolved assumption",
		});
	}
}

function byId(stages: readonly PlanStage[], id: string): PlanStage | undefined {
	return stages.find(stage => stage.id === id);
}

function stageProducesOutput(stage: PlanStage, output: string): boolean {
	if (stage.mode === "synthesis") return stage.output === output;
	return stageTasks(stage).some(task => task.output?.name === output);
}

/** FR51 scopes the evidence-or-assumption rule to stages rooted in a repository manifest base. */
function stageRootsInRepositoryManifest(plan: ContextLineagePlan, stage: PlanStage): boolean {
	const baseId = stageBaseId(stage);
	if (baseId === undefined) return false;
	const base = plan.bases.find(candidate => candidate.id === baseId);
	return base?.source.type === "repository_manifest";
}

function addUnique(ids: Set<string>, id: string, collection: string, issues: ContextLineageValidationIssue[]): boolean {
	if (!ids.has(id)) {
		ids.add(id);
		return true;
	}
	issues.push({ path: collection, message: `duplicate id: ${id}` });
	return false;
}

function hasCycle(stages: readonly PlanStage[]): boolean {
	const byId = new Map(stages.map(stage => [stage.id, stage]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): boolean => {
		if (visiting.has(id)) return true;
		if (visited.has(id)) return false;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) {
			if (byId.has(dependency) && visit(dependency)) return true;
		}
		visiting.delete(id);
		visited.add(id);
		return false;
	};
	return stages.some(stage => visit(stage.id));
}
