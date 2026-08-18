/**
 * Transcript card for one Second Thought fold — what `secondThought.showInTranscript`
 * turns on.
 *
 * It renders the {@link SecondThoughtFoldEntry} payload of a `custom` session
 * entry, never a context message. There is no context message: the fold is
 * injected per-request and retired (04), so the diagnostic entry is the only
 * durable record of what the branch produced and what it cost. A card built from
 * anything else would show an empty feature forever.
 *
 * ## Layout
 *
 * Four bands, in the order a reader needs them:
 *
 * 1. header — the label, plus a marker when the fold never reached a request;
 * 2. units — one line per unit, rails tinted per atom, the atom named once;
 * 3. cost — tokens first, USD after, per DESIGN.md's "tokens are the primary
 *    figure" (a USD figure on an OAuth account prices quota, not money);
 * 4. stats — a single line: harvest counts, the window the branch had, and the
 *    session's skip buckets.
 *
 * Collapsed shows at most {@link COLLAPSED_UNITS} unit lines with the repo's
 * standard `ctrl+o` expand hint; expanded shows all of them. Bands 1, 3 and 4
 * never collapse — the whole point of the card is that a user can read what they
 * paid for without expanding anything.
 */

import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { SecondThoughtFoldEntry } from "../../session/second-thought/fold";
import { parseFoldEntry, SECOND_THOUGHT_FOLD_CUSTOM_TYPE } from "../../session/second-thought/fold";
import { createCachedComponent, formatExpandHint, replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { sanitizeStatusText } from "../shared";
import type { Theme, ThemeColor } from "../theme/theme";
import { theme as defaultTheme } from "../theme/theme";
import {
	buildSecondThoughtFoldSummary,
	type SecondThoughtFoldSummary,
	type SecondThoughtFoldSummaryOptions,
	type SecondThoughtSkipBucket,
} from "./second-thought-view";

/** Unit lines shown before the card collapses the rest behind `ctrl+o`. */
export const COLLAPSED_UNITS = 4;

/** Atom → rail color, so four atoms stay distinguishable at a glance. */
const ATOM_COLORS: Readonly<Record<string, ThemeColor>> = {
	check: "warning",
	rehearse: "accent",
	recall: "success",
	alternative: "muted",
};

/** Buckets read as severity in the stats line, same mapping the segment uses. */
const BUCKET_COLORS: Readonly<Record<SecondThoughtSkipBucket, ThemeColor>> = {
	gated: "dim",
	window: "muted",
	provider: "warning",
	error: "error",
};

function atomColor(atom: string): ThemeColor {
	return ATOM_COLORS[atom] ?? "muted";
}

/** `820ms` under a second, `1.4s` above — the window is a feel, not a measurement. */
function formatWindow(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatUsd(value: number): string {
	// Branch spend is small enough that three decimals rounds most folds to $0.000.
	return value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`;
}

/** Collapse a unit body to one display line. */
function oneLine(text: string): string {
	return sanitizeStatusText(replaceTabs(text));
}

interface UnitLine {
	readonly atom: string;
	/** Only the first unit of an atom is labeled; the rest align under it. */
	readonly labeled: boolean;
	readonly text: string;
}

function unitLines(summary: SecondThoughtFoldSummary): UnitLine[] {
	const lines: UnitLine[] = [];
	for (const { atom, units } of summary.atoms) {
		units.forEach((unit, index) => {
			const text = oneLine(unit);
			if (text) lines.push({ atom, labeled: index === 0, text });
		});
	}
	return lines;
}

/**
 * The tokens band. Cache-read is called out by name rather than folded into
 * input: it is the metric DESIGN.md's R2 acceptance gate reads, and a fold whose
 * cache-read is zero is a cost regression the card should make obvious.
 */
function costLine(summary: SecondThoughtFoldSummary, theme: Theme): string {
	const { tokens } = summary;
	// Arrows for in/out (the status line's own icons); the cache buckets are
	// spelled out rather than iconified — `icon.cache` is an emoji in the default
	// symbol theme, and nothing else in the transcript uses one.
	const parts = [
		`${theme.icon.input} ${formatNumber(tokens.uncachedInput)}`,
		`${theme.icon.output} ${formatNumber(tokens.output)}`,
		`${formatNumber(tokens.cacheRead)} cached`,
	];
	if (tokens.cacheWrite > 0) parts.push(`${formatNumber(tokens.cacheWrite)} written`);
	let line = theme.fg("muted", parts.join("  "));
	if (summary.costUsd !== undefined) {
		const usd = formatUsd(summary.costUsd);
		const suffix = summary.costIsIndicative ? `${usd} est` : usd;
		line += theme.fg("dim", `${theme.sep.dot}${suffix}`);
	}
	return line;
}

/** Append a complete stats detail, or an ellipsis when the next detail will not fit. */
function appendStatsPart(line: string, part: string, width: number, theme: Theme): { line: string; complete: boolean } {
	if (visibleWidth(line) + visibleWidth(part) <= width) return { line: line + part, complete: true };
	const remaining = Math.max(0, width - visibleWidth(line));
	if (remaining === 0) return { line, complete: false };
	return { line: line + truncateToWidth(theme.fg("dim", "…"), remaining), complete: false };
}

/** The single stats line: what the fold harvested, and what the session skipped. */
function statsLine(summary: SecondThoughtFoldSummary, theme: Theme, width: number): string {
	let line = truncateToWidth(
		theme.fg("dim", `${summary.unitCount} ${summary.unitCount === 1 ? "unit" : "units"}`),
		width,
	);
	let complete = visibleWidth(line) < width;
	const append = (color: ThemeColor, text: string): void => {
		if (!complete) return;
		const result = appendStatsPart(line, theme.fg(color, `${theme.sep.dot}${text}`), width, theme);
		line = result.line;
		complete = result.complete;
	};

	append("dim", `${summary.settledCount}/${summary.branchCount} settled`);
	append("dim", formatWindow(summary.windowMs));
	if (!summary.delivered) append("warning", `undelivered (${summary.retireReason})`);
	if (summary.truncated) append("warning", "truncated");

	const totalSkips = summary.skips.reduce((sum, skip) => sum + skip.count, 0);
	if (totalSkips > 0) {
		append("dim", `${totalSkips} skipped (`);
		for (const [index, skip] of summary.skips.entries()) {
			if (!complete) break;
			const prefix = index === 0 ? "" : theme.fg("dim", ", ");
			const result = appendStatsPart(
				line,
				`${prefix}${theme.fg(BUCKET_COLORS[skip.bucket], `${skip.reason} ${skip.count}`)}`,
				width,
				theme,
			);
			line = result.line;
			complete = result.complete;
		}
		if (complete) {
			const result = appendStatsPart(line, theme.fg("dim", ")"), width, theme);
			line = result.line;
		}
	}
	return line;
}

/**
 * Build the card. `getExpanded` is read on every render so the transcript's
 * global expand toggle drives it without rebuilding the component.
 */
export function createSecondThoughtDiagnosticCard(
	summary: SecondThoughtFoldSummary,
	getExpanded: () => boolean,
	theme: Theme = defaultTheme,
): Component {
	const rail = theme.tree.vertical;
	const railWidth = visibleWidth(`${rail} `);
	const labelWidth = Math.max(0, ...summary.atoms.map(entry => entry.atom.length));

	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const header = theme.fg("customMessageLabel", theme.bold(`${theme.icon.branch} Second Thought`));
			const lines: string[] = [truncateToWidth(header, width)];

			const all = unitLines(summary);
			const shown = expanded ? all : all.slice(0, COLLAPSED_UNITS);
			for (const unit of shown) {
				const label = unit.labeled ? unit.atom.padEnd(labelWidth) : " ".repeat(labelWidth);
				const prefix = `${theme.fg(atomColor(unit.atom), rail)} ${theme.fg(atomColor(unit.atom), label)}  `;
				const bodyWidth = Math.max(0, width - railWidth - labelWidth - 2);
				lines.push(truncateToWidth(`${prefix}${truncateToWidth(unit.text, bodyWidth)}`, width));
			}

			const hidden = all.length - shown.length;
			if (hidden > 0) {
				const hint = formatExpandHint(theme, false, true);
				lines.push(
					truncateToWidth(
						`${theme.fg("dim", rail)} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "unit" : "units"}`)}${hint ? ` ${hint}` : ""}`,
						width,
					),
				);
			}
			if (all.length === 0) {
				lines.push(truncateToWidth(`${theme.fg("dim", rail)} ${theme.fg("dim", "no units harvested")}`, width));
			}

			lines.push(truncateToWidth(costLine(summary, theme), width));
			lines.push(truncateToWidth(statsLine(summary, theme, width), width));
			return lines;
		},
		{ paddingX: 1 },
	);
}

/**
 * Transcript-facing component wrapper.
 *
 * Exposes the `setExpanded` contract every collapsible transcript block
 * implements, so ticket 08 can register it with the transcript builder's
 * expandable tracking exactly like any other card.
 */
export class SecondThoughtDiagnosticComponent implements Component {
	readonly #card: Component;
	#expanded = false;

	constructor(
		readonly summary: SecondThoughtFoldSummary,
		theme: Theme = defaultTheme,
	) {
		this.#card = createSecondThoughtDiagnosticCard(summary, () => this.#expanded, theme);
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.invalidate();
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	render(width: number): readonly string[] {
		return this.#card.render(width);
	}

	invalidate(): void {
		this.#card.invalidate?.();
	}
}

/** What {@link secondThoughtDiagnosticComponentFor} needs from a session entry. */
export interface SecondThoughtCustomEntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

/**
 * The single seam ticket 08 calls while walking session entries: hand it any
 * entry and get a component back only when the entry is a Second Thought fold
 * AND `secondThought.showInTranscript` is on.
 *
 * Returning `undefined` for every other entry is what keeps the transcript's
 * default quiet: the feature ships default-off, and the diagnostic entry is
 * opt-in on top of that.
 */
export function secondThoughtDiagnosticComponentFor(
	entry: SecondThoughtCustomEntryLike,
	options: {
		/** Structural, not `Settings` itself, so a test can pass one key. */
		settings?: { get(key: "secondThought.showInTranscript"): boolean };
		theme?: Theme;
		summaryOptions?: SecondThoughtFoldSummaryOptions;
	} = {},
): SecondThoughtDiagnosticComponent | undefined {
	if (entry.type !== "custom" || entry.customType !== SECOND_THOUGHT_FOLD_CUSTOM_TYPE) return undefined;
	if (options.settings && !options.settings.get("secondThought.showInTranscript")) return undefined;
	const payload: SecondThoughtFoldEntry | undefined = parseFoldEntry(entry.data);
	if (!payload) return undefined;
	const summary = buildSecondThoughtFoldSummary(payload, options.summaryOptions);
	if (!summary) return undefined;
	return new SecondThoughtDiagnosticComponent(summary, options.theme);
}
