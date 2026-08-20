import * as path from "node:path";
import { $which, sanitizeText } from "@oh-my-pi/pi-utils";
import { isWsl, openPath } from "../utils/open";
import { detectTerminalHost, type TerminalHost } from "../utils/terminal-host";
import { canvasServerManager } from "./manager";
import type { CanvasCloseResult, CanvasServer } from "./server";

function commandError(stderr: string): string {
	const text = sanitizeText(stderr)
		.replace(/[\r\n]+/g, " ")
		.trim();
	return text.length > 0 ? text : "terminal-browser exited without an error message";
}

export function terminalBrowserCanvasCommand(executable: string, url: string): string[] {
	return [executable, "open", url, "--split", "right", "--size", "0.45", "--app-mode"];
}

export type CanvasOpenTarget = "external-browser" | "terminal-browser";

/**
 * Windows Terminal does not render the Kitty graphics protocol that
 * terminal-browser uses. On WSL, use the graphical browser companion instead.
 */
export function canvasOpenTarget(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): CanvasOpenTarget {
	return isWsl(platform, env) ? "external-browser" : "terminal-browser";
}

interface TerminalBrowserTab {
	url?: unknown;
}

interface TerminalBrowserEntry {
	pane?: { pane?: unknown };
	tabs?: unknown;
}

function matchingCanvasUrl(left: string, right: string): boolean {
	try {
		return new URL(left).href === new URL(right).href;
	} catch {
		return false;
	}
}

/** Extract the host pane which terminal-browser assigned to one canvas URL. */
export function terminalBrowserPaneForUrl(value: unknown, url: string): string | undefined {
	if (typeof value !== "object" || value === null || !("browsers" in value) || !Array.isArray(value.browsers)) {
		return undefined;
	}
	for (const candidate of value.browsers) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const browser = candidate as TerminalBrowserEntry;
		if (!Array.isArray(browser.tabs)) continue;
		const matchesUrl = browser.tabs.some(tab => {
			if (typeof tab !== "object" || tab === null) return false;
			const tabUrl = (tab as TerminalBrowserTab).url;
			return typeof tabUrl === "string" && matchingCanvasUrl(tabUrl, url);
		});
		const paneId = browser.pane?.pane;
		if (matchesUrl && typeof paneId === "string" && paneId.length > 0) return paneId;
	}
	return undefined;
}

async function terminalBrowserPane(executable: string, url: string): Promise<string | undefined> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const child = Bun.spawn([executable, "ls", "--all", "--json"], { stdout: "pipe", stderr: "ignore" });
		const [exitCode, stdout] = await Promise.all([
			child.exited,
			new Response(child.stdout as ReadableStream<Uint8Array>).text(),
		]);
		if (exitCode === 0) {
			try {
				const paneId = terminalBrowserPaneForUrl(JSON.parse(stdout) as unknown, url);
				if (paneId) return paneId;
			} catch {
				// terminal-browser's runtime state can change while it serializes the listing.
			}
		}
		if (attempt < 2) await Bun.sleep(100);
	}
	return undefined;
}

async function closeHerdRPane(paneId: string): Promise<CanvasCloseResult> {
	const herdr = $which("herdr");
	if (!herdr) return { closed: false, message: "OMP could not find HerdR to close this canvas pane." };
	const child = Bun.spawn([herdr, "pane", "close", paneId], { stdout: "ignore", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
	]);
	if (exitCode === 0) return { closed: true };
	return { closed: false, message: `HerdR could not close this canvas pane: ${commandError(stderr)}` };
}

function registerCloseFallback(server: CanvasServer, host: TerminalHost, paneId: string | undefined): void {
	if (host.kind !== "herdr" || !paneId) return;
	server.setCloseHandler(() => closeHerdRPane(paneId));
}

/** Open the active session's canvas in a terminal-browser right split. */
export async function openCanvas(
	artifactsDir: string,
): Promise<{ scenePath: string; url: string; host: TerminalHost; target: CanvasOpenTarget }> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("Canvas requires an interactive terminal");
	}
	const scenePath = path.join(artifactsDir, "canvas.excalidraw");
	const server = canvasServerManager.serverFor(scenePath);
	const host = detectTerminalHost();
	const target = canvasOpenTarget();
	if (target === "external-browser") {
		openPath(server.url);
		return { scenePath, url: server.url, host, target };
	}

	const terminalBrowser = $which("terminal-browser");
	if (!terminalBrowser) {
		throw new Error("Canvas requires terminal-browser. Install it from https://terminal-browser.com");
	}
	const child = Bun.spawn(terminalBrowserCanvasCommand(terminalBrowser, server.url), {
		stdin: "inherit",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
	]);
	if (exitCode !== 0) throw new Error(`terminal-browser could not open the canvas: ${commandError(stderr)}`);
	registerCloseFallback(server, host, await terminalBrowserPane(terminalBrowser, server.url));
	return { scenePath, url: server.url, host, target };
}
