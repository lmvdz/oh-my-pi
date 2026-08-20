import { expect, test } from "bun:test";
import { closeTerminalBrowserPane, requestCanvasPaneClose } from "../src/canvas/terminal-browser";

test("canvas close control quits only its terminal-browser page", () => {
	let quitCalls = 0;
	const page = { terminalBrowser: { quit: () => quitCalls++ } };

	expect(closeTerminalBrowserPane(page)).toBe(true);
	expect(quitCalls).toBe(1);
});

test("canvas close control reports an unavailable terminal-browser page API", () => {
	expect(closeTerminalBrowserPane({})).toBe(false);
});

test("canvas close control leaves a pane open when its page API fails", () => {
	const page = {
		terminalBrowser: {
			quit: () => {
				throw new Error("browser already closed");
			},
		},
	};

	expect(closeTerminalBrowserPane(page)).toBe(false);
});

test("canvas close control surfaces OMP's unsupported-host response", async () => {
	const message = await requestCanvasPaneClose(async () =>
		Response.json(
			{ closed: false, message: "OMP cannot close this canvas pane on the current terminal host." },
			{ status: 409 },
		),
	);

	expect(message).toBe("OMP cannot close this canvas pane on the current terminal host.");
});
