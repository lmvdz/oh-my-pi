import { type CanvasServer, startCanvasServer } from "./server";

/**
 * Owns local canvas hosts for the lifetime of the interactive OMP process.
 *
 * A stopped host must not remain cached: the next `/canvas` invocation starts
 * a replacement instead of returning a stale localhost URL.
 */
export class CanvasServerManager {
	#servers = new Map<string, CanvasServer>();

	serverFor(scenePath: string): CanvasServer {
		const existing = this.#servers.get(scenePath);
		if (existing?.isRunning()) return existing;
		const server = startCanvasServer(scenePath);
		this.#servers.set(scenePath, server);
		return server;
	}

	activeServerFor(scenePath: string): CanvasServer | undefined {
		const server = this.#servers.get(scenePath);
		return server?.isRunning() ? server : undefined;
	}

	stopAll(): void {
		for (const server of this.#servers.values()) server.stop();
		this.#servers.clear();
	}
}

export const canvasServerManager = new CanvasServerManager();
