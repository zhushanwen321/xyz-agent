---
"@zhushanwen/pi-rename-session": minor
---

**rename-session: round-end trigger, two-segment input, slug-style titles, and reliability hardening**

- **Round-end trigger**: the rename LLM call now fires only after the session's first *successful* round fully completes (the final `turn_end` with `stopReason === "stop"`). Previously naming could effectively rely on the first turn's partial state; intermediate tool iterations are now skipped explicitly (`skip: stopReason=toolUse`), and error/aborted/length rounds defer naming to the next successful round instead of using error context.
- **Two-segment input**: the title LLM now receives `[user(first prompt), assistant(final reply), user(instruction)]` — each text segment truncated to 4000 Unicode code points — instead of the full conversation prefix. Tool calls/results and other process data are no longer injected, which sharply reduces input tokens (cost no longer grows with the number of tool iterations) and improves title signal quality.
- **Slug-style titles**: rewritten system prompt and instruction anchor a slug phrase style (noun/gerund phrase, no full sentences, no pronouns or tense markers, no trailing punctuation; lowercase kebab-case for English; follows the conversation language, 3-6 words). `cleanTitle` now also strips trailing punctuation and normalizes internal whitespace.
- **30s timeout**: the title LLM call is bounded by a fixed 30s timeout; timeouts normalize to a silent skip with a failure log line (`rename LLM call failed: ...`) instead of hanging the fire-and-forget promise.
- **Manual-name race guard**: the session name is re-checked immediately before persisting, so a name set manually during the 2-30s LLM call window is never overwritten (`skip: name exists`).
- **Debug evidence chain**: `PI_RENAME_DEBUG=1` now emits an introspection log of the exact messages sent to the title LLM (role + head200/tail100 text preview) plus skip/decision logs with timestamps and turn indices — the contract used by the new E2E suite (`e2e/run-a1..a5.mjs`, `e2e/run-all.mjs`).
