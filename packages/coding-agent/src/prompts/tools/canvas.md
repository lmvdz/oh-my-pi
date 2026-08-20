Use this tool to inspect or draw on the active session canvas. Treat a diagram as a designed explanation, not a dump of every implementation detail.

- `read` returns the current semantic node and edge summary.
- `draw` adds labelled shapes and arrows. `replace` clears the current scene and creates one coherent replacement; use it for a revised whole diagram so old and new drawings never overlap. Never use `replace` to add a small annotation to a user's diagram.
- Use stable node IDs in `nodes[].id` and reference those IDs in `edges[].from` and `edges[].to`.
- First choose a diagram grammar: `vertical` for layers and pipelines, `horizontal` for a primary flow, and `grid` only for peer systems. Give an architecture a concise `title`.
- Keep the diagram selective: typically 4–12 nodes. Put supporting detail in `subtitle`, not in extra nodes. One node should represent one concept.
- For an architecture, keep the primary stack to 3–6 core layers. Put optional capabilities in a short branch and external systems beside the layer they serve; do not make every crate a layer in one long spine. Use a short name and at most one supporting line per node. Do not label simple spine arrows.
- Establish hierarchy with `kind`: use `core` for the main path, `supporting` for ordinary components, `optional` for conditional layers, and `external` for remotes or outside systems. Reserve explicit bright colors for a single meaningful exception.
- Make arrows express a relationship or flow; avoid bidirectional or crossing arrows unless they communicate an important fact. After a replacement, `read` the scene and repair an unexpected node/edge count before claiming it is complete.
- Every `draw` and `replace` automatically receives a Qwen visual art-direction review. Treat a `repair` verdict as mandatory: make the concrete repairs and repeat the call, up to two times. `review` repeats the review without editing. Do not ask the user to supply a screenshot.
- The user can reposition or restyle anything in Excalidraw after it appears.
- Use the canvas for architecture, plans, workflows, and visual status—not as a substitute for source-code changes.
