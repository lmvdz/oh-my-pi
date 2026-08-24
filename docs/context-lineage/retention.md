# Context Lineage retention policy

Context Lineage checkpoints are logical, immutable journal records. They do
not create provider-side cache entries, worktrees, or checkpoint-specific
directories.

## References and versions

`/lineage base retention` reports each checkpoint's reference counts from the
active session journal:

- active named-base generations;
- persisted plans; and
- completed, failed, or aborted execution records.

A checkpoint is **collectable** when all three counts are zero. This is a
logical eligibility state, not a promise that a shared artifact file can be
removed. Archiving or deleting a base appends a tombstone; it never rewrites a
plan, execution, promotion, or earlier generation. Reusing a name creates a
new active generation and always resolves to its recorded immutable checkpoint.

## Artifact and session cleanup

Lineage manifests and sidecar answers use the ordinary session artifact store.
That store also contains non-Lineage tool artifacts and has one numeric ID
space, so individual Lineage checkpoint pruning must not delete files by ID or
filename: doing so could corrupt still-referenced session material.

Physical cleanup is therefore session-scoped. The existing SessionManager
session-delete operation deletes a selected session file and its matching
artifact directory together. It is the only supported physical cleanup action.
Before deleting a session, export any retained plan/run provenance needed for
audit; a fork owns a copied session journal and copied artifacts, so deleting
one session does not prune the other.

## Cross-session reuse

Forking copies the append-only Lineage journal and its artifacts. A named base
in the fork resolves only against that fork's records; later archive/delete or
new-version records are isolated to that session. This prevents one active
session from silently changing another session's reusable base or artifacts.
