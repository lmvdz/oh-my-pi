import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type RoutingDecisionRow, closeDb, getRecentRoutingDecisions, initDb, insertRoutingDecisions } from "@oh-my-pi/omp-stats/db";
import { syncRoutingLog } from "@oh-my-pi/omp-stats/routing-log";

interface MuxTarget { provider: string; id: string }
interface MuxSeat { target: MuxTarget; open: boolean; reason?: string }
interface MuxStatusResponse {
	policy: { weeklyCloseAt: number; fiveHourCloseAt: number; cheap?: MuxTarget; capableOrder?: MuxTarget[] };
	stickySessions: number;
	cheap?: { open: boolean; reason?: string };
	capable?: MuxSeat[];
}
interface RoutingDecision {
	ts: number; sy_route: string | null; sy_tier: string | null; sy_model: string | null;
	sy_prompt_tokens: number | null; sy_cached_tokens: number | null;
	sy_completion_tokens: number | null; sy_reasoning_tokens: number | null;
	mux_lane: string | null; mux_target: string | null; mux_reason: string | null;
}
const ONE_HOUR_MS = 60 * 60 * 1000;
const SCANNED_CACHE_PATH = path.join(os.homedir(), ".omp", ".scanned-sessions.json");
let fullyScanned = new Set<string>();
let lastRoutingLogSize = 0;

function targetName(t: MuxSeat["target"]): string { return `${t.provider}/${t.id}`; }
function formatTokens(n: number | null): string {
	if (!n) return "";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

async function fetchMuxStatus(gatewayUrl?: string): Promise<MuxStatusResponse | null> {
	const baseUrl = gatewayUrl ?? process.env.OMP_AUTH_GATEWAY_BIND ?? "http://127.0.0.1:4010";
	const tokenFile = process.env.OMP_AUTH_GATEWAY_TOKEN_FILE ?? path.join(os.homedir(), ".omp", "auth-gateway.token");
	let token = process.env.OMP_AUTH_GATEWAY_TOKEN;
	if (!token) { try { token = (await Bun.file(tokenFile).text()).trim(); } catch {} }
	try {
		const url = new URL("/v1/mux", baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`);
		const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
		if (!response.ok) return null;
		const status = (await response.json()) as MuxStatusResponse;
		return typeof status.stickySessions === "number" && typeof status.policy?.weeklyCloseAt === "number" ? status : null;
	} catch { return null; }
}

/** Walk session directories and insert mux_decision entries into the stats DB. */
async function syncSessionMuxDecisions(): Promise<void> {
	const dir = path.join(os.homedir(), ".omp", "agent", "sessions");
	try {
		const data = await Bun.file(SCANNED_CACHE_PATH).text();
		fullyScanned = new Set(JSON.parse(data));
	} catch {}
	let entries: fs.Dirent[];
	try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
	const cutoff = Date.now() - ONE_HOUR_MS;
	const batch: RoutingDecisionRow[] = [];
	for (const e of entries) {
		if (!e.isDirectory() || fullyScanned.has(e.name)) continue;
		const fullPath = path.join(dir, e.name);
		let stat: fs.Stats;
		try { stat = await fs.stat(fullPath); } catch { continue; }
		if (stat.mtimeMs < cutoff) continue;
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
	try { await Bun.write(SCANNED_CACHE_PATH, JSON.stringify([...fullyScanned])); } catch {}
}

async function fetchRecentDecisions(limit: number, routingLogPath?: string): Promise<RoutingDecision[]> {
	await initDb();
	await syncSessionMuxDecisions();
	const logPath = routingLogPath ?? path.join(os.homedir(), ".omp", "switchyard-routing.jsonl");
	try {
		if (await Bun.file(logPath).exists()) {
			const stat = await fs.stat(logPath);
			if (stat.size !== lastRoutingLogSize) {
				await syncRoutingLog(logPath);
				lastRoutingLogSize = stat.size;
			}
		}
	} catch {}
	return getRecentRoutingDecisions(limit);
}
function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export async function runFleetStatus(args: { limit?: number; gatewayUrl?: string; routingLog?: string }): Promise<void> {
	const limit = Math.max(1, Math.floor(args.limit ?? 10));
	try {
		const [decisions, mux] = await Promise.all([fetchRecentDecisions(limit, args.routingLog), fetchMuxStatus(args.gatewayUrl)]);
		const cheap = decisions.filter(d => d.mux_lane === "cheap").length;
		const capable = decisions.filter(d => d.mux_lane === "capable").length;
		const syCheap = decisions.filter(d => d.sy_route === "fleet" && d.sy_model?.includes("cheap")).length;
		const syCapable = decisions.filter(d => d.sy_route === "fleet" && d.sy_model?.includes("capable")).length;
		const pTotal = decisions.reduce((s, d) => s + (d.sy_prompt_tokens ?? 0), 0);
		const cTotal = decisions.reduce((s, d) => s + (d.sy_cached_tokens ?? 0), 0);
		const oTotal = decisions.reduce((s, d) => s + (d.sy_completion_tokens ?? 0), 0);
		const tierLabel = syCheap > 0 || syCapable > 0 ? ` · switchyard ${syCheap} cheap / ${syCapable} capable` : "";
		const tokens = pTotal > 0 ? ` · ${formatTokens(pTotal)} in +${formatTokens(cTotal)} cache + ${formatTokens(oTotal)} out` : "";

		console.log(`Fleet routing · ${decisions.length} recent · mux cheap ${cheap} / capable ${capable}${tierLabel}${tokens}`);

		if (mux) {
			const seats = [
				mux.cheap && mux.policy.cheap ? { ...mux.cheap, target: mux.policy.cheap } : undefined,
				...(mux.capable ?? []),
			].filter((s): s is MuxSeat => s !== undefined)
				.map(s => `${s.open ? "open" : s.reason ?? "closed"} ${targetName(s.target)}`).join(" · ");
			console.log(`Mux · ${mux.stickySessions} sticky · close 5h ${(mux.policy.fiveHourCloseAt * 100).toFixed(0)}% / week ${(mux.policy.weeklyCloseAt * 100).toFixed(0)}%${seats ? ` · ${seats}` : ""}`);
		} else {
			console.log("Mux · unavailable");
		}

		// Table
		console.log("TIME      ROUTE                 TARGET                          TOKENS");
		if (decisions.length === 0) {
			console.log("—         No routing decisions recorded");
		} else {
			for (const d of decisions) {
				const route = d.mux_lane ?? d.sy_route ?? d.sy_tier ?? "—";
				const target = d.mux_target ?? d.sy_model ?? "—";
				const p = formatTokens(d.sy_prompt_tokens);
				const c = formatTokens(d.sy_cached_tokens);
				const o = formatTokens(d.sy_completion_tokens);
				const tok = [p, c ? `+${c}` : "", o].filter(Boolean).join(" ");
				console.log(`${formatTime(d.ts).padEnd(9)} ${(route ?? "—").padEnd(20)} ${(target ?? "—").padEnd(35)} ${tok}`);
			}
			if (pTotal > 0 || oTotal > 0) {
				console.log("─".repeat(70));
				console.log(`${"".padEnd(9)} ${"".padEnd(20)} ${"total".padEnd(35)} ${formatTokens(pTotal)} +${formatTokens(cTotal)} ${formatTokens(oTotal)}`);
			}
		}
	} finally {
		closeDb();
	}
}