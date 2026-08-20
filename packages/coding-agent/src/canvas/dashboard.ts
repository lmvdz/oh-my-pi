import * as path from "node:path";
import { canvasServerManager } from "./manager";
import { type CanvasPlanPhase, syncPlanDashboard } from "./scene";

/** Publish authoritative todo state into an already-created session canvas. */
export async function updateCanvasPlanDashboard(
	artifactsDir: string | null | undefined,
	phases: CanvasPlanPhase[],
): Promise<void> {
	if (!artifactsDir) return;
	const scenePath = path.join(artifactsDir, "canvas.excalidraw");
	const file = Bun.file(scenePath);
	if (!(await file.exists())) return;
	const server = canvasServerManager.serverFor(scenePath);
	await server.replaceScene(syncPlanDashboard(await server.getScene(), phases), "omp-plan");
}
