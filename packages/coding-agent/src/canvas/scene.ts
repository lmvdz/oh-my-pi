import { randomUUID } from "node:crypto";

export type CanvasShape = "rectangle" | "ellipse" | "diamond";
export type CanvasNodeKind = "core" | "supporting" | "optional" | "external";

export interface CanvasNode {
	id?: string;
	label: string;
	/** Supporting text rendered beneath the node name. */
	subtitle?: string;
	shape?: CanvasShape;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	color?: string;
	fill?: string;
	/** Semantic role used to establish visual hierarchy when no explicit colors are supplied. */
	kind?: CanvasNodeKind;
}

export interface CanvasEdge {
	from: string;
	to: string;
	label?: string;
	color?: string;
}

export type CanvasLayout = "grid" | "horizontal" | "vertical";

export interface CanvasPlanTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
}

export interface CanvasPlanPhase {
	name: string;
	tasks: CanvasPlanTask[];
}

interface CanvasElement {
	[key: string]: unknown;
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	isDeleted?: boolean;
	text?: string;
	containerId?: string | null;
}

interface CanvasDocument {
	elements: CanvasElement[];
	appState?: Record<string, unknown>;
	files?: Record<string, unknown>;
}

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 72;
const BODY_FONT_SIZE = 16;
const TEXT_PADDING = 24;
const MAX_TEXT_COLUMNS = 34;

const NODE_STYLES: Record<CanvasNodeKind, { color: string; fill: string }> = {
	core: { color: "#1d4ed8", fill: "#eff6ff" },
	supporting: { color: "#475569", fill: "#f8fafc" },
	optional: { color: "#6d28d9", fill: "#f5f3ff" },
	external: { color: "#047857", fill: "#ecfdf5" },
};

function id(): string {
	return randomUUID().replaceAll("-", "");
}

function seed(): number {
	return Math.floor(Math.random() * 2 ** 31);
}

function base(
	type: string,
	x: number,
	y: number,
	width: number,
	height: number,
	color: string,
	backgroundColor = "transparent",
) {
	return {
		id: id(),
		type,
		x,
		y,
		width,
		height,
		angle: 0,
		strokeColor: color,
		backgroundColor,
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [],
		frameId: null,
		roundness: type === "rectangle" ? { type: 3 } : null,
		seed: seed(),
		version: 1,
		versionNonce: seed(),
		isDeleted: false,
		boundElements: [] as Array<{ id: string; type: string }>,
		updated: Date.now(),
		link: null,
		locked: false,
	};
}

function asDocument(value: unknown): CanvasDocument {
	if (typeof value !== "object" || value === null || !("elements" in value) || !Array.isArray(value.elements)) {
		return { elements: [] };
	}
	const document = value as CanvasDocument;
	return { elements: document.elements, appState: document.appState, files: document.files };
}

/** Compact semantic representation, safe for agent context. */
export function summarizeCanvas(value: unknown): {
	nodes: Array<{ id: string; label: string; type: string }>;
	edges: number;
} {
	const document = asDocument(value);
	const nodes = document.elements
		.filter(
			element =>
				!element.isDeleted &&
				(element.type === "rectangle" || element.type === "ellipse" || element.type === "diamond"),
		)
		.map(element => {
			const label =
				document.elements.find(text => text.containerId === element.id && text.type === "text")?.text ?? "";
			return { id: element.id, label, type: element.type };
		});
	return { nodes, edges: document.elements.filter(element => !element.isDeleted && element.type === "arrow").length };
}

interface PreparedNode {
	node: CanvasNode;
	text: string;
	lineCount: number;
	width: number;
	height: number;
}

function wrapLine(line: string): string[] {
	const words = line.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (current && candidate.length > MAX_TEXT_COLUMNS) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function prepareNode(node: CanvasNode): PreparedNode {
	const source = node.subtitle ? `${node.label}\n${node.subtitle}` : node.label;
	const lines = source.split("\n").flatMap(wrapLine);
	const longestLine = Math.max(...lines.map(line => line.length));
	const width = node.width ?? Math.max(DEFAULT_WIDTH, Math.min(440, TEXT_PADDING * 2 + longestLine * 10));
	const height = node.height ?? Math.max(DEFAULT_HEIGHT, 34 + lines.length * 22);
	return { node, text: lines.join("\n"), lineCount: lines.length, width, height };
}

function nodePosition(
	index: number,
	originY: number,
	layout: CanvasLayout,
	nodes: PreparedNode[],
	edges: CanvasEdge[],
): { x: number; y: number } {
	if (layout === "horizontal") {
		return {
			x: 100 + nodes.slice(0, index).reduce((offset, node) => offset + node.width + 100, 0),
			y: originY,
		};
	}
	if (layout === "vertical") {
		const prepared = nodes[index];
		if (prepared?.node.kind === "external") {
			const key = prepared.node.id ?? prepared.node.label;
			const connectedId = edges
				.map(edge => (edge.from === key ? edge.to : edge.to === key ? edge.from : undefined))
				.find(candidate => {
					if (!candidate) return false;
					return nodes.find(node => (node.node.id ?? node.node.label) === candidate)?.node.kind !== "external";
				});
			const connectedIndex = nodes.findIndex(node => (node.node.id ?? node.node.label) === connectedId);
			if (connectedIndex >= 0) {
				const anchor = nodePosition(connectedIndex, originY, layout, nodes, edges);
				return { x: anchor.x + nodes[connectedIndex]!.width + 160, y: anchor.y };
			}
			const externalIndex = nodes.slice(0, index).filter(node => node.node.kind === "external").length;
			return { x: 700, y: originY + externalIndex * (prepared.height + 64) };
		}
		return {
			x: 160,
			y:
				originY +
				nodes
					.slice(0, index)
					.filter(node => node.node.kind !== "external")
					.reduce((offset, node) => offset + node.height + 64, 0),
		};
	}
	const column = index % 3;
	const row = Math.floor(index / 3);
	const priorRows = Array.from({ length: row }, (_, rowIndex) =>
		nodes.slice(rowIndex * 3, rowIndex * 3 + 3).reduce((height, node) => Math.max(height, node.height), 0),
	);
	return {
		x: 100 + nodes.slice(row * 3, row * 3 + column).reduce((offset, node) => offset + node.width + 80, 0),
		y: originY + priorRows.reduce((offset, height) => offset + height + 80, 0),
	};
}

function edgePoints(
	from: CanvasElement,
	to: CanvasElement,
): { startX: number; startY: number; endX: number; endY: number } {
	const fromCenterX = from.x + from.width / 2;
	const fromCenterY = from.y + from.height / 2;
	const toCenterX = to.x + to.width / 2;
	const toCenterY = to.y + to.height / 2;
	if (Math.abs(toCenterX - fromCenterX) >= Math.abs(toCenterY - fromCenterY)) {
		return toCenterX >= fromCenterX
			? { startX: from.x + from.width, startY: fromCenterY, endX: to.x, endY: toCenterY }
			: { startX: from.x, startY: fromCenterY, endX: to.x + to.width, endY: toCenterY };
	}
	return toCenterY >= fromCenterY
		? { startX: fromCenterX, startY: from.y + from.height, endX: toCenterX, endY: to.y }
		: { startX: fromCenterX, startY: from.y, endX: toCenterX, endY: to.y + to.height };
}

/** Add a labelled graph to an Excalidraw document with deliberate layout and readable labels. */
export function addDiagram(
	value: unknown,
	nodes: CanvasNode[],
	edges: CanvasEdge[],
	options: { layout?: CanvasLayout; title?: string } = {},
): CanvasDocument {
	const document = asDocument(value);
	const created = new Map<string, CanvasElement>();
	const originY = document.elements.reduce((bottom, element) => Math.max(bottom, element.y + element.height), 0) + 120;
	const layout = options.layout ?? "grid";
	const preparedNodes = nodes.map(prepareNode);
	if (options.title) {
		document.elements.push({
			...base("text", 100, originY - 70, 900, 32, "#1c1c1c"),
			text: options.title,
			originalText: options.title,
			fontSize: 28,
			fontFamily: 5,
			textAlign: "left",
			verticalAlign: "middle",
			autoResize: true,
			lineHeight: 1.25,
		});
	}
	for (const [index, prepared] of preparedNodes.entries()) {
		const { node } = prepared;
		const automatic = nodePosition(index, originY, layout, preparedNodes, edges);
		const x = node.x ?? automatic.x;
		const y = node.y ?? automatic.y;
		const { width, height, text: textValue, lineCount } = prepared;
		const style = NODE_STYLES[node.kind ?? "supporting"];
		const shape = {
			...base(node.shape ?? "rectangle", x, y, width, height, node.color ?? style.color, node.fill ?? style.fill),
		};
		const text = {
			...base(
				"text",
				x + TEXT_PADDING,
				y + (height - lineCount * BODY_FONT_SIZE * 1.3) / 2,
				width - TEXT_PADDING * 2,
				lineCount * BODY_FONT_SIZE * 1.3,
				node.color ?? style.color,
			),
			text: textValue,
			originalText: textValue,
			fontSize: BODY_FONT_SIZE,
			fontFamily: 5,
			textAlign: "center",
			verticalAlign: "middle",
			containerId: shape.id,
			autoResize: true,
			lineHeight: 1.3,
		};
		shape.boundElements.push({ id: text.id, type: "text" });
		document.elements.push(shape, text);
		created.set(node.id ?? node.label, shape);
	}
	for (const edge of edges) {
		const from = created.get(edge.from);
		const to = created.get(edge.to);
		if (!from || !to) continue;
		const { startX, startY, endX, endY } = edgePoints(from, to);
		document.elements.push({
			...base("arrow", startX, startY, endX - startX, endY - startY, edge.color ?? "#1e1e1e"),
			points: [
				[0, 0],
				[endX - startX, endY - startY],
			],
			endArrowhead: "arrow",
			startArrowhead: null,
		});
		if (edge.label) {
			document.elements.push({
				...base(
					"text",
					(startX + endX) / 2 - 70,
					(startY + endY) / 2 - 16,
					140,
					24,
					edge.color ?? "#495057",
					"#ffffff",
				),
				text: edge.label,
				originalText: edge.label,
				fontSize: 16,
				fontFamily: 5,
				textAlign: "center",
				verticalAlign: "middle",
				autoResize: true,
				lineHeight: 1.25,
			});
		}
	}
	return document;
}

/** Replace the current scene with one coherent, agent-authored diagram. */
export function replaceDiagram(
	value: unknown,
	nodes: CanvasNode[],
	edges: CanvasEdge[],
	options: { layout?: CanvasLayout; title?: string } = {},
): CanvasDocument {
	const document = asDocument(value);
	return addDiagram({ ...document, elements: [] }, nodes, edges, options);
}

/** Replace the OMP-owned dashboard while leaving all user and agent diagrams intact. */
export function syncPlanDashboard(value: unknown, phases: CanvasPlanPhase[]): CanvasDocument {
	const document = asDocument(value);
	const isDashboard = (element: CanvasElement & { customData?: { ompCanvas?: string } }) =>
		element.customData?.ompCanvas === "plan-dashboard";
	document.elements = document.elements.filter(element => !isDashboard(element));
	const existingCount = document.elements.length;
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];
	for (const [phaseIndex, phase] of phases.entries()) {
		const phaseId = `phase-${phaseIndex}`;
		nodes.push({
			id: phaseId,
			label: phase.name,
			shape: "rectangle",
			x: 100 + phaseIndex * 340,
			y: 100,
			color: "#7048e8",
		});
		const laneOffsets = new Map<CanvasPlanTask["status"], number>();
		for (const [taskIndex, task] of phase.tasks.entries()) {
			const statusColor =
				task.status === "completed"
					? "#2f9e44"
					: task.status === "in_progress"
						? "#f08c00"
						: task.status === "blocked"
							? "#e03131"
							: "#495057";
			const taskId = `${phaseId}-task-${taskIndex}`;
			const lane = task.status === "in_progress" ? 0 : task.status === "completed" ? 2 : 1;
			const offset = laneOffsets.get(task.status) ?? 0;
			laneOffsets.set(task.status, offset + 1);
			nodes.push({
				id: taskId,
				label: `${task.status === "completed" ? "✓" : task.status === "in_progress" ? "→" : "○"} ${task.content}`,
				shape: "rectangle",
				x: 100 + phaseIndex * 340,
				y: 240 + lane * 240 + offset * 100,
				color: statusColor,
			});
			edges.push({ from: phaseId, to: taskId, color: statusColor });
		}
	}
	const updated = addDiagram(document, nodes, edges);
	for (const element of updated.elements.slice(existingCount)) {
		Object.assign(element, { customData: { ompCanvas: "plan-dashboard" } });
	}
	return updated;
}
