import { logger } from "@oh-my-pi/pi-utils";

/**
 * §20.1/§20.2 milestone event families: local-only observation with opaque
 * identifiers and counts — never raw prompts, assignments, answers,
 * credentials, or unscoped hashes. Shared so runtime, adapters, and session
 * surfaces emit through one boundary.
 */
export function lineageEvent(event: string, dimensions: Record<string, unknown>): void {
	logger.debug(`lineage.${event}`, dimensions);
}
