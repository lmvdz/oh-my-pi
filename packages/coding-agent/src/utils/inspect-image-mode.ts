/**
 * Effective-state resolution for the `inspect_image` tool.
 *
 * The tool delegates image understanding to a (possibly different)
 * vision-capable model. That indirection is only useful when the active model
 * cannot consume images itself. Native-vision models ordinarily make the tool
 * redundant; however, when `images.describeForVisionModels` routes images to
 * an isolated vision sidecar, the active model does not receive pixels and the
 * tool must remain available for explicit inspection. `on`/`off` force
 * registration regardless of model capability. A session-scoped override (the
 * `/vision` command) takes precedence over the persisted setting for the
 * current session only.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";

export type InspectImageMode = "auto" | "on" | "off";

export const INSPECT_IMAGE_MODES = ["auto", "on", "off"] as const;

/** Minimal session surface needed to resolve the effective inspect_image state. */
export interface InspectImageModeContext {
	settings: Pick<Settings, "get">;
	getActiveModel?: () => Model | undefined;
	getInspectImageModeOverride?: () => InspectImageMode | undefined;
}

/**
 * Whether the `inspect_image` tool should be registered/active right now.
 * `auto` registers it when the active model lacks native image input or its
 * images are delegated to the isolated sidecar. An unresolved model is treated
 * as text-only so the tool stays available.
 */
export function isInspectImageToolActive(session: InspectImageModeContext): boolean {
	const mode = session.getInspectImageModeOverride?.() ?? session.settings.get("inspect_image.mode");
	if (mode === "on") return true;
	if (mode === "off") return false;
	const model = session.getActiveModel?.();
	if (session.settings.get("images.describeForVisionModels")) return true;
	return !(model?.input?.includes("image") ?? false);
}
