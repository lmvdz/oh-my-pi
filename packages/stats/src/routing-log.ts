/**
 * Parse Switchyard --routing-log-file JSONL and ingest into stats DB.
 *
 * Switchyard routing-log records look like:
 *   {"ts":"2026-08-18T12:00:00.000Z","task":null,"trial_id":null,"session_id":"sess-abc",
 *    "model":"cheap","tier":"","prompt_tokens":450,"cached_tokens":0,"cache_creation_tokens":0,
 *    "completion_tokens":120,"reasoning_tokens":0,"total_tokens":570}
 *
 * `model` is the target model id (e.g. "cheap" or "capable" from routes.toml).
 * `tier` is "" for served responses, "classifier" for classifier/judge LLM calls.
 *
 * The route name (fleet vs ship) is NOT in the routing log — it's derived from
 * the model id prefix or configured via a env var hint when calling sync.
 */

import type { RoutingDecisionRow } from "./db";
import { getRoutingLogOffset, insertRoutingDecisions, setRoutingLogOffset } from "./db";

/** Raw Switchyard routing log record (JSONL line). */
interface SwitchyardRecord {
	ts?: string;
	task?: string | null;
	trial_id?: string | null;
	session_id?: string | null;
	model?: string;
	tier?: string;
	prompt_tokens?: number;
	cached_tokens?: number;
	cache_creation_tokens?: number;
	completion_tokens?: number;
	reasoning_tokens?: number;
	total_tokens?: number;
}

/** Map Switchyard model id to a route name for the routing_decisions.sy_route column. */
function inferRoute(model: string | undefined, tier: string | undefined): string | null {
	if (tier === "classifier") return null;
	if (!model) return null;
	// The target model from routes.toml — "cheap" or "mux/cheap" → fleet,
	// "capable" or "mux/capable" → fleet, "weak" / "strong" → ship
	const base = model.startsWith("mux/") ? model.slice(4) : model;
	if (base === "cheap" || base === "capable") return "fleet";
	if (base === "weak" || base === "strong") return "ship";
	return null;
}


/** Parse an ISO-8601 timestamp string to epoch ms. */
function parseTs(ts: string | undefined): number {
	if (!ts) return Date.now();
	const d = new Date(ts);
	return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}

/**
 * Read new records from the Switchyard routing log and insert them into stats DB.
 *
 * @param logPath - Path to the Switchyard --routing-log-file
 * @returns Number of new records inserted
 */
export async function syncRoutingLog(logPath: string): Promise<number> {
	// Read current offset
	const stored = getRoutingLogOffset(logPath);
	const offset = stored?.offset ?? 0;

	// Stat the file to detect truncation / rotation
	let file: Bun.BunFile;
	try {
		const f = Bun.file(logPath);
		const exists = await f.exists();
		if (!exists) return 0;
		file = f;
	} catch {
		return 0;
	}

	const size = file.size;
	if (size === 0) return 0;
	// If file is smaller than our last offset, it was rotated — start over
	const readOffset = offset > size ? 0 : offset;

	if (readOffset === size) {
		return 0; // No new data
	}

	// Read the bytes we haven't processed
	const buffer = await file.slice(readOffset).text();
	if (!buffer.length) return 0;

	const lines = buffer.split("\n");
	const rows: RoutingDecisionRow[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let record: SwitchyardRecord;
		try {
			record = JSON.parse(trimmed) as SwitchyardRecord;
		} catch {
			continue; // skip malformed lines
		}

		if (!record.model) continue; // skip records with no target

		const ts = parseTs(record.ts);
		const traceId = record.session_id ? `${record.session_id}-${ts}` : null;

		rows.push({
			ts,
			trace_id: traceId,
			session_id: record.session_id ?? null,
			sy_route: inferRoute(record.model, record.tier),
			sy_tier: record.tier && record.tier !== "" ? record.tier : null,
			sy_model: record.model ?? null,
			sy_prompt_tokens: record.prompt_tokens ?? null,
			sy_cached_tokens: record.cached_tokens ?? null,
			sy_completion_tokens: record.completion_tokens ?? null,
			sy_reasoning_tokens: record.reasoning_tokens ?? null,
		});
	}

	if (rows.length === 0) return 0;

	const inserted = insertRoutingDecisions(rows);
	const lastModified = Date.now();
	setRoutingLogOffset(logPath, size, lastModified);

	return inserted;
}
