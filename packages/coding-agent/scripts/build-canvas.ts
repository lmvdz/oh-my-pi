#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");
const canvasDir = path.join(packageDir, "src", "canvas");
const assetsDir = path.join(canvasDir, "assets");
const assetManifestPath = path.join(canvasDir, "asset-manifest.generated.ts");
const sourceFontsDir = path.join(repoRoot, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");

async function main(): Promise<void> {
	await fs.rm(assetsDir, { recursive: true, force: true });
	await fs.mkdir(assetsDir, { recursive: true });
	const output = await Bun.build({
		entrypoints: [path.join(canvasDir, "app.tsx")],
		outdir: assetsDir,
		target: "browser",
		format: "esm",
		naming: "app.[ext]",
		minify: true,
		splitting: false,
		throw: false,
	});
	if (!output.success) {
		throw new Error(`Canvas bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}
	await fs.cp(sourceFontsDir, path.join(assetsDir, "fonts"), { recursive: true });
	const assetPaths: string[] = [];
	for await (const entry of new Bun.Glob("**/*").scan({ cwd: assetsDir, onlyFiles: true })) {
		assetPaths.push(entry);
	}
	assetPaths.sort();
	const imports = assetPaths
		.map((entry, index) => `import asset${index} from "./assets/${entry}" with { type: "file" };`)
		.join("\n");
	const entries = assetPaths.map((entry, index) => `\t[${JSON.stringify(entry)}, asset${index}],`).join("\n");
	await Bun.write(
		assetManifestPath,
		`${imports}\n\nexport const canvasAssetFiles = new Map<string, string>([\n${entries}\n]);\n`,
	);
}

await main();
