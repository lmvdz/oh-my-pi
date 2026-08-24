You are completing an isolated, non-production PR10 measurement task.

Case: {{{outcomeCaseId}}}

Required obligation IDs:
{{#each requiredObligationIds}}
- {{{this}}}
{{/each}}

Forbidden obligation IDs:
{{#each forbiddenObligationIds}}
- {{{this}}}
{{/each}}

Apply only these declared candidate variations:
{{#each variation}}
- {{label}} / {{id}}: {{{value}}}
{{/each}}

Do not use tools. Return only one JSON object with exactly these arrays:
`satisfiedObligationIds` and `proposedForbiddenObligationIds`. Include only IDs
from the case above. This is a declaration for measurement, not a production
selection decision.
