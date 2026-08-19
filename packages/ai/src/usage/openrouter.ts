/**
 * OpenRouter credit probe. A $0 balance 402s paid models (and often comes
 * back through a proxy as an empty `stop` with zero tokens). We read the
 * regular API-key endpoints so the mux can fail cheap closed instead.
 *
 *   GET /api/v1/key      — per-key cap + usage (any sk-or- key)
 *   GET /api/v1/credits  — account purchased vs used (best-effort; some keys 401)
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { ProviderHttpError } from "../error/classes";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { usageStatus } from "./shared";

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

const OPENROUTER_PROVIDER = "openrouter" as const;

export const OPENROUTER_CREDITS_LIMIT_ID = "openrouter:credits";
export const OPENROUTER_KEY_LIMIT_ID = "openrouter:key-limit";

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function unwrapData(payload: unknown): Record<string, unknown> | undefined {
	if (!isRecord(payload)) return undefined;
	if (isRecord(payload.data)) return payload.data;
	return payload;
}

function usdAmount(args: { used?: number; limit?: number; remaining?: number }): UsageAmount {
	let { used, limit, remaining } = args;
	if (used === undefined && limit !== undefined && remaining !== undefined) {
		used = Math.max(limit - remaining, 0);
	}
	if (remaining === undefined && limit !== undefined && used !== undefined) {
		remaining = Math.max(limit - used, 0);
	}
	let usedFraction: number | undefined;
	if (used !== undefined && limit !== undefined && limit > 0) {
		usedFraction = Math.min(Math.max(used / limit, 0), 1);
	} else if (remaining !== undefined && remaining <= 0 && (used === undefined || used > 0)) {
		usedFraction = 1;
	}
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		...(used !== undefined ? { used } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(remaining !== undefined ? { remaining } : {}),
		...(usedFraction !== undefined ? { usedFraction } : {}),
		...(remainingFraction !== undefined ? { remainingFraction } : {}),
		unit: "usd",
	};
}

async function fetchJson(
	ctx: UsageFetchContext,
	url: string,
	apiKey: string,
	signal: AbortSignal | undefined,
	opts: { throwOnAuth: boolean },
): Promise<unknown | null> {
	const response = await ctx.fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		signal,
	});
	if (response.status === 401 || response.status === 403) {
		if (opts.throwOnAuth) {
			throw new ProviderHttpError(
				`OpenRouter ${url} returned ${response.status} ${response.statusText}`.trim(),
				response.status,
			);
		}
		return null;
	}
	if (!response.ok) {
		ctx.logger?.warn("OpenRouter usage fetch failed", {
			url,
			status: response.status,
			statusText: response.statusText,
		});
		return null;
	}
	return response.json();
}

export async function fetchOpenRouterUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (params.provider !== OPENROUTER_PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	let keyPayload: unknown;
	try {
		keyPayload = await fetchJson(ctx, KEY_URL, credential.apiKey, params.signal, { throwOnAuth: true });
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("OpenRouter key usage fetch error", { error: String(error) });
		return null;
	}
	const key = unwrapData(keyPayload);
	if (!key) return null;

	let creditsPayload: unknown = null;
	try {
		creditsPayload = await fetchJson(ctx, CREDITS_URL, credential.apiKey, params.signal, { throwOnAuth: false });
	} catch (error) {
		ctx.logger?.warn("OpenRouter credits fetch error", { error: String(error) });
	}
	const credits = unwrapData(creditsPayload);

	const limits: UsageLimit[] = [];

	const totalCredits = asFiniteNumber(credits?.total_credits);
	const totalUsage = asFiniteNumber(credits?.total_usage);
	if (totalCredits !== undefined || totalUsage !== undefined) {
		const amount = usdAmount({
			used: totalUsage,
			limit: totalCredits,
			remaining:
				totalCredits !== undefined && totalUsage !== undefined
					? Math.max(totalCredits - totalUsage, 0)
					: undefined,
		});
		limits.push({
			id: OPENROUTER_CREDITS_LIMIT_ID,
			label: "OpenRouter credits",
			scope: { provider: OPENROUTER_PROVIDER, windowId: "credits", shared: true },
			amount,
			status: amount.remaining !== undefined && amount.remaining <= 0 ? "exhausted" : usageStatus(amount.usedFraction),
		});
	}

	const keyLimit = asFiniteNumber(key.limit);
	const keyRemaining = asFiniteNumber(key.limit_remaining);
	if (keyLimit !== undefined || keyRemaining !== undefined) {
		const amount = usdAmount({
			used: asFiniteNumber(key.usage),
			limit: keyLimit,
			remaining: keyRemaining,
		});
		limits.push({
			id: OPENROUTER_KEY_LIMIT_ID,
			label: "OpenRouter key spend cap",
			scope: { provider: OPENROUTER_PROVIDER, windowId: "key", shared: false },
			amount,
			status: amount.remaining !== undefined && amount.remaining <= 0 ? "exhausted" : usageStatus(amount.usedFraction),
		});
	}

	// Unlimited key and no /credits body: still report lifetime usage so the
	// check endpoint is green, but do not invent a remaining balance.
	if (limits.length === 0) {
		const used = asFiniteNumber(key.usage);
		limits.push({
			id: OPENROUTER_CREDITS_LIMIT_ID,
			label: "OpenRouter usage (no remaining visible)",
			scope: { provider: OPENROUTER_PROVIDER, windowId: "credits", shared: true },
			amount: { ...(used !== undefined ? { used } : {}), unit: "usd" },
			status: "unknown",
			notes: ["Key has no spend cap and /credits did not return a balance."],
		});
	}

	return {
		provider: OPENROUTER_PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: KEY_URL,
			label: typeof key.label === "string" ? key.label : undefined,
			isFreeTier: key.is_free_tier === true,
			usageDaily: asFiniteNumber(key.usage_daily),
			usageWeekly: asFiniteNumber(key.usage_weekly),
			usageMonthly: asFiniteNumber(key.usage_monthly),
		},
		raw: { key: keyPayload, credits: creditsPayload },
	};
}

export const openrouterUsageProvider: UsageProvider = {
	id: OPENROUTER_PROVIDER,
	fetchUsage: fetchOpenRouterUsage,
	supports: params => params.provider === OPENROUTER_PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
