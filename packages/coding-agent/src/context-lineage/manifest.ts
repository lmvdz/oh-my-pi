import * as fs from "node:fs";
import * as path from "node:path";
import { GrepOutputMode, grep } from "@oh-my-pi/pi-natives";
import {
	collectModuleImportBindings,
	collectModuleSourceSpecifiers,
} from "../eval/js/shared/rewrite-imports";
import * as git from "../utils/git";
import { NATIVE_CURRENT_STATE_ADAPTER } from "./adapter";
import { canonicalJson, repositoryManifestIdentity, repositorySnapshotIdentity, semanticIdentity } from "./identity";
import { resolveRepositorySnapshot } from "./snapshot";
import type {
	RepositoryContextManifest,
	RepositoryEvidenceExcerpt,
	RepositoryEvidenceRef,
	RepositoryManifestDegradedSource,
	RepositoryManifestOmission,
	RepositorySnapshot,
} from "./types";

const DEFAULT_MAX_EVIDENCE = 12;
const DEFAULT_MAX_EXCERPT_BYTES = 12 * 1024;
const DEFAULT_MAX_CANDIDATE_BYTES = 512 * 1024;
const DEFAULT_MAX_DEPENDENCY_SCAN_FILES = 64;
const DEFAULT_MAX_SEMANTIC_SCAN_FILES = 64;
const MAX_VERIFICATION_SEMANTIC_SCAN_FILES = 64;
const MAX_VERIFICATION_DEPENDENCY_SCAN_FILES = 64;
const MAX_API_CONTRACT_TEST_FILES = 256;
const MAX_NATIVE_PHRASE_SEED_FILES = 8;
const MAX_NATIVE_PHRASE_SEED_DIRECTORIES = 16;
const MAX_NATIVE_PHRASE_CANDIDATES = 64;
const NATIVE_TASK_WINDOW_LINES = 48;
const NATIVE_COHERENT_TASK_TERM_BOOST = 32;
const DEFAULT_MAX_DIRTY_FILES = 200;
export interface CurrentStateRetrievalPolicy {
	readonly id: string;
	readonly maxEvidence?: number;
	readonly maxExcerptBytes?: number;
	readonly maxCandidateBytes?: number;
	readonly maxDependencyScanFiles?: number;
	readonly maxSemanticScanFiles?: number;
	/** NFR9: cap on staged/unstaged/untracked files hashed into the overlay digest. */
	readonly maxDirtyFiles?: number;
}

export interface CurrentStateManifestRequest {
	readonly task: string;
	readonly retrievalPolicy: CurrentStateRetrievalPolicy;
	readonly contextRendererVersion: string;
	/** Explicit current-source candidates from a caller's native analysis. */
	readonly paths?: readonly string[];
	readonly untrackedPolicy?: RepositorySnapshot["untrackedPolicy"];
	readonly degradedSources?: readonly RepositoryManifestDegradedSource[];
	readonly signal?: AbortSignal;
}

interface Candidate {
	readonly path: string;
	readonly score: number;
	readonly inclusionReason: string;
	readonly evidenceClass: RepositoryEvidenceRef["evidenceClass"];
	readonly sourceKind: string;
}

/**
 * Compile a bounded current-state manifest from source captured during one stable
 * repository observation. The manifest owns its excerpts, so later filesystem
 * changes cannot rewrite a prepared planning base.
 */
export async function compileCurrentStateRepositoryManifest(
	cwd: string,
	request: CurrentStateManifestRequest,
): Promise<RepositoryContextManifest> {
	validateRetrievalPolicy(request.retrievalPolicy);
	const before = await resolveRepositorySnapshot(cwd, {
		signal: request.signal,
		untrackedPolicy: request.untrackedPolicy,
		maxDirtyFiles: request.retrievalPolicy.maxDirtyFiles,
	});
	const repositoryRoot = await git.repo.root(cwd, request.signal);
	if (!repositoryRoot) throw new Error(`Context Lineage requires a Git repository: ${cwd}`);
	const [trackedPaths, untrackedPaths] = await Promise.all([
		git.ls.files(repositoryRoot, { signal: request.signal }),
		before.untrackedPolicy === "include" ? git.ls.untracked(repositoryRoot, request.signal) : Promise.resolve([]),
	]);
	const availablePaths = [...trackedPaths, ...untrackedPaths];
	const candidatePaths = candidatePathsForWorkspace(repositoryRoot, cwd, availablePaths, request.paths ?? []);
	const candidateSelection = await selectCandidates(repositoryRoot, candidatePaths, request);
	const dependencyExpansion = await expandRelativeDependencies(
		repositoryRoot,
		candidateSelection.candidates,
		availablePaths,
		candidatePaths,
		request,
	);
	const materialized = await materializeCandidates(repositoryRoot, before, dependencyExpansion.candidates, request);
	const after = await resolveRepositorySnapshot(repositoryRoot, {
		signal: request.signal,
		untrackedPolicy: before.untrackedPolicy,
		maxDirtyFiles: request.retrievalPolicy.maxDirtyFiles,
	});
	if (repositorySnapshotIdentity(before) !== repositorySnapshotIdentity(after)) {
		throw new Error("Repository changed while compiling Context Lineage evidence; retry the request");
	}
	return createRepositoryContextManifest({
		snapshot: before,
		task: request.task,
		retrievalPolicy: request.retrievalPolicy,
		contextRendererVersion: request.contextRendererVersion,
		evidence: materialized.evidence,
		omissions: materialized.omissions,
		degradedSources: [
			...(request.degradedSources ?? []),
			...candidateSelection.degradedSources,
			...dependencyExpansion.degradedSources,
			...(before.overlayTruncated
				? [
						{
							extractorId: "repository-overlay",
							reason: "budget_limited" as const,
							detail: `dirty-file hashing limited to ${before.overlayTruncated.limit} of ${before.overlayTruncated.observed} changed or untracked files`,
						},
					]
				: []),
		],
	});
}

/**
 * A package-scoped invocation should not spend its bounded native budget on
 * unrelated workspaces. Explicit paths retain cross-workspace authority, and
 * dependency expansion still resolves imports against every tracked path.
 */
function candidatePathsForWorkspace(
	repositoryRoot: string,
	cwd: string,
	availablePaths: readonly string[],
	explicitPaths: readonly string[],
): string[] {
	const workspaceRelative = path.relative(repositoryRoot, cwd).replaceAll("\\", "/").replace(/\/$/, "");
	if (workspaceRelative.length === 0 || workspaceRelative === "." || workspaceRelative.startsWith("..")) {
		return [...availablePaths];
	}
	const prefix = `${workspaceRelative}/`;
	const explicit = new Set(explicitPaths.map(candidatePath => candidatePath.replaceAll("\\", "/")));
	return availablePaths.filter(candidatePath => candidatePath.startsWith(prefix) || explicit.has(candidatePath));
}

/** Construct a canonical manifest from already frozen source evidence. */
export function createRepositoryContextManifest(input: {
	readonly snapshot: RepositorySnapshot;
	readonly task: string;
	readonly retrievalPolicy: CurrentStateRetrievalPolicy;
	readonly contextRendererVersion: string;
	readonly evidence: readonly RepositoryEvidenceRef[];
	readonly omissions?: readonly RepositoryManifestOmission[];
	readonly degradedSources?: readonly RepositoryManifestDegradedSource[];
}): RepositoryContextManifest {
	const manifest: RepositoryContextManifest = {
		version: 1,
		manifestId: "",
		snapshot: input.snapshot,
		taskDigest: semanticIdentity("repository-task", input.task),
		retrievalPolicyId: retrievalPolicyIdentity(input.retrievalPolicy),
		contextRendererVersion: input.contextRendererVersion,
		evidence: [...input.evidence].sort(compareEvidence),
		omissions: [...(input.omissions ?? [])].sort(compareOmission),
		degradedSources: [...(input.degradedSources ?? [])].sort(compareDegradedSource),
	};
	return { ...manifest, manifestId: repositoryManifestIdentity(manifest) };
}

/** Verify that persisted manifest content still matches its immutable identity. */
export function isRepositoryContextManifestIntact(manifest: RepositoryContextManifest): boolean {
	if (!manifest.manifestId.startsWith("repository-manifest:v1:")) return true;
	return manifest.manifestId === repositoryManifestIdentity(manifest);
}

/** Canonical persisted bytes for an inspectable manifest. */
export function serializeRepositoryContextManifest(manifest: RepositoryContextManifest): string {
	return canonicalJson(manifest);
}

/** Deterministic provider-independent display of bounded frozen evidence. */
export function renderRepositoryContextManifest(manifest: RepositoryContextManifest): string {
	const evidenceSections = manifest.evidence.map(evidence => {
		const header = `## ${evidence.sourceRef} (${evidence.inclusionReason})`;
		const provenance = [
			`Evidence ID: ${evidence.evidenceId}`,
			`Class: ${evidence.evidenceClass}`,
			`Source: ${evidence.sourceKind} via ${evidence.adapterId}@${evidence.adapterSchemaVersion}`,
			...(evidence.snapshotCoverage ? [`Snapshot coverage: ${evidence.snapshotCoverage}`] : []),
			...(evidence.staleness ? [`Staleness: ${renderStaleness(evidence.staleness)}`] : []),
		];
		if (!evidence.excerpt) return `${header}\n${provenance.join("\n")}`;
		if (evidence.excerpt.content === undefined) {
			return `${header}\n${provenance.join("\n")}\n\nSource excerpt digest: ${evidence.excerpt.contentDigest} (bytes stored separately)`;
		}
		return `${header}\n${provenance.join("\n")}\n\nSource excerpt:\n${indentExcerpt(evidence.excerpt.content)}`;
	});
	const sections = [
		"# Repository Context Manifest",
		`Snapshot: ${repositorySnapshotIdentity(manifest.snapshot)}`,
		...renderOverlayTruncation(manifest.snapshot),
		...evidenceSections,
		...renderOmissions(manifest.omissions),
		...renderDegradedSources(manifest.degradedSources),
	];
	return sections.join("\n\n");
}

function renderOverlayTruncation(snapshot: RepositorySnapshot): string[] {
	if (!snapshot.overlayTruncated) return [];
	return [
		`# Overlay truncated: hashed ${snapshot.overlayTruncated.limit} of ${snapshot.overlayTruncated.observed} dirty or untracked files`,
	];
}

/**
 * Digest-only projection of a manifest for durable session records: excerpt
 * bytes are dropped (they live in the artifact store) while identity, digests,
 * and provenance survive intact.
 */
export function stripRepositoryManifestSource(manifest: RepositoryContextManifest): RepositoryContextManifest {
	return {
		...manifest,
		evidence: manifest.evidence.map(evidence => {
			if (!evidence.excerpt) return evidence;
			const { content: _content, ...digestExcerpt } = evidence.excerpt;
			return { ...evidence, excerpt: digestExcerpt };
		}),
	};
}

/**
 * Concise, source-free inspection view for a frozen manifest. This is safe for
 * user-facing status surfaces while the full rendered manifest remains the
 * planning-skill input.
 */
export function summarizeRepositoryContextManifest(manifest: RepositoryContextManifest): string {
	const lines = [
		`Context Lineage manifest: ${manifest.manifestId}`,
		`Snapshot: ${repositorySnapshotIdentity(manifest.snapshot)}`,
		`Evidence: ${manifest.evidence.length} item(s); omissions: ${manifest.omissions.length}; degraded sources: ${manifest.degradedSources.length}`,
	];
	for (const evidence of manifest.evidence) {
		const excerpt = evidence.excerpt
			? `, ${evidence.excerpt.content === undefined ? "excerpt digest only" : evidence.excerpt.truncated ? "excerpt truncated" : "excerpt complete"}`
			: "";
		lines.push(`- ${evidence.sourceRef} [${evidence.evidenceClass}; ${evidence.inclusionReason}${excerpt}]`);
	}
	for (const omission of manifest.omissions) {
		lines.push(`- Omitted ${omission.sourceRef}: ${omission.reason} (${omission.detail})`);
	}
	for (const degraded of manifest.degradedSources) {
		lines.push(`- Degraded ${degraded.extractorId}: ${degraded.reason} (${degraded.detail})`);
	}
	for (const line of renderOverlayTruncation(manifest.snapshot)) {
		lines.push(line.replace(/^# /, ""));
	}
	return lines.join("\n");
}

function retrievalPolicyIdentity(policy: CurrentStateRetrievalPolicy): string {
	validateRetrievalPolicy(policy);
	return semanticIdentity("current-state-retrieval-policy", {
		id: policy.id,
		maxEvidence: policy.maxEvidence ?? DEFAULT_MAX_EVIDENCE,
		maxExcerptBytes: policy.maxExcerptBytes ?? DEFAULT_MAX_EXCERPT_BYTES,
		maxCandidateBytes: policy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
		maxDependencyScanFiles: policy.maxDependencyScanFiles ?? DEFAULT_MAX_DEPENDENCY_SCAN_FILES,
		maxSemanticScanFiles: policy.maxSemanticScanFiles ?? DEFAULT_MAX_SEMANTIC_SCAN_FILES,
		maxDirtyFiles: policy.maxDirtyFiles ?? DEFAULT_MAX_DIRTY_FILES,
	});
}

function validateRetrievalPolicy(policy: CurrentStateRetrievalPolicy): void {
	for (const [name, value] of Object.entries({
		maxEvidence: policy.maxEvidence,
		maxExcerptBytes: policy.maxExcerptBytes,
		maxCandidateBytes: policy.maxCandidateBytes,
		maxDependencyScanFiles: policy.maxDependencyScanFiles,
		maxSemanticScanFiles: policy.maxSemanticScanFiles,
		maxDirtyFiles: policy.maxDirtyFiles,
	})) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			throw new Error(`Context Lineage retrieval policy ${name} must be a non-negative safe integer`);
		}
	}
}

async function selectCandidates(
	repositoryRoot: string,
	paths: readonly string[],
	request: CurrentStateManifestRequest,
): Promise<{ candidates: Candidate[]; degradedSources: RepositoryManifestDegradedSource[] }> {
	const explicitPaths = new Set(request.paths ?? []);
	const terms = taskTerms(request.task);
	const normalizedPaths = [...new Set(paths.map(candidatePath => candidatePath.replaceAll("\\", "/")))].sort();
	const selected = new Map<string, Candidate>();
	for (const candidatePath of normalizedPaths) {
		const pathScore = terms.reduce((score, term) => score + (candidatePath.toLowerCase().includes(term) ? 1 : 0), 0);
		if (explicitPaths.has(candidatePath)) {
			selected.set(candidatePath, {
				path: candidatePath,
				score: 1000,
				inclusionReason: "explicit current-source candidate",
				...currentSourceClassification(candidatePath),
			});
		} else if (pathScore > 0) {
			selected.set(candidatePath, {
				path: candidatePath,
				// Primary task matches must outrank package/config/test expansion;
				// otherwise ancillary files consume the evidence budget before the
				// actual source that matched the task can be materialized.
				score: currentStateCandidateScore(candidatePath, pathScore) + directTaskPathBoost(candidatePath, pathScore),
				inclusionReason: "task terms match source path",
				...currentSourceClassification(candidatePath),
			});
		}
	}
	// Path names are cheap but weak signals: a loose filename match must not
	// prevent content retrieval from finding the source that actually implements
	// the requested behavior. Score both sources before package/test expansion;
	// otherwise one path hit can consume the evidence budget with boundaries and
	// hide the relevant implementation.
	const semanticScan = await selectContentCandidates(repositoryRoot, normalizedPaths, terms, request);
	for (const candidate of semanticScan.candidates) {
		const existing = selected.get(candidate.path);
		if (!existing || existing.score < candidate.score) {
			selected.set(candidate.path, candidate);
			continue;
		}
		// A test whose own bounded content matches the task must keep that
		// verification classification even when an exact path match has a higher
		// retrieval score. Materialization reserves this explicit test evidence;
		// otherwise the path-score boost silently turns it back into generic scope.
		if (candidate.inclusionReason === "task terms match verification source content") {
			selected.set(candidate.path, { ...candidate, score: existing.score });
		}
	}
	for (const primaryPath of selected.keys()) {
		for (const related of relatedCurrentStateCandidates(primaryPath, normalizedPaths)) {
			const existing = selected.get(related.path);
			if (!existing) {
				selected.set(related.path, related);
				continue;
			}
			// A test can also happen to match a task term in its filename. Preserve
			// that stronger ordering signal, but label it as verification evidence
			// so inspection does not misrepresent why the test was retained.
			if (
				related.inclusionReason.startsWith("verification candidate for ") &&
				!existing.inclusionReason.startsWith("explicit current-source candidate")
			) {
				selected.set(related.path, { ...related, score: Math.max(existing.score, related.score) });
			} else if (existing.score < related.score) {
				selected.set(related.path, related);
			}
		}
	}
	return {
		candidates: [...selected.values()].sort(
			(left, right) => right.score - left.score || left.path.localeCompare(right.path),
		),
		degradedSources: semanticScan.degradedSources,
	};
}

async function selectContentCandidates(
	repositoryRoot: string,
	paths: readonly string[],
	terms: readonly string[],
	request: CurrentStateManifestRequest,
): Promise<{ candidates: Candidate[]; degradedSources: RepositoryManifestDegradedSource[] }> {
	const semanticTerms = meaningfulTaskTerms(terms);
	if (semanticTerms.length === 0) return { candidates: [], degradedSources: [] };
	const sourcePaths = prioritizeTaskRelevantPaths(
		paths.filter(candidatePath => isSemanticSearchCandidate(candidatePath) && !isTestPath(candidatePath)),
		terms,
	);
	const verificationPaths = prioritizeTaskRelevantPaths(paths.filter(isTestPath), terms);
	const maxScanFiles = request.retrievalPolicy.maxSemanticScanFiles ?? DEFAULT_MAX_SEMANTIC_SCAN_FILES;
	const phraseSeed = await selectNativePhraseSeedCandidates(repositoryRoot, sourcePaths, request.task, semanticTerms, maxScanFiles, request.signal);
	const candidates: Candidate[] = [...phraseSeed.candidates];
	for (const candidatePath of sourcePaths.slice(0, maxScanFiles)) {
		const source = await readRegularSource(
			path.resolve(repositoryRoot, candidatePath),
			request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
		);
		if (!source) continue;
		const matchCount = semanticTerms.filter(term => source.toLowerCase().includes(term)).length;
		if (matchCount === 0) continue;
		candidates.push({
			path: candidatePath,
			score: currentStateCandidateScore(candidatePath, matchCount) + coherentTaskTermBoost(candidatePath, source, semanticTerms),
			inclusionReason: "task terms match current source content",
			...currentSourceClassification(candidatePath),
		});
	}
	for (const candidatePath of verificationPaths.slice(0, MAX_VERIFICATION_SEMANTIC_SCAN_FILES)) {
		const source = await readRegularSource(
			path.resolve(repositoryRoot, candidatePath),
			request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
		);
		if (!source) continue;
		const matchCount = semanticTerms.filter(term => source.toLowerCase().includes(term)).length;
		if (matchCount === 0) continue;
		candidates.push({
			path: candidatePath,
			score: currentStateCandidateScore(candidatePath, matchCount) + coherentTaskTermBoost(candidatePath, source, semanticTerms),
			inclusionReason: "task terms match verification source content",
			...currentSourceClassification(candidatePath),
		});
	}
	return {
		candidates,
		degradedSources:
			[
				...phraseSeed.degradedSources,
				...(sourcePaths.length > maxScanFiles
					? [
						{
							extractorId: "native-current-source-terms",
							reason: "budget_limited" as const,
							detail: `semantic scan limited to ${maxScanFiles} source files`,
						},
					]
					: []),
				...(verificationPaths.length > MAX_VERIFICATION_SEMANTIC_SCAN_FILES
					? [
						{
							extractorId: "native-verification-source-terms",
							reason: "budget_limited" as const,
							detail: `verification semantic scan limited to ${MAX_VERIFICATION_SEMANTIC_SCAN_FILES} test files`,
						},
					]
					: []),
			],
	};
}

/**
 * A phrase such as "Second Thought" often names a cross-cutting runtime whose
 * owner has a generic filename. Seed a small number of exact phrase hits with
 * the repository's native searcher, without widening the bounded content scan.
 */
async function selectNativePhraseSeedCandidates(
	repositoryRoot: string,
	sourcePaths: readonly string[],
	task: string,
	semanticTerms: readonly string[],
	maxScanFiles: number,
	signal: AbortSignal | undefined,
): Promise<{ candidates: Candidate[]; degradedSources: RepositoryManifestDegradedSource[] }> {
	const phrasePattern = taskPhrasePattern(task, semanticTerms);
	const maxSeedFiles = Math.min(maxScanFiles, MAX_NATIVE_PHRASE_SEED_FILES);
	const maxPhraseCandidates = Math.min(maxScanFiles, MAX_NATIVE_PHRASE_CANDIDATES);
	const phraseDirectories = nativePhraseSearchDirectories(sourcePaths);
	if (!phrasePattern || maxSeedFiles === 0 || phraseDirectories.directories.length === 0) {
		return { candidates: [], degradedSources: [] };
	}
	try {
		const available = new Set(sourcePaths);
		const matchedPaths = new Set<string>();
		let limitReached = false;
		for (const searchDirectory of phraseDirectories.directories) {
			if (matchedPaths.size >= maxPhraseCandidates || limitReached) break;
			const result = await grep(
				{
					pattern: phrasePattern,
					path: path.resolve(repositoryRoot, searchDirectory),
					glob: "*.ts",
					ignoreCase: true,
					multiline: false,
					hidden: true,
					gitignore: true,
					maxCount: maxPhraseCandidates - matchedPaths.size,
					maxCountPerFile: 1,
					contextBefore: 0,
					contextAfter: 0,
					mode: GrepOutputMode.FilesWithMatches,
					signal,
				},
				undefined,
			);
			limitReached ||= result.limitReached === true;
			for (const match of result.matches) {
				const candidatePath = nativeMatchRepositoryPath(repositoryRoot, searchDirectory, match.path);
				if (candidatePath && available.has(candidatePath)) matchedPaths.add(candidatePath);
			}
		}
		const candidates = await Promise.all(
			[...matchedPaths].map(async candidatePath => {
				const source = await readRegularSource(
					path.resolve(repositoryRoot, candidatePath),
					DEFAULT_MAX_CANDIDATE_BYTES,
				);
				return {
					path: candidatePath,
					// Exact phrase hits establish a domain match. Prefer an owner where
					// several task terms occur together in one bounded local context,
					// which separates a transition implementation from UI/docs that only
					// repeat the feature name. This measures distinct term coverage, not
					// raw term density, so repeated generic prose cannot win by volume.
					score:
						currentStateCandidateScore(candidatePath, semanticTerms.length + MAX_NATIVE_PHRASE_SEED_FILES) +
						coherentTaskTermBoost(candidatePath, source, semanticTerms),
					inclusionReason: "task phrase matches current source content",
					...currentSourceClassification(candidatePath),
				};
			}),
		);
		candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
		candidates.splice(maxSeedFiles);
		return {
			candidates,
			degradedSources:
				limitReached || phraseDirectories.truncated
					? [
						{
							extractorId: "native-current-source-phrases",
							reason: "budget_limited",
							detail: `phrase seed selected ${maxSeedFiles} from at most ${maxPhraseCandidates} matching files across ${MAX_NATIVE_PHRASE_SEED_DIRECTORIES} source directories`,
						},
					]
				: [],
		};
	} catch (error) {
		return {
			candidates: [],
			degradedSources: [
				{
					extractorId: "native-current-source-phrases",
					reason: "failed",
					detail: `phrase seed unavailable: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
}

/**
 * Reward only a local conjunction of task terms. A phrase hit with one feature
 * label is helpful, but an implementation owner typically also contains the
 * action and transition terms near that label. The small fixed window preserves
 * deterministic bounded retrieval and avoids corpus-wide word-frequency bias.
 */
function coherentTaskTermBoost(
	candidatePath: string,
	source: string | undefined,
	semanticTerms: readonly string[],
): number {
	if (!source || !isModuleSourcePath(candidatePath)) return 0;
	const bestCoverage = coherentTaskTermCoverage(source, semanticTerms);
	return bestCoverage >= 3 ? NATIVE_COHERENT_TASK_TERM_BOOST + bestCoverage : 0;
}

function coherentTaskTermCoverage(source: string, semanticTerms: readonly string[]): number {
	const lines = source.toLowerCase().split("\n");
	let bestCoverage = 0;
	for (let start = 0; start < lines.length; start++) {
		const window = lines.slice(start, start + NATIVE_TASK_WINDOW_LINES).join("\n");
		const coverage = semanticTerms.reduce((count, term) => count + (window.includes(term) ? 1 : 0), 0);
		bestCoverage = Math.max(bestCoverage, coverage);
	}
	return bestCoverage;
}

function taskPhrasePattern(task: string, semanticTerms: readonly string[]): string | undefined {
	const semantic = new Set(semanticTerms);
	const words = task.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
	const phrases = new Set<string>();
	for (let index = 0; index < words.length - 1; index++) {
		if (!semantic.has(words[index]!) || !semantic.has(words[index + 1]!)) continue;
		phrases.add(`\\b${escapeRegex(words[index]!)}[\\s_-]*${escapeRegex(words[index + 1]!)}\\b`);
	}
	return phrases.size > 0 ? [...phrases].sort().join("|") : undefined;
}

function commonCandidateDirectory(paths: readonly string[]): string | undefined {
	const directories = paths.map(candidatePath => path.posix.dirname(candidatePath).split("/").filter(Boolean));
	if (directories.length === 0) return undefined;
	const shared: string[] = [];
	for (let index = 0; ; index++) {
		const part = directories[0]?.[index];
		if (!part || directories.some(directory => directory[index] !== part)) break;
		shared.push(part);
	}
	return shared.length > 0 ? shared.join("/") : undefined;
}

function nativePhraseSearchDirectories(paths: readonly string[]): {
	readonly directories: readonly string[];
	readonly truncated: boolean;
} {
	const shared = commonCandidateDirectory(paths);
	if (shared) return { directories: [shared], truncated: false };
	const directories = new Set<string>();
	for (const candidatePath of paths) {
		const sourceMarker = candidatePath.indexOf("/src/");
		if (sourceMarker < 0) continue;
		directories.add(candidatePath.slice(0, sourceMarker + "/src".length));
	}
	return {
		directories: [...directories].slice(0, MAX_NATIVE_PHRASE_SEED_DIRECTORIES),
		truncated: directories.size > MAX_NATIVE_PHRASE_SEED_DIRECTORIES,
	};
}

function nativeMatchRepositoryPath(repositoryRoot: string, searchDirectory: string, matchPath: string): string | undefined {
	const absolutePath = path.isAbsolute(matchPath)
		? matchPath
		: path.resolve(repositoryRoot, searchDirectory, matchPath);
	if (!isRepositoryPath(repositoryRoot, absolutePath)) return undefined;
	return path.relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function relatedCurrentStateCandidates(primaryPath: string, allPaths: readonly string[]): Candidate[] {
	const primaryDirectory = path.posix.dirname(primaryPath);
	const fileName = path.posix.basename(primaryPath).replace(/\.[^.]+$/, "");
	return allPaths.flatMap(candidatePath => {
		if (candidatePath === "package.json" || candidatePath === `${primaryDirectory}/package.json`) {
			return [
				{
					path: candidatePath,
					score: 60,
					inclusionReason: `package boundary for ${primaryPath}`,
					...currentSourceClassification(candidatePath),
				},
			];
		}
		if (isConfigurationPath(candidatePath)) {
			return [
				{
					path: candidatePath,
					score: 50,
					inclusionReason: `configuration candidate for ${primaryPath}`,
					...currentSourceClassification(candidatePath),
				},
			];
		}
		if (candidatePath !== primaryPath && isMaintainedDecisionPath(candidatePath)) {
			return [
				{
					path: candidatePath,
					score: 40,
					inclusionReason: `maintained decision candidate for ${primaryPath}`,
					...currentSourceClassification(candidatePath),
				},
			];
		}
		const candidateName = path.posix.basename(candidatePath);
		if (isVerificationCandidate(fileName, candidateName)) {
			return [
				{
					path: candidatePath,
					score: 50,
					inclusionReason: `verification candidate for ${primaryPath}`,
					...currentSourceClassification(candidatePath),
				},
			];
		}
		return [];
	});
}

function currentSourceClassification(candidatePath: string): Pick<Candidate, "evidenceClass" | "sourceKind"> {
	const candidateName = path.posix.basename(candidatePath);
	if (candidateName === "package.json") return { evidenceClass: "current_workspace", sourceKind: "package_manifest" };
	if (isConfigurationPath(candidatePath))
		return { evidenceClass: "current_workspace", sourceKind: "configuration_file" };
	if (isMaintainedDecisionPath(candidatePath)) {
		return { evidenceClass: "maintained_decision", sourceKind: "maintained_decision" };
	}
	if (isVerificationCandidate(candidateName.replace(/\.(test|spec)\..*$/, ""), candidateName)) {
		return { evidenceClass: "current_structural", sourceKind: "test_file" };
	}
	return { evidenceClass: "current_structural", sourceKind: "workspace_file" };
}

function isConfigurationPath(candidatePath: string): boolean {
	const candidateName = path.posix.basename(candidatePath);
	return (
		candidateName === "tsconfig.json" ||
		candidateName === "bunfig.toml" ||
		candidateName === "biome.json" ||
		candidateName === "eslint.config.js" ||
		candidateName === "eslint.config.mjs" ||
		candidateName === "vite.config.ts" ||
		candidateName === "vitest.config.ts" ||
		candidateName === "jest.config.ts" ||
		candidateName === "jest.config.js"
	);
}

function isMaintainedDecisionPath(candidatePath: string): boolean {
	const normalizedPath = candidatePath.toLowerCase();
	const candidateName = path.posix.basename(normalizedPath);
	return (
		candidateName === "adr.md" ||
		candidateName === "architecture.md" ||
		candidateName === "architecture-decision-records.md" ||
		normalizedPath.startsWith("docs/adr/") ||
		normalizedPath.startsWith("docs/decisions/") ||
		normalizedPath.startsWith("docs/architecture/")
	);
}

function isVerificationCandidate(sourceName: string, candidateName: string): boolean {
	return (
		candidateName.startsWith(`${sourceName}.test.`) ||
		candidateName.startsWith(`${sourceName}.spec.`) ||
		candidateName.startsWith(`${sourceName}_test.`)
	);
}

async function expandRelativeDependencies(
	repositoryRoot: string,
	candidates: readonly Candidate[],
	availablePaths: readonly string[],
	workspacePaths: readonly string[],
	request: CurrentStateManifestRequest,
): Promise<{ candidates: Candidate[]; degradedSources: RepositoryManifestDegradedSource[] }> {
	const available = new Set(availablePaths.map(candidatePath => candidatePath.replaceAll("\\", "/")));
	const expanded = new Map(candidates.map(candidate => [candidate.path, candidate]));
	const maxScanFiles = request.retrievalPolicy.maxDependencyScanFiles ?? DEFAULT_MAX_DEPENDENCY_SCAN_FILES;
	const primaryCandidates = candidates
		.filter(candidate => isPrimarySourceCandidate(candidate) && isModuleSourcePath(candidate.path))
		.slice(0, maxScanFiles);
	const directDependencies = new Map<string, string>();
	for (const candidate of primaryCandidates) {
		const source = await readRegularSource(
			path.resolve(repositoryRoot, candidate.path),
			request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
		);
		if (!source) continue;
		for (const specifier of await collectModuleSourceSpecifiers(source)) {
			const resolvedPath = resolveRelativeModuleSpecifier(candidate.path, specifier, available);
			if (resolvedPath) directDependencies.set(resolvedPath, candidate.path);
			const existing = resolvedPath ? expanded.get(resolvedPath) : undefined;
			if (!resolvedPath || (existing && isPrimarySourceCandidate(existing))) continue;
			expanded.set(resolvedPath, {
				path: resolvedPath,
				// Dependency context is useful only after the source selected by the
				// task itself. A high score here let transitive imports crowd the
				// primary implementation out of a bounded manifest.
				score: 80,
				inclusionReason: `relative dependency of ${candidate.path}`,
				...currentSourceClassification(resolvedPath),
			});
		}
	}
	const apiContractTests = hasForkArtifactTaskIntent(request.task)
		? await selectForkArtifactContractTests(
			repositoryRoot,
			workspacePaths.filter(isTestPath),
			await selectForkArtifactDependencies(
				repositoryRoot,
				directDependencies,
				request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
			),
			request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
			request.signal,
		)
		: { paths: [], degradedSources: [] };
	for (const candidatePath of apiContractTests.paths) {
		expanded.set(candidatePath, {
			path: candidatePath,
			score: 185,
			inclusionReason: "verification candidate for fork artifact API contract",
			...currentSourceClassification(candidatePath),
		});
	}
	const allVerificationPaths = [...available].filter(isTestPath);
	const verificationTerms = meaningfulTaskTerms(taskTerms(request.task));
	const verificationPaths = prioritizeTaskRelevantPaths(allVerificationPaths, taskTerms(request.task)).slice(
		0,
		MAX_VERIFICATION_DEPENDENCY_SCAN_FILES,
	);
	for (const verificationPath of verificationPaths) {
		const source = await readRegularSource(
			path.resolve(repositoryRoot, verificationPath),
			request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
		);
		if (!source) continue;
		const matchedDependency = await matchingDirectDependency(source, directDependencies);
		if (!matchedDependency) continue;
		const taskMatchCount = verificationTerms.filter(term => source.toLowerCase().includes(term)).length;
		// A module import alone is too broad in this monorepo: many session tests
		// share SessionManager. Require a small multi-term task match so this bridge
		// preserves a behavioral verification surface rather than a merely related
		// harness.
		if (taskMatchCount < 3) continue;
		const existing = expanded.get(verificationPath);
		const score = 180 + taskMatchCount;
		if (existing && existing.score >= score) continue;
		expanded.set(verificationPath, {
			path: verificationPath,
			score,
			inclusionReason: `verification imports dependency of ${matchedDependency}`,
			...currentSourceClassification(verificationPath),
		});
	}
	const primaryPaths = new Set(primaryCandidates.map(candidate => candidate.path));
	const moduleSourcePaths = prioritizeTaskRelevantPaths([...available].filter(isModuleSourcePath), taskTerms(request.task));
	const sourcePaths = moduleSourcePaths.slice(0, maxScanFiles);
	const dependents = new Map<string, string[]>();
	for (const sourcePath of sourcePaths) {
		const source = await readRegularSource(
			path.resolve(repositoryRoot, sourcePath),
			request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
		);
		if (!source) continue;
		for (const specifier of await collectModuleSourceSpecifiers(source)) {
			const resolvedPath = resolveRelativeModuleSpecifier(sourcePath, specifier, available);
			if (!resolvedPath || !primaryPaths.has(resolvedPath) || resolvedPath === sourcePath) continue;
			const targets = dependents.get(sourcePath) ?? [];
			targets.push(resolvedPath);
			dependents.set(sourcePath, targets);
		}
	}
	for (const [dependentPath, targetPaths] of dependents) {
		const existingDependent = expanded.get(dependentPath);
		if (
			(existingDependent && isPrimarySourceCandidate(existingDependent)) ||
			existingDependent?.inclusionReason.startsWith("verification candidate for ")
		) {
			continue;
		}
		const targetPath = [...new Set(targetPaths)].sort()[0]!;
		expanded.set(dependentPath, {
			path: dependentPath,
			score: 70,
			inclusionReason: `relative dependent of ${targetPath}`,
			...currentSourceClassification(dependentPath),
		});
	}
	const degradedSources: RepositoryManifestDegradedSource[] = [];
	if (
		primaryCandidates.length <
			candidates.filter(candidate => isPrimarySourceCandidate(candidate) && isModuleSourcePath(candidate.path))
				.length ||
		sourcePaths.length < moduleSourcePaths.length
	) {
		degradedSources.push({
			extractorId: "native-relative-imports",
			reason: "budget_limited",
			detail: `dependency scan limited to ${maxScanFiles} module files`,
		});
	}
	if (verificationPaths.length < allVerificationPaths.length) {
		degradedSources.push({
			extractorId: "native-verification-dependencies",
			reason: "budget_limited",
			detail: `verification dependency scan limited to ${MAX_VERIFICATION_DEPENDENCY_SCAN_FILES} test files`,
		});
	}
	degradedSources.push(...apiContractTests.degradedSources);
	return {
		candidates: [...expanded.values()].sort(
			(left, right) => right.score - left.score || left.path.localeCompare(right.path),
		),
		degradedSources,
	};
}

async function selectForkArtifactDependencies(
	repositoryRoot: string,
	dependencies: ReadonlyMap<string, string>,
	maxBytes: number,
): Promise<Set<string>> {
	const matches = new Set<string>();
	for (const dependencyPath of [...dependencies.keys()].sort()) {
		const source = await readRegularSource(path.resolve(repositoryRoot, dependencyPath), maxBytes);
		if (!source) continue;
		const lower = source.toLowerCase();
		if (lower.includes("fork") && lower.includes("artifact")) matches.add(moduleEndpoint(dependencyPath));
	}
	return matches;
}

async function selectForkArtifactContractTests(
	repositoryRoot: string,
	testPaths: readonly string[],
	apiDependencies: ReadonlySet<string>,
	maxBytes: number,
	signal: AbortSignal | undefined,
): Promise<{ paths: string[]; degradedSources: RepositoryManifestDegradedSource[] }> {
	if (apiDependencies.size === 0) return { paths: [], degradedSources: [] };
	const directories = new Set<string>();
	for (const testPath of testPaths) {
		const marker = testPath.indexOf("/test/");
		if (marker >= 0) directories.add(testPath.slice(0, marker + "/test".length));
	}
	const available = new Set(testPaths);
	const candidates = new Set<string>();
	let limitReached = false;
	for (const directory of [...directories].sort()) {
		if (candidates.size >= MAX_API_CONTRACT_TEST_FILES || limitReached) break;
		const result = await grep(
			{
				pattern: [...apiDependencies].map(escapeRegex).join("|"),
				path: path.resolve(repositoryRoot, directory),
				glob: "**/*.test.ts",
				ignoreCase: true,
				multiline: false,
				hidden: true,
				gitignore: true,
				maxCount: MAX_API_CONTRACT_TEST_FILES - candidates.size,
				maxCountPerFile: 1,
				contextBefore: 0,
				contextAfter: 0,
				mode: GrepOutputMode.FilesWithMatches,
				signal,
			},
			undefined,
		);
		limitReached ||= result.limitReached === true;
		for (const match of result.matches) {
			const path = nativeMatchRepositoryPath(repositoryRoot, directory, match.path);
			if (path && available.has(path)) candidates.add(path);
		}
	}
	const paths: string[] = [];
	for (const candidatePath of candidates) {
		const source = await readRegularSource(path.resolve(repositoryRoot, candidatePath), maxBytes);
		if (!source || !source.includes("copyArtifacts")) continue;
		const bindings = await collectModuleImportBindings(source);
		if (
			bindings.some(binding => apiDependencies.has(moduleSpecifierEndpoint(binding.source)) && binding.imported === "SessionManager") &&
			source.includes("forkFrom")
		) {
			paths.push(candidatePath);
		}
	}
	return {
		paths: paths.sort(),
		degradedSources: limitReached
			? [
					{
						extractorId: "native-fork-artifact-api-contract",
						reason: "budget_limited",
						detail: `API contract scan limited to ${MAX_API_CONTRACT_TEST_FILES} matching test files`,
					},
				]
			: [],
	};
}

function moduleSpecifierEndpoint(specifier: string): string {
	return specifier.split("/").at(-1) ?? specifier;
}

function hasForkArtifactTaskIntent(task: string): boolean {
	const terms = new Set(taskTerms(task));
	return terms.has("fork") && terms.has("artifact");
}

/** Match alias and relative imports by the direct dependency's terminal module name. */
async function matchingDirectDependency(source: string, dependencies: ReadonlyMap<string, string>): Promise<string | undefined> {
	if (dependencies.size === 0) return undefined;
	for (const specifier of await collectModuleSourceSpecifiers(source)) {
		for (const [dependencyPath, ownerPath] of dependencies) {
			const endpoint = moduleEndpoint(dependencyPath);
			if (specifier === endpoint || specifier.endsWith(`/${endpoint}`)) return ownerPath;
		}
	}
	return undefined;
}

function moduleEndpoint(modulePath: string): string {
	return path.posix.basename(modulePath).replace(/\.[^.]+$/, "");
}

async function readRegularSource(absolutePath: string, maxBytes: number): Promise<string | undefined> {
	let file: fs.promises.FileHandle;
	try {
		file = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	try {
		const status = await file.stat();
		if (!status.isFile() || status.size > maxBytes) return undefined;
		return new TextDecoder().decode(await file.readFile());
	} catch {
		return undefined;
	} finally {
		await file.close();
	}
}

function isPrimarySourceCandidate(candidate: Candidate): boolean {
	return (
		candidate.inclusionReason === "explicit current-source candidate" ||
		candidate.inclusionReason === "task terms match source path" ||
		candidate.inclusionReason === "task terms match current source content" ||
		candidate.inclusionReason === "task phrase matches current source content"
	);
}

function isModuleSourcePath(candidatePath: string): boolean {
	return /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(candidatePath);
}

function resolveRelativeModuleSpecifier(
	importerPath: string,
	specifier: string,
	availablePaths: ReadonlySet<string>,
): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const basePath = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
	const candidates = [
		basePath,
		`${basePath}.ts`,
		`${basePath}.tsx`,
		`${basePath}.js`,
		`${basePath}.jsx`,
		`${basePath}/index.ts`,
		`${basePath}/index.tsx`,
		`${basePath}/index.js`,
		`${basePath}/index.jsx`,
	];
	return candidates.find(candidatePath => availablePaths.has(candidatePath));
}

async function materializeCandidates(
	repositoryRoot: string,
	snapshot: RepositorySnapshot,
	candidates: readonly Candidate[],
	request: CurrentStateManifestRequest,
): Promise<{ evidence: RepositoryEvidenceRef[]; omissions: RepositoryManifestOmission[] }> {
	const maxEvidence = request.retrievalPolicy.maxEvidence ?? DEFAULT_MAX_EVIDENCE;
	const maxExcerptBytes = request.retrievalPolicy.maxExcerptBytes ?? DEFAULT_MAX_EXCERPT_BYTES;
	const maxCandidateBytes = request.retrievalPolicy.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES;
	const evidence: RepositoryEvidenceRef[] = [];
	const omissions: RepositoryManifestOmission[] = [];
	for (const candidate of reserveTaskMatchedVerificationCandidates(candidates, maxEvidence)) {
		if (evidence.length >= maxEvidence) {
			omissions.push({ sourceRef: candidate.path, reason: "budget", detail: `evidence limit ${maxEvidence}` });
			continue;
		}
		const absolutePath = path.resolve(repositoryRoot, candidate.path);
		if (!isRepositoryPath(repositoryRoot, absolutePath)) {
			omissions.push({ sourceRef: candidate.path, reason: "unreadable", detail: "path escapes repository root" });
			continue;
		}
		let file: fs.promises.FileHandle;
		try {
			file = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		} catch {
			omissions.push({ sourceRef: candidate.path, reason: "unreadable", detail: "source could not be captured" });
			continue;
		}
		try {
			const status = await file.stat();
			if (!status.isFile()) {
				omissions.push({ sourceRef: candidate.path, reason: "unreadable", detail: "source is not a regular file" });
				continue;
			}
			if (status.size > maxCandidateBytes) {
				omissions.push({
					sourceRef: candidate.path,
					reason: "budget",
					detail: `candidate exceeds ${maxCandidateBytes} bytes`,
				});
				continue;
			}
			const bytes = new Uint8Array(await file.readFile());
			if (bytes.includes(0)) {
				omissions.push({ sourceRef: candidate.path, reason: "binary", detail: "NUL byte detected" });
				continue;
			}
			const excerptBytes = bytes.slice(0, maxExcerptBytes);
			const content = new TextDecoder().decode(excerptBytes);
			const excerpt: RepositoryEvidenceExcerpt = {
				path: candidate.path,
				startLine: 1,
				endLine: lineCount(content),
				content,
				contentDigest: semanticIdentity("repository-source-excerpt", content),
				sourceBytes: bytes.byteLength,
				truncated: excerptBytes.byteLength < bytes.byteLength,
			};
			evidence.push({
				evidenceId: semanticIdentity("repository-evidence", {
					path: candidate.path,
					excerpt: excerpt.contentDigest,
				}),
				evidenceClass: candidate.evidenceClass,
				sourceKind: candidate.sourceKind,
				sourceRef: candidate.path,
				sourceVersion: repositorySnapshotIdentity(snapshot),
				adapterId: NATIVE_CURRENT_STATE_ADAPTER.adapterId,
				adapterSchemaVersion: NATIVE_CURRENT_STATE_ADAPTER.adapterSchemaVersion,
				determinism: NATIVE_CURRENT_STATE_ADAPTER.determinism,
				authority: NATIVE_CURRENT_STATE_ADAPTER.sourceAuthority,
				extractionMethod: "bounded-file-capture",
				inclusionReason: candidate.inclusionReason,
				snapshotCoverage: NATIVE_CURRENT_STATE_ADAPTER.snapshotCoverage,
				staleness: NATIVE_CURRENT_STATE_ADAPTER.staleness,
				sourceDigest: semanticIdentity("repository-source", bytes),
				excerpt,
			});
		} catch {
			omissions.push({ sourceRef: candidate.path, reason: "unreadable", detail: "source could not be captured" });
		} finally {
			await file.close();
		}
	}
	return { evidence, omissions };
}

/** Reserve verification evidence selected by bounded task or structural dependency retrieval. */
function reserveTaskMatchedVerificationCandidates(candidates: readonly Candidate[], maxEvidence: number): readonly Candidate[] {
	const reserve = Math.min(2, Math.floor(maxEvidence / 4));
	if (reserve === 0) return candidates;
	const apiContracts = candidates.filter(candidate => candidate.inclusionReason === "verification candidate for fork artifact API contract");
	const reserved = [
		...apiContracts.slice(0, reserve),
		...candidates
		.filter(
			candidate =>
				!apiContracts.some(apiContract => apiContract.path === candidate.path) &&
				(candidate.inclusionReason === "task terms match verification source content" ||
					candidate.inclusionReason.startsWith("verification imports dependency of ")),
		)
		.slice(0, Math.max(0, reserve - apiContracts.length)),
	];
	if (reserved.length === 0) return candidates;
	const reservedPaths = new Set(reserved.map(candidate => candidate.path));
	const nonReserved = candidates.filter(candidate => !reservedPaths.has(candidate.path));
	const primaryBudget = Math.max(0, maxEvidence - reserved.length);
	return [...nonReserved.slice(0, primaryBudget), ...reserved, ...nonReserved.slice(primaryBudget)];
}

function taskTerms(task: string): string[] {
	const terms = task.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
	return [...new Set(terms.flatMap(taskTermVariants))].sort();
}

/** Small deterministic lexical bridge for task prose such as “forked” → “fork”. */
function taskTermVariants(term: string): readonly string[] {
	const variants = [term];
	if (term.length > 5 && term.endsWith("ied")) variants.push(`${term.slice(0, -3)}y`);
	else if (term.length > 5 && term.endsWith("ed")) variants.push(term.slice(0, -2));
	else if (term.length > 5 && term.endsWith("ing")) variants.push(term.slice(0, -3));
	else if (term.length > 4 && term.endsWith("s")) variants.push(term.slice(0, -1));
	return variants;
}

function meaningfulTaskTerms(terms: readonly string[]): string[] {
	const genericTerms = new Set([
		"add",
		"and",
		"change",
		"create",
		"fix",
		"for",
		"from",
		"implement",
		"into",
		"keep",
		"preserve",
		"remove",
		"that",
		"the",
		"this",
		"when",
		"with",
		"without",
		"update",
	]);
	const meaningful = terms.filter(term => !genericTerms.has(term));
	return meaningful.length > 0 ? meaningful : [...terms];
}

/**
 * A bounded scan must inspect paths that already match task intent before
 * lexical order. Otherwise a large monorepo spends its scan budget on early
 * examples and documentation, even when a directly relevant source path is
 * available. Lexical ordering remains the deterministic tie-breaker.
 */
function prioritizeTaskRelevantPaths(paths: readonly string[], terms: readonly string[]): string[] {
	return [...paths].sort((left, right) => {
		const scoreDifference = taskScanPriority(right, terms) - taskScanPriority(left, terms);
		return scoreDifference || left.localeCompare(right);
	});
}

function taskScanPriority(candidatePath: string, terms: readonly string[]): number {
	const pathScore = taskPathMatchCount(candidatePath, terms);
	// The compiler is building current repository truth. Inspect implementation
	// source before examples, tests, and documents that happen to repeat task
	// vocabulary; those remain eligible evidence once source has been seeded.
	const sourcePriority = /(?:^|\/)src\//.test(candidatePath)
		? 100
		: /(?:^|\/)(?:test|tests)\//.test(candidatePath)
			? 20
			: /(?:^|\/)(?:docs|examples)\//.test(candidatePath)
				? 0
				: 40;
	return sourcePriority + pathScore;
}

function currentStateCandidateScore(candidatePath: string, matchCount: number): number {
	return 100 + taskScanPriority(candidatePath, []) + matchCount;
}

/**
 * An exact task term in an implementation path is stronger evidence of owner
 * responsibility than a phrase hit in a supporting surface. Keep that source
 * ahead of phrase seeds, using path depth only as a deterministic tie-breaker
 * between otherwise equally direct names.
 */
function directTaskPathBoost(candidatePath: string, matchCount: number): number {
	const depth = candidatePath.split("/").length;
	return matchCount * 18 + Math.max(0, 16 - depth);
}

function taskPathMatchCount(candidatePath: string, terms: readonly string[]): number {
	const normalizedPath = candidatePath.toLowerCase();
	return terms.reduce((score, term) => score + (normalizedPath.includes(term) ? 1 : 0), 0);
}

function isSemanticSearchCandidate(candidatePath: string): boolean {
	return isModuleSourcePath(candidatePath) || /(?:^|\/)(?:package\.json|README\.md|AGENTS\.md)$/.test(candidatePath);
}

function isTestPath(candidatePath: string): boolean {
	return /(?:^|\/)(?:test|tests)\//.test(candidatePath) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(candidatePath);
}

function isRepositoryPath(repositoryRoot: string, candidatePath: string): boolean {
	const relativePath = path.relative(repositoryRoot, candidatePath);
	return relativePath !== "" && !relativePath.startsWith(`..${path.sep}`) && relativePath !== "..";
}

function lineCount(content: string): number {
	return content.length === 0 ? 0 : content.split("\n").length;
}

function compareEvidence(left: RepositoryEvidenceRef, right: RepositoryEvidenceRef): number {
	return left.sourceRef.localeCompare(right.sourceRef) || left.evidenceId.localeCompare(right.evidenceId);
}

function compareOmission(left: RepositoryManifestOmission, right: RepositoryManifestOmission): number {
	return left.sourceRef.localeCompare(right.sourceRef) || left.reason.localeCompare(right.reason);
}

function compareDegradedSource(
	left: RepositoryManifestDegradedSource,
	right: RepositoryManifestDegradedSource,
): number {
	return left.extractorId.localeCompare(right.extractorId) || left.reason.localeCompare(right.reason);
}

function renderOmissions(omissions: readonly RepositoryManifestOmission[]): string[] {
	if (omissions.length === 0) return [];
	return [
		`## Omitted evidence\n${omissions.map(omission => `- ${omission.sourceRef}: ${omission.detail}`).join("\n")}`,
	];
}

function renderDegradedSources(sources: readonly RepositoryManifestDegradedSource[]): string[] {
	if (sources.length === 0) return [];
	return [
		`## Degraded extractors\n${sources.map(source => `- ${source.extractorId}: ${source.reason} (${source.detail})`).join("\n")}`,
	];
}

function renderStaleness(staleness: NonNullable<RepositoryEvidenceRef["staleness"]>): string {
	return staleness.state === "fresh" ? "fresh" : `${staleness.state} (${staleness.detail})`;
}

function indentExcerpt(content: string): string {
	return content
		.split("\n")
		.map(line => `    ${line}`)
		.join("\n");
}
