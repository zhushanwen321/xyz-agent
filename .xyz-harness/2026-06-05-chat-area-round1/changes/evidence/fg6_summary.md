# FG6 (Fork / Clone Naming) — Execution Summary

## Commits (4 total)

| Commit | Description |
|--------|-------------|
| `9681ae2` | **Task 21**: `rebindAfterFork` accepts `label` param from caller |
| `15c57aa` | **Task 22**: `labelSuffix` param added to `forkFromEntry` / `cloneSession` |
| `7a484bf` | **Task 24**: Fork/clone label orchestration in `tree-message-handler` |
| `ce0145f` | **Tests**: 4 tests for fork/clone label naming (AC10) |

## Files Modified (5)

| File | Change |
|------|--------|
| `src-electron/runtime/src/interfaces.ts` | `rebindAfterFork(old, new, label, sessionFilePath?)` — added `label` param |
| `src-electron/runtime/src/services/session-service.ts` | `rebindAfterFork` uses caller-provided `label` instead of `old.label` |
| `src-electron/runtime/src/services/tree-service.ts` | `forkFromEntry(sid, entryId, labelSuffix?='-fork')`, `cloneSession(sid, labelSuffix?='-clone')` |
| `src-electron/runtime/src/tree-message-handler.ts` | Fork: `originalLabel+'-fork'` → `rebindAfterFork`; Clone: `renameSession(newId, originalLabel+'-clone')` |
| `test/services/tree-message-handler.test.ts` | **Created**: 4 tests covering AC10 |

## AC10 Verification

| Scenario | Expected | Verified |
|----------|----------|----------|
| Fork → new session label | `原名称-fork` | ✅ Test: `rebindAfterFork` called with `my-session-fork` |
| Clone → new session label | `原名称-clone` | ✅ Test: `renameSession` called with `my-session-clone` |
| Fork (no summary) → fallback | `session-fork` | ✅ Test: fallback label works |
| Clone (no summary) → fallback | `session-clone` | ✅ Test: fallback label works |

## Validation

- `npm run lint`: ✅ 0 errors (4 pre-existing warnings unrelated to FG6)
- `npx vitest run test/services/tree-message-handler.test.ts`: ✅ 4/4 passed
- All pre-existing test failures unchanged (Vue plugin, version check — unrelated to FG6)

## Key Design Decisions

1. **Label computed at message-handler layer** — `TreeMessageHandler` reads `getSummary(sid)?.label` and computes `originalLabel + '-fork'` / `originalLabel + '-clone'`. This keeps tree-service as a thin RPC proxy.

2. **Clone uses `renameSession`** — Unlike fork (which replaces the session via `rebindAfterFork`), clone creates a new session that isn't rebind-managed, so `renameSession` is the correct path to set its label.

3. **Fallback label = `'session'`** — When `getSummary()` returns undefined (edge case: session not in active map), uses `'session'` as base, resulting in `'session-fork'` / `'session-clone'`.
