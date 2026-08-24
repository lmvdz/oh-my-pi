import { prompt } from "@oh-my-pi/pi-utils";
import repositoryPlanPrompt from "../prompts/context-lineage/repository-plan.md" with { type: "text" };
import repositoryPlanRepairPrompt from "../prompts/context-lineage/repository-plan-repair.md" with { type: "text" };
import repositoryPlanUnguidedPrompt from "../prompts/context-lineage/repository-plan-unguided.md" with { type: "text" };
import type { RepositoryPlanningBenchmarkClaims, UnguidedPlanningClaimsGenerator } from "./benchmark";
import { isRepositoryContextManifestIntact, renderRepositoryContextManifest } from "./manifest";
import { stageTasks, type ContextLineagePlan, type PlanStage, type PlanTask, type RepositoryContextManifest } from "./types";
import {
	type ContextLineageValidationOptions,
	type ContextLineageValidationResult,
	validateContextLineagePlan,
} from "./validation";

export interface RepositoryPlanningSkillRequest {
	readonly task: string;
	readonly manifest: RepositoryContextManifest;
}

export interface RepositoryPlanningSkillGenerator {
	generate(prompt: string): Promise<string>;
}

/** Minimal read-only model boundary for planning from a frozen manifest. */
export interface EphemeralRepositoryPlanningSession {
	runEphemeralTurn(args: {
		readonly promptText: string;
		readonly signal?: AbortSignal;
	}): Promise<{ readonly replyText: string }>;
}

export type RepositoryPlanningSkillResponse =
	| { readonly valid: true; readonly plan: ContextLineagePlan }
	| { readonly valid: false; readonly error: string };

export type RepositoryPlanningSkillValidation =
	| { readonly valid: false; readonly phase: "manifest"; readonly error: string }
	| { readonly valid: false; readonly phase: "parse"; readonly error: string; readonly response: string }
	| {
			readonly valid: boolean;
			readonly phase: "semantic";
			readonly plan: ContextLineagePlan;
			readonly result: ContextLineageValidationResult;
			/** Persist only through an explicit artifact sink, never session history. */
			readonly response: string;
	  };

/** Adapt an existing side-channel model turn without changing cache routing or session history. */
export function createEphemeralRepositoryPlanningSkillGenerator(
	session: EphemeralRepositoryPlanningSession,
	signal?: AbortSignal,
): RepositoryPlanningSkillGenerator {
	return {
		async generate(promptText): Promise<string> {
			return (await session.runEphemeralTurn({ promptText, signal })).replyText;
		},
	};
}

/** Create the evidence-free baseline generator used by planning benchmarks. */
export function createEphemeralUnguidedPlanningClaimsGenerator(
	session: EphemeralRepositoryPlanningSession,
	signal?: AbortSignal,
): UnguidedPlanningClaimsGenerator {
	return {
		async generate(task): Promise<RepositoryPlanningBenchmarkClaims> {
			const replyText = (
				await session.runEphemeralTurn({ promptText: renderUnguidedPlanningClaimsRequest(task), signal })
			).replyText;
			return parseUnguidedPlanningClaimsResponse(replyText);
		},
	};
}

/** Render the portable PR3 planning-skill input from immutable repository evidence. */
export function renderRepositoryPlanningSkillRequest(request: RepositoryPlanningSkillRequest): string {
	if (!isRepositoryContextManifestIntact(request.manifest)) {
		throw new Error(`Context Lineage manifest integrity check failed: ${request.manifest.manifestId}`);
	}
	return prompt.render(repositoryPlanPrompt, {
		task: request.task,
		manifestId: request.manifest.manifestId,
		citationCatalog: renderEvidenceCitationCatalog(request.manifest),
		manifest: renderRepositoryContextManifest(request.manifest),
	});
}

function renderEvidenceCitationCatalog(manifest: RepositoryContextManifest): string {
	return manifest.evidence
		.map((evidence, index) => `- E${index + 1} | ${evidence.sourceRef} => ${evidence.evidenceId}`)
		.join("\n");
}

/** Render a task-only baseline request without repository evidence. */
export function renderUnguidedPlanningClaimsRequest(task: string): string {
	return prompt.render(repositoryPlanUnguidedPrompt, { task });
}

/** Source-free, user-facing plan tree for review before side-request execution. */
export function renderContextLineagePlanInspection(plan: ContextLineagePlan): string {
	const lines = [`Context Lineage plan: ${plan.title}`, `Bases: ${plan.bases.map(base => `${base.id} (${base.source.type})`).join(", ")}`];
	for (const stage of plan.stages) {
		lines.push(`- ${stage.id} [${stage.mode}]${stage.dependsOn?.length ? ` after ${stage.dependsOn.join(", ")}` : ""}`);
		for (const task of stageTasks(stage)) {
			lines.push(`  - ${task.id}: ${task.assignment}`);
			for (const evidence of task.evidence ?? []) {
				lines.push(`    evidence: ${evidence.manifestId}/${evidence.evidenceId} (${evidence.purpose})`);
			}
			for (const assumption of task.unresolvedAssumptions ?? []) {
				lines.push(`    inspect: ${assumption.requiredInspection} (${assumption.statement})`);
			}
		}
		if (stage.mode === "synthesis") {
			lines.push(`  output: ${stage.output}; inputs: ${stage.inputs.map(input => input.stageId).join(", ")}`);
		}
	}
	return lines.join("\n");
}

/** Parse the task-only baseline's normalized planning claims. */
export function parseUnguidedPlanningClaimsResponse(response: string): RepositoryPlanningBenchmarkClaims {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonResponseContent(response));
	} catch {
		throw new Error("unguided planning response must be valid JSON");
	}
	if (!isRepositoryPlanningBenchmarkClaims(parsed)) {
		throw new Error("unguided planning response must contain scope and verification string arrays");
	}
	return { scope: [...new Set(parsed.scope)].sort(), verification: [...new Set(parsed.verification)].sort() };
}

/** Parse only a structurally valid plan; semantic evidence and DAG checks remain separate. */
export function parseRepositoryPlanningSkillResponse(response: string): RepositoryPlanningSkillResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonResponseContent(response));
	} catch {
		return { valid: false, error: "planning response must be valid JSON" };
	}
	return isContextLineagePlan(parsed)
		? { valid: true, plan: parsed }
		: { valid: false, error: "planning response does not match the ContextLineagePlan structure" };
}

/** Parse a skill response and immediately enforce manifest-scoped plan semantics. */
export function validateRepositoryPlanningSkillResponse(
	response: string,
	manifests: readonly RepositoryContextManifest[],
	options: ContextLineageValidationOptions = {},
): RepositoryPlanningSkillValidation {
	if (manifests.some(manifest => !isRepositoryContextManifestIntact(manifest))) {
		return { valid: false, phase: "manifest", error: "repository manifest integrity check failed" };
	}
	const parsed = parseRepositoryPlanningSkillResponse(response);
	if (!parsed.valid) return { valid: false, phase: "parse", error: parsed.error, response };
	const plan = canonicalizeEvidenceReferences(parsed.plan, manifests);
	const result = validateContextLineagePlan(plan, manifests, {
		...options,
		allowedBaseSourceTypes: new Set(["repository_manifest"]),
		allowedWorkspaceModes: new Set(["frozen_read_only"]),
	});
	const issues = [...result.issues];
	for (const stage of plan.stages) {
		if (stage.capabilityRequirements?.workspaceMode !== "frozen_read_only") {
			issues.push({
				path: `stages.${stage.id}.capabilities.workspaceMode`,
				message: "repository planning requires frozen_read_only workspace mode",
			});
		}
	}
	return {
		valid: issues.length === 0,
		phase: "semantic",
		plan,
		result: { valid: issues.length === 0, issues },
		response,
	};
}

/**
 * Boundary normalization for real planners (Gate B usability): a reference is
 * valid when it cites the manifest's semantic evidenceId, but models often cite
 * the human-readable path instead. When the cited value equals exactly one
 * evidence item's sourceRef, rewrite it onto that item's identity. This is
 * identifier equivalence — selection authority still comes from the frozen
 * manifest, and genuinely unknown references still fail validation.
 */
function canonicalizeEvidenceReferences(
	plan: ContextLineagePlan,
	manifests: readonly RepositoryContextManifest[],
): ContextLineagePlan {
	const refBySource = new Map<string, { manifestId: string; evidenceId: string }>();
	const refByEvidenceId = new Map<string, { manifestId: string; evidenceId: string } | undefined>();
	const refByAlias = new Map<string, { manifestId: string; evidenceId: string } | undefined>();
	for (const manifest of manifests) {
		for (const [index, item] of manifest.evidence.entries()) {
			const evidenceReference = { manifestId: manifest.manifestId, evidenceId: item.evidenceId };
			if (!refBySource.has(item.sourceRef)) {
				refBySource.set(item.sourceRef, evidenceReference);
			}
			refByEvidenceId.set(
				item.evidenceId,
				refByEvidenceId.has(item.evidenceId) ? undefined : evidenceReference,
			);
			const alias = `E${index + 1}`;
			refByAlias.set(alias, refByAlias.has(alias) ? undefined : evidenceReference);
		}
	}
	let changed = false;
	const rewriteTask = (task: PlanTask): PlanTask => {
		if (!task.evidence?.length) return task;
		const evidence = task.evidence.map(reference => {
			const declared = evidenceIdsByManifest(manifests).get(reference.manifestId);
			if (declared?.has(reference.evidenceId)) return reference;
			const match =
				refBySource.get(reference.evidenceId) ??
				refByEvidenceId.get(reference.evidenceId) ??
				refByAlias.get(reference.evidenceId);
			if (!match) return reference;
			changed = true;
			return { ...reference, manifestId: match.manifestId, evidenceId: match.evidenceId };
		});
		return { ...task, evidence };
	};
	const stages = plan.stages.map(stage => {
		if (stage.mode === "fanout") return { ...stage, tasks: stage.tasks.map(rewriteTask) };
		if (stage.mode === "single") return { ...stage, task: rewriteTask(stage.task) };
		return stage;
	});
	return changed ? { ...plan, stages } : plan;
}

function evidenceIdsByManifest(
	manifests: readonly RepositoryContextManifest[],
): ReadonlyMap<string, ReadonlySet<string>> {
	return new Map(manifests.map(manifest => [manifest.manifestId, new Set(manifest.evidence.map(e => e.evidenceId))]));
}

/** Invoke an injected planning generator and return only its manifest-validated result. */
export async function runRepositoryPlanningSkill(
	request: RepositoryPlanningSkillRequest,
	generator: RepositoryPlanningSkillGenerator,
	options: ContextLineageValidationOptions = {},
): Promise<RepositoryPlanningSkillValidation> {
	if (!isRepositoryContextManifestIntact(request.manifest)) {
		return { valid: false, phase: "manifest", error: "repository manifest integrity check failed" };
	}
	const response = await generator.generate(renderRepositoryPlanningSkillRequest(request));
	const validation = validateRepositoryPlanningSkillResponse(response, [request.manifest], options);
	if (validation.phase !== "parse") return validation;
	const repairedResponse = await generator.generate(
		prompt.render(repositoryPlanRepairPrompt, { manifestId: request.manifest.manifestId, response }),
	);
	return validateRepositoryPlanningSkillResponse(repairedResponse, [request.manifest], options);
}

function isContextLineagePlan(value: unknown): value is ContextLineagePlan {
	if (!isRecord(value) || value.version !== 1 || typeof value.title !== "string") return false;
	if (!Array.isArray(value.bases) || !value.bases.every(isPlanBase)) return false;
	if (!Array.isArray(value.stages) || !value.stages.every(isPlanStage)) return false;
	return value.metadata === undefined || (isRecord(value.metadata) && isStringRecord(value.metadata));
}

function jsonResponseContent(response: string): string {
	const trimmed = response.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
	return fenced?.[1] ?? trimmed;
}

function isRepositoryPlanningBenchmarkClaims(value: unknown): value is RepositoryPlanningBenchmarkClaims {
	return isRecord(value) && isStringArray(value.scope) && isStringArray(value.verification);
}

function isPlanBase(value: unknown): boolean {
	return isRecord(value) && typeof value.id === "string" && isPlanBaseSource(value.source);
}

function isPlanBaseSource(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "current_checkpoint") return value.leafId === undefined || typeof value.leafId === "string";
	if (value.type === "checkpoint") return typeof value.checkpointId === "string";
	return value.type === "repository_manifest" && typeof value.manifestId === "string";
}

function isPlanStage(value: unknown): value is PlanStage {
	if (!isRecord(value) || typeof value.id !== "string" || !isContextExpression(value.base)) return false;
	if (value.dependsOn !== undefined && !isStringArray(value.dependsOn)) return false;
	if (!isCapabilities(value.capabilityRequirements)) return false;
	if (value.mode === "single") return isPlanTask(value.task);
	return value.mode === "fanout" && Array.isArray(value.tasks) && value.tasks.every(isPlanTask);
}

function isContextExpression(value: unknown): boolean {
	if (!isRecord(value) || typeof value.baseId !== "string") return false;
	if (value.type === "base") return true;
	return value.type === "extension" && Array.isArray(value.inputs) && value.inputs.every(isOutputReference);
}

function isOutputReference(value: unknown): boolean {
	return isRecord(value) && typeof value.stageId === "string" && typeof value.output === "string";
}

function isCapabilities(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	return (
		(value.tools === undefined || isStringArray(value.tools)) &&
		(value.workspaceMode === undefined ||
			["none", "live_read_only", "frozen_read_only", "isolated_write"].includes(value.workspaceMode as string)) &&
		(value.securityScope === undefined || typeof value.securityScope === "string")
	);
}

function isPlanTask(value: unknown): boolean {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.assignment !== "string") return false;
	if (value.evidence !== undefined && (!Array.isArray(value.evidence) || !value.evidence.every(isEvidenceReference)))
		return false;
	if (
		value.unresolvedAssumptions !== undefined &&
		(!Array.isArray(value.unresolvedAssumptions) || !value.unresolvedAssumptions.every(isAssumption))
	)
		return false;
	return value.output === undefined || isOutput(value.output);
}

function isEvidenceReference(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.manifestId === "string" &&
		typeof value.evidenceId === "string" &&
		["scope", "constraint", "dependency", "rationale", "verification"].includes(value.purpose as string)
	);
}

function isAssumption(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.statement === "string" &&
		typeof value.requiredInspection === "string"
	);
}

function isOutput(value: unknown): boolean {
	return (
		isRecord(value) && typeof value.name === "string" && ["text", "markdown", "json"].includes(value.format as string)
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isStringRecord(value: Readonly<Record<string, unknown>>): boolean {
	return Object.values(value).every(item => typeof item === "string");
}
