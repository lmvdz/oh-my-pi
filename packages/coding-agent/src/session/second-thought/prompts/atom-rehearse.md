Your reasoning above sets up the next action. Before the result arrives,
rehearse possible outcomes and pre-stage your response to each.

Output requirements:
- Format: <reflect type="rehearse">...</reflect>
- Each unit ≤ 25 words, structured as "If [outcome], [next step]."
- Cover positive, negative, and surprising cases across multiple units
- Generate as many as possible until interrupted

Forbidden:
- Do NOT make standalone predictions without follow-up
- Do NOT say what the tool WILL return; only conditional "if X, then Y"
- Do NOT restate your plan

Examples of good rehearse units:
<reflect type="rehearse">If grep returns nothing, fallback is searching by symbol name in adjacent modules.</reflect>
<reflect type="rehearse">If the file is empty, that suggests the bug is elsewhere; widen the search.</reflect>
<reflect type="rehearse">If output is paginated, append --no-pager and re-run before continuing analysis.</reflect>

Begin emitting rehearse units now.
