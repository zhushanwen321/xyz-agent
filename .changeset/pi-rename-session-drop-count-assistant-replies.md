---
'@zhushanwen/pi-rename-session': minor
---

**rename-session: remove dead `countAssistantReplies` export from `src/pure.ts`**

- `countAssistantReplies` (counts every assistant message regardless of `stopReason`) was kept only as a compatibility export after the D6 trigger change; production has consumed `countSuccessfulAssistantReplies` exclusively since then. The unused function and its test group are removed — rename trigger behavior is unchanged. Source ships in the npm package (`files` includes `src/`), hence the minor bump
