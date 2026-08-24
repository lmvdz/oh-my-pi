// Gate E live capture: relay two real, locally authorized provider requests,
// retain their raw encoded bytes only in a local 0600 fixture, and emit no
// provider-visible request content to stdout.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import gateEPrefixCapturePrompt from "../../src/prompts/context-lineage/gate-e-prefix-capture.md" with { type: "text" };
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { semanticIdentity } from "@oh-my-pi/pi-coding-agent/context-lineage";

const modelPattern = process.argv[2] ?? "mux/capable";
const targetDirectory = process.argv[3] ?? "/home/lars/.omp/context-lineage-gate-e";
const targetFixture = path.join(targetDirectory, "authorized-provider-prefix-fixture.json");
const capturedBodies: Uint8Array[] = [];

const bootstrap = await createAgentSession({
	cwd: import.meta.dir + "/../..",
	modelPattern,
	thinkingLevel: "off",
	enableLsp: false,
	enableMCP: false,
	disableExtensionDiscovery: true,
});
const baseModel = bootstrap.session.agent.state.model;
if (!baseModel?.baseUrl) throw new Error(`model ${modelPattern} has no configured provider base URL`);
const getApiKey = bootstrap.session.agent.getApiKey;
if (!getApiKey) throw new Error(`model ${modelPattern} has no configured credential resolver`);

const upstreamBaseUrl = new URL(baseModel.baseUrl);
const relay = Bun.serve({
	port: 0,
	async fetch(request): Promise<Response> {
		const body = new Uint8Array(await request.arrayBuffer());
		if (request.method === "POST") capturedBodies.push(body);
		const incoming = new URL(request.url);
		const upstream = new URL(`${incoming.pathname}${incoming.search}`, upstreamBaseUrl);
		const headers = new Headers(request.headers);
		headers.delete("host");
		return await fetch(upstream, {
			method: request.method,
			headers,
			body: body.byteLength > 0 ? body : undefined,
		});
	},
});

const capturedModel: Model = { ...baseModel, baseUrl: `${relay.url}v1` };
const captured = await createAgentSession({
	cwd: import.meta.dir + "/../..",
	model: capturedModel,
	getApiKey: requestModel => getApiKey(requestModel),
	thinkingLevel: "off",
	enableLsp: false,
	enableMCP: false,
	disableExtensionDiscovery: true,
});
try {
	await captured.session.runEphemeralTurn({
		promptText: prompt.render(gateEPrefixCapturePrompt, { probe: "Identify the shared frozen repository evidence boundary." }),
	});
	await captured.session.runEphemeralTurn({
		promptText: prompt.render(gateEPrefixCapturePrompt, { probe: "Identify the isolated leaf question boundary." }),
	});
	if (capturedBodies.length !== 2) {
		throw new Error(`expected exactly two provider requests, observed ${capturedBodies.length}`);
	}
	const basePrefix = longestCommonPrefix(capturedBodies[0]!, capturedBodies[1]!);
	if (basePrefix.length === 0) throw new Error("captured provider requests have no common encoded prefix");
	const fixture = {
		version: 1,
		providerId: baseModel.provider,
		modelId: baseModel.id,
		captureId: semanticIdentity("gate-e-live-capture", {
			baseDigest: semanticIdentity("gate-e-provider-prefix", basePrefix),
			leafDigests: capturedBodies.map(body => semanticIdentity("gate-e-provider-leaf", body)),
		}),
		basePrefixBase64: toBase64(basePrefix),
		leafPrefixesBase64: capturedBodies.map(toBase64),
	};
	await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
	await Bun.write(targetFixture, JSON.stringify(fixture));
	await fs.chmod(targetFixture, 0o600);
	console.log(
		[
			"Gate E capture: PASS",
			`provider=${baseModel.provider}`,
			`model=${baseModel.id}`,
			`capture=${fixture.captureId}`,
			`baseBytes=${basePrefix.length}`,
			`baseDigest=${semanticIdentity("gate-e-provider-prefix", basePrefix)}`,
			`leaves=${capturedBodies.length}`,
			`fixture=${targetFixture}`,
		].join(" "),
	);
} finally {
	relay.stop(true);
	await captured.session.dispose();
	await bootstrap.session.dispose();
}

function longestCommonPrefix(left: Uint8Array, right: Uint8Array): Uint8Array {
	const length = Math.min(left.length, right.length);
	let index = 0;
	while (index < length && left[index] === right[index]) index++;
	return left.slice(0, index);
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
