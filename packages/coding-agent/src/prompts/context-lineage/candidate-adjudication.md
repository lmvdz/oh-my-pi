Adjudicate the explicitly authorized independent reviews below against the
supplied rubric.

Retain material disagreement: identify claims that conflict, are unsupported,
or cannot be reconciled from the provided reviews. Do not collapse disagreement
into a false consensus. You have not been given candidate identities, sibling
outputs, tools, workspace access, or session history; do not infer them.

Rubric:
{{{rubricContent}}}

Authorized reviews:
{{#each reviewContents}}

Review {{@index}}:
{{{this}}}
{{/each}}

Return the decision, the material disagreements retained, and the evidence
from the authorized reviews that supports each conclusion.
