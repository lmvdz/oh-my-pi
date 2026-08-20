/**
 * Bring up the quota-router sidecar (broker → mux gateway → Switchyard)
 * from an interactive `omp` boot when `quotaRouter.enabled` is set.
 *
 * Idempotent: a healthy stack is left alone. The TUI process always gets
 * `OMP_AUTH_GATEWAY_TOKEN` from the gateway token file so models.yml resolves.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";

export interface QuotaRouterConfig {
	enabled: boolean;
	broker: boolean;
	gateway: boolean;
	switchyard: boolean;
	root: string;
	gatewayBind: string;
	switchyardBind: string;
	brokerUrl: string;
	muxCheap: string;
	muxCapable: string;
	muxVision: string;
}

export interface EnsureQuotaRouterResult {
	ok: boolean;
	started: boolean;
	detail: string;
}

export const DEFAULT_QUOTA_ROUTER: Omit<QuotaRouterConfig, "enabled"> = {
	broker: true,
	gateway: true,
	switchyard: true,
	root: path.join(homedir(), "src", "omp-quota-router"),
	gatewayBind: "127.0.0.1:4010",
	switchyardBind: "127.0.0.1:4001",
	brokerUrl: "http://127.0.0.1:8765",
	muxCheap: "openrouter/deepseek/deepseek-v4-flash",
	muxCapable: "anthropic/claude-opus-5,openai-codex/gpt-5.6-sol,xai-oauth/grok-4.6",
	muxVision: "openrouter/qwen/qwen3.8-27b",
};

export function parseQuotaRouterSettings(raw: unknown): QuotaRouterConfig {
	const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const enabled = rec.enabled === true;
	return {
		enabled,
		broker: rec.broker !== false,
		gateway: rec.gateway !== false,
		switchyard: rec.switchyard !== false,
		root: typeof rec.root === "string" && rec.root.trim() ? expandHome(rec.root.trim()) : DEFAULT_QUOTA_ROUTER.root,
		gatewayBind:
			typeof rec.gatewayBind === "string" && rec.gatewayBind.trim()
				? rec.gatewayBind.trim()
				: DEFAULT_QUOTA_ROUTER.gatewayBind,
		switchyardBind:
			typeof rec.switchyardBind === "string" && rec.switchyardBind.trim()
				? rec.switchyardBind.trim()
				: DEFAULT_QUOTA_ROUTER.switchyardBind,
		brokerUrl:
			typeof rec.brokerUrl === "string" && rec.brokerUrl.trim()
				? rec.brokerUrl.trim()
				: DEFAULT_QUOTA_ROUTER.brokerUrl,
		muxCheap:
			typeof rec.muxCheap === "string" && rec.muxCheap.trim() ? rec.muxCheap.trim() : DEFAULT_QUOTA_ROUTER.muxCheap,
		muxCapable:
			typeof rec.muxCapable === "string" && rec.muxCapable.trim()
				? rec.muxCapable.trim()
				: DEFAULT_QUOTA_ROUTER.muxCapable,
		muxVision:
			typeof rec.muxVision === "string" && rec.muxVision.trim()
				? rec.muxVision.trim()
				: DEFAULT_QUOTA_ROUTER.muxVision,
	};
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
	return p;
}

export function gatewayTokenPath(): string {
	return path.join(homedir(), ".omp", "auth-gateway.token");
}

/** Put the inbound gateway bearer into this process so models.yml `apiKey: OMP_AUTH_GATEWAY_TOKEN` resolves. */
export function applyQuotaRouterEnv(cfg: QuotaRouterConfig): void {
	if (!process.env.OMP_AUTH_BROKER_URL) {
		process.env.OMP_AUTH_BROKER_URL = cfg.brokerUrl;
	}
	if (cfg.muxCheap) process.env.OMP_MUX_CHEAP = cfg.muxCheap;
	if (cfg.muxCapable) process.env.OMP_MUX_CAPABLE = cfg.muxCapable;
	if (cfg.muxVision) process.env.OMP_MUX_VISION = cfg.muxVision;
	const tokenFile = gatewayTokenPath();
	if (process.env.OMP_AUTH_GATEWAY_TOKEN) return;
	try {
		const token = fs.readFileSync(tokenFile, "utf8").trim();
		if (token) process.env.OMP_AUTH_GATEWAY_TOKEN = token;
	} catch {
		// Token is created on first gateway serve; start.sh will write it.
	}
}

export async function httpOk(url: string, timeoutMs = 800): Promise<boolean> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ac.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(t);
	}
}

export async function stackHealth(
	cfg: QuotaRouterConfig,
): Promise<{ broker: boolean; gateway: boolean; switchyard: boolean }> {
	const broker = cfg.broker ? await httpOk(`${cfg.brokerUrl.replace(/\/$/, "")}/v1/healthz`) : true;
	const gateway = cfg.gateway ? await httpOk(`http://${cfg.gatewayBind}/healthz`) : true;
	const switchyard = cfg.switchyard ? await httpOk(`http://${cfg.switchyardBind}/health`) : true;
	return { broker, gateway, switchyard };
}

export function startScriptPath(cfg: QuotaRouterConfig): string {
	return path.join(cfg.root, "deploy", "quota-router", "start.sh");
}

export interface EnsureQuotaRouterDeps {
	health?: typeof stackHealth;
	spawnStart?: (cfg: QuotaRouterConfig) => void;
	waitMs?: number;
	pollMs?: number;
}

export async function ensureQuotaRouter(
	cfg: QuotaRouterConfig,
	deps: EnsureQuotaRouterDeps = {},
): Promise<EnsureQuotaRouterResult> {
	if (!cfg.enabled) {
		return { ok: true, started: false, detail: "disabled" };
	}

	applyQuotaRouterEnv(cfg);
	const health = deps.health ?? stackHealth;
	const before = await health(cfg);
	if (before.broker && before.gateway && before.switchyard) {
		applyQuotaRouterEnv(cfg);
		return { ok: true, started: false, detail: `already up gateway ${cfg.gatewayBind}` };
	}

	if (!deps.spawnStart && !fs.existsSync(startScriptPath(cfg))) {
		return { ok: false, started: false, detail: `missing ${startScriptPath(cfg)}` };
	}

	(deps.spawnStart ?? spawnStartScript)(cfg);

	const deadline = Date.now() + (deps.waitMs ?? 20_000);
	const poll = deps.pollMs ?? 200;
	while (Date.now() < deadline) {
		const now = await health(cfg);
		if (now.broker && now.gateway && now.switchyard) {
			applyQuotaRouterEnv(cfg);
			return { ok: true, started: true, detail: `started gateway ${cfg.gatewayBind}` };
		}
		await new Promise(r => setTimeout(r, poll));
	}

	const after = await health(cfg);
	const missing = [
		!after.broker ? "broker" : "",
		!after.gateway ? "gateway" : "",
		!after.switchyard ? "switchyard" : "",
	]
		.filter(Boolean)
		.join(",");
	return { ok: false, started: true, detail: `timed out waiting for ${missing || "stack"}` };
}

function spawnStartScript(cfg: QuotaRouterConfig): void {
	const script = startScriptPath(cfg);
	const args = [script];
	if (cfg.switchyard) args.push("--with-switchyard");
	if (!cfg.broker) args.push("--no-broker-start");
	args.push("--gateway-bind", cfg.gatewayBind, "--switchyard-bind", cfg.switchyardBind, "--broker-url", cfg.brokerUrl);

	const logPath = path.join(os.tmpdir(), `omp-quota-router-${process.getuid?.() ?? process.pid}.log`);
	const logFd = fs.openSync(logPath, "a");
	const home = homedir();
	const extraPath = [path.join(home, ".cargo", "bin"), path.join(home, ".volta", "bin"), process.env.PATH ?? ""].join(
		path.delimiter,
	);

	const child = spawn("bash", args, {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env, PATH: extraPath },
		cwd: cfg.root,
	});
	child.unref();
	fs.closeSync(logFd);
}
