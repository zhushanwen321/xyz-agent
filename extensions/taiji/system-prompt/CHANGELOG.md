# @zhushanwen/pi-system-prompt

## 1.0.1

### Patch Changes

- 8e52cb3ba: Builtin extension npm migration completion

  - agent-ext: session tree navigation (`/xyz-navigate`) + `/__xyz_reload__` internal reload command, migrated from builtin file to npm package
  - msg-id-mapper: message id mapping extension, migrated from builtin file to npm package; hook internals refactored for complexity (behavior unchanged: rpc-tag strip → pending uuid → leafId flush → custom entry)
  - system-prompt: system prompt injection extension, migrated from builtin file to npm package; config parsing / prompt assembly split into helpers for complexity (injection order and fail-safe semantics unchanged)
  - runtime drops the getBuiltinExtensionPaths chain; extensions load as regular npm packages

  No public API change: package roots keep `index.ts` (pi.extensions manifest entry) and `export { default } from "./src/index.ts"`; no export was removed.
