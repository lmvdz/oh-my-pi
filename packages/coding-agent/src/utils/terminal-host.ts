export type TerminalHostKind =
	| "herdr"
	| "tmux"
	| "zellij"
	| "screen"
	| "cmux"
	| "wezterm"
	| "kitty"
	| "ghostty"
	| "vscode"
	| "unknown";

export interface TerminalHost {
	kind: TerminalHostKind;
	paneId?: string;
}

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const candidate = env[key]?.trim();
	return candidate || undefined;
}

/**
 * Identify the terminal or multiplexer that owns OMP's current pane.
 *
 * Pane IDs are accepted only from each host's authoritative environment
 * variable—`TERM` alone is not enough to target a user pane safely.
 */
export function detectTerminalHost(env: NodeJS.ProcessEnv = process.env): TerminalHost {
	const herdrPane = value(env, "HERDR_PANE_ID");
	if (herdrPane || value(env, "HERDR_ENV") === "1") return { kind: "herdr", paneId: herdrPane };

	const cmuxSurface = value(env, "CMUX_SURFACE_ID");
	if (cmuxSurface || value(env, "CMUX_WORKSPACE_ID")) return { kind: "cmux", paneId: cmuxSurface };

	const tmuxPane = value(env, "TMUX_PANE");
	if (tmuxPane || value(env, "TMUX") || value(env, "TERM")?.startsWith("tmux"))
		return { kind: "tmux", paneId: tmuxPane };

	const zellijPane = value(env, "ZELLIJ_PANE_ID");
	if (zellijPane || value(env, "ZELLIJ")) return { kind: "zellij", paneId: zellijPane };

	const weztermPane = value(env, "WEZTERM_PANE");
	if (weztermPane || value(env, "TERM_PROGRAM") === "WezTerm") return { kind: "wezterm", paneId: weztermPane };

	const kittyWindow = value(env, "KITTY_WINDOW_ID");
	if (kittyWindow || value(env, "TERM")?.includes("kitty")) return { kind: "kitty", paneId: kittyWindow };

	if (value(env, "TERM_PROGRAM") === "Ghostty") return { kind: "ghostty" };
	if (value(env, "TERM_PROGRAM") === "vscode") return { kind: "vscode" };
	if (value(env, "STY") || value(env, "TERM")?.startsWith("screen")) return { kind: "screen" };
	return { kind: "unknown" };
}
