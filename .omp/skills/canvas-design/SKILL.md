---
name: canvas-design
description: Design clear, compact Excalidraw diagrams with OMP's canvas tool for architectures, plans, and flows. Use when a user asks to visualize a system or work in the session canvas.
---

# Canvas Design

Create a designed explanation, not a transcription of source files. Start by deciding what the reader should understand in one glance, then select only the components needed for that message.

Use `canvas` directly. Read the existing canvas before changing it. Use `replace` when redrawing an OMP-generated whole diagram; use `draw` only for a deliberate addition to the current scene.

## Choose the grammar

- **Architecture:** one primary path of 3–6 core layers; put remotes beside the layer they serve. Put optional capabilities in a short side branch rather than extending the main spine indefinitely.
- **Flow:** 3–6 left-to-right steps. Use a diamond only for a real decision and label the outgoing paths only when the distinction is essential.
- **Plan or dashboard:** group work by phase, show status with the built-in plan dashboard when available, and avoid making every task a node.
- **Peer systems:** use a small grid only when no reading order is implied.

Use one concise title. A node gets a short name and, only if necessary, a single supporting line. Prefer fewer than nine nodes. Do not put paragraphs, APIs, or multiple concepts inside a node. Do not use edge labels on a simple vertical spine; they collide with connectors at small canvas sizes.

## Visual hierarchy

Mark the main path `core`; use `optional` only for conditional parts and `external` only for systems outside the ownership boundary. Let this semantic hierarchy provide the color treatment—do not invent a rainbow palette. Reserve a custom accent color for one genuine focal exception.

Every arrow must have one direction and one clear meaning. Remove a relationship rather than add a bidirectional or crossing connector. If an architecture has many interactions, make a second focused diagram instead of turning the first into a dependency graph.

## Finish deliberately

After each `replace` or substantial `draw`, inspect the automatic Qwen art-direction review in the tool result. A `repair` verdict requires a concrete correction, then one retry. In particular, fix clipped copy, connector/label collisions, overfull stacks, and ambiguous arrow direction. Stop after two repair rounds and state any remaining tradeoff plainly.

## Anti-patterns

- Do not trust `vertical`/`grid` auto-arrangement past ~6 nodes. It clips tall stacks and tangles cross-column edges; the auto-placer does not know your edge semantics. The 3–6 core-layer rule exists partly because auto-layout breaks beyond it.
- Do not place a node at the same vertical level as a horizontal edge that must cross its column — the edge runs through the node's text.
- Do not route long diagonals across empty canvas between columns — they cross labels and box borders.
- Do not iterate the Qwen review past two repair rounds. Beyond that it starts inventing relationships that are not in the source (e.g. proposing an edge between two unrelated peers).
