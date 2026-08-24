import { type Component, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

export interface ContextLineageBoardAnswer {
	readonly stageId?: string;
	readonly taskId: string;
	readonly assignment: string;
	readonly artifactRef: string;
	readonly cacheStatus?: string;
}

export interface ContextLineageBoardRun {
	readonly runId: string;
	readonly status: "running" | "completed" | "failed" | "aborted";
	readonly answers: readonly ContextLineageBoardAnswer[];
}

export type ContextLineageBoardAction = "inspect" | "copy" | "retry" | "cancel" | "promote" | "discard" | "synthesize" | "diagnostics";

export interface ContextLineageCandidateBoardItem {
	readonly candidateId: string;
	readonly status: "pending" | "completed" | "discarded";
	readonly variation: string;
	readonly artifactRef?: string;
}

export interface ContextLineageCandidateBoardFamily {
	readonly familyId: string;
	readonly planId: string;
	readonly taskId: string;
	readonly candidates: readonly ContextLineageCandidateBoardItem[];
	readonly reviewCount: number;
	readonly adjudicationCount: number;
	readonly selectionCount: number;
}

export type ContextLineageCandidateBoardAction =
	| "rubric"
	| "inspect"
	| "copy"
	| "retry"
	| "discard"
	| "stop"
	| "review"
	| "adjudicate"
	| "select"
	| "approve"
	| "replay";

/** Normalize multiline editor input while preserving the user-declared order. */
export function parseContextLineageQuestionEditorInput(source: string): readonly string[] {
	return source
		.split(/\r?\n/)
		.map(question => question.trim())
		.filter(question => question.length > 0);
}

/**
 * Durable Parallel Questions board. Cards retain plan input order because the
 * caller supplies execution outputs in persisted task order; the component
 * never sorts by completion time. It owns no raw answer content.
 */
export class ContextLineageBoardComponent implements Component {
	#selected = 0;
	#runSelected: number;
	onClose?: () => void;
	onAskFromHere?: () => void;
	onAction?: (action: ContextLineageBoardAction, run: ContextLineageBoardRun, answerIndex: number) => void;
	onRequestRender?: () => void;

	constructor(private readonly runs: readonly ContextLineageBoardRun[]) {
		this.#runSelected = Math.max(0, runs.length - 1);
	}

	render(width: number): readonly string[] {
		const active = this.runs[this.#runSelected];
		const answers = active?.answers ?? [];
		const lines = [topBorder(width, "Parallel Questions")];
		if (!active) {
			lines.push(row(theme.fg("dim", "No saved Parallel Questions runs. Start one with /fanout q1 | q2."), width));
		} else {
			lines.push(row(`Run ${this.#runSelected + 1}/${this.runs.length} · ${active.runId} · ${active.status} · ${answers.length} result(s)`, width));
			lines.push(divider(width));
			for (const [index, answer] of answers.entries()) {
				const selected = index === this.#selected;
				const marker = selected ? theme.fg("accent", "›") : " ";
				const label = `${marker} ${index + 1}. ${answer.assignment || answer.taskId}`;
				lines.push(row(selected ? theme.bold(label) : label, width));
				const details = `${answer.artifactRef}${answer.cacheStatus ? ` · cache ${answer.cacheStatus}` : ""}`;
				lines.push(row(theme.fg("dim", truncateToWidth(details, Math.max(1, width - 8))), width));
			}
		}
		lines.push(divider(width));
		lines.push(row(theme.fg("dim", "a ask · ←/→ run · ↑/↓ select · i inspect · c copy · r retry · x cancel · p promote · d discard · s synthesize · g diagnostics · Esc close"), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}
		if (data === "a") {
			this.onAskFromHere?.();
			return;
		}
		if (matchesKey(data, "left") || data === "h") {
			this.#selectRun(this.#runSelected - 1);
			return;
		}
		if (matchesKey(data, "right") || data === "l") {
			this.#selectRun(this.#runSelected + 1);
			return;
		}
		const run = this.runs[this.#runSelected];
		if (!run || run.answers.length === 0) return;
		if (matchesKey(data, "up") || data === "k") this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down") || data === "j") this.#selected = Math.min(run.answers.length - 1, this.#selected + 1);
		else if (data === "i") this.onAction?.("inspect", run, this.#selected);
		else if (data === "c") this.onAction?.("copy", run, this.#selected);
		else if (data === "r") this.onAction?.("retry", run, this.#selected);
		else if (data === "x") this.onAction?.("cancel", run, this.#selected);
		else if (data === "p") this.onAction?.("promote", run, this.#selected);
		else if (data === "d") this.onAction?.("discard", run, this.#selected);
		else if (data === "s") this.onAction?.("synthesize", run, this.#selected);
		else if (data === "g") this.onAction?.("diagnostics", run, this.#selected);
		else return;
		this.onRequestRender?.();
	}

	#selectRun(index: number): void {
		const next = Math.max(0, Math.min(this.runs.length - 1, index));
		if (next === this.#runSelected) return;
		this.#runSelected = next;
		this.#selected = 0;
		this.onRequestRender?.();
	}
}

/** Ordered, artifact-only control surface for durable PR10 candidate families. */
export class ContextLineageCandidateBoardComponent implements Component {
	#selected = 0;
	#familySelected: number;
	onClose?: () => void;
	onAction?: (action: ContextLineageCandidateBoardAction, family: ContextLineageCandidateBoardFamily, candidateIndex: number) => void;
	onRequestRender?: () => void;

	constructor(private readonly families: readonly ContextLineageCandidateBoardFamily[]) {
		this.#familySelected = Math.max(0, families.length - 1);
	}

	render(width: number): readonly string[] {
		const family = this.families[this.#familySelected];
		const candidates = family?.candidates ?? [];
		const lines = [topBorder(width, "Controlled Candidates")];
		if (!family) {
			lines.push(row(theme.fg("dim", "No saved candidate families. Start one with /lineage candidate run …"), width));
		} else {
			lines.push(row(`Family ${this.#familySelected + 1}/${this.families.length} · ${family.familyId} · ${family.taskId}`, width));
			lines.push(row(theme.fg("dim", `reviews ${family.reviewCount} · adjudications ${family.adjudicationCount} · selections ${family.selectionCount}`), width));
			lines.push(divider(width));
			for (const [index, candidate] of candidates.entries()) {
				const selected = index === this.#selected;
				const marker = selected ? theme.fg("accent", "›") : " ";
				lines.push(row(selected ? theme.bold(`${marker} ${index + 1}. ${candidate.status} · ${candidate.variation}`) : `${marker} ${index + 1}. ${candidate.status} · ${candidate.variation}`, width));
				lines.push(row(theme.fg("dim", truncateToWidth(candidate.artifactRef ?? "no completed sidecar artifact", Math.max(1, width - 8))), width));
			}
		}
		lines.push(divider(width));
		lines.push(row(theme.fg("dim", "←/→ family · ↑/↓ candidate · u rubric · i inspect · c copy · r retry · d discard · x stop pending · v review · a adjudicate · s select · p approve · y replay · Esc close"), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.onClose?.();
		if (matchesKey(data, "left") || data === "h") return this.#selectFamily(this.#familySelected - 1);
		if (matchesKey(data, "right") || data === "l") return this.#selectFamily(this.#familySelected + 1);
		const family = this.families[this.#familySelected];
		if (!family || family.candidates.length === 0) return;
		if (matchesKey(data, "up") || data === "k") this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down") || data === "j") this.#selected = Math.min(family.candidates.length - 1, this.#selected + 1);
		else if (data === "u") this.onAction?.("rubric", family, this.#selected);
		else if (data === "i") this.onAction?.("inspect", family, this.#selected);
		else if (data === "c") this.onAction?.("copy", family, this.#selected);
		else if (data === "r") this.onAction?.("retry", family, this.#selected);
		else if (data === "d") this.onAction?.("discard", family, this.#selected);
		else if (data === "x") this.onAction?.("stop", family, this.#selected);
		else if (data === "v") this.onAction?.("review", family, this.#selected);
		else if (data === "a") this.onAction?.("adjudicate", family, this.#selected);
		else if (data === "s") this.onAction?.("select", family, this.#selected);
		else if (data === "p") this.onAction?.("approve", family, this.#selected);
		else if (data === "y") this.onAction?.("replay", family, this.#selected);
		else return;
		this.onRequestRender?.();
	}

	#selectFamily(index: number): void {
		const next = Math.max(0, Math.min(this.families.length - 1, index));
		if (next === this.#familySelected) return;
		this.#familySelected = next;
		this.#selected = 0;
		this.onRequestRender?.();
	}
}
