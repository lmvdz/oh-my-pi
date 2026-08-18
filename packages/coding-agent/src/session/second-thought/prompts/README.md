# Second-thought prompts

This directory is deliberately excluded from `scripts/format-prompts.ts`'s `PROMPT_DIRS`: these prompts must remain byte-verbatim, because the formatter rewrites characters such as `...` to `…`.
