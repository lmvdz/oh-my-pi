import {
	type CacheObservation,
	createArtifactManagerContextLineageOutputVerifier,
	createSideRequestContextLineageTaskRunner,
	executeContextLineagePlan,
	lowerFanoutRequest,
	prepareRepositoryContextLineage,
	renderRepositoryContextManifest,
} from "@oh-my-pi/pi-coding-agent/context-lineage";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import * as fs from "node:fs";

// Persistent fixture repo (survives the script; cleaned by tier cleanup).
const repoRoot = "/tmp/opencode/tier2-scip-repo";
async function ensureFixtureRepo(): Promise<void> {
	await $`mkdir -p ${repoRoot}/src`.quiet();
	await Bun.write(
		`${repoRoot}/src/types.ts`,
		"export interface Widget {\n\treadonly id: string;\n\treadonly weight: number;\n}\n\nexport function scale(widget: Widget, factor: number): Widget {\n\treturn { id: widget.id, weight: widget.weight * factor };\n}\n",
	);
	await Bun.write(
		`${repoRoot}/src/registry.ts`,
		'import { scale, type Widget } from "./types";\n\nexport class WidgetRegistry {\n\treadonly #widgets = new Map<string, Widget>();\n\n\tregister(widget: Widget): void {\n\t\tthis.#widgets.set(widget.id, widget);\n\t}\n\n\ttotalWeight(factor: number): number {\n\t\tlet total = 0;\n\t\tfor (const widget of this.#widgets.values()) total += scale(widget, factor).weight;\n\t\treturn total;\n\t}\n}\n',
	);
	const head = await $`git rev-parse HEAD`.cwd(repoRoot).quiet().nothrow();
	if (head.exitCode !== 0) {
		await $`git init --initial-branch=main`.cwd(repoRoot).quiet();
		await $`git add .`.cwd(repoRoot).quiet();
		await $`git -c user.name=T -c user.email=t@x commit -m fixture`.cwd(repoRoot).quiet();
	}
	// Real source files give the frozen base enough tokens to clear provider
	// cache minimums (OpenAI 1024, Anthropic 2048).
	const lineageDir = import.meta.dir + "/../../src/context-lineage";
	for (const name of fs.readdirSync(lineageDir)) {
		if (!name.endsWith(".ts")) continue;
		await Bun.write(`${repoRoot}/src/${name}`, await Bun.file(`${lineageDir}/${name}`).text());
		await $`git add src`.cwd(repoRoot).quiet().nothrow();
	}
	const dirty = await $`git status --porcelain`.cwd(repoRoot).quiet().nothrow();
	if (dirty.text().trim().length > 0) {
		await $`git -c user.name=T -c user.email=t@x commit -am "sync fixture"`.cwd(repoRoot).quiet().nothrow();
	}
	if (
		!(await Bun.file(`${repoRoot}/.scip/index.scip`).exists()) &&
		(await Bun.file("/tmp/opencode/scip-fixture/index.scip").exists())
	) {
		await $`mkdir -p ${repoRoot}/.scip && cp /tmp/opencode/scip-fixture/index.scip ${repoRoot}/.scip/index.scip`;
	}
}
await ensureFixtureRepo();
const modelPattern = process.argv[2] ?? "claude-haiku-4-5";
const warmPolicy = (process.argv[3] ?? "off") as "off" | "stagger_first";

using artifactsDir = TempDir.createSync("@tier2-artifacts-");
const artifacts = new ArtifactManager(artifactsDir.path());

console.log(`creating session (${modelPattern}, warm=${warmPolicy})…`);
const { session } = await createAgentSession({
	cwd: repoRoot,
	modelPattern,
	thinkingLevel: "off",
	enableLsp: false,
	enableMCP: false,
	disableExtensionDiscovery: true,
});

const prepared = await prepareRepositoryContextLineage({
	cwd: repoRoot,
	task: "context lineage snapshot manifest identity validation runtime",
	journal: session.sessionManager,
});
console.log(`manifest ${prepared.manifest.manifestId.slice(0, 50)}… (${prepared.manifest.evidence.length} items)`);

const lowered = lowerFanoutRequest(
	{
		version: 1,
		checkpoint: { type: "current_idle" },
		questions: [
			{ question: "In one sentence: what does WidgetRegistry do?" },
			{ question: "In one sentence: what does the scale function guarantee?" },
			{ question: "In one sentence: which file would you change to add a max-weight cap?" },
		],
	},
	// Checkpoint rooting (see /lineage ask fix): questions are parity-surface
	// branching, not FR51-grounded plan steps.
	{ type: "checkpoint", checkpointId: prepared.checkpoint.checkpointId },
);

// Capture per-attempt provider usage by wrapping the session boundary the
// production side-request runner uses; map Anthropic-reported cache buckets
// into lineage CacheObservations (FR8).
type Attempt = { taskId: string; usage: unknown };
const attempts: Attempt[] = [];
const capturingSession = {
	runEphemeralTurn: async (args: { promptText: string; signal?: AbortSignal }) => {
		const result = await session.runEphemeralTurn(args);
		attempts.push({ taskId: "?", usage: result.assistantMessage.usage });
		return { replyText: result.replyText };
	},
};
const baseRunner = createSideRequestContextLineageTaskRunner({
	session: capturingSession as never,
	saveArtifact: async content => `artifact://${await artifacts.save(content, "context-lineage")}`,
});
const runner = {
	async run(request: Parameters<typeof baseRunner.run>[0]) {
		try {
			attempts.push({ taskId: request.task.id, usage: undefined as never });
			const result = await baseRunner.run(request);
			const usage = attempts[attempts.length - 1]!.usage as Record<string, number>;
			const status: CacheObservation["status"] =
				(usage.cacheRead ?? 0) > 0
					? "hit"
					: (usage.cacheWrite ?? 0) > 0
						? "write"
						: (usage.input ?? 0) > 0
							? "miss"
							: "unknown";
			return {
				...result,
				cacheObservation: {
					status,
					readTokens: usage.cacheRead || undefined,
					writeTokens: usage.cacheWrite || undefined,
					uncachedInputTokens: usage.input,
					observedAt: Date.now(),
				} satisfies CacheObservation,
			};
		} catch (error) {
			console.log(`task ${request.task.id} FAILED:`, String(error).slice(0, 400));
			throw error;
		}
	},
};

const expectedSharedBytes = new TextEncoder().encode(renderRepositoryContextManifest(prepared.manifest)).byteLength;
console.log(`expected shared prefix ~${(expectedSharedBytes / 1024).toFixed(1)}KiB; fanout=3 concurrency=2`);
const t0 = performance.now();
const outcome = await executeContextLineagePlan({
	manifest: prepared.manifest,
	checkpoint: prepared.checkpoint,
	plan: lowered,
	journal: session.sessionManager,
	runner,
	outputVerifier: createArtifactManagerContextLineageOutputVerifier(artifacts),
	concurrency: 2,
	warmPolicy,
});
const makespan = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\n== run ${outcome.runId.slice(0, 24)}… ==`);
console.log(`status: ${outcome.status} in ${makespan}s`);
for (const obs of outcome.cacheObservations) {
	console.log(
		`cache ${obs.status}: read=${obs.readTokens ?? 0} write=${obs.writeTokens ?? 0} uncachedInput=${obs.uncachedInputTokens ?? "?"}`,
	);
}
const totalRead = outcome.cacheObservations.reduce((s, o) => s + (o.readTokens ?? 0), 0);
console.log(
	`\nGate F: ${totalRead > 0 ? `PASS — ${totalRead} cache-read tokens observed across siblings` : "no cache reads reported"}`,
);
await session.dispose();
process.exit(0);
