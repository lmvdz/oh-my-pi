import * as path from "node:path";

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/** Translate a Windows drive path pasted by a terminal into its WSL mount path. */
export function resolveWslDragPath(
	value: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform !== "linux" || !(env.WSL_DISTRO_NAME || env.WSL_INTEROP)) return value;
	const match = WINDOWS_DRIVE_PATH.exec(value.trim());
	if (!match) return value;
	const [, drive, remainder] = match;
	const segments = remainder.replaceAll("\\", "/").split("/").filter(Boolean);
	return path.posix.join("/mnt", drive.toLowerCase(), ...segments);
}
