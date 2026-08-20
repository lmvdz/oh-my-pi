import { expect, test } from "bun:test";
import { resolveWslDragPath } from "../../src/utils/wsl-path";

test("translates Windows drag paths to WSL mounts", () => {
	expect(
		resolveWslDragPath("C:\\Users\\Lars\\Downloads\\Screenshot 2026-08-20 153406.png", "linux", {
			WSL_INTEROP: "/run/WSL/interop",
		}),
	).toBe("/mnt/c/Users/Lars/Downloads/Screenshot 2026-08-20 153406.png");
});

test("keeps native and non-drive paths unchanged", () => {
	expect(resolveWslDragPath("/tmp/image.png", "linux", { WSL_INTEROP: "/run/WSL/interop" })).toBe("/tmp/image.png");
	expect(resolveWslDragPath("C:\\Users\\Lars\\image.png", "darwin", {})).toBe("C:\\Users\\Lars\\image.png");
});
