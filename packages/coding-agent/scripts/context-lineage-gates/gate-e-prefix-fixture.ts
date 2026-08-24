// Gate E: verify one locally captured, provider-specific encoded-prefix fixture
// without logging its provider-visible bytes. The fixture is intentionally not
// committed: it may contain authorized prompt material from a real request.
import { semanticIdentity } from "@oh-my-pi/pi-coding-agent/context-lineage";

interface EncodedPrefixFixture {
	readonly version: 1;
	readonly providerId: string;
	readonly modelId: string;
	readonly captureId: string;
	readonly basePrefixBase64: string;
	readonly leafPrefixesBase64: readonly string[];
}

function isEncodedPrefixFixture(value: unknown): value is EncodedPrefixFixture {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === 1 &&
		typeof record.providerId === "string" &&
		typeof record.modelId === "string" &&
		typeof record.captureId === "string" &&
		typeof record.basePrefixBase64 === "string" &&
		Array.isArray(record.leafPrefixesBase64) &&
		record.leafPrefixesBase64.every(prefix => typeof prefix === "string")
	);
}

function decodeBase64(value: string): Uint8Array {
	try {
		const binary = atob(value);
		return Uint8Array.from(binary, byte => byte.codePointAt(0) ?? 0);
	} catch {
		throw new Error("fixture contains invalid base64-encoded prefix bytes");
	}
}

function hasExactPrefix(base: Uint8Array, leaf: Uint8Array): boolean {
	return leaf.length >= base.length && base.every((byte, index) => leaf[index] === byte);
}

const fixturePath = process.argv[2];
if (!fixturePath) {
	throw new Error("usage: gate-e-prefix-fixture.ts <authorized-provider-prefix-fixture.json>");
}
const parsed: unknown = await Bun.file(fixturePath).json();
if (!isEncodedPrefixFixture(parsed)) {
	throw new Error("fixture must contain version, providerId, modelId, captureId, basePrefixBase64, and leafPrefixesBase64");
}
if (parsed.leafPrefixesBase64.length === 0) throw new Error("fixture must contain at least one leaf prefix");
const base = decodeBase64(parsed.basePrefixBase64);
if (base.length === 0) throw new Error("fixture base prefix must not be empty");
const leaves = parsed.leafPrefixesBase64.map(decodeBase64);
const incompatible = leaves.findIndex(leaf => !hasExactPrefix(base, leaf));
if (incompatible >= 0) {
	throw new Error(`Gate E failed: leaf ${incompatible + 1} does not extend the captured base prefix`);
}
console.log(
	[
		"Gate E: PASS",
		`provider=${parsed.providerId}`,
		`model=${parsed.modelId}`,
		`capture=${parsed.captureId}`,
		`baseBytes=${base.length}`,
		`baseDigest=${semanticIdentity("gate-e-provider-prefix", base)}`,
		`leaves=${leaves.length}`,
	].join(" "),
);
