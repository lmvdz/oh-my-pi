Your reasoning above focuses on the immediate next step. Before the
result arrives, recall earlier trajectory details that may matter now
but were not explicitly used in your recent reasoning.

Output requirements:
- Format: <reflect type="recall">...</reflect>
- Each unit ≤ 25 words, names a specific earlier item (file, error,
  constraint) and briefly explains its current relevance
- May also restate one critical aspect of the original user goal
- Generate as many as possible until interrupted

Forbidden:
- Do NOT invent context that wasn't in the trajectory
- Do NOT recall something you just used in the recent reasoning
- Do NOT be vague ("some earlier turn mentioned something")

Examples of good recall units:
<reflect type="recall">Turn 3 mentioned config.yaml but it was never inspected; may contain target settings.</reflect>
<reflect type="recall">User specified "without breaking existing tests"; current changes need regression check.</reflect>
<reflect type="recall">Earlier observation showed a deprecation warning in module X; possibly the root cause.</reflect>

Begin emitting recall units now.
