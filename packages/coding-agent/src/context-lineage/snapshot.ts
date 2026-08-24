import * as fs from "node:fs";
import * as path from "node:path";
import * as git from "../utils/git";
import { semanticIdentity } from "./identity";
import type { RepositorySnapshot } from "./types";

export interface ResolveRepositorySnapshotOptions {
	readonly signal?: AbortSignal;
	readonly untrackedPolicy?: RepositorySnapshot["untrackedPolicy"];
	/**
	 * NFR9 budget: the maximum number of staged, unstaged, and untracked files
	 * whose content is hashed into the overlay digest. Exceeding it truncates the
	 * overlay scope and is disclosed on the snapshot instead of growing unbounded.
	 */
	readonly maxDirtyFiles?: number;
}

const DEFAULT_MAX_DIRTY_FILES = 200;

interface TrackedOverlayEntry {
	readonly path: string;
	readonly indexBlobId?: string;
	readonly worktreeDigest?: string;
}

/** Resolve a read-only, reproducible repository snapshot for later manifest compilation. */
export async function resolveRepositorySnapshot(
	cwd: string,
	options: ResolveRepositorySnapshotOptions = {},
): Promise<RepositorySnapshot> {
	const repositoryRoot = await git.repo.root(cwd, options.signal);
	if (!repositoryRoot) throw new Error(`Context Lineage requires a Git repository: ${cwd}`);
	const headCommit = await git.head.sha(repositoryRoot, options.signal);
	if (!headCommit) throw new Error(`Context Lineage requires a resolved HEAD commit: ${repositoryRoot}`);
	const untrackedPolicy = options.untrackedPolicy ?? "exclude";
	const [stagedDiff, unstagedDiff, stagedPaths, unstagedPaths, untrackedPaths] = await Promise.all([
		git.diff(repositoryRoot, { cached: true, signal: options.signal }),
		git.diff(repositoryRoot, { signal: options.signal }),
		git.diff.changedFiles(repositoryRoot, { cached: true, signal: options.signal }),
		git.diff.changedFiles(repositoryRoot, { signal: options.signal }),
		untrackedPolicy === "include" ? git.ls.untracked(repositoryRoot, options.signal) : Promise.resolve([]),
	]);
	const trackedDirtyPaths = [...new Set([...stagedPaths, ...unstagedPaths])].sort();
	const sortedUntrackedPaths = [...untrackedPaths].sort();
	const maxDirtyFiles = Math.max(0, options.maxDirtyFiles ?? DEFAULT_MAX_DIRTY_FILES);
	const dirtyEntries = [
		...trackedDirtyPaths.map(dirtyPath => ({ kind: "tracked" as const, path: dirtyPath })),
		...sortedUntrackedPaths.map(dirtyPath => ({ kind: "untracked" as const, path: dirtyPath })),
	].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
	const observedDirty = dirtyEntries.length;
	const boundedDirty = observedDirty > maxDirtyFiles ? dirtyEntries.slice(0, maxDirtyFiles) : dirtyEntries;
	const tracked = await resolveTrackedOverlayEntries(
		repositoryRoot,
		boundedDirty.filter(entry => entry.kind === "tracked").map(entry => entry.path),
		options.signal,
	);
	const overlayDigest = await repositoryOverlayDigest(
		repositoryRoot,
		stagedDiff,
		unstagedDiff,
		boundedDirty.filter(entry => entry.kind === "untracked").map(entry => entry.path),
		tracked,
	);
	const snapshot: RepositorySnapshot = {
		version: 1,
		repositoryId: semanticIdentity("repository-root", path.resolve(repositoryRoot)),
		workspaceScopeId: semanticIdentity("workspace-scope", path.resolve(repositoryRoot)),
		headCommit,
		...(overlayDigest ? { overlayDigest } : {}),
		untrackedPolicy,
		...(observedDirty > maxDirtyFiles ? { overlayTruncated: { limit: maxDirtyFiles, observed: observedDirty } } : {}),
	};
	return snapshot;
}

/** Stable overlay digest, with untracked file content included only when policy permits it. */
export async function repositoryOverlayDigest(
	repositoryRoot: string,
	stagedDiff: string,
	unstagedDiff: string,
	untrackedPaths: readonly string[],
	tracked: readonly TrackedOverlayEntry[] = [],
): Promise<string | undefined> {
	const untracked = await Promise.all(
		[...untrackedPaths].sort().map(async relativePath => {
			const contents = await readRegularWorktreeFile(repositoryRoot, relativePath);
			return contents
				? { path: relativePath, digest: semanticIdentity("untracked-file", contents) }
				: { path: relativePath, unreadable: true };
		}),
	);
	if (stagedDiff.length === 0 && unstagedDiff.length === 0 && untracked.length === 0 && tracked.length === 0)
		return undefined;
	return semanticIdentity("repository-overlay", { stagedDiff, unstagedDiff, tracked, untracked });
}

async function resolveTrackedOverlayEntries(
	repositoryRoot: string,
	paths: readonly string[],
	signal: AbortSignal | undefined,
): Promise<TrackedOverlayEntry[]> {
	return await Promise.all(
		[...new Set(paths)].sort().map(async path => {
			const [indexBlobId, worktreeDigest] = await Promise.all([
				git.index.blobId(repositoryRoot, path, signal),
				worktreeFileDigest(repositoryRoot, path),
			]);
			return {
				path,
				...(indexBlobId ? { indexBlobId } : {}),
				...(worktreeDigest ? { worktreeDigest } : {}),
			};
		}),
	);
}

async function worktreeFileDigest(repositoryRoot: string, relativePath: string): Promise<string | undefined> {
	const contents = await readRegularWorktreeFile(repositoryRoot, relativePath);
	return contents ? semanticIdentity("tracked-worktree-file", contents) : undefined;
}

async function readRegularWorktreeFile(repositoryRoot: string, relativePath: string): Promise<Uint8Array | undefined> {
	let file: fs.promises.FileHandle;
	try {
		file = await fs.promises.open(
			path.join(repositoryRoot, relativePath),
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
		);
	} catch {
		return undefined;
	}
	try {
		return (await file.stat()).isFile() ? new Uint8Array(await file.readFile()) : undefined;
	} catch {
		return undefined;
	} finally {
		await file.close();
	}
}
