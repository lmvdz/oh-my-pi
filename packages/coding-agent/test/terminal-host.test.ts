import { expect, test } from "bun:test";
import { detectTerminalHost } from "../src/utils/terminal-host";

test("terminal host detection prefers an authoritative nested pane over generic terminal markers", () => {
	expect(detectTerminalHost({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4", TERM_PROGRAM: "WezTerm" })).toEqual({
		kind: "tmux",
		paneId: "%4",
	});
});

test("terminal host detection identifies cmux only from its host environment", () => {
	expect(detectTerminalHost({ CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "surface" })).toEqual({
		kind: "cmux",
		paneId: "surface",
	});
});

test("terminal host detection identifies HerdR's pane identifier", () => {
	expect(detectTerminalHost({ HERDR_ENV: "1", HERDR_PANE_ID: "pane-17" })).toEqual({
		kind: "herdr",
		paneId: "pane-17",
	});
});
