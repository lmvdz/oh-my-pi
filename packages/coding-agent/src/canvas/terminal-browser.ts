export interface TerminalBrowserPageApi {
	quit(): void;
}

export type CanvasCloseRequest = (input: string, init: RequestInit) => Promise<Response>;

interface TerminalBrowserGlobal {
	terminalBrowser?: TerminalBrowserPageApi;
}

function isTerminalBrowserGlobal(value: unknown): value is TerminalBrowserGlobal {
	if (typeof value !== "object" || value === null || !("terminalBrowser" in value)) return false;
	const terminalBrowser = value.terminalBrowser;
	return (
		typeof terminalBrowser === "object" &&
		terminalBrowser !== null &&
		"quit" in terminalBrowser &&
		typeof terminalBrowser.quit === "function"
	);
}

/** Closes only the terminal-browser window hosting this page. */
export function closeTerminalBrowserPane(browserGlobal: unknown = globalThis): boolean {
	if (!isTerminalBrowserGlobal(browserGlobal)) return false;
	const terminalBrowser = browserGlobal.terminalBrowser;
	if (!terminalBrowser) return false;
	try {
		terminalBrowser.quit();
		return true;
	} catch {
		return false;
	}
}

function closeMessage(value: unknown): string | null {
	if (typeof value !== "object" || value === null || !("message" in value)) return null;
	return typeof value.message === "string" ? value.message : null;
}

/** Ask OMP to close the tracked host pane when the page API is unavailable. */
export async function requestCanvasPaneClose(request: CanvasCloseRequest = fetch): Promise<string | null> {
	const response = await request("/close", { method: "POST" });
	if (response.ok) return null;
	return closeMessage(await response.json()) ?? "OMP could not close this canvas pane.";
}
