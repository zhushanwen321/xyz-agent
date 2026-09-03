# @zhushanwen/pi-agent-ext

## 1.2.0

### Minor Changes

- 7b33e6f00: **agent-ext: remove the `/xyz-navigate` slash command**

  - The `/xyz-navigate <entryId>` command (session tree navigation via `ctx.navigateTree`) is removed. Its only consumer was the runtime-side bridge that intercepted the `navigate-result` custom message and forwarded it to the renderer's session tree view; that bridge was deleted in the monorepo era, and no session tree view exists in the current renderer, so the command had no reachable caller. The remaining `/__xyz_reload__` and `/__xyz_get_system_prompt__` internal commands are unchanged. Original design: docs/adr/0008-extension-bridge-for-navigate-tree.md (now marked superseded).

## 1.1.2

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 1.1.1

### Patch Changes

- 63aa77435: Repo reorganization and dependency convergence for the 0.9.5 cycle

  - Extension packages are grouped into `extensions/taiji/` (xyz-agent integrated) and `extensions/universal/` (standalone); install targets and READMEs updated accordingly
  - earendil family dependencies converged to 0.84.1 (peer/dependency ranges updated)
  - llm-shared: export shared `getCurrentModelId` helper for model consumers
  - model-switch: consume the shared helper, internal simplification

## 1.1.0

### Minor Changes

- ccd7d2d70: (no changeset body; minor version bump)

## 1.0.1

### Patch Changes

- 8e52cb3ba: Builtin extension npm migration completion

  - agent-ext: session tree navigation (`/xyz-navigate`) + `/__xyz_reload__` internal reload command, migrated from builtin file to npm package
  - msg-id-mapper: message id mapping extension, migrated from builtin file to npm package; hook internals refactored for complexity (behavior unchanged: rpc-tag strip → pending uuid → leafId flush → custom entry)
  - system-prompt: system prompt injection extension, migrated from builtin file to npm package; config parsing / prompt assembly split into helpers for complexity (injection order and fail-safe semantics unchanged)
  - runtime drops the getBuiltinExtensionPaths chain; extensions load as regular npm packages

  No public API change: package roots keep `index.ts` (pi.extensions manifest entry) and `export { default } from "./src/index.ts"`; no export was removed.
