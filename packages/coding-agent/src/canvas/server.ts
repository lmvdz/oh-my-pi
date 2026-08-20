import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { canvasAssetFiles } from "./asset-manifest.generated";
import canvasHtml from "./index.html" with { type: "text" };

const MAX_SCENE_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES = new Map([
	[".css", "text/css; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".woff2", "font/woff2"],
]);
const canvasPage = canvasHtml as unknown as string;

export interface CanvasServer {
	readonly url: string;
	isRunning(): boolean;
	getScene(): Promise<unknown>;
	replaceScene(scene: unknown, source?: string): Promise<void>;
	setCloseHandler(handler: CanvasCloseHandler): void;
	stop(): void;
}

interface CanvasEvent {
	source?: string;
	scene: unknown;
}

export interface CanvasCloseResult {
	closed: boolean;
	message?: string;
}

export type CanvasCloseHandler = () => Promise<CanvasCloseResult>;

export interface CanvasServerOptions {
	closeHandler?: CanvasCloseHandler;
}

function emptyScene(): Record<string, never[]> {
	return { elements: [] };
}

/** Excalidraw collaborators is a Map; JSON persistence would restore it as `{}` and crash the editor. */
function serializableScene(scene: unknown): unknown {
	if (!isRecord(scene) || !isRecord(scene.appState) || !("collaborators" in scene.appState)) return scene;
	const { collaborators: _collaborators, ...appState } = scene.appState;
	return { ...scene, appState };
}

async function loadScene(scenePath: string): Promise<unknown> {
	try {
		return serializableScene(await Bun.file(scenePath).json());
	} catch (error) {
		if (isEnoent(error)) return emptyScene();
		throw error;
	}
}

async function saveScene(scenePath: string, scene: unknown): Promise<void> {
	const serialized = JSON.stringify(serializableScene(scene));
	if (Buffer.byteLength(serialized) > MAX_SCENE_BYTES) {
		throw new Error("Canvas exceeds the 25 MiB session artifact limit");
	}
	const tempPath = `${scenePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.mkdir(path.dirname(scenePath), { recursive: true, mode: 0o700 });
		await Bun.write(tempPath, serialized);
		await fs.rename(tempPath, scenePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

function assetName(urlPath: string): string | null {
	const relativePath = urlPath.slice("/assets/".length);
	if (!relativePath || relativePath.includes("\\") || relativePath.split("/").some(part => part === "..")) return null;
	return relativePath;
}

async function serveAsset(urlPath: string): Promise<Response> {
	const name = assetName(urlPath);
	if (!name) return new Response("Not found", { status: 404 });
	const filePath = canvasAssetFiles.get(name);
	if (!filePath) return new Response("Not found", { status: 404 });
	const file = Bun.file(filePath);
	if (!(await file.exists())) return new Response("Not found", { status: 404 });
	return new Response(file, {
		headers: { "content-type": CONTENT_TYPES.get(path.extname(filePath)) ?? "application/octet-stream" },
	});
}

/** Start a localhost-only web host for one session-scoped Excalidraw scene. */
export function startCanvasServer(scenePath: string, options: CanvasServerOptions = {}): CanvasServer {
	let running = true;
	const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const encoder = new TextEncoder();
	const publish = (scene: unknown, source?: string) => {
		const event: CanvasEvent = { scene };
		if (source) event.source = source;
		const message = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
		for (const subscriber of subscribers) subscriber.enqueue(message);
	};
	let closeHandler: CanvasCloseHandler =
		options.closeHandler ??
		(async () => ({
			closed: false,
			message: "OMP cannot close this canvas pane on the current terminal host.",
		}));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			if (url.pathname === "/events") {
				if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
				let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
				const stream = new ReadableStream<Uint8Array>({
					start(next) {
						controller = next;
						subscribers.add(next);
					},
					cancel() {
						if (controller) subscribers.delete(controller);
					},
				});
				return new Response(stream, {
					headers: { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" },
				});
			}
			if (url.pathname === "/") {
				if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
				return new Response(canvasPage, { headers: { "content-type": "text/html; charset=utf-8" } });
			}
			if (url.pathname.startsWith("/assets/")) {
				if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
				return await serveAsset(url.pathname);
			}
			if (url.pathname === "/close") {
				if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
				try {
					const result = await closeHandler();
					return Response.json(result, { status: result.closed ? 200 : 409 });
				} catch (error) {
					logger.warn("Canvas close request failed", {
						scenePath,
						error: error instanceof Error ? error.message : String(error),
					});
					return Response.json(
						{ closed: false, message: "OMP could not close this canvas pane." },
						{ status: 500 },
					);
				}
			}
			if (url.pathname !== "/scene") return new Response("Not found", { status: 404 });
			try {
				if (request.method === "GET") return Response.json(await loadScene(scenePath));
				if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
				const contentLength = Number(request.headers.get("content-length"));
				if (Number.isFinite(contentLength) && contentLength > MAX_SCENE_BYTES) {
					return new Response("Canvas exceeds the 25 MiB session artifact limit", { status: 413 });
				}
				const scene = serializableScene(await request.json());
				await saveScene(scenePath, scene);
				publish(scene, request.headers.get("x-canvas-client")?.trim() || undefined);
				return new Response(null, { status: 204 });
			} catch (error) {
				logger.warn("Canvas request failed", {
					scenePath,
					error: error instanceof Error ? error.message : String(error),
				});
				return new Response(error instanceof Error ? error.message : "Canvas request failed", { status: 400 });
			}
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		isRunning: () => running,
		getScene: () => loadScene(scenePath),
		replaceScene: async (scene, source) => {
			await saveScene(scenePath, scene);
			publish(scene, source);
		},
		setCloseHandler: handler => {
			closeHandler = handler;
		},
		stop: () => {
			if (!running) return;
			running = false;
			server.stop(true);
		},
	};
}
