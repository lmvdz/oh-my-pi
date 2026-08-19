import { commandConsumed } from "./helpers/parse";
import * as os from "node:os";
import * as path from "node:path";
import { type RoutingDecisionRow, closeDb, getRecentRoutingDecisions, initDb, insertRoutingDecisions } from "@oh-my-pi/omp-stats/db";
import { syncRoutingLog } from "@oh-my-pi/omp-stats/routing-log";
import type { SlashCommandSpec } from "./types";

interface MuxSeat {
	target: { provider: string; id: string };
	open: boolean;
	reason?: string;
}

interface MuxStatusResponse {
	policy: { weeklyCloseAt: number; fiveHourCloseAt: number };
	stickySessions: number;
	cheap?: { open: boolean; reason?: string };
	capable?: MuxSeat[];
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatLines(decisions: RoutingDecisionRow[], mux: MuxStatusResponse | null): string[] {
	const lines: string[] = [];
	const cheap = decisions.filter(d => d.mux_lane === "cheap").length;
	const capable = decisions.filter(d => d.mux_lane === "capable").length;
	const syCheap = decisions.filter(d => d.sy_tier === null && d.sy_model === "cheap").length;
	const syCapable = decisions.filter(d => d.sy_tier === null && d.sy_model === "capable").length;

	const parts = [`Fleet routing · ${decisions.length} recent`];
	if (cheap > 0 || capable > 0) parts.push(`mux cheap ${cheap} / capable ${capable}`);
	if (syCheap > 0 || syCapable > 0) parts.push(`switchyard cheap ${syCheap} / capable ${syCapable}`);
	lines.push(parts.join(" · "));

	if (mux) {
		const targets = [
			...(mux.capable ?? []),
		]
			.map(s => `${s.open ? "open" : s.reason ?? "closed"} ${s.target.provider}/${s.target.id}`)
			.join(" · ");
		const cheapStr = mux.cheap ? `${mux.cheap.open ? "open" : mux.cheap.reason ?? "closed"}` : "";
		lines.push(
			`Mux · ${mux.stickySessions} sticky · close 5h ${(mux.policy.fiveHourCloseAt * 100).toFixed(0)}% / week ${(mux.policy.weeklyCloseAt * 100).toFixed(0)}%${cheapStr ? ` · cheap ${cheapStr}` : ""}${targets ? ` · ${targets}` : ""}`,
		);
	} else {
		lines.push("Mux · unavailable");
	}

	lines.push("");
	lines.push("TIME      ROUTE                 TARGET");
	for (const d of decisions) {
		const route = d.mux_lane ?? d.sy_tier ?? "—";
		const target = d.mux_target ?? d.sy_model ?? "—";
		lines.push(`${formatTime(d.ts).padEnd(9)} ${(route ?? "—").padEnd(20)} ${target ?? "—"}`);
	}
	return lines;
}

async function fetchMuxStatus(gatewayUrl?: string): Promise<MuxStatusResponse | null> {
	const baseUrl = gatewayUrl ?? process.env.OMP_AUTH_GATEWAY_BIND ?? "http://127.0.0.1:4010";
	const tokenFile = process.env.OMP_AUTH_GATEWAY_TOKEN_FILE ?? path.join(os.homedir(), ".omp", "auth-gateway.token");
	let token = process.env.OMP_AUTH_GATEWAY_TOKEN;
	if (!token) {
		try {
			token = (await Bun.file(tokenFile).text()).trim();
		} catch {}
	}
	try {
		const url = new URL("/v1/mux", baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`);
		const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
		if (!response.ok) return null;
		const status = (await response.json()) as MuxStatusResponse;
		return typeof status.stickySessions === "number" && typeof status.policy?.weeklyCloseAt === "number" ? status : null;
	} catch {
		return null;
	}
}

async function syncSessionMuxDecisions(): Promise<void> {
	const dir = path.join(os.homedir(), ".omp", "agent", "sessions");
	let entries: fs.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const batch: RoutingDecisionRow[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let files: string[];
		try {
			files = await fs.readdir(path.join(dir, entry.name));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const text = await Bun.file(path.join(dir, entry.name, file)).text();
			for (const line of text.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const decision = JSON.parse(trimmed);
					if (decision.type === "mux_decision") {
						batch.push({
							ts: new Date(decision.timestamp).getTime(),
							mux_lane: decision.lane,
							mux_target: decision.target,
							mux_reason: decision.reason,
							mux_success: decision.success ? 1 : 0,
						});
					}
				} catch {}
			}
		}
	}
	if (batch.length > 0) insertRoutingDecisions(batch);
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

export const BUILTIN_FLEET_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "fleet",
		description: "Show fleet routing status from Switchyard and mux",
		allowArgs: true,
		inlineHint: "[--routing-log <path>] [--gateway-url <url>]",
		subcommands: [
			{ name: "status", description: "Show current routing state" },
			{ name: "watch", description: "Continuously monitor routing", usage: "[--interval <seconds>]" },
		],
		handle: async (command, runtime) => {
			const tokens = command.args.trim().split(/\s+/).filter(Boolean);
			if (tokens[0] === "watch") {
				const intervalIdx = tokens.indexOf("--interval");
				const intervalSec =
					intervalIdx >= 0 && intervalIdx + 1 < tokens.length
						? Math.max(2, parseInt(tokens[intervalIdx + 1], 10) || 5)
						: 10;
				await runtime.output("Fleet watch — polling every " + intervalSec + "s");
				const routingLog = path.join(os.homedir(), ".omp", "switchyard-routing.jsonl");
				await initDb();
				const poll = async () => {
					while (true) {
						try {
							await syncSessionMuxDecisions();
							if (await Bun.file(routingLog).exists()) await syncRoutingLog(routingLog);
							const decisions = getRecentRoutingDecisions(10);
							const cheap = decisions.filter(d => d.mux_lane === "cheap").length;
							const capable = decisions.filter(d => d.mux_lane === "capable").length;
							const promptTokens = decisions.reduce((sum, d) => sum + (d.sy_prompt_tokens ?? 0), 0);
							const cachedTokens = decisions.reduce((sum, d) => sum + (d.sy_cached_tokens ?? 0), 0);
							const completionTokens = decisions.reduce((sum, d) => sum + (d.sy_completion_tokens ?? 0), 0);
							const tokenSummary =
								promptTokens > 0
									? ` · ${formatTokens(promptTokens)} in +${formatTokens(cachedTokens)} cache + ${formatTokens(completionTokens)} out`
									: "";
							await runtime.output(
								`[${new Date().toLocaleTimeString()}] Fleet routing · ${decisions.length} recent · mux cheap ${cheap} / capable ${capable}${tokenSummary}`,
							);
						} catch {}
						await Bun.sleep(intervalSec * 1000);
					}
				};
				poll();
				return { consumed: true };
			}
			let routingLog: string | undefined;
			let gatewayUrl: string | undefined;
			let limit = 10;

			for (let i = 0; i < tokens.length; i++) {
				if (tokens[i] === "--routing-log" && i + 1 < tokens.length) {
					routingLog = tokens[++i];
				} else if (tokens[i] === "--gateway-url" && i + 1 < tokens.length) {
					gatewayUrl = tokens[++i];
				} else if (tokens[i] === "-n" && i + 1 < tokens.length) {
					limit = Math.max(1, parseInt(tokens[++i], 10) || 10);
				}
			}

			try {
				await initDb();

				if (routingLog) {
					try {
						await syncRoutingLog(routingLog);
					} catch {}
				}

				const [decisions, mux] = await Promise.all([
					Promise.resolve().then(() => getRecentRoutingDecisions(limit) as RoutingDecisionRow[]),
					fetchMuxStatus(gatewayUrl),
				]);

				const lines = formatLines(decisions, mux);
				for (const line of lines) {
					await runtime.output(line);
				}
			} finally {
				closeDb();
			}

			return commandConsumed();
		},
	},
];