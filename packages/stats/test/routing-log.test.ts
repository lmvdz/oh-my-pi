import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { getRecentRoutingDecisions, initDb } from "../src/db";
import { syncRoutingLog } from "../src/routing-log";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-routing-log-");

describe("routing log", () => {
	it("syncs a Switchyard routing log JSONL into the DB", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "routing-log-test-"));
		const logPath = `${tmp}/switchyard-routing.jsonl`;

		const lines = [
			JSON.stringify({
				ts: "2026-08-18T12:00:00.000Z",
				session_id: "sess-001",
				model: "cheap",
				tier: "",
				prompt_tokens: 450,
				cached_tokens: 10,
				completion_tokens: 120,
				reasoning_tokens: 0,
			}),
			JSON.stringify({
				ts: "2026-08-18T12:01:00.000Z",
				session_id: "sess-002",
				model: "capable",
				tier: "",
				prompt_tokens: 800,
				cached_tokens: 200,
				completion_tokens: 300,
				reasoning_tokens: 50,
			}),
			JSON.stringify({
				ts: "2026-08-18T12:02:00.000Z",
				session_id: "sess-003",
				model: "cheap",
				tier: "classifier",
				prompt_tokens: 100,
				cached_tokens: 0,
				completion_tokens: 50,
				reasoning_tokens: 0,
			}),
			"", // blank line, should be skipped
		].join("\n");

		await Bun.write(logPath, lines);
		await initDb();

		const inserted = await syncRoutingLog(logPath);
		expect(inserted).toBe(3); // 2 served + 1 classifier, blank skipped

		const decisions = getRecentRoutingDecisions(10);
		expect(decisions.length).toBe(3);

		// Most recent first
		expect(decisions[0].sy_model).toBe("cheap");
		expect(decisions[0].sy_tier).toBe("classifier");
		expect(decisions[0].sy_route).toBeNull(); // classifier has no route

		expect(decisions[1].sy_model).toBe("capable");
		expect(decisions[1].sy_tier).toBeNull(); // "" -> null
		expect(decisions[1].sy_route).toBe("fleet");

		expect(decisions[2].sy_model).toBe("cheap");
		expect(decisions[2].sy_route).toBe("fleet");

		// Second sync should be a no-op (same offset)
		const dupes = await syncRoutingLog(logPath);
		expect(dupes).toBe(0);

		// Append a new record and re-sync
		const newLine = JSON.stringify({
			ts: "2026-08-18T13:00:00.000Z",
			session_id: "sess-004",
			model: "capable",
			tier: "",
			prompt_tokens: 1000,
			cached_tokens: 0,
			completion_tokens: 500,
			reasoning_tokens: 100,
		});
		await Bun.write(logPath, `${lines}\n${newLine}`);

		const incremental = await syncRoutingLog(logPath);
		expect(incremental).toBe(1);

		const allDecisions = getRecentRoutingDecisions(10);
		expect(allDecisions.length).toBe(4);
	});
});