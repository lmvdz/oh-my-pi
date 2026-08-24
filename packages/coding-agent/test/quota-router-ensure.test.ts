import { describe, expect, it } from "bun:test";
import { ensureQuotaRouter, parseQuotaRouterSettings } from "../src/quota-router/ensure";

describe("parseQuotaRouterSettings", () => {
	it("stays off unless enabled is true", () => {
		expect(parseQuotaRouterSettings(undefined).enabled).toBe(false);
		expect(parseQuotaRouterSettings({}).enabled).toBe(false);
		expect(parseQuotaRouterSettings({ enabled: true }).enabled).toBe(true);
	});

	it("defaults the three services on and expands ~ in root", () => {
		const cfg = parseQuotaRouterSettings({ enabled: true, root: "~/src/omp-quota-router" });
		expect(cfg.broker).toBe(true);
		expect(cfg.gateway).toBe(true);
		expect(cfg.switchyard).toBe(true);
		expect(cfg.root.endsWith("/src/omp-quota-router")).toBe(true);
		expect(cfg.root.includes("~")).toBe(false);
	});
});

describe("ensureQuotaRouter", () => {
	const base = parseQuotaRouterSettings({
		enabled: true,
		root: "/tmp/missing-quota-router",
		gatewayBind: "127.0.0.1:4010",
		switchyardBind: "127.0.0.1:4001",
		brokerUrl: "http://127.0.0.1:8765",
	});

	it("no-ops when disabled", async () => {
		const result = await ensureQuotaRouter({ ...base, enabled: false });
		expect(result).toEqual({ ok: true, started: false, detail: "disabled" });
	});

	it("does not spawn when the stack is already healthy", async () => {
		let spawned = 0;
		const result = await ensureQuotaRouter(base, {
			health: async () => ({ broker: true, gateway: true, switchyard: true }),
			spawnStart: () => {
				spawned++;
			},
		});
		expect(spawned).toBe(0);
		expect(result.ok).toBe(true);
		expect(result.started).toBe(false);
		expect(result.detail).toContain("already up");
	});

	it("spawns start.sh and waits until health flips", async () => {
		let spawned = 0;
		let healthy = false;
		const result = await ensureQuotaRouter(base, {
			health: async () =>
				healthy
					? { broker: true, gateway: true, switchyard: true }
					: { broker: true, gateway: false, switchyard: false },
			spawnStart: () => {
				spawned++;
				healthy = true;
			},
			waitMs: 1000,
			pollMs: 10,
		});
		expect(spawned).toBe(1);
		expect(result).toEqual({ ok: true, started: true, detail: "started gateway 127.0.0.1:4010" });
	});

	it("reports a missing start.sh instead of hanging", async () => {
		const result = await ensureQuotaRouter(base, {
			health: async () => ({ broker: false, gateway: false, switchyard: false }),
		});
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("missing");
	});
});
