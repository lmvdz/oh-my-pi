import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canvasOpenTarget, terminalBrowserCanvasCommand, terminalBrowserPaneForUrl } from "../src/canvas/launcher";
import { CanvasServerManager } from "../src/canvas/manager";
import { addDiagram, replaceDiagram, summarizeCanvas, syncPlanDashboard } from "../src/canvas/scene";
import { startCanvasServer } from "../src/canvas/server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

test("canvas host persists scene edits to its session artifact", async () => {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-canvas-"));
	temporaryDirectories.push(artifactsDir);
	const scenePath = path.join(artifactsDir, "canvas.excalidraw");
	const server = startCanvasServer(scenePath);
	try {
		const page = await fetch(server.url);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(await page.text()).toContain('<script type="module" src="/assets/app.js"></script>');

		const appAsset = await fetch(`${server.url}/assets/app.js`);
		expect(appAsset.headers.get("content-type")).toContain("text/javascript");
		expect(await appAsset.text()).toContain("Excalidraw");

		const initial = (await (await fetch(`${server.url}/scene`)).json()) as { elements: unknown[] };
		expect(initial.elements).toEqual([]);

		const scene = { elements: [{ id: "rectangle" }], appState: {}, files: {} };
		const saved = await fetch(`${server.url}/scene`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(scene),
		});
		expect(saved.status).toBe(204);
		expect(await Bun.file(scenePath).json()).toEqual(scene);
	} finally {
		server.stop();
	}
});

test("canvas host strips the non-serializable Excalidraw collaborator map", async () => {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-canvas-"));
	temporaryDirectories.push(artifactsDir);
	const scenePath = path.join(artifactsDir, "canvas.excalidraw");
	const server = startCanvasServer(scenePath);
	try {
		await fetch(`${server.url}/scene`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ elements: [], appState: { collaborators: {}, gridSize: 20 } }),
		});
		expect(await Bun.file(scenePath).json()).toEqual({ elements: [], appState: { gridSize: 20 } });
		expect(await server.getScene()).toEqual({ elements: [], appState: { gridSize: 20 } });
	} finally {
		server.stop();
	}
});

test("canvas command opens terminal-browser in a right-side app-mode pane", () => {
	expect(terminalBrowserCanvasCommand("terminal-browser", "http://127.0.0.1:4567")).toEqual([
		"terminal-browser",
		"open",
		"http://127.0.0.1:4567",
		"--split",
		"right",
		"--size",
		"0.45",
		"--app-mode",
	]);
});

test("canvas command uses a graphical browser companion under WSL", () => {
	expect(canvasOpenTarget("linux", { WSL_INTEROP: "/run/WSL/1" })).toBe("external-browser");
	expect(canvasOpenTarget("linux", {})).toBe("terminal-browser");
});

test("semantic canvas drawing creates labelled nodes and connecting arrows", () => {
	const scene = addDiagram(
		{ elements: [] },
		[
			{ id: "api", label: "API" },
			{ id: "db", label: "Database" },
		],
		[{ from: "api", to: "db" }],
	);

	expect(summarizeCanvas(scene)).toEqual({
		nodes: [
			{ id: scene.elements[0]?.id, label: "API", type: "rectangle" },
			{ id: scene.elements[2]?.id, label: "Database", type: "rectangle" },
		],
		edges: 1,
	});
});

test("replacement produces one vertical architecture instead of stacking the prior diagram", () => {
	const initial = addDiagram({ elements: [] }, [{ id: "old", label: "Old architecture" }], []);
	const replacement = replaceDiagram(
		initial,
		[
			{ id: "ui", label: "UI", kind: "core" },
			{ id: "service", label: "Service", subtitle: "handles requests", kind: "supporting" },
		],
		[{ from: "ui", to: "service" }],
		{ layout: "vertical", title: "Request path" },
	);
	const shapes = replacement.elements.filter(element => element.type === "rectangle");
	const arrow = replacement.elements.find(element => element.type === "arrow");

	expect(summarizeCanvas(replacement).nodes.map(node => node.label)).toEqual(["UI", "Service\nhandles requests"]);
	expect(shapes[1]?.y).toBeGreaterThan((shapes[0]?.y ?? 0) + (shapes[0]?.height ?? 0));
	expect(arrow?.x).toBe((shapes[0]?.x ?? 0) + (shapes[0]?.width ?? 0) / 2);
	expect(arrow?.y).toBe((shapes[0]?.y ?? 0) + (shapes[0]?.height ?? 0));
	// Generated connectors have fixed border endpoints. Excalidraw rebinding
	// them to shape centres can draw a spine through node labels after reload.
	expect(arrow?.startBinding).toBeUndefined();
	expect(arrow?.endBinding).toBeUndefined();
	expect(shapes[0]?.backgroundColor).toBe("#eff6ff");
});

test("canvas wraps supporting copy inside a container sized for a readable architecture", () => {
	const scene = addDiagram(
		{ elements: [] },
		[
			{
				id: "provider",
				label: "stateroom-provider",
				subtitle: "SwitchyardProvider · DocStateQuery IR · route selection",
			},
		],
		[],
		{ layout: "vertical" },
	);
	const shape = scene.elements.find(element => element.type === "rectangle");
	const text = scene.elements.find(element => element.type === "text" && element.containerId === shape?.id);

	expect(text?.text).toEqual("stateroom-provider\nSwitchyardProvider · DocStateQuery\nIR · route selection");
	expect(shape?.width).toBeGreaterThanOrEqual(320);
	expect(shape?.height).toBeGreaterThan(90);
	expect(text?.fontSize).toBe(16);
});

test("vertical architectures place a connected external system alongside its layer", () => {
	const scene = addDiagram(
		{ elements: [] },
		[
			{ id: "provider", label: "Provider", kind: "core" },
			{ id: "switchyard", label: "Switchyard", kind: "external" },
			{ id: "sync", label: "Sync", kind: "core" },
		],
		[{ from: "provider", to: "switchyard" }],
		{ layout: "vertical" },
	);
	const shapes = scene.elements.filter(element => element.type === "rectangle");
	const provider = shapes[0];
	const switchyard = shapes[1];
	const sync = shapes[2];

	expect(switchyard?.x).toBeGreaterThan((provider?.x ?? 0) + (provider?.width ?? 0));
	expect(switchyard?.y).toBe(provider?.y);
	expect(sync?.y).toBeGreaterThan((provider?.y ?? 0) + (provider?.height ?? 0));
});

test("plan dashboard replaces only OMP-owned dashboard elements", () => {
	const scene = addDiagram({ elements: [] }, [{ id: "user", label: "User diagram" }], []);
	const first = syncPlanDashboard(scene, [
		{ name: "Build", tasks: [{ content: "Implement", status: "in_progress" }] },
	]);
	const second = syncPlanDashboard(first, [{ name: "Build", tasks: [{ content: "Implement", status: "completed" }] }]);
	const inProgressText = first.elements.find(element => element.text === "→ Implement");
	const completedText = second.elements.find(element => element.text === "✓ Implement");

	expect(summarizeCanvas(second).nodes.some(node => node.label === "User diagram")).toBe(true);
	expect(summarizeCanvas(second).nodes.some(node => node.label === "✓ Implement")).toBe(true);
	expect(completedText?.y).toBeGreaterThan(inProgressText?.y ?? 0);
	expect(
		second.elements.filter(
			element => (element as { customData?: { ompCanvas?: string } }).customData?.ompCanvas === "plan-dashboard",
		),
	).toHaveLength(5);
});

test("canvas host delegates a close request to its tracked terminal pane", async () => {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-canvas-"));
	temporaryDirectories.push(artifactsDir);
	const server = startCanvasServer(path.join(artifactsDir, "canvas.excalidraw"));
	let closeRequests = 0;
	server.setCloseHandler(async () => {
		closeRequests++;
		return { closed: true };
	});
	try {
		const response = await fetch(`${server.url}/close`, { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ closed: true });
		expect(closeRequests).toBe(1);
	} finally {
		server.stop();
	}
});

test("terminal-browser pane lookup selects the browser serving this canvas URL", () => {
	const listing = {
		browsers: [
			{ pane: { pane: "w1:p1A" }, tabs: [{ url: "https://example.com/" }] },
			{ pane: { pane: "w1:p1J" }, tabs: [{ url: "http://127.0.0.1:37007/" }] },
		],
	};

	expect(terminalBrowserPaneForUrl(listing, "http://127.0.0.1:37007")).toBe("w1:p1J");
});

test("canvas host is replaced instead of reusing a stopped localhost server", async () => {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-canvas-"));
	temporaryDirectories.push(artifactsDir);
	const manager = new CanvasServerManager();
	const scenePath = path.join(artifactsDir, "canvas.excalidraw");
	const first = manager.serverFor(scenePath);
	first.stop();

	const replacement = manager.serverFor(scenePath);
	try {
		expect(first.isRunning()).toBe(false);
		expect(replacement.isRunning()).toBe(true);
		expect((await fetch(`${replacement.url}/scene`)).status).toBe(200);
	} finally {
		manager.stopAll();
	}
});
