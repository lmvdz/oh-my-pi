import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LiveJournal } from "./journal";

function recorder(): { write: (line: string) => Promise<void>; lines: string[] } {
	const lines: string[] = [];
	return { lines, write: async line => void lines.push(line) };
}

describe("LiveJournal", () => {
	test("resolves an append only after the write actually lands, in gapless order", async () => {
		const landed: number[] = [];
		const order: number[] = [];
		const journal = new LiveJournal({
			sessionId: "s1",
			write: async line => {
				const envelope = JSON.parse(line);
				order.push(envelope.seq);
				await Bun.sleep(envelope.seq === 0 ? 20 : 0); // first write is slower than the second
				landed.push(envelope.seq);
			},
		});

		const first = journal.append({ type: "terminal", error: null });
		const second = journal.append({ type: "terminal", error: null });
		const [a, b] = await Promise.all([first, second]);

		expect(a.seq).toBe(0);
		expect(b.seq).toBe(1);
		// Queued in call order, and each resolves only once its own write landed —
		// so even though the first write is slower, both callers still observed
		// their write complete before their promise settled.
		expect(landed).toEqual([0, 1]);
		expect(order).toEqual([0, 1]);
	});

	test("a decision is written before mutating in-memory state — write-before-act", async () => {
		const writes: string[] = [];
		let sawWriteBeforeReturn = false;
		const journal = new LiveJournal({
			sessionId: "s1",
			write: async line => {
				writes.push(line);
			},
		});
		// A caller mimicking the arbiter's own pattern: no in-memory state changes
		// until the append this awaits has actually resolved.
		let inMemory: unknown;
		await journal.append({ type: "terminal", error: null }).then(envelope => {
			sawWriteBeforeReturn = writes.length === 1;
			inMemory = envelope;
		});
		expect(sawWriteBeforeReturn).toBe(true);
		expect(inMemory).toBeDefined();
	});

	test("sequence numbers are gapless and monotonic across many concurrent appends", async () => {
		const { write, lines } = recorder();
		const journal = new LiveJournal({ sessionId: "s1", write });
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				journal.append({ type: "artifact", artifact: { path: `a${i}`, status: "ready" } }),
			),
		);
		const seqs = results.map(r => r.seq);
		expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
		expect(lines).toHaveLength(20);
		// The file itself is gapless too, in call order, not completion order.
		const onDisk = lines.map(line => JSON.parse(line).seq);
		expect(onDisk).toEqual(seqs);
	});

	test("a write failure rejects that append but still advances the sequence, and never wedges later writes", async () => {
		let calls = 0;
		const journal = new LiveJournal({
			sessionId: "s1",
			write: async () => {
				calls += 1;
				if (calls === 1) throw new Error("disk full");
			},
		});

		const failing = journal.append({ type: "terminal", error: null });
		await expect(failing).rejects.toThrow("disk full");

		// The seq consumed by the failed write is never reused, and the append
		// after it still lands normally — the gap is visible, not silently healed.
		const next = await journal.append({ type: "terminal", error: null });
		expect(next.seq).toBe(1);
		await journal.flush();
		expect(calls).toBe(2);
	});

	test("the final terminal state is a durable record like any other", async () => {
		const { write, lines } = recorder();
		const journal = new LiveJournal({ sessionId: "call-1", write });
		await journal.append({ type: "terminal", error: "the transport dropped" });
		await journal.flush();
		expect(lines).toHaveLength(1);
		const envelope = JSON.parse(lines[0] as string);
		expect(envelope).toMatchObject({
			seq: 0,
			sessionId: "call-1",
			record: { type: "terminal", error: "the transport dropped" },
		});
	});

	test("a journal with no minted path is disabled and resolves without writing anything", async () => {
		const journal = new LiveJournal({ sessionId: "s1" });
		expect(journal.enabled).toBe(false);
		const envelope = await journal.append({ type: "terminal", error: null });
		expect(envelope.seq).toBe(0);
		const next = await journal.append({ type: "terminal", error: null });
		expect(next.seq).toBe(1); // still gapless even with nothing to persist
	});

	test("writes to a real path create the parent directory once and append newline-delimited JSON", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-journal-"));
		const filePath = path.join(dir, "nested", "journal.jsonl");
		const journal = new LiveJournal({ sessionId: "s1", path: filePath });
		await journal.append({ type: "terminal", error: null });
		await journal.append({ type: "artifact", artifact: { path: "report.md", status: "ready" } });
		await journal.flush();
		const text = await Bun.file(filePath).text();
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string).record).toEqual({ type: "terminal", error: null });
		expect(JSON.parse(lines[1] as string).record).toEqual({
			type: "artifact",
			artifact: { path: "report.md", status: "ready" },
		});
	});
});
