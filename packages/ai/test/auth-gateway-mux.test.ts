import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	decideMuxLane,
	DEFAULT_MUX_POLICY,
	loadMuxPolicyFromEnv,
	MuxRuntime,
	parseCapableOrder,
	parseMuxLane,
	parseMuxTarget,
	seatStatus,
} from "@oh-my-pi/pi-ai/auth-gateway/mux";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";

function limit(partial: {
	id: string;
	windowId: string;
	usedFraction: number;
	status?: UsageLimit["status"];
	provider?: string;
}): UsageLimit {
	return {
		id: partial.id,
		label: partial.id,
		scope: { provider: (partial.provider ?? "anthropic") as UsageLimit["scope"]["provider"], windowId: partial.windowId },
		window: { id: partial.windowId, label: partial.windowId },
		amount: { usedFraction: partial.usedFraction, unit: "percent" },
		status: partial.status ?? "ok",
	};
}

function report(provider: string, limits: UsageLimit[]): UsageReport {
	return { provider: provider as UsageReport["provider"], fetchedAt: Date.now(), limits };
}

describe("mux policy parse", () => {
	it("recognizes virtual model ids", () => {
		expect(parseMuxLane("mux/cheap")).toBe("cheap");
		expect(parseMuxLane("mux/capable")).toBe("capable");
		expect(parseMuxLane("cheap")).toBe("cheap");
		expect(parseMuxLane("quota/cheap")).toBe("cheap");
		expect(parseMuxLane("anthropic/claude-opus-5")).toBeUndefined();
	});

	it("splits provider/model with slashes in the model id", () => {
		expect(parseMuxTarget("openrouter/deepseek/deepseek-v4-flash")).toEqual({
			provider: "openrouter",
			id: "deepseek/deepseek-v4-flash",
		});
		expect(parseCapableOrder("anthropic/claude-opus-5,openai-codex/gpt-5.6-sol")).toEqual([
			{ provider: "anthropic", id: "claude-opus-5" },
			{ provider: "openai-codex", id: "gpt-5.6-sol" },
		]);
	});

	it("loads env overrides", () => {
		const policy = loadMuxPolicyFromEnv({
			OMP_MUX_WEEKLY_CLOSE: "0.65",
			OMP_MUX_FIVE_HOUR_CLOSE: "0.5",
			OMP_MUX_CHEAP: "deepseek/deepseek-v4-flash",
			OMP_MUX_CHEAP_MAX_OUTPUT_TOKENS: "2048",
			OMP_MUX_CAPABLE: "anthropic/claude-fable-5,xai-oauth/grok-4.6",
		});
		expect(policy.weeklyCloseAt).toBe(0.65);
		expect(policy.fiveHourCloseAt).toBe(0.5);
		expect(policy.cheapMinUsd).toBe(0.05);
		expect(policy.cheapMaxOutputTokens).toBe(2048);
		expect(policy.cheap).toEqual({ provider: "deepseek", id: "deepseek-v4-flash" });
		expect(policy.capableOrder).toEqual([
			{ provider: "anthropic", id: "claude-fable-5" },
			{ provider: "xai-oauth", id: "grok-4.6" },
		]);
	});

	it("defaults cheapMaxOutputTokens in the default policy", () => {
		expect(DEFAULT_MUX_POLICY.cheapMaxOutputTokens).toBe(4096);
	});
});

describe("mux seat + decide", () => {
	const policy = DEFAULT_MUX_POLICY;
	const anthropic = policy.capableOrder[0]!;
	const codex = policy.capableOrder[1]!;

	it("closes a seat at the 7-day threshold without waiting for 429", () => {
		const status = seatStatus(
			anthropic,
			[report("anthropic", [limit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.71 })])],
			policy,
		);
		expect(status.open).toBe(false);
		expect(status.reason).toBe("weekly");
	});

	it("closes a seat at the 5-hour threshold", () => {
		const status = seatStatus(
			anthropic,
			[report("anthropic", [limit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.61 })])],
			policy,
		);
		expect(status.open).toBe(false);
		expect(status.reason).toBe("five-hour");
	});

	it("stays open below both thresholds", () => {
		const status = seatStatus(
			anthropic,
			[
				report("anthropic", [
					limit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.2 }),
					limit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.4 }),
				]),
			],
			policy,
		);
		expect(status.open).toBe(true);
	});

	it("walks capable order onto the next open seat", () => {
		const decision = decideMuxLane(
			"capable",
			[report("anthropic", [limit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.95 })])],
			policy,
		);
		expect(decision.ok).toBe(true);
		if (decision.ok) {
			expect(decision.target).toEqual(codex);
			expect(decision.reason).toBe("no-usage-report");
		}
	});

	it("overflows to cheap when every capable seat is closed", () => {
		const reports = policy.capableOrder.map(target =>
			report(target.provider, [limit({ id: `${target.provider}:7d`, windowId: "7d", usedFraction: 0.99, provider: target.provider })]),
		);
		const decision = decideMuxLane("capable", reports, policy);
		expect(decision.ok).toBe(true);
		if (decision.ok) {
			expect(decision.reason).toBe("capable-overflow");
			expect(decision.target).toEqual(policy.cheap);
		}
	});

	it("returns 503 when capable closed and cheap credits exhausted", () => {
		const closedSeats = policy.capableOrder.map(target =>
			report(target.provider, [limit({ id: `${target.provider}:7d`, windowId: "7d", usedFraction: 0.99, provider: target.provider })]),
		);
		const noCredits = report("openrouter", [
			{
				id: "openrouter:credits",
				label: "OpenRouter credits",
				scope: { provider: "openrouter", windowId: "credits" },
				amount: { remaining: 0, used: 10, limit: 10, usedFraction: 1, unit: "usd" },
				status: "exhausted",
			},
		]);
		const decision = decideMuxLane("capable", [...closedSeats, noCredits], policy);
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toBe("all-capable-seats-closed");
	});

	it("keeps a capable session on the same seat until it closes", () => {
		const mux = new MuxRuntime(policy);
		const open = mux.resolve("capable", [], "sess-1");
		expect(open.ok && open.target.provider).toBe("anthropic");
		const again = mux.resolve(
			"capable",
			[report("anthropic", [limit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.4 })])],
			"sess-1",
		);
		expect(again.ok && again.sticky).toBe(true);
		expect(again.ok && again.target.provider).toBe("anthropic");
		const hopped = mux.resolve(
			"capable",
			[report("anthropic", [limit({ id: "anthropic:7d", windowId: "7d", usedFraction: 0.9 })])],
			"sess-1",
		);
		expect(hopped.ok && hopped.sticky).toBe(false);
		expect(hopped.ok && hopped.target.provider).toBe("openai-codex");
	});

	it("keeps cheap open when there is no OpenRouter usage report", () => {
		const decision = decideMuxLane("cheap", [], policy);
		expect(decision).toEqual({
			ok: true,
			lane: "cheap",
			target: policy.cheap,
			sticky: false,
			reason: "unknown",
		});
	});

	it("closes cheap when OpenRouter remaining USD is at the floor", () => {
		const decision = decideMuxLane(
			"cheap",
			[
				report("openrouter", [
					{
						id: "openrouter:credits",
						label: "OpenRouter credits",
						scope: { provider: "openrouter", windowId: "credits" },
						amount: { remaining: 0, used: 10, limit: 10, usedFraction: 1, unit: "usd" },
						status: "exhausted",
					},
				]),
			],
			policy,
		);
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.reason).toBe("cheap-credits-exhausted");
	});
});

describe("auth-gateway mux wire", () => {
	it("rewrites mux/cheap onto the configured cheap model", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-mux-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("mock", "test-key");
		const flash = createMockModel({
			provider: "mock",
			id: "flash",
			handler: () => ({ content: ["cheap-ok"] }),
		});
		const opus = createMockModel({
			provider: "mock",
			id: "opus",
			handler: () => ({ content: ["capable-ok"] }),
		});
		const mux = new MuxRuntime({
			weeklyCloseAt: 0.7,
			fiveHourCloseAt: 0.6,
			cheap: { provider: "mock", id: "flash" },
			capableOrder: [{ provider: "mock", id: "opus" }],
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			mux,
			resolveModel: id => {
				if (id === "mock/flash" || id === "flash") return flash.model;
				if (id === "mock/opus" || id === "opus") return opus.model;
				return undefined;
			},
			version: "test",
		});
		try {
			const cheap = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mux/cheap",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			expect(cheap.status).toBe(200);
			expect(cheap.headers.get("x-omp-mux-lane")).toBe("cheap");
			expect(cheap.headers.get("x-omp-mux-target")).toBe("mock/flash");
			expect(flash.calls).toHaveLength(1);
			expect(opus.calls).toHaveLength(0);

			const capable = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mux/capable",
					messages: [{ role: "user", content: "hard" }],
					stream: false,
				}),
			});
			expect(capable.status).toBe(200);
			expect(capable.headers.get("x-omp-mux-target")).toBe("mock/opus");
			expect(opus.calls).toHaveLength(1);

			const status = await fetch(`${handle.url}/v1/mux`, { headers: { Authorization: "Bearer t" } });
			expect(status.status).toBe(200);
			const body = (await status.json()) as { stickySessions: number };
			expect(body.stickySessions).toBe(1);
		} finally {
			await handle.close();
			storage.close();
		}
	});

	it("returns 503 when capable seats are closed", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-mux-closed-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"), {
			fetchUsageReports: async () => [
				report("mock", [limit({ id: "mock:7d", windowId: "7d", usedFraction: 0.99, provider: "mock" })]),
			],
		});
		storage.setRuntimeApiKey("mock", "test-key");
		const opus = createMockModel({
			provider: "mock",
			id: "opus",
			handler: () => ({ content: ["should-not-run"] }),
		});
		const flash = createMockModel({
			provider: "mock",
			id: "flash",
			handler: () => ({ content: ["overflow-served"] }),
		});
		const mux = new MuxRuntime({
			weeklyCloseAt: 0.7,
			fiveHourCloseAt: 0.6,
			cheap: { provider: "mock", id: "flash" },
			capableOrder: [{ provider: "mock", id: "opus" }],
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			mux,
			resolveModel: id => (id === "mock/flash" || id === "flash" ? flash.model : opus.model),
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mux/capable",
					messages: [{ role: "user", content: "hard" }],
					stream: false,
				}),
			});
			// Capable seats closed → overflow serves cheap (flash) with a 200
			expect(res.status).toBe(200);
			const body = (await res.json()) as { model?: string };
			expect(body.model).toBe("mock/flash");
			expect(res.headers.get("x-omp-mux-lane")).toBe("capable");
			expect(res.headers.get("x-omp-mux-target")).toBe("mock/flash");
			expect(res.headers.get("x-omp-mux-reason")).toBe("capable-overflow");
			expect(opus.calls).toHaveLength(0);
		} finally {
			await handle.close();
			storage.close();
		}
	});
});
