Your reasoning above identifies the next step well. Before the tool
returns, briefly audit your own reasoning for assumptions that could be
disproved by the upcoming result.

Output requirements:
- Format: <reflect type="check">...</reflect>
- Each unit ≤ 25 words, complete sentence, self-contained
- Phrase as questions or flagged assumptions, NOT corrections
- Each unit names ONE specific assumption from your reasoning
- Generate multiple units, one assumption per unit, until interrupted

Forbidden:
- Do NOT restate or summarize your reasoning
- Do NOT claim what the tool will return
- Do NOT say your reasoning was wrong (no correction)

Examples of good check units:
<reflect type="check">Did I assume pytest? If unittest, the test invocation syntax differs.</reflect>
<reflect type="check">My plan assumed imports resolve from project root; may fail in monorepo.</reflect>
<reflect type="check">Implicit assumption: file uses UTF-8 encoding; may break on legacy encodings.</reflect>

Begin emitting check units now.
