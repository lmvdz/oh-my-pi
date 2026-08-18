import { describe, expect, it } from "bun:test";
import type { Api, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type BranchCallOutcome,
	type BranchCallResult,
	DEFAULT_BRANCH_MAX_TOKENS,
} from "../../src/session/second-thought/branch-call";
import type { SecondThoughtForkInfo, SecondThoughtHarvest } from "../../src/session/second-thought/coordinator";
import {
	DEFAULT_RATE_LIMIT_COOLDOWN_MS,
	looksLikeRateLimit,
	SecondThoughtLedger,
	type SecondThoughtLedgerHost,
	splitUsage,
	terminationOf,
} from "../../src/session/second-thought/ledger";

// ── fixtures ────────────────────────────────────────────────────────────────

function model<TApi extends Api>(api: TApi, provider: string, id: string): Model<TApi> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		api,
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: true,
		input: ["text"],
		// $3 / $15 / $0.30 / $3.75 per million — Anthropic's Sonnet-shaped table.
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

const ANTHROPIC = model("anthropic-messages", "anthropic", "claude-fable-5");

function usage(partial: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> } = {}): Usage {
	const { cost, ...rest } = partial;
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...rest,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...cost },
	};
}

function forkInfo(overrides: Partial<SecondThoughtForkInfo> = {}): SecondThoughtForkInfo {
	return {
		generation: 1,
		epoch: 0,
		forkedAt: 1_000,
		branchCount: 1,
		model: ANTHROPIC.id,
		provider: ANTHROPIC.provider,
		conditioningChars: 128,
		...overrides,
	};
}

function branchResult(overrides: Partial<BranchCallResult> = {}): BranchCallResult {
	return {
		sessionId: "session-1:side:reflect:abc",
		text: "",
		units: [],
		unitCount: 0,
		outcome: "completed" as BranchCallOutcome,
		toolUseLeak: false,
		durationMs: 500,
		...overrides,
	};
}

interface ObservedEntry {
	provider: string;
	model: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd?: number;
	at?: number;
}

function ledgerWith(overrides: Partial<SecondThoughtLedgerHost> = {}): {
	ledger: SecondThoughtLedger;
	observed: ObservedEntry[];
	cooldowns: { provider: string; cooldownMs: number }[];
} {
	const observed: ObservedEntry[] = [];
	const cooldowns: { provider: string; cooldownMs: number }[] = [];
	const ledger = new SecondThoughtLedger({
		modelFor: (provider, id) => (provider === ANTHROPIC.provider && id === ANTHROPIC.id ? ANTHROPIC : undefined),
		recordObservedUsage: entry => observed.push(entry),
		onProviderRateLimit: (provider, cooldownMs) => cooldowns.push({ provider, cooldownMs }),
		now: () => 5_000,
		...overrides,
	});
	return { ledger, observed, cooldowns };
}

function harvest(overrides: Partial<SecondThoughtHarvest> = {}): SecondThoughtHarvest {
	return {
		generation: 1,
		epoch: 0,
		forkedAt: 1_000,
		harvestedAt: 1_300,
		windowMs: 300,
		units: [],
		unitsByAtom: {},
		fold: "",
		branchCount: 1,
		settledCount: 1,
		usage: [],
		...overrides,
	};
}

// ── pure helpers ────────────────────────────────────────────────────────────

describe("terminationOf", () => {
	it("collapses outcome + toolUseLeak with a fixed precedence", () => {
		expect(terminationOf({ outcome: "completed", toolUseLeak: false })).toBe("completed");
		expect(terminationOf({ outcome: "unitCap", toolUseLeak: false })).toBe("unit-cap");
		expect(terminationOf({ outcome: "aborted", toolUseLeak: false })).toBe("cancelled");
		expect(terminationOf({ outcome: "error", toolUseLeak: false })).toBe("error");
		// leak outranks a clean finish, but never outranks an error
		expect(terminationOf({ outcome: "completed", toolUseLeak: true })).toBe("tool-use-leak");
		expect(terminationOf({ outcome: "aborted", toolUseLeak: true })).toBe("tool-use-leak");
		expect(terminationOf({ outcome: "error", toolUseLeak: true })).toBe("error");
	});
});

describe("splitUsage", () => {
	it("keeps cache buckets separate from uncached input", () => {
		const split = splitUsage(
			usage({ input: 100, output: 20, cacheRead: 4_000, cacheWrite: 300, totalTokens: 4_420 }),
		);
		expect(split).toEqual({
			uncachedInput: 100,
			cacheRead: 4_000,
			cacheWrite: 300,
			output: 20,
			totalTokens: 4_420,
		});
	});

	it("folds orchestration tokens into the bucket they are billed as", () => {
		const split = splitUsage(
			usage({
				input: 10,
				output: 5,
				cacheRead: 1,
				orchestration: { input: 7, output: 3, cacheRead: 2 },
			}),
		);
		expect(split.uncachedInput).toBe(17);
		expect(split.output).toBe(8);
		expect(split.cacheRead).toBe(3);
	});

	it("treats absent usage as all-zero and non-finite numbers as zero", () => {
		expect(splitUsage(undefined)).toEqual({
			uncachedInput: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			totalTokens: 0,
		});
		const split = splitUsage(usage({ input: Number.NaN, output: Number.POSITIVE_INFINITY, cacheRead: 5 }));
		expect(split.uncachedInput).toBe(0);
		expect(split.output).toBe(0);
		expect(split.cacheRead).toBe(5);
	});
});

describe("looksLikeRateLimit", () => {
	it("matches status codes and prose, and nothing else", () => {
		expect(looksLikeRateLimit("HTTP 429 Too Many Requests")).toBe(true);
		expect(looksLikeRateLimit("rate_limit_error: quota exceeded")).toBe(true);
		expect(looksLikeRateLimit("Overloaded")).toBe(true);
		expect(looksLikeRateLimit("500 internal server error")).toBe(false);
		expect(looksLikeRateLimit(undefined)).toBe(false);
	});
});

// ── usage aggregation ───────────────────────────────────────────────────────

describe("SecondThoughtLedger usage aggregation", () => {
	it("prices a completed branch through the model cost table, split four ways", () => {
		const { ledger } = ledgerWith();
		ledger.recordFork(forkInfo());
		ledger.recordBranchResult(
			branchResult({
				usage: usage({ input: 1_000, output: 2_000, cacheRead: 10_000, cacheWrite: 4_000, totalTokens: 17_000 }),
				units: [
					["check", "one"],
					["recall", "two"],
				],
				ttftMs: 220,
			}),
			forkInfo(),
		);

		const report = ledger.report();
		expect(report.branches).toBe(1);
		expect(report.tokens).toEqual({
			uncachedInput: 1_000,
			cacheRead: 10_000,
			cacheWrite: 4_000,
			output: 2_000,
			totalTokens: 17_000,
		});
		// 1000 * 3/1e6 + 2000 * 15/1e6 + 10000 * 0.3/1e6 + 4000 * 3.75/1e6
		expect(report.costUsd.input).toBeCloseTo(0.003, 10);
		expect(report.costUsd.output).toBeCloseTo(0.03, 10);
		expect(report.costUsd.cacheRead).toBeCloseTo(0.003, 10);
		expect(report.costUsd.cacheWrite).toBeCloseTo(0.015, 10);
		expect(report.costUsd.total).toBeCloseTo(0.051, 10);
		expect(report.records[0]?.costFromCostTable).toBe(true);
		expect(report.records[0]?.unitsHarvested).toBe(2);
		expect(report.records[0]?.ttftMs).toBe(220);
		expect(report.records[0]?.sessionId).toBe("session-1:side:reflect:abc");
	});

	it("does not mutate the usage object it prices", () => {
		const { ledger } = ledgerWith();
		const shared = usage({ input: 1_000, output: 2_000 });
		ledger.recordBranchResult(branchResult({ usage: shared }), forkInfo());
		expect(shared.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	it("aggregates completed, cancelled and errored branches into one session total", () => {
		const { ledger } = ledgerWith();
		ledger.recordFork(forkInfo({ generation: 1, branchCount: 3 }));
		ledger.recordBranchResult(
			branchResult({ usage: usage({ input: 100, output: 500, cacheRead: 8_000 }) }),
			forkInfo({ generation: 1 }),
		);
		ledger.recordBranchResult(
			branchResult({ outcome: "aborted", usage: usage({ input: 100, output: 120, cacheRead: 8_000 }) }),
			forkInfo({ generation: 1 }),
		);
		ledger.recordBranchResult(
			branchResult({ outcome: "error", error: "connection reset" }),
			forkInfo({ generation: 1 }),
		);

		const report = ledger.report();
		expect(report.branches).toBe(3);
		expect(report.tokens.uncachedInput).toBe(200);
		expect(report.tokens.output).toBe(620);
		expect(report.tokens.cacheRead).toBe(16_000);
		expect(report.terminations).toEqual({
			completed: 1,
			"unit-cap": 0,
			cancelled: 1,
			error: 1,
			"tool-use-leak": 0,
		});
		// The errored branch reported no usage at all: unknown, not zero.
		expect(report.branchesWithoutUsage).toBe(1);
	});

	it("records a branch that reported no usage without inventing a zero", () => {
		const { ledger, observed } = ledgerWith();
		ledger.recordBranchResult(branchResult({ outcome: "aborted" }), forkInfo());
		const record = ledger.report().records[0];
		expect(record?.usageObserved).toBe(false);
		expect(record?.tokens.output).toBe(0);
		// and it is NOT forwarded to the broker, which counts a request per call
		expect(observed).toHaveLength(0);
	});

	it("falls back to the provider's own cost when no cost table resolves", () => {
		const { ledger } = ledgerWith({ modelFor: () => undefined });
		ledger.recordBranchResult(
			branchResult({ usage: usage({ input: 10, output: 20, cost: { total: 1.25, output: 1.25 } }) }),
			forkInfo(),
		);
		const record = ledger.report().records[0];
		expect(record?.costFromCostTable).toBe(false);
		expect(record?.costUsd.total).toBeCloseTo(1.25, 10);
	});

	it("survives a host whose cost-table lookup throws", () => {
		const { ledger } = ledgerWith({
			modelFor: () => {
				throw new Error("registry offline");
			},
		});
		ledger.recordBranchResult(branchResult({ usage: usage({ input: 10, output: 20 }) }), forkInfo());
		expect(ledger.report().branches).toBe(1);
		expect(ledger.report().records[0]?.costFromCostTable).toBe(false);
	});
});

// ── undercount bound ────────────────────────────────────────────────────────

describe("SecondThoughtLedger undercount bound", () => {
	it("is zero for a completed stream", () => {
		const { ledger } = ledgerWith();
		ledger.recordBranchResult(branchResult({ usage: usage({ output: 400 }) }), forkInfo());
		expect(ledger.report().records[0]?.undercountBoundTokens).toBe(0);
		expect(ledger.undercountBoundTokens).toBe(0);
	});

	it("is branchMaxTokens minus observed output for a cancelled stream", () => {
		const { ledger } = ledgerWith({ branchMaxTokens: () => 2_048 });
		ledger.recordBranchResult(branchResult({ outcome: "aborted", usage: usage({ output: 400 }) }), forkInfo());
		expect(ledger.report().records[0]?.undercountBoundTokens).toBe(1_648);
	});

	it("bounds an aborted stream that observed nothing at the full ceiling", () => {
		const { ledger } = ledgerWith({ branchMaxTokens: () => 1_000 });
		ledger.recordBranchResult(branchResult({ outcome: "aborted" }), forkInfo());
		expect(ledger.report().records[0]?.undercountBoundTokens).toBe(1_000);
	});

	it("never goes negative when observed output exceeds the ceiling", () => {
		const { ledger } = ledgerWith({ branchMaxTokens: () => 100 });
		ledger.recordBranchResult(branchResult({ outcome: "aborted", usage: usage({ output: 900 }) }), forkInfo());
		expect(ledger.report().records[0]?.undercountBoundTokens).toBe(0);
	});

	it("applies to unit-capped and errored streams too — neither ended naturally", () => {
		const { ledger } = ledgerWith({ branchMaxTokens: () => 1_000 });
		ledger.recordBranchResult(branchResult({ outcome: "unitCap", usage: usage({ output: 600 }) }), forkInfo());
		ledger.recordBranchResult(branchResult({ outcome: "error", usage: usage({ output: 100 }) }), forkInfo());
		expect(ledger.undercountBoundTokens).toBe(400 + 900);
	});

	it("falls back to the documented default when the host names no ceiling", () => {
		const { ledger } = ledgerWith({ branchMaxTokens: undefined });
		ledger.recordBranchResult(branchResult({ outcome: "aborted" }), forkInfo());
		expect(ledger.report().records[0]?.undercountBoundTokens).toBe(DEFAULT_BRANCH_MAX_TOKENS);
	});

	it("falls back to the default when the seam throws", () => {
		const { ledger } = ledgerWith({
			branchMaxTokens: () => {
				throw new Error("settings gone");
			},
		});
		ledger.recordBranchResult(branchResult({ outcome: "aborted" }), forkInfo());
		expect(ledger.report().records[0]?.undercountBoundTokens).toBe(DEFAULT_BRANCH_MAX_TOKENS);
	});

	it("aggregates the bound across a session so the error bar is visible at the top level", () => {
		const { ledger } = ledgerWith({ branchMaxTokens: () => 500 });
		ledger.recordBranchResult(branchResult({ outcome: "aborted", usage: usage({ output: 100 }) }), forkInfo());
		ledger.recordBranchResult(
			branchResult({ outcome: "aborted", usage: usage({ output: 200 }) }),
			forkInfo({ generation: 2 }),
		);
		expect(ledger.report().undercountBoundTokens).toBe(400 + 300);
	});
});

// ── skip / drop counters ────────────────────────────────────────────────────

describe("SecondThoughtLedger skip and drop counters", () => {
	it("counts every skip reason the coordinator reports", () => {
		const { ledger } = ledgerWith();
		ledger.recordSkip("adaptive-window", { toolBatchEmaMs: 40 });
		ledger.recordSkip("adaptive-window");
		ledger.recordSkip("provider-cooldown", { provider: "anthropic" });
		ledger.recordSkip("developer-tail");
		expect(ledger.skipCounts()).toEqual({
			"adaptive-window": 2,
			"provider-cooldown": 1,
			"developer-tail": 1,
		});
	});

	it("counts drop reasons separately from skips", () => {
		const { ledger } = ledgerWith();
		ledger.recordSkip("disabled");
		ledger.recordDrop("history-epoch");
		ledger.recordDrop("no-units");
		ledger.recordDrop("no-units");
		expect(ledger.dropCounts()).toEqual({ "history-epoch": 1, "no-units": 2 });
		expect(ledger.skipCounts()).toEqual({ disabled: 1 });
	});

	it("reports skip counters with zero forks, so a fully-suppressed session is legible", () => {
		const { ledger } = ledgerWith();
		ledger.recordSkip("context-too-large");
		const report = ledger.report();
		expect(report.forks).toBe(0);
		expect(report.branches).toBe(0);
		expect(report.skips["context-too-large"]).toBe(1);
	});
});

// ── broker attribution ──────────────────────────────────────────────────────

describe("SecondThoughtLedger broker attribution", () => {
	it("forwards each branch's burn once, tagged with the branch's provider and model", () => {
		const { ledger, observed } = ledgerWith();
		ledger.recordBranchResult(
			branchResult({ usage: usage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }) }),
			forkInfo(),
		);
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({
			provider: "anthropic",
			model: ANTHROPIC.id,
			usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
			at: 5_000,
		});
		expect(observed[0]?.costUsd).toBeCloseTo((10 * 3 + 20 * 15 + 30 * 0.3 + 40 * 3.75) / 1_000_000, 10);
	});

	it("keeps recording when the broker sink throws", () => {
		const { ledger } = ledgerWith({
			recordObservedUsage: () => {
				throw new Error("broker unreachable");
			},
		});
		ledger.recordBranchResult(branchResult({ usage: usage({ input: 5, output: 5 }) }), forkInfo());
		expect(ledger.report().branches).toBe(1);
		expect(ledger.report().tokens.output).toBe(5);
	});

	it("is a no-op when no broker sink is wired at all", () => {
		const ledger = new SecondThoughtLedger();
		ledger.recordBranchResult(branchResult({ usage: usage({ input: 5, output: 5 }) }), forkInfo());
		expect(ledger.report().branches).toBe(1);
	});
});

// ── token-primary reporting on OAuth ────────────────────────────────────────

describe("SecondThoughtLedger token-primary reporting", () => {
	it("flags USD as indicative when the branch provider is OAuth-served", () => {
		const { ledger } = ledgerWith({ hasOAuth: provider => provider === "anthropic" });
		ledger.recordBranchResult(
			branchResult({ usage: usage({ input: 1_000, output: 500, cacheRead: 20_000 }) }),
			forkInfo(),
		);
		const report = ledger.report();
		// The tokens are the real bill on OAuth: quota-window burn.
		expect(report.tokens.uncachedInput).toBe(1_000);
		expect(report.tokens.cacheRead).toBe(20_000);
		expect(report.tokens.output).toBe(500);
		expect(report.costIsIndicative).toBe(true);
		// USD is still reported, just not authoritative.
		expect(report.costUsd.total).toBeGreaterThan(0);
	});

	it("leaves USD unflagged on an API-key credential", () => {
		const { ledger } = ledgerWith({ hasOAuth: () => false });
		ledger.recordBranchResult(branchResult({ usage: usage({ input: 10, output: 10 }) }), forkInfo());
		expect(ledger.report().costIsIndicative).toBe(false);
	});

	it("leaves USD unflagged when the auth store cannot be consulted", () => {
		const { ledger } = ledgerWith({
			hasOAuth: () => {
				throw new Error("no auth storage");
			},
		});
		ledger.recordBranchResult(branchResult({ usage: usage({ input: 10, output: 10 }) }), forkInfo());
		expect(ledger.report().costIsIndicative).toBe(false);
	});
});

// ── 429 hook ────────────────────────────────────────────────────────────────

describe("SecondThoughtLedger rate-limit hook", () => {
	it("forwards an explicit observation to the coordinator's cooldown breaker", () => {
		const { ledger, cooldowns } = ledgerWith();
		ledger.noteRateLimit("anthropic");
		expect(cooldowns).toEqual([{ provider: "anthropic", cooldownMs: DEFAULT_RATE_LIMIT_COOLDOWN_MS }]);
		expect(ledger.report().rateLimits).toEqual({ anthropic: 1 });
	});

	it("arms the breaker from a branch that died on a 429", () => {
		const { ledger, cooldowns } = ledgerWith();
		ledger.recordBranchResult(
			branchResult({ outcome: "error", error: "429 rate_limit_error: too many requests" }),
			forkInfo(),
		);
		expect(cooldowns).toHaveLength(1);
		expect(cooldowns[0]?.provider).toBe("anthropic");
		expect(ledger.report().rateLimits.anthropic).toBe(1);
	});

	it("does not arm the breaker for an unrelated provider error", () => {
		const { ledger, cooldowns } = ledgerWith();
		ledger.recordBranchResult(branchResult({ outcome: "error", error: "socket hang up" }), forkInfo());
		expect(cooldowns).toHaveLength(0);
		expect(ledger.report().rateLimits).toEqual({});
	});

	it("classifies an arbitrary provider error for the primary call's path", () => {
		const { ledger, cooldowns } = ledgerWith();
		expect(ledger.observeProviderError("anthropic", new Error("HTTP 429"))).toBe(true);
		expect(ledger.observeProviderError("anthropic", new Error("bad gateway"))).toBe(false);
		expect(cooldowns).toHaveLength(1);
	});

	it("honours a caller-supplied cooldown and survives a throwing hook", () => {
		const { ledger } = ledgerWith({
			onProviderRateLimit: () => {
				throw new Error("coordinator disposed");
			},
		});
		ledger.noteRateLimit("anthropic", 5_000);
		expect(ledger.report().rateLimits.anthropic).toBe(1);
	});
});

// ── rollups and harvest ─────────────────────────────────────────────────────

describe("SecondThoughtLedger rollups", () => {
	it("rolls a fork's branches up per generation", () => {
		const { ledger } = ledgerWith({ branchMaxTokens: () => 1_000 });
		ledger.recordFork(forkInfo({ generation: 1, branchCount: 2 }));
		ledger.recordBranchResult(
			branchResult({ usage: usage({ input: 10, output: 100 }) }),
			forkInfo({ generation: 1 }),
		);
		ledger.recordBranchResult(
			branchResult({ outcome: "aborted", usage: usage({ input: 10, output: 40 }) }),
			forkInfo({ generation: 1 }),
		);
		ledger.recordHarvest(harvest({ generation: 1, units: [["check", "a"]], windowMs: 275 }));

		ledger.recordFork(forkInfo({ generation: 2, forkedAt: 9_000 }));
		ledger.recordBranchResult(
			branchResult({ usage: usage({ input: 1, output: 2 }) }),
			forkInfo({ generation: 2, forkedAt: 9_000 }),
		);

		const first = ledger.rollup(1);
		expect(first?.branchCount).toBe(2);
		expect(first?.recordedBranches).toBe(2);
		expect(first?.tokens.output).toBe(140);
		expect(first?.undercountBoundTokens).toBe(960);
		expect(first?.harvestedUnits).toBe(1);
		expect(first?.windowMs).toBe(275);
		expect(first?.terminations.completed).toBe(1);
		expect(first?.terminations.cancelled).toBe(1);

		const rollups = ledger.rollups();
		expect(rollups.map(entry => entry.generation)).toEqual([1, 2]);
		expect(ledger.report().forks).toBe(2);
		expect(ledger.report().harvests).toBe(1);
		expect(ledger.report().unitsHarvested).toBe(1);
	});

	it("opens a rollup for a branch whose fork was never announced", () => {
		// The finalizer can land after a reset; the ledger must still book the spend.
		const { ledger } = ledgerWith();
		ledger.recordBranchResult(branchResult({ usage: usage({ output: 7 }) }), forkInfo({ generation: 42 }));
		expect(ledger.rollup(42)?.recordedBranches).toBe(1);
		expect(ledger.report().forks).toBe(0);
		expect(ledger.report().branches).toBe(1);
	});

	it("ignores a harvest for a generation it never saw", () => {
		const { ledger } = ledgerWith();
		ledger.recordHarvest(harvest({ generation: 99, units: [["check", "a"]] }));
		expect(ledger.report().harvests).toBe(1);
		expect(ledger.report().unitsHarvested).toBe(1);
		expect(ledger.rollup(99)).toBeUndefined();
	});
});

// ── retention and reset ─────────────────────────────────────────────────────

describe("SecondThoughtLedger retention", () => {
	it("caps retained rows while keeping totals exact", () => {
		const ledger = new SecondThoughtLedger({ modelFor: () => ANTHROPIC }, { recordCap: 3 });
		for (let index = 0; index < 10; index++) {
			ledger.recordBranchResult(branchResult({ usage: usage({ output: 10 }) }), forkInfo({ generation: index + 1 }));
		}
		const report = ledger.report();
		expect(report.records).toHaveLength(3);
		expect(report.records.map(record => record.generation)).toEqual([8, 9, 10]);
		expect(report.rollups).toHaveLength(3);
		expect(report.branches).toBe(10);
		expect(report.tokens.output).toBe(100);
	});

	it("keeps aggregating with retention disabled", () => {
		const ledger = new SecondThoughtLedger({}, { recordCap: 0 });
		ledger.recordBranchResult(branchResult({ usage: usage({ output: 10 }) }), forkInfo());
		expect(ledger.report().records).toHaveLength(0);
		expect(ledger.report().tokens.output).toBe(10);
	});

	it("clears every counter on reset", () => {
		const { ledger } = ledgerWith({ hasOAuth: () => true });
		ledger.recordFork(forkInfo());
		ledger.recordSkip("disabled");
		ledger.recordDrop("cancelled");
		ledger.recordBranchResult(branchResult({ outcome: "aborted", usage: usage({ output: 10 }) }), forkInfo());
		ledger.recordHarvest(harvest({ units: [["check", "a"]] }));
		ledger.noteRateLimit("anthropic");
		ledger.reset();

		const report = ledger.report();
		expect(report).toMatchObject({
			forks: 0,
			branches: 0,
			harvests: 0,
			unitsHarvested: 0,
			undercountBoundTokens: 0,
			branchesWithoutUsage: 0,
			costIsIndicative: false,
		});
		expect(report.tokens).toEqual({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 });
		expect(report.skips).toEqual({});
		expect(report.drops).toEqual({});
		expect(report.rateLimits).toEqual({});
		expect(report.records).toHaveLength(0);
		expect(report.rollups).toHaveLength(0);
	});

	it("hands out copies, so a caller cannot mutate the ledger through its report", () => {
		const { ledger } = ledgerWith();
		ledger.recordBranchResult(branchResult({ usage: usage({ output: 10 }) }), forkInfo());
		const report = ledger.report();
		(report.records as unknown as unknown[]).push({} as never);
		(report.tokens as { output: number }).output = 9_999;
		expect(ledger.report().records).toHaveLength(1);
		expect(ledger.report().tokens.output).toBe(10);
	});
});

// ── coordinator interface conformance ───────────────────────────────────────

describe("SecondThoughtLedger as a coordinator sink", () => {
	it("satisfies every optional method the coordinator may call", () => {
		const ledger = new SecondThoughtLedger();
		// Structural check: this is exactly how 08 hands the ledger to the coordinator.
		const sink: {
			recordSkip?: (reason: never, info?: Record<string, unknown>) => void;
			recordFork?: (info: SecondThoughtForkInfo) => void;
			recordBranchResult?: (result: BranchCallResult, info: SecondThoughtForkInfo) => void;
			recordDrop?: (reason: never, info?: Record<string, unknown>) => void;
			recordHarvest?: (value: SecondThoughtHarvest) => void;
		} = ledger;
		expect(typeof sink.recordSkip).toBe("function");
		expect(typeof sink.recordFork).toBe("function");
		expect(typeof sink.recordBranchResult).toBe("function");
		expect(typeof sink.recordDrop).toBe("function");
		expect(typeof sink.recordHarvest).toBe("function");
	});
});
