Evaluate the single structured candidate declaration against the immutable
outcome contract below. You have no sibling candidate, identity metadata,
workspace access, tools, or session history.

Your first line must be exactly one of:

VERDICT: ACCEPTABLE
VERDICT: UNACCEPTABLE

After that, explain only whether the declaration satisfies the listed required
obligations and avoids forbidden obligations.

Case: {{{outcomeCaseId}}}

Required obligation IDs:
{{#each requiredObligationIds}}
- {{{this}}}
{{/each}}

Forbidden obligation IDs:
{{#each forbiddenObligationIds}}
- {{{this}}}
{{/each}}

Candidate declaration:
{{{candidateContent}}}
