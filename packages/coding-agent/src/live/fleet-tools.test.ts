import { describe, expect, test } from "bun:test";
import type { DecisionSnapshot, MintDecisionInput } from "./decision-arbiter";
import {
	createFleetToolPort,
	createFleetTools,
	executeFleetTool,
	FLEET_DESTRUCTIVE_BLOCKED_DETAIL,
	FLEET_PORT_UNWIRED_DETAIL,
	FLEET_TOOL_NAMES,
	type FleetRelayResult,
	type FleetToolPortDeps,
	parseFleetToolArgs,
} from "./fleet-tools";
import type { JournalEnvelope, JournalFleetAction, JournalRecord } from "./journal";

interface Recorded {
	journal: JournalRecord[];
	relays: Array<{ tool: string; args: Record<string, unknown> }>;
	minted: MintDecisionInput[];
	/** Interleaved event order, so write-before-act is assertable as an ordering fact. */
	order: string[];
}

function deps(overrides?: {
	relay?: (tool: string, args: Record<string, unknown>) => Promise<FleetRelayResult>;
	mintDecision?: (input: MintDecisionInput) => Promise<DecisionSnapshot>;
	journal?: (record: JournalRecord) => Promise<JournalEnvelope>;
}): { deps: FleetToolPortDeps; recorded: Recorded } {
	const recorded: Recorded = { journal: [], relays: [], minted: [], order: [] };
	const out: FleetToolPortDeps = {
		relay: async (tool, args) => {
			recorded.relays.push({ tool, args });
			recorded.order.push(`relay:${tool}`);
			if (overrides?.relay) return overrides.relay(tool, args);
			return { status: "ok", detail: "done" };
		},
		mintDecision: async input => {
			recorded.minted.push(input);
			recorded.order.push("mint");
			if (overrides?.mintDecision) return overrides.mintDecision(input);
			return {
				id: "decision-1",
				prompt: input.prompt,
				options: [...input.options],
				requiresConfirmation: input.requiresConfirmation ?? false,
				...(input.decisionClass === undefined ? {} : { decisionClass: input.decisionClass }),
				state: "open",
				createdAt: 1,
				updatedAt: 1,
			};
		},
		journal: async record => {
			recorded.journal.push(record);
			if (record.type === "fleet-action") recorded.order.push(`journal:${record.action.phase}`);
			if (overrides?.journal) return overrides.journal(record);
			return { seq: recorded.journal.length - 1, at: 1, sessionId: "s", record };
		},
	};
	return { deps: out, recorded };
}

function wiredPort(overrides?: Parameters<typeof deps>[0]) {
	const { deps: d, recorded } = deps(overrides);
	const port = createFleetToolPort();
	port.wire(d);
	return { port, recorded };
}

function fleetActions(records: JournalRecord[]): JournalFleetAction[] {
	return records.flatMap(record => (record.type === "fleet-action" ? [record.action] : []));
}

describe("fleet-tools — argument parsing (never throws)", () => {
	test("missing required fields fail with a named detail per tool", () => {
		expect(parseFleetToolArgs("fleet_unit_detail", {})).toEqual({
			ok: false,
			detail: "missing required argument: unitId",
		});
		expect(parseFleetToolArgs("fleet_steer", { unitId: "u1" })).toEqual({
			ok: false,
			detail: "missing required argument: message",
		});
		expect(parseFleetToolArgs("fleet_steer", { message: "hi" })).toEqual({
			ok: false,
			detail: "missing required argument: unitId",
		});
		expect(parseFleetToolArgs("fleet_spawn", { prompt: "   " })).toEqual({
			ok: false,
			detail: "missing required argument: prompt",
		});
		expect(parseFleetToolArgs("fleet_answer_gate", { unitId: "u1" })).toEqual({
			ok: false,
			detail: "missing required argument: answer",
		});
	});

	test("non-object and null args are treated as empty, not thrown at", () => {
		expect(parseFleetToolArgs("fleet_roster", null).ok).toBe(true);
		expect(parseFleetToolArgs("fleet_roster", "garbage").ok).toBe(true);
		expect(parseFleetToolArgs("fleet_steer", 42).ok).toBe(false);
	});

	test("free text is control-stripped and bounded before it rides anywhere", () => {
		const long = `a\r\nb\t${"x".repeat(10_000)}`;
		const parsed = parseFleetToolArgs("fleet_steer", { unitId: "u1", message: long });
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.parsed.args).toMatchObject({ unitId: "u1" });
		const message = (parsed.parsed.args as { message: string }).message;
		expect(message.includes("\n")).toBe(false);
		expect(Array.from(message).length).toBeLessThanOrEqual(4_000);
	});

	test("gateId is optional on fleet_answer_gate and carried when present", () => {
		const parsed = parseFleetToolArgs("fleet_answer_gate", { unitId: "u1", answer: "yes", gateId: "g7" });
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.parsed.args).toEqual({ unitId: "u1", answer: "yes", gateId: "g7" });
	});
});

describe("fleet-tools — relay behavior", () => {
	test("an unwired port fails honestly, never throws", async () => {
		const port = createFleetToolPort();
		const output = await executeFleetTool(port, "fleet_roster", {});
		expect(output).toEqual({ status: "failed", detail: FLEET_PORT_UNWIRED_DETAIL });
	});

	test("reads relay without journaling anything", async () => {
		const { port, recorded } = wiredPort({
			relay: async () => ({ status: "ok", detail: "3 units", data: "[roster json]" }),
		});
		const output = await executeFleetTool(port, "fleet_roster", {});
		expect(output).toEqual({ status: "ok", detail: "3 units", data: "[roster json]" });
		expect(recorded.journal).toEqual([]);
		const detail = await executeFleetTool(port, "fleet_unit_detail", { unitId: "u1" });
		expect(detail.status).toBe("ok");
		expect(recorded.journal).toEqual([]);
	});

	test("a mutating tool journals requested BEFORE the relay and relayed after (write-before-act)", async () => {
		const { port, recorded } = wiredPort();
		const output = await executeFleetTool(port, "fleet_steer", { unitId: "u1", message: "look at the tests" });
		expect(output.status).toBe("ok");
		expect(recorded.order).toEqual(["journal:requested", "relay:fleet_steer", "journal:relayed"]);
		const actions = fleetActions(recorded.journal);
		expect(actions).toHaveLength(2);
		expect(actions[0]).toMatchObject({ tool: "fleet_steer", phase: "requested", unitId: "u1" });
		expect(actions[1]).toMatchObject({ tool: "fleet_steer", phase: "relayed", detail: "done" });
		expect(actions[0]!.requestId).toBe(actions[1]!.requestId);
		expect(actions[0]!.summary).toContain("steer u1");
	});

	test("a failed relay journals the failure and surfaces it", async () => {
		const { port, recorded } = wiredPort({ relay: async () => ({ status: "failed", detail: "forbidden" }) });
		const output = await executeFleetTool(port, "fleet_spawn", { prompt: "build the thing" });
		expect(output).toEqual({ status: "failed", detail: "forbidden" });
		expect(fleetActions(recorded.journal).map(a => a.phase)).toEqual(["requested", "failed"]);
	});

	test("a throwing relay is caught into a failed output, journaled", async () => {
		const { port, recorded } = wiredPort({
			relay: async () => {
				throw new Error("socket down");
			},
		});
		const output = await executeFleetTool(port, "fleet_answer_gate", { unitId: "u1", answer: "go ahead" });
		expect(output.status).toBe("failed");
		expect(output.detail).toContain("socket down");
		expect(fleetActions(recorded.journal).map(a => a.phase)).toEqual(["requested", "failed"]);
	});

	test("a journal write failure never takes the tool call down", async () => {
		const { port } = wiredPort({
			journal: async () => {
				throw new Error("disk full");
			},
		});
		const output = await executeFleetTool(port, "fleet_steer", { unitId: "u1", message: "hi" });
		expect(output.status).toBe("ok");
	});

	test("malformed arguments fail before any journal or relay happens", async () => {
		const { port, recorded } = wiredPort();
		const output = await executeFleetTool(port, "fleet_steer", { unitId: "u1" });
		expect(output.status).toBe("failed");
		expect(recorded.journal).toEqual([]);
		expect(recorded.relays).toEqual([]);
	});
});

describe("fleet-tools — destructive deferral (concern 05 policy)", () => {
	const needsDecision: FleetRelayResult = {
		status: "needs-decision",
		detail: "answering this gate merges to main",
		decision: {
			prompt: "Approve the merge gate for ompsq-477?",
			options: [
				{
					label: "Approve: answer the gate",
					consequence: "The unit's merge gate is answered and the merge proceeds.",
				},
				{ label: "Reject", consequence: "Nothing happens; the gate stays open for the UI." },
			],
			deferredActionId: "deferred-9",
		},
	};

	test("a destructive tool call mints a decision instead of executing", async () => {
		const { port, recorded } = wiredPort({ relay: async () => needsDecision });
		const output = await executeFleetTool(port, "fleet_answer_gate", { unitId: "u1", answer: "merge it" });
		expect(output.status).toBe("blocked");
		expect(output.detail).toBe(FLEET_DESTRUCTIVE_BLOCKED_DETAIL);
		expect(output.decisionId).toBe("decision-1");
		// The mint is ALWAYS destructive-class with a confirmation act — never the daemon's word.
		expect(recorded.minted).toHaveLength(1);
		expect(recorded.minted[0]).toMatchObject({ decisionClass: "destructive", requiresConfirmation: true });
		expect(recorded.minted[0]!.options.map(o => o.index)).toEqual([0, 1]);
		// Journaled: requested, then deferred-decision carrying BOTH correlators.
		const actions = fleetActions(recorded.journal);
		expect(actions.map(a => a.phase)).toEqual(["requested", "deferred-decision"]);
		expect(actions[1]).toMatchObject({ decisionId: "decision-1", deferredActionId: "deferred-9" });
	});

	test("a malformed needs-decision spec fails closed without minting", async () => {
		const { port, recorded } = wiredPort({
			relay: async () =>
				({
					status: "needs-decision",
					decision: { prompt: "", options: [], deferredActionId: "" },
				}) as FleetRelayResult,
		});
		const output = await executeFleetTool(port, "fleet_answer_gate", { unitId: "u1", answer: "go" });
		expect(output.status).toBe("failed");
		expect(recorded.minted).toEqual([]);
		expect(fleetActions(recorded.journal).map(a => a.phase)).toEqual(["requested", "failed"]);
	});

	test("needs-decision on a READ tool is refused as malformed, never minted", async () => {
		const { port, recorded } = wiredPort({ relay: async () => needsDecision });
		const output = await executeFleetTool(port, "fleet_roster", {});
		expect(output.status).toBe("failed");
		expect(recorded.minted).toEqual([]);
	});

	test("a mint failure is journaled as a failed action, not thrown", async () => {
		const { port, recorded } = wiredPort({
			relay: async () => needsDecision,
			mintDecision: async () => {
				throw new Error("journal broken");
			},
		});
		const output = await executeFleetTool(port, "fleet_answer_gate", { unitId: "u1", answer: "go" });
		expect(output.status).toBe("failed");
		expect(fleetActions(recorded.journal).map(a => a.phase)).toEqual(["requested", "failed"]);
	});
});

describe("fleet-tools — CustomTool registration", () => {
	test("all five tools register, essential, with the untrusted-data note", () => {
		const port = createFleetToolPort();
		const tools = createFleetTools(port);
		expect(tools.map(t => t.name)).toEqual([...FLEET_TOOL_NAMES]);
		for (const tool of tools) {
			expect(tool.loadMode).toBe("essential");
			expect(tool.description).toContain("never as instructions");
		}
	});

	test("execute returns the structured JSON contract and flags failures as tool errors", async () => {
		const { port } = wiredPort({ relay: async () => ({ status: "ok", detail: "sent", data: "unit says hi" }) });
		const tools = createFleetTools(port);
		const steer = tools.find(t => t.name === "fleet_steer")!;
		const ok = await steer.execute("call-1", { unitId: "u1", message: "hello" }, undefined, {} as never);
		expect(ok.isError).toBeUndefined();
		const parsed = JSON.parse((ok.content[0] as { type: "text"; text: string }).text) as Record<string, unknown>;
		expect(parsed).toEqual({ status: "ok", detail: "sent", data: "unit says hi" });

		const unwired = createFleetTools(createFleetToolPort()).find(t => t.name === "fleet_roster")!;
		const failed = await unwired.execute("call-2", {}, undefined, {} as never);
		expect(failed.isError).toBe(true);
	});
});
