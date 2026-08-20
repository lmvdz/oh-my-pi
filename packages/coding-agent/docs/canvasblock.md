# Deferred CanvasBlock

The split-pane canvas uses Excalidraw in terminal-browser because it provides a real Chromium canvas with full pointer, keyboard, clipboard, and resize behavior. OMP's transcript cannot host that browser surface.

## Agent canvas

`/canvas` opens the active session's persistent board. On WSL, OMP opens it in the registered Windows browser because Windows Terminal cannot render the Kitty graphics protocol required for an in-terminal Chromium surface.

The built-in `canvas` agent tool provides `read` for a compact graph summary and `draw` for semantic nodes and arrows. This supports prompts such as “draw the architecture of this module” without asking the model to author raw Excalidraw JSON.

When a board exists, OMP mirrors every successful `todo` update onto an OMP-owned plan dashboard. The dashboard is live-synced to the browser, and other diagrams on the canvas are preserved.

An interactive in-TUI canvas would need to be a new terminal-native renderer, not an embedded Excalidraw component. It is deferred until the split-pane workflow proves useful.

## Constraints

- Transcript rows are committed to native scrollback and cannot safely be redrawn or hit-tested after they leave the live tail.
- `Image` components use terminal graphics placements for static rasters; they are not DOM canvases and must be budgeted and explicitly purged.
- Mouse tracking is currently designed for fullscreen overlays. Normal transcript interaction would need a focus/capture policy, a post-layout hit-test API, coordinate mapping, and a clear terminal-selection tradeoff.
- A live canvas needs bounded raster refreshes plus a non-graphics fallback. It must not keep an arbitrary historical transcript block permanently mutable.

## Future direction

If an in-TUI experience is needed, build a fullscreen `CanvasMode` as an OMP overlay with mouse tracking, an OMP-native scene model, and PNG/SVG/ASCII snapshot export back into chat. An inline card can later be a static preview that enters this mode; it should not claim to be inline-interactive.
