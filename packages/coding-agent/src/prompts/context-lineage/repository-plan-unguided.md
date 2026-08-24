Identify the likely implementation scope and verification files for this repository task.

Task:
{{task}}

Return JSON only, with exactly this shape:

```json
{
  "scope": ["repository-relative source path"],
  "verification": ["repository-relative test or verification path"]
}
```

Do not assume repository evidence, history, or tool results beyond the task framing. If uncertain, return fewer claims rather than inventing paths.
