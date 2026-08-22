import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb, getRecentRoutingDecisions, initDb, insertRoutingDecisions } from "@oh-my-pi/omp-stats/db";
import { syncRoutingLog } from "@oh-my-pi/omp-stats/routing-log";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTokens(n: number | null | undefined): string {
	if (!n) return "";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

const SCANNED_CACHE_PATH = path.join(os.homedir(), ".omp", ".scanned-sessions.json");

async function loadScannedCache(): Promise<Set<string>> {
	try { return new Set(JSON.parse(await Bun.file(SCANNED_CACHE_PATH).text())); } catch { return new Set(); }
}
async function saveScannedCache(set: Set<string>): Promise<void> {
	await Bun.write(SCANNED_CACHE_PATH, JSON.stringify([...set]));
}

async function syncSessionMuxDecisions(): Promise<void> {
	const dir = path.join(os.homedir(), ".omp", "agent", "sessions");
	let entries: Dirent[];
	try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
	const fullyScanned = await loadScannedCache();
	const cutoff = Date.now() - 60 * 60 * 1000;
	const batch: Array<{
		ts: number; mux_lane: string; mux_target: string; mux_reason: string; mux_success: number;
	}> = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		if (fullyScanned.has(e.name)) continue;
		const fullPath = path.join(dir, e.name);
		let stat: Stats;
		try { stat = await fs.stat(fullPath); } catch { continue; }
		if (stat.mtimeMs < cutoff) { fullyScanned.add(e.name); continue; }
		let files: string[];
		try { files = await fs.readdir(fullPath); } catch { continue; }
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const text = await Bun.file(path.join(fullPath, f)).text();
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (!t) continue;
				try {
					const d = JSON.parse(t);
					if (d.type === "mux_decision") {
						batch.push({ ts: new Date(d.timestamp).getTime(), mux_lane: d.lane, mux_target: d.target, mux_reason: d.reason, mux_success: d.success ? 1 : 0 });
					}
				} catch {}
			}
		}
		fullyScanned.add(e.name);
	}
	if (batch.length > 0) insertRoutingDecisions(batch);
	await saveScannedCache(fullyScanned);
}

export const BUILTIN_FLEET_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "fleet",
		description: "Show fleet routing status from Switchyard and mux",
		allowArgs: true,
		inlineHint: "status|watch [--interval <s>]|restart",
		subcommands: [
			{ name: "status", description: "Show current routing state" },
			{ name: "watch", description: "Continuously monitor routing", usage: "[--interval <seconds>]" },
			{ name: "restart", description: "Restart the quota-router stack (gateway + switchyard)" },
		],
		handle: async (command, runtime) => {
			const tokens = command.args.trim().split(/\s+/).filter(Boolean);

			// --- restart ---
			if (tokens[0] === "restart") {
				await runtime.output("Restarting quota-router stack...");
				try {
					const { parseQuotaRouterSettings } = await import("../quota-router/ensure");
					const settings = runtime.settings;
					const qr = parseQuotaRouterSettings({
						enabled: true,
						broker: settings.get("quotaRouter.broker"),
						gateway: settings.get("quotaRouter.gateway"),
						switchyard: settings.get("quotaRouter.switchyard"),
						root: settings.get("quotaRouter.root"),
						gatewayBind: settings.get("quotaRouter.gatewayBind"),
						switchyardBind: settings.get("quotaRouter.switchyardBind"),
						brokerUrl: settings.get("quotaRouter.brokerUrl"),
						muxCheap: settings.get("quotaRouter.muxCheap"),
						muxCapable: settings.get("quotaRouter.muxCapable"),
					});
					// Spawn start.sh --replace to kill old gateway and start fresh
					const script = path.join(qr.root, "deploy", "quota-router", "start.sh");
					const args = [script, "--replace"];
					if (qr.switchyard) args.push("--with-switchyard");
					if (!qr.broker) args.push("--no-broker-start");
					args.push("--gateway-bind", qr.gatewayBind, "--switchyard-bind", qr.switchyardBind, "--broker-url", qr.brokerUrl);
					const { spawn } = await import("node:child_process");
					await runtime.output("Starting: " + ["bash", ...args].join(" "));
					const child = spawn("bash", args, { detached: true, stdio: "ignore", env: process.env, cwd: qr.root });
					child.unref();
					// Wait for the gateway to come up
					const deadline = Date.now() + 30000;
					let up = false;
					while (Date.now() < deadline) {
						try {
							const res = await fetch(`http://${qr.gatewayBind}/healthz`, { signal: AbortSignal.timeout(1000) });
							if (res.ok) { up = true; break; }
						} catch {}
						await Bun.sleep(500);
					}
					await runtime.output(up ? "Stack restarted." : "Timed out waiting for stack to come up.");
				} catch (err) {
					await runtime.output(`Error: ${err instanceof Error ? err.message : String(err)}`);
				}
				return commandConsumed();
			}
			// --- status (default) ---
			let routingLog: string | undefined;
			let limit = 10;
			for (let i = 0; i < tokens.length; i++) {
				if (tokens[i] === "--routing-log" && i + 1 < tokens.length) routingLog = tokens[++i];
				else if (tokens[i] === "-n" && i + 1 < tokens.length) limit = Math.max(1, parseInt(tokens[++i], 10) || 10);
			}

			await initDb();
			await syncSessionMuxDecisions();
			const logPath = routingLog ?? path.join(os.homedir(), ".omp", "switchyard-routing.jsonl");
			try { if (await Bun.file(logPath).exists()) await syncRoutingLog(logPath); } catch {}

			const decisions = getRecentRoutingDecisions(limit);
			const cheap = decisions.filter(d => d.mux_lane === "cheap").length;
			const capable = decisions.filter(d => d.mux_lane === "capable").length;
			const syCheap = decisions.filter(d => d.sy_route === "fleet" && d.sy_model?.includes("cheap")).length;
			const syCapable = decisions.filter(d => d.sy_route === "fleet" && d.sy_model?.includes("capable")).length;
			const pTotal = decisions.reduce((s, d) => s + (d.sy_prompt_tokens ?? 0), 0);
			const cTotal = decisions.reduce((s, d) => s + (d.sy_cached_tokens ?? 0), 0);
			const oTotal = decisions.reduce((s, d) => s + (d.sy_completion_tokens ?? 0), 0);
			const tierLabel = syCheap > 0 || syCapable > 0 ? ` · switchyard ${syCheap} cheap / ${syCapable} capable` : "";
			const tokensStr = pTotal > 0 ? ` · ${formatTokens(pTotal)} in +${formatTokens(cTotal)} cache + ${formatTokens(oTotal)} out` : "";
			await runtime.output(`Fleet routing · ${decisions.length} recent · mux cheap ${cheap} / capable ${capable}${tierLabel}${tokensStr}`);

			for (const d of decisions) {
				const route = d.mux_lane ?? d.sy_route ?? d.sy_tier ?? "—";
				const target = d.mux_target ?? d.sy_model ?? "—";
				const p = formatTokens(d.sy_prompt_tokens);
				const c = formatTokens(d.sy_cached_tokens);
				const o = formatTokens(d.sy_completion_tokens);
				const tok = [p, c ? `+${c}` : "", o].filter(Boolean).join(" ");
				await runtime.output(`${formatTime(d.ts).padEnd(9)} ${(route ?? "—").padEnd(20)} ${(target ?? "—").padEnd(35)} ${tok}`);
			}
			if (pTotal > 0 || oTotal > 0) {
				await runtime.output("─".repeat(70));
				await runtime.output(`${"".padEnd(9)} ${"".padEnd(20)} ${"total".padEnd(35)} ${formatTokens(pTotal)} +${formatTokens(cTotal)} ${formatTokens(oTotal)}`);
			}

			closeDb();
			return commandConsumed();
		},
	},
];
