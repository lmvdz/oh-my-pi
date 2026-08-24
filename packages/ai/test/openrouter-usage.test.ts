import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ProviderHttpError } from "../src/error/classes";
import { OPENROUTER_CREDITS_LIMIT_ID, OPENROUTER_KEY_LIMIT_ID, openrouterUsageProvider } from "../src/usage/openrouter";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): FetchImpl {
	const fn = async (input: string | URL | Request) => {
		const url = String(input);
		const match = Object.entries(routes).find(([key]) => url.includes(key));
		if (!match) return new Response("not found", { status: 404 });
		const [, spec] = match;
		return new Response(JSON.stringify(spec.body), {
			status: spec.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

const cred = { type: "api_key" as const, apiKey: "sk-or-test" };

describe("openrouter usage provider", () => {
	it("prefers account credits remaining over key usage", async () => {
		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential: cred },
			{
				fetch: fakeFetch({
					"/api/v1/key": {
						body: { data: { label: "main", usage: 4.2, usage_daily: 0.1, is_free_tier: false, limit: null } },
					},
					"/api/v1/credits": { body: { data: { total_credits: 20, total_usage: 4.2 } } },
				}),
			},
		);
		expect(report).not.toBeNull();
		const credits = report?.limits.find(limit => limit.id === OPENROUTER_CREDITS_LIMIT_ID);
		expect(credits?.amount.remaining).toBeCloseTo(15.8, 5);
		expect(credits?.amount.used).toBeCloseTo(4.2, 5);
		expect(credits?.amount.unit).toBe("usd");
		expect(credits?.status).toBe("ok");
		expect(report?.metadata?.isFreeTier).toBe(false);
	});

	it("marks remaining $0 as exhausted", async () => {
		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential: cred },
			{
				fetch: fakeFetch({
					"/api/v1/key": { body: { data: { usage: 5, limit: 5, limit_remaining: 0 } } },
					"/api/v1/credits": { body: { data: { total_credits: 5, total_usage: 5 } } },
				}),
			},
		);
		const credits = report?.limits.find(limit => limit.id === OPENROUTER_CREDITS_LIMIT_ID);
		const key = report?.limits.find(limit => limit.id === OPENROUTER_KEY_LIMIT_ID);
		expect(credits?.status).toBe("exhausted");
		expect(key?.status).toBe("exhausted");
		expect(key?.amount.remaining).toBe(0);
	});

	it("throws on a 401 from /key so credential check is red", async () => {
		await expect(
			openrouterUsageProvider.fetchUsage(
				{ provider: "openrouter", credential: cred },
				{ fetch: fakeFetch({ "/api/v1/key": { status: 401, body: { error: "unauthorized" } } }) },
			),
		).rejects.toBeInstanceOf(ProviderHttpError);
	});

	it("tolerates /credits 401 when the key has no spend cap", async () => {
		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential: cred },
			{
				fetch: fakeFetch({
					"/api/v1/key": { body: { data: { usage: 1.25, limit: null, is_free_tier: true } } },
					"/api/v1/credits": { status: 401, body: { error: "management key required" } },
				}),
			},
		);
		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]?.status).toBe("unknown");
		expect(report?.limits[0]?.amount.used).toBeCloseTo(1.25, 5);
	});
});
