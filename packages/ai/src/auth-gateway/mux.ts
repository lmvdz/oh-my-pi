/**
 * Quota mux: map virtual `mux/cheap` and `mux/capable` model ids onto a live
 * backend. Cheap is a fixed OpenRouter/DeepSeek target. Capable walks a
 * subscription order and skips a seat once its 5-hour or 7-day window is
 * above the close thresholds — before the provider 429s.
 *
 * Session stickiness: a conversation that already bound to a capable seat
 * stays there until that seat closes, so Second Thought (same-model Anthropic
 * cache fork) is not reset mid-run by a hop.
 */

import { resolveUsedFraction, type UsageLimit, type UsageReport } from "../usage";

export type MuxLane = "cheap" | "capable";

export interface MuxTarget {
	provider: string;
	id: string;
}

export interface MuxPolicy {
	weeklyCloseAt: number;
	fiveHourCloseAt: number;
	/** Close mux/cheap when remaining OpenRouter USD drops to this (default 0.05). */
	cheapMinUsd?: number;
	cheap: MuxTarget;
	capableOrder: MuxTarget[];
}

export type MuxCloseReason = "five-hour" | "weekly" | "exhausted" | "unknown" | "credits";

export interface MuxSeatStatus {
	target: MuxTarget;
	open: boolean;
	fiveHour?: number;
	weekly?: number;
	reason?: MuxCloseReason;
}

export type MuxDecision =
	| { ok: true; lane: MuxLane; target: MuxTarget; sticky: boolean; reason: string }
	| { ok: false; lane: MuxLane; reason: string; seats: MuxSeatStatus[] };

export const MUX_CHEAP_ID = "mux/cheap";
export const MUX_CAPABLE_ID = "mux/capable";

export const DEFAULT_MUX_POLICY: MuxPolicy = {
	weeklyCloseAt: 0.7,
	fiveHourCloseAt: 0.6,
	cheapMinUsd: 0.05,
	cheap: { provider: "openrouter", id: "deepseek/deepseek-v4-flash" },
	capableOrder: [
		{ provider: "anthropic", id: "claude-opus-5" },
		{ provider: "openai-codex", id: "gpt-5.6-sol" },
		{ provider: "xai-oauth", id: "grok-4.6" },
	],
};

/** Parse `mux/cheap` / `mux/capable` (also bare `cheap` / `capable`). */
export function parseMuxLane(modelId: string): MuxLane | undefined {
	if (modelId === MUX_CHEAP_ID || modelId === "quota/cheap" || modelId === "cheap") return "cheap";
	if (modelId === MUX_CAPABLE_ID || modelId === "quota/capable" || modelId === "capable") return "capable";
	return undefined;
}

export function muxTargetKey(target: MuxTarget): string {
	return `${target.provider}/${target.id}`;
}

export function parseMuxTarget(spec: string): MuxTarget | undefined {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export function parseCapableOrder(spec: string): MuxTarget[] {
	return spec
		.split(",")
		.map(parseMuxTarget)
		.filter((target): target is MuxTarget => target !== undefined);
}

/**
 * Load policy from env. Empty / invalid values fall back to {@link DEFAULT_MUX_POLICY}.
 *
 * - `OMP_MUX_WEEKLY_CLOSE` / `OMP_MUX_FIVE_HOUR_CLOSE` — 0..1
 * - `OMP_MUX_CHEAP_MIN_USD` — close cheap at or below this remaining USD
 * - `OMP_MUX_CHEAP` — `provider/model` (model may contain slashes)
 * - `OMP_MUX_CAPABLE` — comma-separated `provider/model` list
 */
export function loadMuxPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): MuxPolicy {
	const weekly = parseUnitInterval(env.OMP_MUX_WEEKLY_CLOSE, DEFAULT_MUX_POLICY.weeklyCloseAt);
	const fiveHour = parseUnitInterval(env.OMP_MUX_FIVE_HOUR_CLOSE, DEFAULT_MUX_POLICY.fiveHourCloseAt);
	const cheapMinUsd = parseNonNegative(env.OMP_MUX_CHEAP_MIN_USD, DEFAULT_MUX_POLICY.cheapMinUsd);
	const cheap = (env.OMP_MUX_CHEAP ? parseMuxTarget(env.OMP_MUX_CHEAP) : undefined) ?? DEFAULT_MUX_POLICY.cheap;
	const capableOrder = env.OMP_MUX_CAPABLE
		? parseCapableOrder(env.OMP_MUX_CAPABLE)
		: DEFAULT_MUX_POLICY.capableOrder;
	return {
		weeklyCloseAt: weekly,
		fiveHourCloseAt: fiveHour,
		cheapMinUsd,
		cheap,
		capableOrder: capableOrder.length > 0 ? capableOrder : DEFAULT_MUX_POLICY.capableOrder,
	};
}

function parseUnitInterval(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
	return n;
}

function parseNonNegative(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return n;
}

export interface CheapCreditSnapshot {
	open: boolean;
	remainingUsd?: number;
	limitUsd?: number;
	usedUsd?: number;
	reason?: MuxCloseReason | "cheap-fixed";
}

/** Remaining OpenRouter USD on the cheap lane. Unknown remaining stays open. */
export function cheapCreditSnapshot(reports: UsageReport[], policy: MuxPolicy): CheapCreditSnapshot {
	const report = reports.find(r => r.provider === policy.cheap.provider);
	if (!report) return { open: true, reason: "unknown" };

	let remaining: number | undefined;
	let limit: number | undefined;
	let used: number | undefined;
	let exhausted = false;
	for (const entry of report.limits) {
		if (entry.amount.unit !== "usd") continue;
		if (entry.status === "exhausted") exhausted = true;
		if (entry.amount.remaining !== undefined) {
			remaining = remaining === undefined ? entry.amount.remaining : Math.min(remaining, entry.amount.remaining);
		}
		if (entry.amount.limit !== undefined) {
			limit = limit === undefined ? entry.amount.limit : Math.max(limit, entry.amount.limit);
		}
		if (entry.amount.used !== undefined) {
			used = used === undefined ? entry.amount.used : Math.max(used, entry.amount.used);
		}
	}

	const minUsd = policy.cheapMinUsd ?? DEFAULT_MUX_POLICY.cheapMinUsd;
	if (exhausted || (remaining !== undefined && remaining <= minUsd)) {
		return { open: false, remainingUsd: remaining, limitUsd: limit, usedUsd: used, reason: "credits" };
	}
	return { open: true, remainingUsd: remaining, limitUsd: limit, usedUsd: used, reason: "cheap-fixed" };
}

export function seatStatus(target: MuxTarget, reports: UsageReport[], policy: MuxPolicy): MuxSeatStatus {
	const report = reports.find(r => r.provider === target.provider);
	if (!report) {
		return { target, open: true, reason: "unknown" };
	}
	const fiveHour = peakFraction(report.limits, isFiveHourWindow);
	const weekly = peakFraction(report.limits, isWeeklyWindow);
	if (report.limits.some(limit => limit.status === "exhausted")) {
		return { target, open: false, fiveHour, weekly, reason: "exhausted" };
	}
	if (fiveHour !== undefined && fiveHour >= policy.fiveHourCloseAt) {
		return { target, open: false, fiveHour, weekly, reason: "five-hour" };
	}
	if (weekly !== undefined && weekly >= policy.weeklyCloseAt) {
		return { target, open: false, fiveHour, weekly, reason: "weekly" };
	}
	return { target, open: true, fiveHour, weekly };
}

function isFiveHourWindow(limit: UsageLimit): boolean {
	const id = `${limit.scope.windowId ?? ""} ${limit.window?.id ?? ""} ${limit.id}`;
	return /\b5h\b/i.test(id) || limit.window?.durationMs === 5 * 60 * 60 * 1000;
}

function isWeeklyWindow(limit: UsageLimit): boolean {
	const id = `${limit.scope.windowId ?? ""} ${limit.window?.id ?? ""} ${limit.id}`;
	return /\b7d\b/i.test(id) || /\bweekly\b/i.test(id) || limit.window?.durationMs === 7 * 24 * 60 * 60 * 1000;
}

function peakFraction(limits: UsageLimit[], match: (limit: UsageLimit) => boolean): number | undefined {
	let peak: number | undefined;
	for (const limit of limits) {
		if (!match(limit)) continue;
		const fraction = resolveUsedFraction(limit);
		if (fraction === undefined || !Number.isFinite(fraction)) continue;
		peak = peak === undefined ? fraction : Math.max(peak, fraction);
	}
	return peak;
}

export function decideMuxLane(
	lane: MuxLane,
	reports: UsageReport[],
	policy: MuxPolicy,
	sticky?: MuxTarget,
): MuxDecision {
	if (lane === "cheap") {
		const credit = cheapCreditSnapshot(reports, policy);
		if (!credit.open) {
			return {
				ok: false,
				lane,
				reason: "cheap-credits-exhausted",
				seats: [
					{
						target: policy.cheap,
						open: false,
						reason: "credits",
					},
				],
			};
		}
		return { ok: true, lane, target: policy.cheap, sticky: false, reason: credit.reason ?? "cheap-fixed" };
	}

	const seats = policy.capableOrder.map(target => seatStatus(target, reports, policy));

	if (sticky) {
		const current = seats.find(seat => muxTargetKey(seat.target) === muxTargetKey(sticky));
		if (current?.open) {
			return { ok: true, lane, target: sticky, sticky: true, reason: "session-sticky" };
		}
	}

	const openKnown = seats.find(seat => seat.open && seat.reason !== "unknown");
	const openUnknown = seats.find(seat => seat.open && seat.reason === "unknown");
	const picked = openKnown ?? openUnknown;
	if (!picked) {
		return { ok: false, lane, reason: "all-capable-seats-closed", seats };
	}
	return {
		ok: true,
		lane,
		target: picked.target,
		sticky: false,
		reason: picked.reason === "unknown" ? "no-usage-report" : "quota-open",
	};
}

/** In-process session → capable-seat binding. */
export class MuxRuntime {
	readonly policy: MuxPolicy;
	#sticky = new Map<string, MuxTarget>();

	constructor(policy: MuxPolicy = loadMuxPolicyFromEnv()) {
		this.policy = policy;
	}

	resolve(lane: MuxLane, reports: UsageReport[], sessionKey?: string): MuxDecision {
		const sticky = lane === "capable" && sessionKey ? this.#sticky.get(sessionKey) : undefined;
		const decision = decideMuxLane(lane, reports, this.policy, sticky);
		if (decision.ok && lane === "capable" && sessionKey) {
			this.#sticky.set(sessionKey, decision.target);
		}
		if (!decision.ok && sessionKey) {
			this.#sticky.delete(sessionKey);
		}
		return decision;
	}

	clearSession(sessionKey: string): void {
		this.#sticky.delete(sessionKey);
	}

	get stickySessions(): number {
		return this.#sticky.size;
	}
}

export function catalogIdsFor(target: MuxTarget): string[] {
	return [muxTargetKey(target), target.id];
}
