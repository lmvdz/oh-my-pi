import { beforeAll, describe, expect, it } from "bun:test";
import {
	buildSecondThoughtStatusView,
	type SecondThoughtStatusView,
	secondThoughtSkipBucket,
} from "@oh-my-pi/pi-coding-agent/modes/components/second-thought-view";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SecondThoughtFoldEntry } from "@oh-my-pi/pi-coding-agent/session/second-thought/fold";
import { SECOND_THOUGHT_FOLD_ENTRY_VERSION } from "@oh-my-pi/pi-coding-agent/session/second-thought/fold";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

function foldEntry(overrides: Partial<SecondThoughtFoldEntry> = {}): SecondThoughtFoldEntry {
	return {
		version: SECOND_THOUGHT_FOLD_ENTRY_VERSION,
		generation: 1,
		epoch: 0,
		forkedAt: 1000,
		harvestedAt: 1820,
		retiredAt: 1900,
		windowMs: 820,
		unitsByAtom: { check: ["the guard runs before the mkdir"], recall: ["ripgrep is `rg` here"] },
		unitCount: 2,
		branchCount: 1,
		settledCount: 1,
		markupBytes: 128,
		blockBytes: 400,
		truncated: false,
		usage: [],
		delivered: true,
		deliveryCount: 1,
		deferralCount: 0,
		refusalCount: 0,
		retireReason: "delivered",
		...overrides,
	};
}

/**
 * A session double that carries only what the segment is allowed to touch. If
 * the segment ever reaches for AgentSession internals this throws instead of
 * quietly coupling the status line to the coordinator.
 */
function contextFor(view: SecondThoughtStatusView | undefined, implemented = true): SegmentContext {
	const session = implemented ? { getSecondThoughtStatus: () => view } : {};
	return { session, width: 120 } as unknown as SegmentContext;
}

describe("second_thought status-line segment", () => {
	it("is omitted when the feature is disabled", () => {
		const rendered = renderSegment("second_thought", contextFor({ enabled: false }));
		expect(rendered).toEqual({ content: "", visible: false });
	});

	it("is omitted on a host that predates the 08 wiring", () => {
		const rendered = renderSegment("second_thought", contextFor(undefined, false));
		expect(rendered).toEqual({ content: "", visible: false });
	});

	it("is omitted while enabled but nothing has forked yet", () => {
		const rendered = renderSegment("second_thought", contextFor({ enabled: true }));
		expect(rendered).toEqual({ content: "", visible: false });
	});

	it("shows the last fold's harvested-unit count", () => {
		const view = buildSecondThoughtStatusView({ enabled: true, entry: foldEntry() });
		const rendered = renderSegment("second_thought", contextFor(view));

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.icon.branch} 2`);
		expect(rendered.content).toBe(theme.fg("statusLineSubagents", `${theme.icon.branch} 2`));
	});

	it("prefers a harvest over an earlier skip", () => {
		const view = buildSecondThoughtStatusView({
			enabled: true,
			entry: foldEntry(),
			lastSkipReason: "adaptive-window",
		});
		expect(Bun.stripANSI(renderSegment("second_thought", contextFor(view)).content)).toBe(`${theme.icon.branch} 2`);
	});

	it("renders one bucketed glyph per skip family, never the raw reason", () => {
		const cases: readonly [string, string, string][] = [
			["sub-session", theme.status.disabled, "dim"],
			["adaptive-window", theme.status.shadowed, "muted"],
			["provider-cooldown", theme.status.warning, "warning"],
			["snapshot-failed", theme.status.error, "error"],
		];
		for (const [reason, glyph, color] of cases) {
			const view = buildSecondThoughtStatusView({ enabled: true, lastSkipReason: reason });
			const rendered = renderSegment("second_thought", contextFor(view));
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toBe(theme.fg(color as "dim", `${theme.icon.branch} ${glyph}`));
			expect(Bun.stripANSI(rendered.content)).not.toContain(reason);
		}
	});

	it("shows a zero-unit fold as a skip glyph rather than a bare 0", () => {
		const view = buildSecondThoughtStatusView({
			enabled: true,
			entry: foldEntry({ unitsByAtom: {}, unitCount: 0, delivered: false, retireReason: "empty" }),
			lastSkipReason: "conditioning-too-short",
		});
		expect(Bun.stripANSI(renderSegment("second_thought", contextFor(view)).content)).toBe(
			`${theme.icon.branch} ${theme.status.shadowed}`,
		);
	});
});

describe("skip-reason bucketing", () => {
	it("collapses every coordinator and gate reason into four buckets", () => {
		const reasons: Readonly<Record<string, string>> = {
			// gating.ts
			disabled: "gated",
			"sub-session": "gated",
			"no-primary-model": "gated",
			"primary-model-not-anthropic": "gated",
			"branch-model-not-anthropic": "gated",
			// coordinator.ts
			disposed: "gated",
			"conditioning-too-short": "window",
			"context-too-large": "window",
			"adaptive-window": "window",
			"provider-cooldown": "provider",
			"in-flight-cap": "provider",
			"developer-tail": "error",
			"no-fork-context": "error",
			"snapshot-failed": "error",
		};
		for (const [reason, bucket] of Object.entries(reasons)) {
			expect(secondThoughtSkipBucket(reason)).toBe(bucket as "gated");
		}
		expect(new Set(Object.values(reasons)).size).toBe(4);
	});

	it("buckets an unrecognized reason as error rather than hiding it", () => {
		expect(secondThoughtSkipBucket("a-reason-added-after-07")).toBe("error");
	});
});
