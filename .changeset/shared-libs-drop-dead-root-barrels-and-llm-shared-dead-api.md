---
'@zhushanwen/pi-extension-logger': minor
'@zhushanwen/pi-file-lock': minor
'@zhushanwen/pi-llm-shared': minor
---

**shared libs: remove dead package-root barrels and llm-shared dead API surface**

- The package-root `index.ts` in `@zhushanwen/pi-extension-logger`, `@zhushanwen/pi-file-lock`, and `@zhushanwen/pi-llm-shared` is deleted. Each package's `main` points at `src/index.ts` and none of the root barrels was ever resolved (zero deep imports across the repo), so resolution behavior is unchanged. The `index.ts` entry is dropped from `files` (publish surface shrink) and from the two tsconfigs' `include` that listed it.
- `@zhushanwen/pi-llm-shared`: the `recoverable` field is removed from the `CallLLMResult` failure variant. All three construction sites in `src/call.ts` hardcoded `true`, the sole production constructor outside the library (`permission` classifier) never read it, and no consumer branched on it — the field was pure noise on every `ok:false` result. The `CallLLMResult`-typed test fixtures are updated accordingly.
- `@zhushanwen/pi-llm-shared`: `extractText` is no longer re-exported from `src/index.ts` (zero external consumers; same-named helpers elsewhere in the repo are deliberate local implementations). The function itself stays in `src/call.ts` for internal use, so deep imports of `../call.ts` are unaffected.
