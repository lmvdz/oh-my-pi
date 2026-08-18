import { describe, expect, it } from "bun:test";

const TUI_SURFACE_SOURCES = [
	new URL("../../src/modes/components/second-thought-view.ts", import.meta.url),
	new URL("../../src/modes/components/status-line/segments.ts", import.meta.url),
	new URL("../../src/modes/components/second-thought-diagnostic.ts", import.meta.url),
];

describe("Second Thought TUI surface boundary", () => {
	it("does not import session orchestration internals", async () => {
		const sources = await Promise.all(TUI_SURFACE_SOURCES.map(source => Bun.file(source).text()));
		const forbidden =
			/import(?:\s+type)?[\s\S]*?from\s+["'][^"']*(?:session\/agent-session|second-thought\/(?:coordinator|branch-call))["']/;

		for (const source of sources) expect(source).not.toMatch(forbidden);
	});
});
