# @zhushanwen/pi-smart-context

## 0.1.3

### Patch Changes

- 7b33e6f00: **Supplemental changesets for five packages that changed src without a declaration (4N.1 scan finding)**

  - `@xyz-agent/extension-protocol`: add the `background-task` protocol module (task registration/reaping contract types consumed by the runtime background-task reaper sunk from base-tool-enhance), plus 183 lines of contract tests and index re-exports.
  - `@zhushanwen/pi-msg-id-mapper`: comment/test text sync with implementation (stale pi version comment fix, dead test mock dropped).
  - `@zhushanwen/pi-smart-context`: minor text sync in pure.ts.
  - `@zhushanwen/pi-system-prompt`: doc-comment sync clarifying the deliberate divergence from pi 0.84.4's `loadContextFileFromDir` (global-dir-only candidate list, no `AGENTS.override.md`); no behavior change.
  - `@zhushanwen/pi-unified-hooks` (deprecated package): text sync with implementation in the deprecated notice era.

## 0.1.2

### Patch Changes

- 837f2faf6: (no changeset body; patch version bump)

## 0.1.1

### Patch Changes

- d4f466667: chore: refresh dependency range (triggered by @zhushanwen/pi-extension-logger@0.2.2 → @zhushanwen/pi-extension-logger@0.3.0, @zhushanwen/pi-llm-shared@0.4.0 → @zhushanwen/pi-llm-shared@0.4.1)

# Changelog

## 0.1.0

- 初始版本：compact_context 工具、双模式生成接管（same-model / cross-model）、3 档阈值提醒、排除模型门控与切换通知、接管熔断与收缩校验、transcript 回查指针、文件重注入、config skill。
