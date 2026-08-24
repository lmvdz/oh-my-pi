import { parseIssueUrl } from "../tools/gh-common";
import { getOrFetchView, resolveGithubCacheAuthKey } from "../tools/github-cache";
import * as git from "../utils/git";
import { semanticIdentity } from "./identity";
import type { WayfinderContextLineageBinding, WayfinderIssueReference } from "./types";

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/;

interface GitHubIssuePayload {
	readonly number: number;
	readonly title: string;
	readonly state: "OPEN" | "CLOSED";
	readonly labels: readonly { readonly name: string }[];
	readonly url: string;
	readonly body: string;
	readonly updatedAt: string;
}

export interface WayfinderIssueResolver {
	resolve(cwd: string, issueUrl: string, signal?: AbortSignal): Promise<WayfinderIssueReference>;
}

/** Resolve and locally cache one GitHub issue without creating or changing any tracker state. */
export const githubWayfinderIssueResolver: WayfinderIssueResolver = {
	async resolve(cwd, issueUrl, signal) {
		const { repo, issueNumber } = parseIssueUrl(issueUrl);
		if (!repo || !issueNumber) throw new Error(`Wayfinder issue URL is invalid: ${issueUrl}`);
		const result = await getOrFetchView<GitHubIssuePayload>({
			repo,
			kind: "issue",
			number: issueNumber,
			includeComments: false,
			authKey: resolveGithubCacheAuthKey(),
			fetchFresh: async () => {
				const payload = await git.github.json<GitHubIssuePayload>(
					cwd,
					["issue", "view", issueUrl, "--json", "number,title,state,labels,url,body,updatedAt"],
					signal,
				);
				return { payload, rendered: payload.title, sourceUrl: payload.url };
			},
		});
		return {
			tracker: "github",
			repository: repo,
			number: result.payload.number,
			url: result.payload.url,
			title: result.payload.title,
			state: result.payload.state === "OPEN" ? "open" : "closed",
			labels: result.payload.labels.map(label => label.name),
			bodyDigest: semanticIdentity("wayfinder-issue-body", result.payload.body),
			updatedAt: result.payload.updatedAt,
		};
	},
};

/** Resolve a Campaign map and frontier ticket into one tracker snapshot pair. */
export async function resolveWayfinderIssuePair(input: {
	readonly cwd: string;
	readonly mapIssueUrl: string;
	readonly ticketIssueUrl: string;
	readonly resolver?: WayfinderIssueResolver;
	readonly signal?: AbortSignal;
}): Promise<{ readonly mapIssue: WayfinderIssueReference; readonly ticketIssue: WayfinderIssueReference }> {
	const resolver = input.resolver ?? githubWayfinderIssueResolver;
	const [mapIssue, ticketIssue] = await Promise.all([
		resolver.resolve(input.cwd, input.mapIssueUrl, input.signal),
		resolver.resolve(input.cwd, input.ticketIssueUrl, input.signal),
	]);
	return { mapIssue, ticketIssue };
}

/** Create a durable, read-only Campaign binding for one frozen planning base. */
export function createWayfinderContextLineageBinding(input: {
	readonly goal: string;
	readonly mapIssue: WayfinderIssueReference;
	readonly ticketIssue: WayfinderIssueReference;
	readonly manifestId: string;
	readonly checkpointId: string;
}): WayfinderContextLineageBinding {
	validateWayfinderIssue(input.mapIssue, "map issue");
	validateWayfinderIssue(input.ticketIssue, "ticket issue");
	if (!input.mapIssue.labels.includes("wayfinder:map")) {
		throw new Error("Wayfinder map issue must carry the wayfinder:map label");
	}
	if (input.goal.trim().length === 0) throw new Error("Wayfinder binding requires a goal");
	if (input.manifestId.length === 0) throw new Error("Wayfinder binding requires a manifest identity");
	if (input.checkpointId.length === 0) throw new Error("Wayfinder binding requires a checkpoint identity");
	const semanticBinding = {
		version: 1 as const,
		goalDigest: semanticIdentity("wayfinder-goal", input.goal),
		mapIssue: canonicalIssue(input.mapIssue),
		ticketIssue: canonicalIssue(input.ticketIssue),
		manifestId: input.manifestId,
		checkpointId: input.checkpointId,
	};
	return {
		...semanticBinding,
		bindingId: semanticIdentity("wayfinder-context-lineage-binding", semanticBinding),
	};
}

/** Verify persisted binding integrity without consulting or mutating the tracker. */
export function isWayfinderContextLineageBindingIntact(binding: WayfinderContextLineageBinding): boolean {
	try {
		validateWayfinderIssue(binding.mapIssue, "map issue");
		validateWayfinderIssue(binding.ticketIssue, "ticket issue");
		if (!binding.mapIssue.labels.includes("wayfinder:map")) return false;
		const semanticBinding = {
			version: 1 as const,
			goalDigest: binding.goalDigest,
			mapIssue: canonicalIssue(binding.mapIssue),
			ticketIssue: canonicalIssue(binding.ticketIssue),
			manifestId: binding.manifestId,
			checkpointId: binding.checkpointId,
		};
		return binding.bindingId === semanticIdentity("wayfinder-context-lineage-binding", semanticBinding);
	} catch {
		return false;
	}
}

function validateWayfinderIssue(issue: WayfinderIssueReference, label: string): void {
	if (issue.tracker !== "github") throw new Error(`${label} must use the GitHub tracker`);
	if (!/^[^/\s]+\/[^/\s]+$/.test(issue.repository)) throw new Error(`${label} has an invalid repository`);
	if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error(`${label} has an invalid issue number`);
	if (issue.title.trim().length === 0) throw new Error(`${label} requires a title`);
	const match = GITHUB_ISSUE_URL.exec(issue.url);
	if (!match || match[1] !== issue.repository || Number(match[2]) !== issue.number) {
		throw new Error(`${label} URL does not match its repository and issue number`);
	}
}

function canonicalIssue(issue: WayfinderIssueReference): WayfinderIssueReference {
	return { ...issue, labels: [...new Set(issue.labels)].sort() };
}
