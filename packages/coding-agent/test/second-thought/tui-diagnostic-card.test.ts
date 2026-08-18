import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	COLLAPSED_UNITS,
	SecondThoughtDiagnosticComponent,
	secondThoughtDiagnosticComponentFor,
} from "@oh-my-pi/pi-coding-agent/modes/components/second-thought-diagnostic";
import { buildSecondThoughtFoldSummary } from "@oh-my-pi/pi-coding-agent/modes/components/second-thought-view";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SecondThoughtFoldEntry } from "@oh-my-pi/pi-coding-agent/session/second-thought/fold";
import {
	SECOND_THOUGHT_FOLD_CUSTOM_TYPE,
	SECOND_THOUGHT_FOLD_ENTRY_VERSION,
} from "@oh-my-pi/pi-coding-agent/session/second-thought/fold";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

const usage = (over: Partial<Usage> = {}): Usage =>
	({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...over }) as unknown as Usage;

function foldEntry(overrides: Partial<SecondThoughtFoldEntry> = {}): SecondThoughtFoldEntry {
	return {
		version: SECOND_THOUGHT_FOLD_ENTRY_VERSION,
		generation: 3,
		epoch: 0,
		forkedAt: 1000,
		harvestedAt: 1820,
		retiredAt: 1900,
		windowMs: 820,
		unitsByAtom: {
			// Deliberately out of canonical order: the card re-orders.
			recall: ["ripgrep is `rg` in this repo"],
			check: ["the guard runs before the mkdir", "second check unit"],
			alternative: ["could stream instead of buffering"],
		},
		unitCount: 4,
		branchCount: 1,
		settledCount: 1,
		markupBytes: 128,
		blockBytes: 400,
		truncated: false,
		usage: [usage({ input: 1200, output: 340, cacheRead: 8100, cacheWrite: 0 })],
		delivered: true,
		deliveryCount: 1,
		deferralCount: 0,
		refusalCount: 0,
		retireReason: "delivered",
		...overrides,
	};
}

function card(entry: SecondThoughtFoldEntry, costUsd?: number, costIsIndicative?: boolean) {
	const summary = buildSecondThoughtFoldSummary(entry, { costUsd, costIsIndicative });
	if (!summary) throw new Error("expected a summary");
	return new SecondThoughtDiagnosticComponent(summary);
}

function loadedCard(
	entry: SecondThoughtFoldEntry,
	costUsd?: number,
	costIsIndicative?: boolean,
): SecondThoughtDiagnosticComponent {
	const component = secondThoughtDiagnosticComponentFor(
		{ type: "custom", customType: SECOND_THOUGHT_FOLD_CUSTOM_TYPE, data: entry },
		{
			settings: { get: () => true },
			summaryOptions: { costUsd, costIsIndicative },
		},
	);
	if (!component) throw new Error("expected a loaded card");
	return component;
}

function rows(component: { render(width: number): readonly string[] }, width = 100): string[] {
	return component
		.render(width)
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(row => row.trim());
}

describe("Second Thought transcript card", () => {
	it("pins the collapsed unit count", () => {
		expect(COLLAPSED_UNITS).toBe(4);
	});

	it("leads with a label, one line per unit, and a single stats line", () => {
		const lines = rows(card(foldEntry()));

		expect(lines[0]).toContain("Second Thought");
		// 4 units, all under the collapse threshold, one per line.
		expect(lines.filter(line => line.includes("the guard runs before the mkdir"))).toHaveLength(1);
		expect(lines.filter(line => line.includes("second check unit"))).toHaveLength(1);
		expect(lines.filter(line => line.includes("ripgrep is `rg` in this repo"))).toHaveLength(1);
		expect(lines.filter(line => line.includes("could stream instead of buffering"))).toHaveLength(1);

		const stats = lines.filter(line => line.includes("units") && line.includes("settled"));
		expect(stats).toHaveLength(1);
		expect(stats[0]).toContain("4 units");
		expect(stats[0]).toContain("1/1 settled");
		expect(stats[0]).toContain("820ms");
	});

	it("orders atoms canonically and names each atom once", () => {
		const lines = rows(card(foldEntry()));
		const text = lines.join("\n");
		expect(text.indexOf("check")).toBeLessThan(text.indexOf("recall"));
		expect(text.indexOf("recall")).toBeLessThan(text.indexOf("alternative"));
		// The atom's second unit is aligned under the label, not re-labeled: only
		// one row carries "check" in the label column.
		const labelColumn = lines.map(line =>
			line
				.replace(/^\s*\S\s*/, "")
				.slice(0, 12)
				.trim(),
		);
		expect(labelColumn.filter(label => label === "check")).toHaveLength(1);
	});

	it("puts tokens before USD on the cost line", () => {
		const lines = rows(card(foldEntry(), 0.0041));
		const cost = lines.find(line => line.includes("cached"));
		expect(cost).toBeDefined();
		const dollarIndex = cost?.indexOf("$") ?? -1;
		expect(dollarIndex).toBeGreaterThan(0);
		// Every token figure precedes the USD figure.
		expect(cost?.slice(0, dollarIndex)).toContain("340");
	});

	it("marks an OAuth-priced figure as an estimate", () => {
		const cost = rows(card(foldEntry(), 0.0041, true)).find(line => line.includes("$"));
		expect(cost).toContain("est");
	});

	it("collapses past the unit threshold and expands on demand", () => {
		const units = Array.from({ length: COLLAPSED_UNITS + 3 }, (_, index) => `unit number ${index}`);
		const component = card(foldEntry({ unitsByAtom: { check: units }, unitCount: units.length }));

		const collapsed = rows(component);
		expect(collapsed.filter(line => line.includes("unit number"))).toHaveLength(COLLAPSED_UNITS);
		expect(collapsed.some(line => line.includes("+3 more units"))).toBe(true);

		component.setExpanded(true);
		const expanded = rows(component);
		expect(expanded.filter(line => line.includes("unit number"))).toHaveLength(units.length);
		expect(expanded.some(line => line.includes("more units"))).toBe(false);
	});

	it("says so when the fold never reached a request", () => {
		const stats = rows(card(foldEntry({ delivered: false, retireReason: "run-end" }))).at(-1);
		expect(stats).toContain("undelivered (run-end)");
	});

	it("reports the skip counters the entry carries, verbatim, on the stats line", () => {
		const stats = rows(
			card(foldEntry({ skips: { "adaptive-window": 4, "provider-cooldown": 2, "in-flight-cap": 0 } })),
		).at(-1);
		expect(stats).toContain("6 skipped");
		// Ordered by count, and the FULL reason appears here — the footer only
		// ever shows the bucket glyph.
		expect(stats).toContain("adaptive-window 4");
		expect(stats).toContain("provider-cooldown 2");
		expect(stats).not.toContain("in-flight-cap");
	});

	it("renders an empty harvest without pretending it had units", () => {
		const lines = rows(card(foldEntry({ unitsByAtom: {}, unitCount: 0, retireReason: "empty", delivered: false })));
		expect(lines.some(line => line.includes("no units harvested"))).toBe(true);
		expect(lines.at(-1)).toContain("0 units");
	});

	it("truncates unit text to the available width instead of wrapping the card", () => {
		const long = "x".repeat(400);
		const lines = rows(card(foldEntry({ unitsByAtom: { check: [long] }, unitCount: 1 })), 60);
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
	});

	it("clamps every rendered band at narrow widths while progressively eliding skip detail", () => {
		const entry = foldEntry({
			unitsByAtom: {
				check: ["first check", "second check"],
				recall: ["recall result", "another recall"],
				alternative: ["alternative result", "another alternative"],
			},
			unitCount: 6,
			branchCount: 3,
			settledCount: 1,
			truncated: true,
			delivered: false,
			retireReason: "run-end",
			skips: { "adaptive-window": 4, "provider-cooldown": 3, "in-flight-cap": 2 },
		});
		const component = loadedCard(entry, 0.0041, true);

		for (const width of [40, 60, 80, 120]) {
			for (const line of component.render(width)) {
				expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
			}
		}

		const lines = rows(component, 120);
		expect(lines.find(line => line.includes("$"))).toContain("est");
		const stats = lines.at(-1);
		expect(stats).toContain("9 skipped");
		expect(stats).toContain("adaptive-window 4");
		expect(stats).toContain("…");
	});

	it("strips terminal controls from model-authored unit text", () => {
		const component = card(
			foldEntry({
				unitsByAtom: {
					check: ["\x1b[31mred\x1b[0m \x1b[2Jclear\x07 \x1b]2;hidden title\x07title"],
				},
				unitCount: 1,
			}),
		);
		const unit = rows(component).find(line => line.includes("red"));

		expect(unit).toContain("red clear title");
		expect(unit).not.toContain("hidden title");
		expect(unit).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	});
});

describe("secondThoughtDiagnosticComponentFor", () => {
	const entry = { type: "custom", customType: SECOND_THOUGHT_FOLD_CUSTOM_TYPE, data: foldEntry() };
	const settings = (show: boolean) => ({ get: () => show });

	it("renders only when secondThought.showInTranscript is on", () => {
		expect(secondThoughtDiagnosticComponentFor(entry, { settings: settings(false) })).toBeUndefined();
		expect(secondThoughtDiagnosticComponentFor(entry, { settings: settings(true) })).toBeDefined();
	});

	it("ignores every other entry", () => {
		expect(secondThoughtDiagnosticComponentFor({ type: "message" })).toBeUndefined();
		expect(
			secondThoughtDiagnosticComponentFor({ type: "custom", customType: "session_exit", data: {} }),
		).toBeUndefined();
	});

	it("refuses a payload version this build cannot read", () => {
		const forward = { ...entry, data: { ...foldEntry(), version: SECOND_THOUGHT_FOLD_ENTRY_VERSION + 1 } };
		expect(secondThoughtDiagnosticComponentFor(forward)).toBeUndefined();
	});
});
