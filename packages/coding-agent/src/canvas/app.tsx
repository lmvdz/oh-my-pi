import { Excalidraw, type ExcalidrawInitialDataState } from "@excalidraw/excalidraw";
import * as React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./app.css";
import { closeTerminalBrowserPane, requestCanvasPaneClose } from "./terminal-browser";

interface CanvasDocument extends ExcalidrawInitialDataState {
	files?: Record<string, unknown>;
}

const SAVE_DELAY_MS = 200;
const canvasClientId = crypto.randomUUID();

interface ExcalidrawSceneApi {
	updateScene(scene: ExcalidrawInitialDataState): void;
}

function CanvasApp() {
	const visualReviewMode = new URLSearchParams(window.location.search).has("review");
	const [scene, setScene] = React.useState<CanvasDocument | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [saveError, setSaveError] = React.useState<string | null>(null);
	const [closeError, setCloseError] = React.useState<string | null>(null);
	const saveTimer = React.useRef<number | undefined>(undefined);
	const latestScene = React.useRef<CanvasDocument | null>(null);
	const api = React.useRef<ExcalidrawSceneApi | null>(null);
	const persistScene = React.useCallback((nextScene: CanvasDocument, keepalive = false) => {
		return fetch("/scene", {
			method: "PUT",
			headers: { "content-type": "application/json", "x-canvas-client": canvasClientId },
			body: JSON.stringify(nextScene),
			keepalive,
		})
			.then(response => {
				if (!response.ok) throw new Error("Canvas changes could not be saved");
				setSaveError(null);
			})
			.catch(() =>
				setSaveError("Canvas changes could not be saved. Keep this pane open and reopen the canvas from OMP."),
			);
	}, []);
	const closeCanvas = React.useCallback(() => {
		setCloseError(null);
		if (closeTerminalBrowserPane()) return;
		void requestCanvasPaneClose()
			.then(message => {
				if (message) setCloseError(message);
			})
			.catch(() => setCloseError("OMP could not reach the canvas close service."));
	}, []);

	React.useEffect(() => {
		void fetch("/scene", { headers: { accept: "application/json" } })
			.then(async response => {
				if (!response.ok) throw new Error(`Failed to load canvas (${response.status})`);
				return (await response.json()) as CanvasDocument;
			})
			.then(nextScene => {
				latestScene.current = nextScene;
				setScene(nextScene);
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Failed to load canvas"));
		return () => {
			if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
		};
	}, []);

	React.useEffect(() => {
		const events = new EventSource("/events");
		events.onmessage = event => {
			try {
				const update = JSON.parse(event.data) as { source?: unknown; scene?: unknown };
				if (update.source === canvasClientId || typeof update.scene !== "object" || update.scene === null) return;
				api.current?.updateScene(update.scene as ExcalidrawInitialDataState);
				latestScene.current = update.scene as CanvasDocument;
				setScene(update.scene as CanvasDocument);
			} catch {
				// Ignore malformed transient events; the persisted scene remains authoritative.
			}
		};
		return () => events.close();
	}, []);

	React.useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "q") return;
			event.preventDefault();
			closeCanvas();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [closeCanvas]);

	React.useEffect(() => {
		const flush = () => {
			if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
			const pending = latestScene.current;
			if (pending) void persistScene(pending, true);
		};
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [persistScene]);

	if (error) return <main className="canvas-status">{error}</main>;
	if (!scene) return <main className="canvas-status">Loading canvas…</main>;

	return (
		<main className="canvas-shell">
			<Excalidraw
				excalidrawAPI={value => {
					api.current = value;
				}}
				initialData={{ ...scene, scrollToContent: true }}
				viewModeEnabled={visualReviewMode}
				zenModeEnabled={visualReviewMode}
				onChange={(elements, appState, files) => {
					const nextScene = { elements, appState, files } as CanvasDocument;
					latestScene.current = nextScene;
					if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
					saveTimer.current = window.setTimeout(() => {
						void persistScene(nextScene);
					}, SAVE_DELAY_MS);
				}}
			/>
			<button
				className="canvas-close"
				type="button"
				onClick={closeCanvas}
				title="Close canvas (Ctrl+Shift+Q)"
				aria-keyshortcuts="Control+Shift+Q Meta+Shift+Q"
			>
				Close canvas
			</button>
			{closeError ? (
				<p className="canvas-close-error" role="status">
					{closeError}
				</p>
			) : null}
			{saveError ? (
				<p className="canvas-save-error" role="status">
					{saveError}
				</p>
			) : null}
		</main>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Canvas root element is missing");

createRoot(rootElement).render(<CanvasApp />);
