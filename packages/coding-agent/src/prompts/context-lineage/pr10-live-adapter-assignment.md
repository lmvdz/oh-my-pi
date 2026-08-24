Review a repository-planning adapter proposal that consumes an optional external
graph artifact. The artifact may contain inferred or ambiguous relationships
and may have been built at a different commit than the frozen repository
snapshot. Identify the authority boundary, the required snapshot/staleness
behavior, fallback behavior when the artifact is unavailable, and regression
tests that prevent documentary or inferred claims from becoming current source
truth.
