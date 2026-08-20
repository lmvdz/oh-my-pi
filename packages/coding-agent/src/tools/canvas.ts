import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { canvasServerManager } from "../canvas/manager";
import { renderCanvasReview } from "../canvas/review-renderer";
import { addDiagram, replaceDiagram, summarizeCanvas } from "../canvas/scene";
import canvasDescription from "../prompts/tools/canvas.md" with { type: "text" };
import canvasReviewPrompt from "../prompts/tools/canvas-review.md" with { type: "text" };
import type { ToolSession } from "./index";
import { InspectImageTool } from "./inspect-image";
import { ToolError } from "./tool-errors";

const canvasSchema = type({
	op: type("'read' | 'draw' | 'replace' | 'review'").describe(
		"read the canvas, add or replace a diagram, or render it for visual review",
	),
	"layout?": type("'grid' | 'horizontal' | 'vertical'").describe(
		"automatic diagram arrangement; use vertical for layer stacks",
	),
	"title?": type("string").describe("optional diagram title"),
	"nodes?": type({
		"id?": type("string").describe("stable node ID for edges"),
		label: type("string").describe("visible node label"),
		"subtitle?": type("string").describe("supporting text rendered beneath the label"),
		"shape?": type("'rectangle' | 'ellipse' | 'diamond'").describe("node shape"),
		"x?": type("number").describe("optional horizontal position"),
		"y?": type("number").describe("optional vertical position"),
		"width?": type("number").describe("optional node width"),
		"height?": type("number").describe("optional node height"),
		"color?": type("string").describe("optional stroke color"),
		"fill?": type("string").describe("optional background color"),
		"kind?": type("'core' | 'supporting' | 'optional' | 'external'").describe("semantic role for visual hierarchy"),
	})
		.array()
		.describe("nodes to add"),
	"edges?": type({
		from: type("string").describe("source node ID"),
		to: type("string").describe("target node ID"),
		"label?": type("string").describe("optional edge label"),
		"color?": type("string").describe("optional arrow color"),
	})
		.array()
		.describe("arrows to add"),
}).describe("inspect or draw on the active session canvas");

type CanvasToolInput = typeof canvasSchema.infer;

export class CanvasTool implements AgentTool<typeof canvasSchema> {
	readonly name = "canvas";
	readonly label = "Canvas";
	readonly summary = "Read or draw semantic diagrams on the active session canvas";
	readonly description = prompt.render(canvasDescription);
	readonly parameters = canvasSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly loadMode = "discoverable" as const;

	constructor(private readonly session: ToolSession) {}

	async #review(serverUrl: string, artifactsDir: string): Promise<string> {
		const screenshotPath = path.join(artifactsDir, "canvas-review.png");
		try {
			await renderCanvasReview(serverUrl, screenshotPath);
			const result = await new InspectImageTool(this.session).execute("canvas-review", {
				path: screenshotPath,
				question: prompt.render(canvasReviewPrompt),
			});
			const feedback = result.content
				.filter(content => content.type === "text")
				.map(content => content.text)
				.join("\n")
				.trim();
			return feedback
				? `Qwen visual art-direction review:\n${feedback}`
				: "Canvas was saved, but Qwen returned no visual-review feedback.";
		} catch (error) {
			return `Canvas was saved, but automated visual review was unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	async execute(
		_toolCallId: string,
		params: CanvasToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const artifactsDir = this.session.getArtifactsDir?.();
		if (!artifactsDir)
			throw new ToolError("Canvas is unavailable until this session has a persistent artifact directory.");
		const server = canvasServerManager.serverFor(path.join(artifactsDir, "canvas.excalidraw"));
		const scene = await server.getScene();
		if (params.op === "read") {
			return { content: [{ type: "text", text: JSON.stringify(summarizeCanvas(scene)) }] };
		}
		if (params.op === "review") {
			return { content: [{ type: "text", text: await this.#review(server.url, artifactsDir) }] };
		}
		const nodes = params.nodes ?? [];
		if (nodes.length === 0) throw new ToolError(`${params.op} requires at least one node.`);
		const options = { layout: params.layout, title: params.title };
		const updated =
			params.op === "replace"
				? replaceDiagram(scene, nodes, params.edges ?? [], options)
				: addDiagram(scene, nodes, params.edges ?? [], options);
		await server.replaceScene(updated, "omp-agent");
		const summary = JSON.stringify(summarizeCanvas(updated));
		const review = await this.#review(server.url, artifactsDir);
		return { content: [{ type: "text", text: `${summary}\n${review}` }] };
	}
}
