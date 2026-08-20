# Terminal host awareness

OMP identifies the terminal or multiplexer surrounding its current pane, including tmux, cmux, HerdR, WezTerm, kitty, Ghostty, VS Code, Zellij, and screen. Pane IDs are used only when supplied by that host's authoritative environment variables.

Companion panes such as `/canvas` delegate splitting to `terminal-browser`. This keeps host-specific focus, graphics, and configuration requirements in the tool that owns them, while OMP can present meaningful host-aware status and errors.

Future companions can share this detection layer. Native split adapters should be added only when a host exposes a stable, scoped API; OMP must never infer a target pane from `TERM` alone or modify terminal configuration automatically.
