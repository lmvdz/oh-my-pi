import { semanticIdentity } from "./identity";

/** A deterministic, artifact-only acceptance rule for one PR10 measurement profile. */
export interface ContextLineageDeclaredOutcomeProfile {
	readonly profileId: string;
	readonly requiredTermGroups: readonly (readonly string[])[];
	readonly forbiddenTerms: readonly string[];
}

/** Digest-safe result of applying a declared outcome profile to one candidate artifact. */
export interface ContextLineageDeclaredOutcome {
	readonly profileId: string;
	readonly verdict: "acceptable" | "unacceptable";
	readonly missingRequiredGroups: readonly number[];
	readonly matchedForbiddenTerms: readonly string[];
}

/**
 * Narrow, profile-specific reference contracts for the live PR10 harness.
 * They are deliberately lexical and conservative: their purpose is to expose
 * evaluator disagreement, not to decide what a user should continue.
 */
export const CONTEXT_LINEAGE_PR10_DECLARED_OUTCOME_PROFILES = {
	"adapter-authority": {
		profileId: "context-lineage-pr10-declared-outcome:adapter-authority:v3",
		requiredTermGroups: [
			["optional", "opt-in", "opt in", "off by default"],
			["read-only", "read only", "non-mutating", "non mutating", "does not mutate", "doesn't mutate"],
			["snapshot", "stale"],
			["fallback"],
			["test"],
		],
		forbiddenTerms: ["network retrieval", "current repository truth"],
	},
	"artifact-copy": {
		profileId: "context-lineage-pr10-declared-outcome:artifact-copy:v2",
		requiredTermGroups: [["artifact"], ["copy"], ["default"], ["isolated", "isolation", "opt out"], ["test"]],
		forbiddenTerms: ["provider cache", "invented api"],
	},
	"capability-isolation": {
		profileId: "context-lineage-pr10-declared-outcome:capability-isolation:v2",
		requiredTermGroups: [["frozen"], ["no tools", "without tools"], ["parent"], ["raw"], ["test"], ["restart", "retry"]],
		forbiddenTerms: ["workspace access", "provider feature"],
	},
	"recovery-replay": {
		profileId: "context-lineage-pr10-declared-outcome:recovery-replay:v2",
		requiredTermGroups: [["completed"], ["restart"], ["approved"], ["descendant"], ["unrelated"], ["test"]],
		forbiddenTerms: ["branch state merging", "cache behavior"],
	},
} as const satisfies Record<string, ContextLineageDeclaredOutcomeProfile>;

/**
 * Apply an explicit lexical outcome contract without invoking a model or
 * retaining the candidate body. This is a calibration reference, never a
 * production selection policy.
 */
export function evaluateContextLineageDeclaredOutcome(
	content: string,
	profile: ContextLineageDeclaredOutcomeProfile,
): ContextLineageDeclaredOutcome {
	if (!profile.profileId || profile.requiredTermGroups.length === 0) {
		throw new Error("Declared outcome profile requires an identifier and required terms");
	}
	const normalized = normalize(content);
	const missingRequiredGroups = profile.requiredTermGroups
		.map((terms, index) => ({ index, terms }))
		.filter(({ terms }) => terms.length === 0 || !terms.some(term => normalized.includes(normalize(term))))
		.map(({ index }) => index);
	const matchedForbiddenTerms = [...new Set(profile.forbiddenTerms.filter(term => containsForbiddenAssertion(normalized, normalize(term))))].sort();
	return {
		profileId: profile.profileId,
		verdict: missingRequiredGroups.length === 0 && matchedForbiddenTerms.length === 0 ? "acceptable" : "unacceptable",
		missingRequiredGroups,
		matchedForbiddenTerms,
	};
}

/** Stable identifier for a declared outcome profile, without candidate content. */
export function contextLineageDeclaredOutcomeProfileIdentity(profile: ContextLineageDeclaredOutcomeProfile): string {
	return semanticIdentity("context-lineage-declared-outcome-profile", profile);
}

/** Reject malformed persisted outcome references before they become calibration evidence. */
export function isContextLineageDeclaredOutcome(value: unknown): value is ContextLineageDeclaredOutcome {
	if (!isRecord(value)) return false;
	return (
		typeof value.profileId === "string" &&
		(value.verdict === "acceptable" || value.verdict === "unacceptable") &&
		Array.isArray(value.missingRequiredGroups) &&
		value.missingRequiredGroups.every(index => typeof index === "number" && Number.isSafeInteger(index) && index >= 0) &&
		Array.isArray(value.matchedForbiddenTerms) &&
		value.matchedForbiddenTerms.every(term => typeof term === "string")
	);
}

function normalize(value: string): string {
	return value.toLocaleLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A candidate may mention a forbidden capability in order to prohibit it. */
function containsForbiddenAssertion(content: string, term: string): boolean {
	let index = content.indexOf(term);
	while (index >= 0) {
		const preceding = content.slice(Math.max(0, index - 48), index);
		if (!/\b(?:no|not|without|never|avoid|prevent|forbid|prohibit|disallow)\b(?:\s+\p{L}+){0,4}\s*$/u.test(preceding)) return true;
		index = content.indexOf(term, index + term.length);
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
