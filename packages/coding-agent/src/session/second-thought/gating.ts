import type { Api, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveRoleSelection } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";

export type SecondThoughtGateReason =
	| "disabled"
	| "sub-session"
	| "no-primary-model"
	| "primary-model-not-anthropic"
	| "branch-model-not-anthropic";

export interface SecondThoughtGateOptions {
	settings: Settings;
	agentKind: "main" | "sub";
	primaryModel: Model<Api> | undefined;
	availableModels: Model<Api>[];
}

export interface SecondThoughtGateResult {
	allowed: boolean;
	branchModel: Model<Api> | undefined;
	reason?: SecondThoughtGateReason;
}

const loggedGateFailures = new Set<Exclude<SecondThoughtGateReason, "disabled">>();

function isAnthropicApi(model: Model<Api> | undefined): model is Model<Api> {
	return model?.api === "anthropic-messages";
}

function logGateFailureOnce(
	reason: Exclude<SecondThoughtGateReason, "disabled">,
	options: SecondThoughtGateOptions,
): void {
	if (loggedGateFailures.has(reason)) return;
	loggedGateFailures.add(reason);
	logger.debug("Second Thought enabled but unavailable", {
		reason,
		agentKind: options.agentKind,
		primaryModel: options.primaryModel && `${options.primaryModel.provider}/${options.primaryModel.id}`,
	});
}

/**
 * Resolve the branch model. An absent or unresolvable `reflect` override uses
 * the primary model so enabling the feature never silently selects a fallback
 * provider.
 */
export function resolveSecondThoughtBranchModel(
	settings: Settings,
	availableModels: Model<Api>[],
	primaryModel: Model<Api> | undefined,
): Model<Api> | undefined {
	if (!settings.getModelRole("reflect")) return primaryModel;
	return resolveRoleSelection(["reflect"], settings, availableModels)?.model ?? primaryModel;
}

/** Resolve Second Thought's branch model and determine whether it may run. */
export function evaluateSecondThoughtGate(options: SecondThoughtGateOptions): SecondThoughtGateResult {
	if (!options.settings.get("secondThought.enabled")) {
		return { allowed: false, branchModel: undefined, reason: "disabled" };
	}

	const branchModel = resolveSecondThoughtBranchModel(options.settings, options.availableModels, options.primaryModel);
	if (options.agentKind !== "main") {
		logGateFailureOnce("sub-session", options);
		return { allowed: false, branchModel, reason: "sub-session" };
	}
	if (!options.primaryModel) {
		logGateFailureOnce("no-primary-model", options);
		return { allowed: false, branchModel, reason: "no-primary-model" };
	}
	if (!isAnthropicApi(options.primaryModel)) {
		logGateFailureOnce("primary-model-not-anthropic", options);
		return { allowed: false, branchModel, reason: "primary-model-not-anthropic" };
	}
	if (!isAnthropicApi(branchModel)) {
		logGateFailureOnce("branch-model-not-anthropic", options);
		return { allowed: false, branchModel, reason: "branch-model-not-anthropic" };
	}

	return { allowed: true, branchModel };
}

/** Return whether Second Thought may start a branch for this session state. */
export function shouldRunSecondThought(options: SecondThoughtGateOptions): boolean {
	return evaluateSecondThoughtGate(options).allowed;
}
