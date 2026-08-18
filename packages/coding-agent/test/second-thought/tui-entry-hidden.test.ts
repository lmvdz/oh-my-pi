/**
 * The diagnostic entry is a state entry, not a message. These tests pin the
 * three places that must keep ignoring it — the session tree, the LLM context
 * builder, and the `history://` serializer — because "a hidden custom entry
 * leaks into the tree / into context" is the exact failure class the design
 * review flagged (DESIGN.md, "Compaction cut points / tree editing /
 * hidden-custom leaks").
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SECOND_THOUGHT_FOLD_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/second-thought/fold";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";

/** Alt+A cycles the tree selector into its "all" filter mode. */
const ALT_A = "\x1ba";

const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp: "2026-01-01T00:00:00.000Z" });

const userEntry: SessionEntry = {
	...base("u1", null),
	type: "message",
	message: { role: "user", content: "start", timestamp: 0 } as AgentMessage,
} as SessionEntry;

const foldEntry: SessionEntry = {
	...base("st1", "u1"),
	type: "custom",
	customType: SECOND_THOUGHT_FOLD_CUSTOM_TYPE,
	data: {
		version: 1,
		generation: 1,
		unitsByAtom: { check: ["a leaked reflection unit"] },
		unitCount: 1,
		delivered: true,
		retireReason: "delivered",
	},
} as SessionEntry;

const assistantEntry: SessionEntry = {
	...base("a1", "st1"),
	type: "message",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		timestamp: 0,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	} as unknown as AgentMessage,
} as SessionEntry;

const entries = [userEntry, foldEntry, assistantEntry];

function chain(list: SessionEntry[]): SessionTreeNode {
	const nodes: SessionTreeNode[] = list.map(entry => ({ entry, children: [] }));
	for (let index = 1; index < nodes.length; index++) nodes[index - 1]?.children.push(nodes[index] as SessionTreeNode);
	return nodes[0] as SessionTreeNode;
}

function visibleRows(selector: TreeSelectorComponent): string {
	return selector
		.render(100)
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(row => row.trim())
		.join("\n");
}

function selector(): TreeSelectorComponent {
	return new TreeSelectorComponent(
		[chain(entries)],
		"a1",
		40,
		() => {},
		() => {},
	);
}

describe("second thought diagnostic entry is not a conversation node", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("never appears in the session tree's default view", () => {
		const rows = visibleRows(selector());
		expect(rows).toContain("user: start");
		expect(rows).not.toContain(SECOND_THOUGHT_FOLD_CUSTOM_TYPE);
		expect(rows).not.toContain("a leaked reflection unit");
	});

	it("shows only as an inert bookkeeping row in the tree's all-entries view", () => {
		const tree = selector();
		tree.handleInput(ALT_A);
		const rows = visibleRows(tree);
		// Visible for completeness, but as a type label — never as content a user
		// could mistake for something they said or the model said.
		expect(rows).toContain(`[custom: ${SECOND_THOUGHT_FOLD_CUSTOM_TYPE}]`);
		expect(rows).not.toContain("a leaked reflection unit");
	});
});

describe("second thought diagnostic entry never becomes a message", () => {
	it("contributes nothing to the LLM context", () => {
		const withFold = buildSessionContext([...entries], "a1");
		const withoutFold = buildSessionContext([userEntry, { ...assistantEntry, parentId: "u1" } as SessionEntry], "a1");
		expect(withFold.messages).toHaveLength(withoutFold.messages.length);
		expect(JSON.stringify(withFold.messages)).not.toContain(SECOND_THOUGHT_FOLD_CUSTOM_TYPE);
		expect(JSON.stringify(withFold.messages)).not.toContain("a leaked reflection unit");
	});

	it("contributes nothing to the history:// transcript", () => {
		const markdown = formatSessionHistoryMarkdown(buildSessionContext([...entries], "a1").messages);
		expect(markdown).toContain("start");
		expect(markdown).not.toContain(SECOND_THOUGHT_FOLD_CUSTOM_TYPE);
		expect(markdown).not.toContain("a leaked reflection unit");
	});
});
