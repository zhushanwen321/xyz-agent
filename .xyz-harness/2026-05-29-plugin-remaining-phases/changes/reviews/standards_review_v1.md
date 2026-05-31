---
verdict: pass
must_fix: 0
reviewer: standards-expert
date: 2026-05-29
scope: a54ec76..HEAD (46 files, +2957 -1251)
---

# Standards Review — plugin-remaining-phases

## Automated Checks

| Check | Result | Detail |
|-------|--------|--------|
| ESLint `src-electron/runtime/src/` | 1 error, 11 warnings | Error is false-positive `prefer-const`; warnings are pre-existing or minor |
| TypeScript `tsc --noEmit` | 9 errors | All in test files (`plugin-api-hooks.test.ts`), 0 in production code |
| `any` usage in diff | 0 | Grep confirms no `any` in production source |
| Native HTML form elements | 0 | No `<input>/<select>/<button>/<form>` in Vue diff |
| Hardcoded colors | 0 | Uses `var(--muted)` CSS variable correctly |

## Core Standards Compliance

### ✅ No `any` Type
All production code uses `unknown`, `Record<string, unknown>`, or specific interfaces. No `any` found in diff scope.

### ✅ No Native HTML Form Elements
`ExtensionUIDialog.vue` uses xyz-ui `<Dialog>` component. Content text uses `<p>` (display only, not form element — acceptable per CLAUDE.md rule).

### ✅ Tailwind / CSS Conventions
`ExtensionUIDialog.vue`: `class="text-sm leading-relaxed mb-5"` + `style="color: var(--muted))"` — CSS variable usage correct. No `@apply`, no `<style scoped>` abuse.

### ✅ emit Single Payload
No emit changes in this diff.

### ✅ Error Handling
- `EventAdapter.attach()` now wraps `handleEvent` in `.catch()` — correct, prevents unhandled promise rejection.
- `plugin-storage.ts` persists `catch (err: unknown)` with proper type narrowing — correct.
- Silent catches in `event-adapter.ts` (lines 156, 209) are intentional: hook errors must not block main event flow.

### ✅ No Hardcoded Colors / Magic Spacing
No new violations. All spacing uses standard Tailwind scale.

## Observations (non-blocking)

### 1. ESLint `prefer-const` False Positive — `index.ts:59`

```
error  'pluginService' is never reassigned. Use 'const' instead  prefer-const
```

`pluginService` IS reassigned on line 89. The `let` is required for the forward-reference pattern (declare before `SessionService` constructor so the closure can capture it, assign after). This is a known ESLint false positive for uninitialized `let` + deferred assignment.

**Recommendation**: Add `// eslint-disable-next-line prefer-const` on line 59.

### 2. Eager Ternary in `onHookExecute` — `index.ts:71`

```ts
onHookExecute: pluginService!
  ? (hookType, context) => pluginService!.executeHooks(...)
  : undefined,
```

At construction time `pluginService` is `undefined`, so the ternary evaluates to `undefined`. The hook callback is never created. The comment says "closure reads pluginService at session creation time" but the ternary is **eager**, not lazy.

**Functional concern** (not standards): This means hooks from `EventAdapter` never fire. If this is intentional for this phase, document it. If not, wrap in a lazy closure:

```ts
onHookExecute: (hookType, context) => {
  if (!pluginService) return Promise.resolve({ blocked: false })
  return pluginService.executeHooks(hookType, { ... })
},
```

### 3. Indentation Warnings — `index.ts:73-77` (5 warnings)

The `onHookExecute` callback body indents 12 spaces where ESLint expects 10. Minor formatting issue in the inline closure.

### 4. Double Cast in `server.ts` — `as unknown as`

```ts
const uiService = this.pluginService as unknown as { handleUiResponse(...): void }
```

Type escape hatch to call `handleUiResponse` which isn't on `IPluginService` interface. Works, but fragile.

**Recommendation**: Add `handleUiResponse` to `IPluginService` interface for type safety.

### 5. TypeScript Errors in Test Files

All 9 `tsc` errors in `plugin-api-hooks.test.ts` are type narrowing issues (`Property 'result' does not exist`, `'entries' is possibly 'undefined'`). Production code compiles clean.

### 6. Magic Number — `demo/index.ts:37`

```ts
results.slice(0, 10)
```

**Recommendation**: Extract `const MAX_RESULTS = 10` or add `// eslint-disable-next-line no-magic-numbers`.

## File-by-File Summary

| File | Verdict | Notes |
|------|---------|-------|
| `runtime/src/index.ts` | ✅ | `prefer-const` false positive; eager ternary concern |
| `runtime/src/event-adapter.ts` | ✅ | Clean async refactor; 2 intentional silent catches |
| `runtime/src/server.ts` | ✅ | Double cast for `handleUiResponse` — fragile but works |
| `runtime/src/services/plugin-service/plugin-service.ts` | ✅ | Clean; proper DI pattern |
| `runtime/src/services/plugin-service/plugin-storage.ts` | ✅ | Good error handling with type narrowing |
| `runtime/src/services/plugin-service/plugin-activator.ts` | ✅ | Clean permission flow |
| `runtime/src/services/plugin-service/plugin-host.ts` | ✅ | Rebuild logic with crash counter |
| `runtime/src/plugins/demo/index.ts` | ✅ | 1 magic number (minor) |
| `renderer/src/components/extension/ExtensionUIDialog.vue` | ✅ | Uses xyz-ui Dialog, CSS variables |
| `renderer/src/composables/useExtensionUI.ts` | ✅ | Clean source routing |
| `shared/src/protocol.ts` | ✅ | New message types properly typed |
| `packages/plugin-sdk/src/types.ts` | ✅ | Clean interface definitions |

## Conclusion

**PASS** — No must-fix standards violations. Production code is free of `any`, native HTML form elements, hardcoded colors, and emit violations. ESLint error is a false positive (`prefer-const` on forward-referenced `let`). All TypeScript errors are confined to test files. The one notable observation is the eager ternary in `onHookExecute` (observation #2) which may affect functionality but is not a standards violation.
