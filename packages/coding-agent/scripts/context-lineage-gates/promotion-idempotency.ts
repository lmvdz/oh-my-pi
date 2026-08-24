// T4b: origin-safe promotion against a REAL persisted SessionManager.
// Verifies: branch creation under the explicit origin leaf, digest-only
// provenance on disk, idempotency per (origin, assignment, answer), and
// restart-surviving idempotency via session reopen.

import * as fs from "node:fs";
import { promoteContextLineageResult, semanticIdentity } from "@oh-my-pi/pi-coding-agent/context-lineage";
import { sanitizeAssistantForReparentedHistory } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const dir = "/tmp/opencode/tier4-promote";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const ANSWER = "WidgetRegistry totals widget weights; scale multiplies by a factor.";
const ASSIGNMENT = "Promoted answer for question-1:";
const originSeedText = "seed turn";

function sink(manager: SessionManager) {
	return async (assignment: string, answer: string) => {
		const userId = manager.appendMessageToBranch(
			{ role: "user", content: [{ type: "text", text: assignment }], timestamp: Date.now() },
			null,
		);
		const assistantId = manager.appendMessageToBranch(
			sanitizeAssistantForReparentedHistory({
				role: "assistant",
				content: [{ type: "text", text: answer }],
				api: "text",
				provider: "context-lineage",
				model: "sidecar",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			}),
			userId,
		);
		return { sessionId: manager.getSessionId(), leafId: assistantId };
	};
}

// --- process 1: fresh session, seed an origin leaf, promote once ---
const managerA = SessionManager.create(dir, `${dir}/sessions`);
const originLeafId = managerA.appendMessageToBranch(
	{ role: "user", content: [{ type: "text", text: originSeedText }], timestamp: Date.now() },
	null,
);
const first = await promoteContextLineageResult({
	journal: managerA,
	originLeafId,
	assignment: ASSIGNMENT,
	answer: ANSWER,
	answerArtifactRef: "artifact://42",
	promote: sink(managerA),
});
console.log(`first:  reused=${first.reused} leaf=${first.leafId}`);
if (first.reused) throw new Error("first promotion reported reuse");

const sessionFile = managerA.getSessionFile()!;
await managerA.close();

// --- process 2 (fresh manager over the same file): identical request must reuse ---
const managerB = await SessionManager.open(sessionFile, undefined, undefined, {
	initialCwd: dir,
	suppressBreadcrumb: true,
});
const second = await promoteContextLineageResult({
	journal: managerB,
	originLeafId,
	assignment: ASSIGNMENT,
	answer: ANSWER,
	answerArtifactRef: "artifact://42",
	promote: sink(managerB),
});
console.log(`reopen: reused=${second.reused} leaf=${second.leafId} (same leaf: ${second.leafId === first.leafId})`);

// --- different answer must NOT reuse ---
const third = await promoteContextLineageResult({
	journal: managerB,
	originLeafId,
	assignment: ASSIGNMENT,
	answer: "A materially different answer.",
	answerArtifactRef: "artifact://43",
	promote: sink(managerB),
});
console.log(`variant: reused=${third.reused} leaf=${third.leafId} (distinct: ${third.leafId !== first.leafId})`);
await managerB.close();

// --- inspect durable bytes: digest-only provenance, no raw answer in records ---
const onDisk = await Bun.file(sessionFile).text();
const lineageRows = onDisk
	.split("\n")
	.filter(line => line.includes("context-lineage") && line.includes('"kind":"promotion"'));
console.log("promotion records on disk:", lineageRows.length);
const record = JSON.parse(lineageRows[0]!) as { data?: { answerDigest?: string; answerArtifactRef?: string } };
console.log(
	"digest-only provenance:",
	typeof record.data?.answerDigest === "string",
	"| artifactRef:",
	record.data?.answerArtifactRef,
);
console.log("raw answer leaked into record:", lineageRows[0]!.includes(ANSWER));
// the ANSWER itself belongs in the promoted branch messages, not the record:
console.log("promoted branch carries answer:", onDisk.includes(ANSWER));
