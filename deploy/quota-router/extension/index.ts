/**
 * Auto-start the quota-router sidecar from any omp (including PATH 17.1.8).
 * First-class equivalent lives in the 17.3.7 clone (`quotaRouter.enabled`).
 *
 * Drop this directory at ~/.omp/agent/extensions/quota-router/
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Pi = {
	on: (event: string, handler: () => void | Promise<void>) => void;
};

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function readConfig(): {
	enabled: boolean;
	switchyard: boolean;
	root: string;
	gatewayBind: string;
	switchyardBind: string;
	brokerUrl: string;
} {
	const defaults = {
		enabled: false,
		switchyard: true,
		root: path.join(os.homedir(), "src", "omp-quota-router"),
		gatewayBind: "127.0.0.1:4010",
		switchyardBind: "127.0.0.1:4001",
		brokerUrl: "http://127.0.0.1:8765",
	};
	try {
		const raw = fs.readFileSync(path.join(os.homedir(), ".omp", "agent", "config.yml"), "utf8");
		const block = raw.match(/(?:^|\n)quotaRouter:\n((?:[ \t]+.+\n?)*)/);
		if (!block) return defaults;
		const get = (key: string): string | undefined => {
			const m = block[1]?.match(new RegExp(`(?:^|\\n)[ \\t]+${key}:[ \\t]*(\\S+)`));
			return m?.[1]?.replace(/^["']|["']$/g, "");
		};
		return {
			enabled: get("enabled") === "true",
			switchyard: get("switchyard") !== "false",
			root: expandHome(get("root") ?? defaults.root),
			gatewayBind: get("gatewayBind") ?? defaults.gatewayBind,
			switchyardBind: get("switchyardBind") ?? defaults.switchyardBind,
			brokerUrl: get("brokerUrl") ?? defaults.brokerUrl,
		};
	} catch {
		return defaults;
	}
}

function applyToken(): void {
	if (process.env.OMP_AUTH_GATEWAY_TOKEN) return;
	try {
		const token = fs.readFileSync(path.join(os.homedir(), ".omp", "auth-gateway.token"), "utf8").trim();
		if (token) process.env.OMP_AUTH_GATEWAY_TOKEN = token;
	} catch {
		// created on first gateway serve
	}
}

async function ok(url: string): Promise<boolean> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), 800);
	try {
		const res = await fetch(url, { signal: ac.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(t);
	}
}

async function ensure(): Promise<void> {
	const cfg = readConfig();
	if (!cfg.enabled) return;
	if (!process.env.OMP_AUTH_BROKER_URL) process.env.OMP_AUTH_BROKER_URL = cfg.brokerUrl;
	applyToken();
	const gatewayUp = await ok(`http://${cfg.gatewayBind}/healthz`);
	const switchyardUp = cfg.switchyard ? await ok(`http://${cfg.switchyardBind}/health`) : true;
	if (gatewayUp && switchyardUp) {
		applyToken();
		return;
	}
	const script = path.join(cfg.root, "deploy", "quota-router", "start.sh");
	if (!fs.existsSync(script)) return;
	const args = [script, "--gateway-bind", cfg.gatewayBind, "--switchyard-bind", cfg.switchyardBind];
	if (cfg.switchyard) args.splice(1, 0, "--with-switchyard");
	const logFd = fs.openSync(path.join(os.tmpdir(), `omp-quota-router-${process.getuid?.() ?? "user"}.log`), "a");
	const extraPath = [
		path.join(os.homedir(), ".cargo", "bin"),
		path.join(os.homedir(), ".volta", "bin"),
		process.env.PATH ?? "",
	].join(path.delimiter);
	const child = spawn("bash", args, {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env, PATH: extraPath },
		cwd: cfg.root,
	});
	child.unref();
	fs.closeSync(logFd);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if ((await ok(`http://${cfg.gatewayBind}/healthz`)) && (!cfg.switchyard || (await ok(`http://${cfg.switchyardBind}/health`)))) {
			applyToken();
			return;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	applyToken();
}

export default function (pi: Pi): void {
	const pending = ensure();
	pi.on("session_start", () => pending);
}
