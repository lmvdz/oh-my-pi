/**
 * Second Thought eval runner (ST-09).
 *
 * Three experiments, none of which needs a provider:
 *
 *   E1  mechanism overhead — turn-end latency delta, feature off vs on, with the
 *       branch settling at several speeds including "never".
 *   E2  harvest / skip / drop behaviour across a scenario matrix.
 *   E3  fold-injection fidelity, branch cache-prefix parity, and the token
 *       accounting that fixes the feature's marginal cost.
 *
 * Raw output lands in ./raw/*.json. RESULTS.md is written by hand from it and
 * states what a scripted provider cannot answer.
 *
 *   bun plans/second-thought/eval/run.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai";
import { countTokens } from "@oh-my-pi/pi-natives";
import { COMBINED_BRANCH_PROMPT } from "@oh-my-pi/pi-coding-agent/session/second-thought/atoms";
import {
	cleanupTempDirs,
	createHarness,
	DEFAULT_REFLECT,
	encodeWire,
	foldMessages,
	type Harness,
	mean,
	quantile,
	reflectText,
	round,
	setProbeDelayMs,
	setProbeOutputTokens,
	SHORT_THINKING,
	textOf,
	THINKING,
} from "./harness.ts";

const OUT_DIR = new URL("raw/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

function write(name: string, data: unknown): void {
	writeFileSync(`${OUT_DIR}${name}`, `${JSON.stringify(data, null, "\t")}\n`);
	console.log(`  wrote raw/${name}`);
}

const TOOL_TURN = { thinking: THINKING, toolCall: { name: "probe", args: {} } } as const;

// ---------------------------------------------------------------------------
// E1 — mechanism overhead
// ---------------------------------------------------------------------------

interface LatencyCondition {
	readonly id: string;
	readonly note: string;
	readonly enabled: boolean;
	readonly branchDelayMs?: number;
	/** `undefined` branch text = the branch never settles and must be aborted. */
	readonly hangs?: boolean;
}

const LATENCY_CONDITIONS: LatencyCondition[] = [
	{ id: "off", note: "secondThought.enabled=false — the control", enabled: false },
	{ id: "on-instant", note: "branch settles before turn end", enabled: true, branchDelayMs: 0 },
	{ id: "on-50ms", note: "branch settles 50ms after fork", enabled: true, branchDelayMs: 50 },
	{ id: "on-150ms", note: "branch settles inside the 300ms harvest grace", enabled: true, branchDelayMs: 150 },
	{ id: "on-600ms", note: "branch settles past the grace — harvest gives up", enabled: true, branchDelayMs: 600 },
	{ id: "on-hang", note: "branch never settles; turn end aborts it", enabled: true, hangs: true },
];

async function runLatency(reps: number) {
	console.log(`E1 mechanism overhead (${reps} reps x ${LATENCY_CONDITIONS.length} conditions)`);
	const samples: Record<string, number[]> = {};
	const harvestSamples: Record<string, number[]> = {};

	// One warmup pass per condition so JIT/module load never lands in a sample.
	for (const pass of ["warmup", "measure"] as const) {
		const n = pass === "warmup" ? 3 : reps;
		for (let i = 0; i < n; i++) {
			for (const condition of LATENCY_CONDITIONS) {
				const h = await createHarness({
					script: {
						turns: [TOOL_TURN, { text: "done" }],
						...(condition.hangs ? {} : { branchText: DEFAULT_REFLECT }),
						branchDelayMs: condition.branchDelayMs ?? 0,
					},
					settings: { "secondThought.enabled": condition.enabled },
				});
				const t0 = performance.now();
				await h.session.prompt("fix the failing test");
				const t1 = performance.now();
				const elapsed = t1 - t0;
				if (pass === "measure") {
					(samples[condition.id] ??= []).push(elapsed);
					// The turn-end tail: how long `prompt()` stays open after the last
					// provider request was issued. This is where harvest lives.
					const last = h.script.calls.at(-1);
					if (last) (harvestSamples[condition.id] ??= []).push(t1 - last.atAbsMs);
				}
				h.dispose();
			}
		}
		cleanupTempDirs();
	}

	const control = samples.off ?? [];
	const rows = LATENCY_CONDITIONS.map(condition => {
		const values = samples[condition.id] ?? [];
		return {
			condition: condition.id,
			note: condition.note,
			n: values.length,
			totalMs: {
				p50: round(quantile(values, 0.5)),
				p95: round(quantile(values, 0.95)),
				mean: round(mean(values)),
			},
			deltaVsOffMs: {
				p50: round(quantile(values, 0.5) - quantile(control, 0.5)),
				p95: round(quantile(values, 0.95) - quantile(control, 0.95)),
				mean: round(mean(values) - mean(control)),
			},
			tailAfterLastProviderCallMs: {
				p50: round(quantile(harvestSamples[condition.id] ?? [], 0.5)),
				p95: round(quantile(harvestSamples[condition.id] ?? [], 0.95)),
			},
		};
	});

	write("e1-latency.json", { reps, conditions: rows, rawSamplesMs: samples });
	return rows;
}

// ---------------------------------------------------------------------------
// E1b — overhead as a function of context size
// ---------------------------------------------------------------------------

/**
 * The fork snapshots the conversation, so whatever overhead the mechanism has
 * should grow with the context it copies. This drives two warm-up turns whose
 * tool results inflate the transcript, then times the third turn on and off.
 */
async function runContextScaling(sizes: readonly number[], reps: number) {
	console.log(`E1b overhead vs context size (${sizes.length} sizes x ${reps} reps)`);
	const rows: unknown[] = [];
	for (const payloadTokens of sizes) {
		const byCondition: Record<string, number[]> = {};
		let measuredPrefixTokens = 0;
		let forks = 0;
		let skips: Record<string, number> = {};
		for (const enabled of [false, true]) {
			for (let i = 0; i < reps; i++) {
				setProbeOutputTokens(payloadTokens);
				const h = await createHarness({
					script: {
						turns: [TOOL_TURN, { text: "ok" }, TOOL_TURN, { text: "ok" }, TOOL_TURN, { text: "done" }],
						branchText: DEFAULT_REFLECT,
					},
					settings: { "secondThought.enabled": enabled },
				});
				await h.session.prompt("turn 1");
				await h.session.prompt("turn 2");
				const t0 = performance.now();
				await h.session.prompt("turn 3");
				byCondition[enabled ? "on" : "off"] = [...(byCondition[enabled ? "on" : "off"] ?? []), performance.now() - t0];
				if (enabled && i === reps - 1) {
					const third = h.script.mainCalls()[4];
					measuredPrefixTokens = third ? countTokens(third.messagesJson) : 0;
					const report = h.session.secondThought?.report();
					forks = report?.forks ?? 0;
					skips = { ...(report?.skips ?? {}) };
				}
				h.dispose();
			}
			cleanupTempDirs();
		}
		setProbeOutputTokens(0);
		const off = byCondition.off ?? [];
		const on = byCondition.on ?? [];
		rows.push({
			toolPayloadTokens: payloadTokens,
			measuredPrefixTokensAtTurn3: measuredPrefixTokens,
			forksAcrossSession: forks,
			skips,
			offMs: { p50: round(quantile(off, 0.5)), p95: round(quantile(off, 0.95)) },
			onMs: { p50: round(quantile(on, 0.5)), p95: round(quantile(on, 0.95)) },
			deltaMs: { p50: round(quantile(on, 0.5) - quantile(off, 0.5)), p95: round(quantile(on, 0.95) - quantile(off, 0.95)) },
			raw: { off, on },
		});
		console.log(
			`  payload=${payloadTokens} prefix=${measuredPrefixTokens} forks=${forks} skips=${JSON.stringify(skips)} delta p50=${round(quantile(on, 0.5) - quantile(off, 0.5))}ms`,
		);
	}
	write("e1b-context-scaling.json", { reps, rows });
	return rows;
}

// ---------------------------------------------------------------------------
// E1c — the race that decides whether a fork ever pays off
// ---------------------------------------------------------------------------

/**
 * A branch is forked at `toolcall_start` and harvested at turn end. It is
 * therefore racing the rest of the turn: if it has not settled by then it is
 * aborted and contributes nothing. This sweeps branch latency against how long
 * the turn stays open (modelled as tool-execution time) and records whether the
 * fold survived.
 */
async function runHarvestRace(branchDelays: readonly number[], turnHolds: readonly number[]) {
	console.log(`E1c harvest race (${branchDelays.length} branch delays x ${turnHolds.length} turn durations)`);
	const rows: unknown[] = [];
	for (const turnHoldMs of turnHolds) {
		for (const branchDelayMs of branchDelays) {
			setProbeDelayMs(turnHoldMs);
			const h = await createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT, branchDelayMs },
			});
			const t0 = performance.now();
			await h.session.prompt("fix the failing test");
			const turnMs = performance.now() - t0;
			const report = h.session.secondThought?.report();
			const foldDelivered = h.script.mainCalls().some(call => foldMessages(call.context).length > 0);
			rows.push({
				turnHoldMs,
				branchDelayMs,
				turnMs: round(turnMs),
				forks: report?.forks ?? 0,
				harvests: report?.harvests ?? 0,
				unitsHarvested: report?.unitsHarvested ?? 0,
				foldDelivered,
				terminations: report?.terminations ?? null,
				drops: report?.drops ?? null,
				branchTokensBilled: report?.tokens.totalTokens ?? 0,
				undercountBoundTokens: report?.undercountBoundTokens ?? 0,
			});
			h.dispose();
			setProbeDelayMs(0);
		}
	}
	cleanupTempDirs();
	for (const row of rows as { turnHoldMs: number; branchDelayMs: number; harvests: number; foldDelivered: boolean }[]) {
		console.log(`  turnHold=${row.turnHoldMs}ms branch=${row.branchDelayMs}ms -> harvests=${row.harvests} fold=${row.foldDelivered}`);
	}
	write("e1c-harvest-race.json", rows);
	return rows;
}

// ---------------------------------------------------------------------------
// E2 — harvest / skip / drop matrix
// ---------------------------------------------------------------------------

interface Scenario {
	readonly id: string;
	readonly expect: string;
	build(): Promise<Harness>;
	/** Number of `prompt()` calls to drive. */
	readonly prompts?: number;
}

const SCENARIOS: Scenario[] = [
	{
		id: "baseline",
		expect: "one fork, one branch, one harvest, 2 units",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
			}),
	},
	{
		id: "no-tool-call",
		expect: "no fork at all — nothing to fork at",
		build: () => createHarness({ script: { turns: [{ thinking: THINKING, text: "done" }] } }),
	},
	{
		id: "two-tool-calls-one-stream",
		expect: "one fork per stream, not per tool call",
		build: () =>
			createHarness({
				script: {
					turns: [
						{ thinking: THINKING, toolCall: { name: "probe", args: {} }, secondToolCall: { name: "probe", args: {} } },
						{ text: "done" },
					],
					branchText: DEFAULT_REFLECT,
				},
			}),
	},
	{
		id: "conditioning-too-short",
		expect: "skip: conditioning-too-short",
		build: () =>
			createHarness({
				script: { turns: [{ thinking: SHORT_THINKING, toolCall: { name: "probe", args: {} } }, { text: "done" }], branchText: DEFAULT_REFLECT },
			}),
	},
	{
		id: "context-too-large",
		expect: "skip: context-too-large",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				settings: { "secondThought.maxContextTokens": 1 },
			}),
	},
	{
		id: "disabled",
		expect: "no runtime at all",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				settings: { "secondThought.enabled": false },
			}),
	},
	{
		id: "sub-session",
		expect: "no runtime — subagents never fork",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				agentKind: "sub",
			}),
	},
	{
		id: "non-anthropic-primary",
		expect: "no fork — the gate requires an anthropic-messages primary",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				primary: { provider: "openai", id: "gpt-5.1" },
			}),
	},
	{
		id: "no-side-stream-fn",
		expect: "no runtime — a bare host cannot fork",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				withoutSideStreamFn: true,
			}),
	},
	{
		id: "branch-returns-no-units",
		expect: "drop: no-units",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: "I have nothing useful to add." },
			}),
	},
	{
		id: "branch-over-unit-cap",
		expect: "harvest capped at harvestCapPerAtom per atom",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: reflectText(["check"], 40) },
				settings: { "secondThought.harvestCapPerAtom": 5 },
			}),
	},
	{
		id: "atoms-restricted",
		expect: "only the configured atoms survive the harvest filter",
		build: () =>
			createHarness({
				script: {
					turns: [TOOL_TURN, { text: "done" }],
					branchText: reflectText(["check", "rehearse", "recall", "alternative"], 2),
				},
				settings: { "secondThought.atoms": ["check"] },
			}),
	},
	{
		id: "branch-hangs",
		expect: "termination: cancelled, drop: no-settled-branches",
		build: () => createHarness({ script: { turns: [TOOL_TURN, { text: "done" }] } }),
	},
	{
		id: "branch-past-grace",
		expect: "600ms settle exceeds the 300ms grace",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT, branchDelayMs: 600 },
			}),
	},
	{
		id: "branch-count-2",
		expect: "two branches per fork",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				settings: { "secondThought.branchCount": 2 },
			}),
	},
	{
		id: "branch-count-4",
		expect: "four branches per fork",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				settings: { "secondThought.branchCount": 4 },
			}),
	},
	{
		id: "delivery-calls-2",
		expect: "the fold rides two consecutive main calls",
		build: () =>
			createHarness({
				script: { turns: [TOOL_TURN, TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
				settings: { "secondThought.deliveryCalls": 2 },
			}),
	},
	{
		id: "three-turn-session",
		expect: "one fork per turn across a multi-turn session",
		prompts: 3,
		build: () =>
			createHarness({
				script: {
					turns: [TOOL_TURN, { text: "done" }, TOOL_TURN, { text: "done" }, TOOL_TURN, { text: "done" }],
					branchText: DEFAULT_REFLECT,
				},
			}),
	},
];

interface ScenarioResult {
	readonly id: string;
	readonly expect: string;
	readonly mainCalls: number;
	readonly branchCalls: number;
	readonly callsWithFold: number[];
	readonly runtimePresent: boolean;
	readonly report: unknown;
	readonly harvestRate: number | null;
	readonly unitsPerHarvest: number | null;
	/** Every branch call recorded, for the E3 prefix sweep. */
	readonly wire: { branch: Message[]; main: Message[]; model: Model }[];
}

async function runScenarios(): Promise<ScenarioResult[]> {
	console.log(`E2 harvest/skip matrix (${SCENARIOS.length} scenarios)`);
	const results: ScenarioResult[] = [];
	for (const scenario of SCENARIOS) {
		const h = await scenario.build();
		for (let i = 0; i < (scenario.prompts ?? 1); i++) {
			await h.session.prompt(`turn ${i + 1}: fix the failing test`);
		}
		const report = h.session.secondThought?.report();
		const mainCalls = h.script.mainCalls();
		const branchCalls = h.script.branchCalls();
		// A branch forks off the most recent main call that started before it — the
		// stream it is reflecting on. Index pairing is wrong the moment a fork
		// produces several branches or a session runs several turns.
		const wire = branchCalls.flatMap(branch => {
			const parent = [...mainCalls].reverse().find(call => call.atMs < branch.atMs);
			if (!parent) return [];
			return [
				{
					branch: JSON.parse(branch.messagesJson) as Message[],
					main: JSON.parse(parent.messagesJson) as Message[],
					model: branch.model,
				},
			];
		});
		results.push({
			id: scenario.id,
			expect: scenario.expect,
			mainCalls: mainCalls.length,
			branchCalls: branchCalls.length,
			callsWithFold: mainCalls.map((call, index) => (foldMessages(call.context).length > 0 ? index : -1)).filter(i => i >= 0),
			runtimePresent: h.session.secondThought !== undefined,
			report: report
				? {
						forks: report.forks,
						branches: report.branches,
						harvests: report.harvests,
						unitsHarvested: report.unitsHarvested,
						tokens: report.tokens,
						costUsd: report.costUsd,
						costIsIndicative: report.costIsIndicative,
						branchesWithoutUsage: report.branchesWithoutUsage,
						skips: report.skips,
						drops: report.drops,
						terminations: report.terminations,
					}
				: null,
			harvestRate: report && report.forks > 0 ? round(report.harvests / report.forks, 3) : null,
			unitsPerHarvest: report && report.harvests > 0 ? round(report.unitsHarvested / report.harvests, 2) : null,
			wire,
		});
		h.dispose();
		console.log(`  ${scenario.id}: forks=${report?.forks ?? 0} branches=${report?.branches ?? 0} harvests=${report?.harvests ?? 0}`);
	}
	cleanupTempDirs();
	write(
		"e2-scenarios.json",
		results.map(({ wire: _wire, ...rest }) => rest),
	);
	return results;
}

// ---------------------------------------------------------------------------
// E3 — fidelity, cache-prefix parity, token accounting
// ---------------------------------------------------------------------------

function prefixParity(scenarios: ScenarioResult[]) {
	const rows: { scenario: string; branchIndex: number; exactPrefix: boolean; appendedMessages: number; sharedPrefixBytes: number }[] =
		[];
	for (const scenario of scenarios) {
		scenario.wire.forEach((pair, branchIndex) => {
			const mainWire = encodeWire(pair.main, pair.model);
			const branchWire = encodeWire(pair.branch, pair.model);
			const head = JSON.stringify(branchWire.slice(0, mainWire.length));
			const want = JSON.stringify(mainWire);
			rows.push({
				scenario: scenario.id,
				branchIndex,
				exactPrefix: head === want,
				appendedMessages: branchWire.length - mainWire.length,
				sharedPrefixBytes: head === want ? Buffer.byteLength(want, "utf8") : 0,
			});
		});
	}
	const total = rows.length;
	const exact = rows.filter(r => r.exactPrefix).length;
	return {
		branchCallsExamined: total,
		byteIdenticalPrefix: exact,
		fraction: total > 0 ? round(exact / total, 4) : null,
		appendedMessagesHistogram: rows.reduce<Record<string, number>>((acc, r) => {
			acc[String(r.appendedMessages)] = (acc[String(r.appendedMessages)] ?? 0) + 1;
			return acc;
		}, {}),
		rows,
	};
}

/** Cost of one fork and one fold, in real tokens, at the catalog's real prices. */
async function tokenAccounting() {
	console.log("E3 token accounting");
	const h = await createHarness({
		script: { turns: [TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
	});
	await h.session.prompt("fix the failing test");

	const mainCall = h.script.mainCalls()[0]!;
	const branchCall = h.script.branchCalls()[0]!;
	const foldCall = h.script.mainCalls()[1]!;
	const model = mainCall.model;
	const cost = model.cost as { input: number; output: number; cacheRead: number; cacheWrite: number };

	const mainWire = encodeWire(JSON.parse(mainCall.messagesJson) as Message[], model);
	const branchWire = encodeWire(JSON.parse(branchCall.messagesJson) as Message[], model);
	const appended = branchWire.slice(mainWire.length);
	const appendedText = JSON.stringify(appended);
	const branchPromptTokens = countTokens(COMBINED_BRANCH_PROMPT);
	const appendedTokens = countTokens(appendedText);

	const foldText = foldMessages(foldCall.context).map(textOf).join("\n");
	const foldTokens = countTokens(foldText);

	// How the fold scales with the number of harvested units.
	const foldScaling: { units: number; foldTokens: number; foldBytes: number }[] = [];
	for (const units of [1, 2, 4, 8, 16]) {
		const hh = await createHarness({
			script: { turns: [TOOL_TURN, { text: "done" }], branchText: reflectText(["check"], units) },
			settings: { "secondThought.harvestCapPerAtom": 64 },
		});
		await hh.session.prompt("fix the failing test");
		const call = hh.script.mainCalls()[1];
		const text = call ? foldMessages(call.context).map(textOf).join("\n") : "";
		foldScaling.push({ units, foldTokens: countTokens(text), foldBytes: Buffer.byteLength(text, "utf8") });
		hh.dispose();
	}

	h.dispose();
	cleanupTempDirs();

	// Marginal spend per fork as a function of how big the reused prefix is. The
	// prefix is charged at the cache-read rate when warm (the design's gate) and
	// at the full input rate when cold.
	const branchMaxTokens = 2048;
	const perFork = [10_000, 30_000, 100_000].map(prefixTokens => {
		const warm = (prefixTokens * cost.cacheRead) / 1e6;
		const cold = (prefixTokens * cost.input) / 1e6;
		const appendedUsd = (appendedTokens * cost.input) / 1e6;
		const outputUsdCap = (branchMaxTokens * cost.output) / 1e6;
		return {
			prefixTokens,
			warmPrefixUsd: round(warm, 6),
			coldPrefixUsd: round(cold, 6),
			appendedUsd: round(appendedUsd, 6),
			outputUsdAtCap: round(outputUsdCap, 6),
			totalWarmUsd: round(warm + appendedUsd + outputUsdCap, 6),
			totalColdUsd: round(cold + appendedUsd + outputUsdCap, 6),
			warmToColdRatio: round(cold / warm, 1),
		};
	});

	const data = {
		model: { id: model.id, provider: model.provider, api: model.api, costPerMTok: cost },
		tokenizer: "@oh-my-pi/pi-natives countTokens (exact)",
		branchRequest: {
			combinedBranchPromptTokens: branchPromptTokens,
			appendedMessagesOverMainPrefix: appended.length,
			appendedTokensIncludingConditioning: appendedTokens,
			branchMaxTokensDefault: branchMaxTokens,
		},
		fold: {
			deliveredFoldTokens: foldTokens,
			deliveredFoldBytes: Buffer.byteLength(foldText, "utf8"),
			unitsInFold: 2,
			scaling: foldScaling,
		},
		marginalSpendPerFork: perFork,
	};
	write("e3-tokens.json", data);
	return data;
}

/** Fidelity claims about where the fold lands and what it may never become. */
async function foldFidelity() {
	console.log("E3 fold fidelity");
	const h = await createHarness({
		script: { turns: [TOOL_TURN, TOOL_TURN, { text: "done" }], branchText: DEFAULT_REFLECT },
	});
	await h.session.prompt("fix the failing test");
	await h.session.prompt("and again");

	const mainCalls = h.script.mainCalls();
	const perCall = mainCalls.map((call, index) => {
		const folds = foldMessages(call.context);
		const last = call.context.messages.at(-1);
		return {
			callIndex: index,
			foldMessages: folds.length,
			foldIsFinalMessage: folds.length > 0 ? folds.at(-1) === last : null,
			foldRole: folds.at(-1)?.role ?? null,
		};
	});

	// The fold must never become a durable conversation message.
	const entries = h.session.sessionManager.getEntries() as { type: string; message?: { role: string; content: unknown } }[];
	const foldInEntries = entries.filter(
		entry => entry.type === "message" && JSON.stringify(entry.message?.content ?? "").includes("second_thought"),
	).length;
	const diagnosticEntries = entries.filter(entry => entry.type === "custom").length;

	const data = {
		mainCalls: mainCalls.length,
		branchCalls: h.script.branchCalls().length,
		perCall,
		foldsThatBecameConversationMessages: foldInEntries,
		customDiagnosticEntries: diagnosticEntries,
	};
	h.dispose();
	cleanupTempDirs();
	write("e3-fidelity.json", data);
	return data;
}

// ---------------------------------------------------------------------------

const reps = Number(process.env.ST_EVAL_REPS ?? 30);
const latency = await runLatency(reps);
const contextScaling = await runContextScaling([100, 5_000, 20_000, 50_000], Math.max(5, Math.floor(reps / 3)));
const harvestRace = await runHarvestRace([100, 500, 2_000, 5_000], [0, 250, 1_000, 3_000]);
const scenarios = await runScenarios();
const parity = prefixParity(scenarios);
write("e3-prefix-parity.json", parity);
const tokens = await tokenAccounting();
const fidelity = await foldFidelity();

write("summary.json", {
	generatedAt: new Date().toISOString(),
	reps,
	latency,
	contextScaling,
	harvestRace,
	prefixParity: { ...parity, rows: undefined },
	tokens,
	fidelity,
	scenarios: scenarios.map(({ wire: _wire, ...rest }) => rest),
});
console.log("done");
