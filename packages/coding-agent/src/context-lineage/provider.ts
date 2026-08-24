import { semanticIdentity } from "./identity";
import type { RequestBlockView } from "./partition";

/**
 * Provider-reported cache observation (PRD §18.4). Never folded into
 * checkpoint or prefix identity: expected compatibility and observed reuse
 * are separate facts (P11).
 */
export interface CacheObservation {
	readonly status: "hit" | "write" | "miss" | "unsupported" | "unknown";
	readonly readTokens?: number;
	readonly writeTokens?: number;
	readonly uncachedInputTokens?: number;
	readonly providerRequestId?: string;
	readonly routeId?: string;
	readonly observedAt: number;
}

/**
 * Provider adapter boundary (NFR5): all cache-relevant encoding and
 * observation logic lives behind this contract; the coordinator never sees
 * provider payload internals.
 */
export interface LineageProviderAdapter {
	readonly providerId: string;
	/** Deterministic cache-relevant encoding of an ordered block view. */
	encodePrefix(blocks: readonly RequestBlockView[]): string;
}

/** Deterministic encoding used by tests and the fake provider (NFR6). */
export const FAKE_LINEAGE_PROVIDER: LineageProviderAdapter = {
	providerId: "fake-lineage",
	encodePrefix(blocks) {
		return semanticIdentity(
			"fake-provider-prefix",
			blocks.map(block => [block.kind, block.digest]),
		);
	},
};

/**
 * Deterministic prefix cache modelling exact-prefix providers (NFR6):
 * duplicate writers, hits, misses, and TTL expiry without real KV state.
 */
export class FakePrefixCache {
	readonly #writtenAt = new Map<string, number>();
	#now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.#now = now;
	}

	advanceClock(ms: number): void {
		const previous = this.#now;
		this.#now = () => previous() + ms;
	}

	clear(): void {
		this.#writtenAt.clear();
	}

	/** Provider-observed reuse for one encoded prefix; a miss becomes a write. */
	observe(encodedPrefix: string, tokensInPrefix: number, routeId?: string): CacheObservation {
		const now = this.#now();
		const writtenAt = this.#writtenAt.get(encodedPrefix);
		if (writtenAt !== undefined) {
			return {
				status: "hit",
				readTokens: tokensInPrefix,
				providerRequestId: `fake-${now}`,
				routeId,
				observedAt: now,
			};
		}
		this.#writtenAt.set(encodedPrefix, now);
		return {
			status: "write",
			writeTokens: tokensInPrefix,
			providerRequestId: `fake-${now}`,
			routeId,
			observedAt: now,
		};
	}
}

export interface ExactFamilyCheck {
	readonly compatible: boolean;
	/** First provider-visible divergence when incompatible; undefined otherwise. */
	readonly divergence?: {
		readonly index: number;
		readonly reason: string;
	};
}

/**
 * FR2/FR3: verify that every leaf request extends one immutable base through
 * the declared boundary. Uses block-view comparison; the first kind change or
 * content divergence disqualifies the family.
 */
export function verifyExactFamily(
	baseBlocks: readonly RequestBlockView[],
	leafBlocks: readonly (readonly RequestBlockView[])[],
	isDivergence: (left: RequestBlockView, right: RequestBlockView, index: number) => boolean = (left, right) =>
		left.kind !== right.kind || left.digest !== right.digest,
): ExactFamilyCheck {
	for (const leaf of leafBlocks) {
		for (let index = 0; index < Math.min(baseBlocks.length, leaf.length); index++) {
			if (isDivergence(baseBlocks[index]!, leaf[index]!, index)) {
				return {
					compatible: false,
					divergence: {
						index,
						reason: `leaf block ${index} (${leaf[index]!.digest}) diverges from the prepared base`,
					},
				};
			}
		}
		if (leaf.length < baseBlocks.length) {
			return {
				compatible: false,
				divergence: { index: leaf.length, reason: "leaf request is shorter than the prepared base" },
			};
		}
	}
	return { compatible: true };
}
