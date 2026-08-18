# TUI surface
STATUS: open
PRIORITY: p2
REPOS: oh-my-pi
COMPLEXITY: mechanical
TOUCHES: packages/coding-agent/src/modes/interactive/ (footer/status segment + transcript renderer for the diagnostic entry — exact files located at implementation from the advisor-status precedent)
BLOCKED_BY: 04

## Goal
Users can see that Second Thought is working and read what it produced: a footer counter
plus an opt-in transcript rendering of each turn's diagnostic entry.

## Approach
- Footer/status segment (advisor-count precedent): harvested-unit count for the last
  fold, or the current skip reason glyph when the last turn skipped; omitted when
  disabled.
- `secondThought.showInTranscript: true` renders the diagnostic entry (04) as a collapsed
  block: per-atom units, branch cost line (tokens primary), skip/harvest stats. Renders
  from the diagnostic entry, never from context messages (there are none — grok finding
  13's "unreadable feature" is answered by rendering the entry, not by un-hiding a custom
  message).
- No session-tree presence: the diagnostic entry is a state entry; verify the tree
  selector ignores it (codex finding 17 class).

## Cross-Repo Side Effects
None.

## Verify
Snapshot/TUI tests for footer segment states (harvested / skipped / disabled) and the
transcript block when `showInTranscript` is on; tree-selector test confirms the entry is
neither rendered nor editable there.
