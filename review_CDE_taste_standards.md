# Code Review: 品味 & 规范合规性 (C2/D2/E2 + C3/D3/E3)

**分支**: `feat-integration-pi-extension` (main...HEAD)
**审查范围**: `src-electron/shared/`, `resources/`, `src-electron/resources/`, `src-electron/runtime/test/`
**日期**: 2026-06-04

---

## 总览

变更主要包括：
1. 新增 `src-electron/shared/src/extension.ts` — widget/status payload 类型和事件常量
2. `protocol.ts` 扩展 — 新增 `extension.install`/`extension.uninstall` client 消息 + `extension.widget`/`extension.status` server 消息
3. `ExtensionInfo` 新增 `source` 字段
4. 删除 `src-electron/resources/pi/agent/extensions/` 下所有内置 extension（goal, hooks, subagent, todo, usage-tracker, workflow）
5. 删除 `src-electron/resources/pi/.gitkeep`
6. `resources/` 下 bridge/goal/statusline 的小修改
7. 新增 3 个测试文件，更新 4 个测试文件

---

## 问题列表

### 1. `extension.widget` / `extension.status` 的 ServerMessageType 命名违反 WS 命名约定

| 属性 | 值 |
|------|-----|
| 优先级 | **MUST_FIX** |
| 文件 | `src-electron/shared/src/protocol.ts:180` |
| 维度 | 规范 — CLAUDE.md 合规 |

CLAUDE.md 明确规定：

> WS 命名约定: Client→Server 用点号（`plugin.xxx`），Server→Client 用冒号+camelCase（`plugin:statusBarUpdate`）

但新增的 Server→Client 事件类型使用了点号分隔（`extension.widget`, `extension.status`），而不是冒号+camelCase 格式（应为 `extension:widget`, `extension:status` 或 `extension:widgetUpdate`, `extension:statusUpdate`）。

同文件中 `plugin:` 系列（`plugin:crashed`, `plugin:statusBarUpdate`, `plugin:uiRequest`）全部使用冒号格式，新增的 extension server 事件是唯一的例外。

### 2. `EXTENSION_EVENTS` 常量与 `ServerMessageType` 存在重复定义

| 属性 | 值 |
|------|-----|
| 优先级 | **MUST_FIX** |
| 文件 | `src-electron/shared/src/extension.ts:13-16`, `src-electron/shared/src/protocol.ts:180` |
| 维度 | 品味 — 关注点分离 |

`extension.ts` 中定义了 `EXTENSION_EVENTS = { WIDGET: 'extension.widget', STATUS: 'extension.status' }`，而 `protocol.ts` 的 `ServerMessageType` 联合类型中也包含相同的字符串字面量 `'extension.widget' | 'extension.status'`。

这是同一协议事件的两个 source of truth。如果 `EXTENSION_EVENTS` 的值与 `ServerMessageType` 中的字符串不一致，不会有编译期错误。应让 `ServerMessageType` 直接引用 `EXTENSION_EVENTS` 的值，或移除 `EXTENSION_EVENTS` 仅依赖类型系统。

### 3. `extension.ts` 使用 `export *` re-export

| 属性 | 值 |
|------|-----|
| 优先级 | **LOW** |
| 文件 | `src-electron/shared/src/index.ts:28` |
| 维度 | 品味 — 关注点分离 |

`index.ts` 对 `extension.ts` 使用 `export * from './extension'`，而同文件其他行都用 `export type { ... } from '...'`（纯类型导出）。`extension.ts` 中包含值导出（`EXTENSION_EVENTS` 常量），所以 `export *` 是功能正确的，但与周围的 `export type` 风格不一致。

如果是有意为之（因为 `EXTENSION_EVENTS` 是运行时值），可以接受；但建议加注释说明为什么这里是 `export *` 而非 `export type`。

### 4. `extension-service.test.ts` 使用 `require()` 而非 ESM import

| 属性 | 值 |
|------|-----|
| 优先级 | **MUST_FIX** |
| 文件 | `src-electron/runtime/test/extension-service.test.ts:46,79` |
| 维度 | 规范 — TypeScript 约束 |

测试文件顶部已经 `import { ... } from 'node:fs'`，但 `afterEach` 和 `it` 回调中又用 `const fs = require('node:fs')` 来调用 `fs.rmSync()`。同一文件中混用 ESM import 和 CJS `require` 不一致。

应直接使用文件顶部已导入的 `renameSync`（已删除的旧测试用了 `renameSync`，新测试导入了但未使用），或从顶部 import `rmSync`。

### 5. `extension-service.test.ts` 导入了未使用的 `renameSync`

| 属性 | 值 |
|------|-----|
| 优先级 | **LOW** |
| 文件 | `src-electron/runtime/test/extension-service.test.ts:2` |
| 维度 | 规范 — 代码质量 |

`import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'` — `renameSync` 在整个测试文件中未被使用。这是从旧测试重构时的遗留。

### 6. `ExtensionInfo.source` 类型的 `'built-in' | 'user-installed'` 与 resolver 的 source 不匹配

| 属性 | 值 |
|------|-----|
| 优先级 | **MUST_FIX** |
| 文件 | `src-electron/shared/src/protocol.ts:228`, `src-electron/runtime/src/extension-resolver.ts:27`, `src-electron/runtime/src/extension-service.ts:105` |
| 维度 | 品味 — 类型设计一致性 |

`ExtensionInfo.source` 定义为 `'built-in' | 'user-installed'`，但 `ExtensionResolver` 的 `PRIORITY_ORDER` 有 5 种来源：`'npm' | 'user' | 'settings' | 'third-party' | 'bundled'`。

`extension-service.ts:105` 通过 `isUserInstalled ? 'user-installed' : 'built-in'` 将 5 种来源映射为 2 种，但缺少对 `'bundled'`、`'settings'`、`'third-party'` 来源的明确映射。如果 settings 安装的 extension 被判定为非 user-installed（因为它不在 `packages` 列表中），它会被标记为 `'built-in'`，这是语义上不准确的。

建议：要么让 `source` 反映实际的 resolver 来源类型（union of all 5），要么在 `ExtensionService` 中添加显式的映射注释解释为什么只有 2 种分类。

### 7. `statusline-event-adapter.test.ts` 的 describe 名称过时

| 属性 | 值 |
|------|-----|
| 优先级 | **LOW** |
| 文件 | `src-electron/runtime/test/statusline-event-adapter.test.ts:104` |
| 维度 | 品味 — 命名精确性 |

`describe('TC-1-02: setWidget still discarded', ...)` — 测试描述说 "still discarded"，但实际行为已从"丢弃"改为"发送 `extension.widget` WS event"。it 名称已更新为 `'sends extension.widget WS event for setWidget'`，但外层 describe 仍然是旧描述。

### 8. `event-adapter-extension.test.ts` 的 describe 名称过时

| 属性 | 值 |
|------|-----|
| 优先级 | **LOW** |
| 文件 | `src-electron/runtime/test/event-adapter-extension.test.ts:191` |
| 维度 | 品味 — 命名精确性 |

`describe('extension_ui_request (discard methods)', ...)` — 描述说 "discard methods"，但 setStatus 和 setWidget 现在被 bridge 到 WS event，不再是丢弃行为。应改为更准确的描述，如 `'extension_ui_request (bridge methods)'`。

### 9. bridge extension 中 `throw e` 破坏事件循环

| 属性 | 值 |
|------|-----|
| 优先级 | **MUST_FIX** |
| 文件 | `resources/pi/agent/extensions/bridge/index.ts:60,75` |
| 维度 | 品味 — 错误处理语义 |

在 `api.on('extension_ui_response', ...)` 和 `api.on('agent_end', ...)` 的事件回调内，catch 块先 `console.error` 然后 `throw e`。在 pi extension 的事件回调中 re-throw 可能导致：

1. 如果 pi 内部做了 try-catch，这个 throw 会被静默吞掉，加了等于没加
2. 如果 pi 不 catch，单个事件处理失败会导致整个 extension 崩溃，后续所有事件都无法处理

bridge extension 的核心职责是转发事件，单个事件的失败不应影响后续事件。建议去掉 `throw e`，保留 `console.error` 即可。或者如果确实想让错误冒泡到 pi，至少在注释中说明理由。

同样的问题也出现在 `resources/plugins/statusline/index.ts:71`。

### 10. `extension-service.test.ts` 使用真实文件系统而非 mock

| 属性 | 值 |
|------|-----|
| 优先级 | **INFO** |
| 文件 | `src-electron/runtime/test/extension-service.test.ts` |
| 维度 | 品味 — 测试策略 |

旧测试使用 `vi.mock('node:fs/promises')` 做纯 mock，新测试改为在 `/tmp/xyz-agent-test/` 下创建真实文件/目录结构。这是合理的集成测试风格，但有几个问题：

1. `/tmp` 硬编码路径可能在 CI 或不同 OS 上行为不同
2. `afterEach` 中的 cleanup 用 `try { require('node:fs').rmSync(...) } catch {}` — 如果 cleanup 失败会被静默吞掉
3. 测试之间可能存在状态泄漏（`beforeEach` 不清理上一次的目录）

`extension-resolver.test.ts` 仍然使用纯 mock 风格，两种策略在同一模块共存，不一致。

### 11. `extension-resolver.test.ts` mock 了 `node:path`

| 属性 | 值 |
|------|-----|
| 优先级 | **INFO** |
| 文件 | `src-electron/runtime/test/extension-resolver.test.ts:9-12` |
| 维度 | 品味 — 测试策略 |

`vi.mock('node:path', ...)` 用简单的字符串拼接替代了 `path.join`。这使得 mock 行为与真实 `path.join` 不同（不处理 `.`, `..`, 重复分隔符等）。对于当前测试场景足够，但如果 source code 使用了 `path.resolve` 或相对路径，mock 会掩盖 bug。

### 12. `ClientMessageMap` 中 `extension.install` 的 `source` 字段命名

| 属性 | 值 |
|------|-----|
| 优先级 | **LOW** |
| 文件 | `src-electron/shared/src/protocol.ts:81` |
| 维度 | 品味 — 命名精确性 |

`'extension.install': { source: string }` 中 `source` 是裸 `string` 类型，但语义上它应该是 `'npm:' + packageName` 格式（如 `'npm:pi-ask-user'`）。同文件的 `extension.uninstall` 用 `name: string`，两者描述同一个 extension 但用不同的标识符（`source` vs `name`），调用者需要知道什么时候用 `npm:` 前缀什么时候不用。

建议：添加注释说明 `source` 的格式，或者用 branded type / union type 约束。

### 13. 所有测试文件均正确使用 vitest（非 node:test）

| 属性 | 值 |
|------|-----|
| 优先级 | **INFO** |
| 文件 | 所有 8 个测试文件 |
| 维度 | 规范 — 测试约定 ✅ |

所有新增和修改的测试文件均从 `'vitest'` 导入 `describe/it/expect/vi`，未使用 `node:test`。符合 CLAUDE.md 要求。

### 14. 删除 `src-electron/resources/pi/` 下所有 extension 是正确的整合方向

| 属性 | 值 |
|------|-----|
| 优先级 | **INFO** |
| 文件 | `src-electron/resources/pi/` (全部删除) |
| 维度 | 规范 — 架构一致性 ✅ |

将内置 extension 从 `src-electron/resources/`（Electron 打包目录）移至 `resources/`（项目根目录）是合理的。`src-electron/resources/` 是 Electron 打包路径，其中的文件会被 electron-builder 处理；而 pi extension 应该通过 `--extension` CLI 参数注入，不属于 Electron 的打包资源。删除 `.gitkeep` 也表明该目录已不再需要。

### 15. `bridge/index.ts` 的 `SYNC_INTERVAL_MS` 提取

| 属性 | 值 |
|------|-----|
| 优先级 | **INFO** |
| 文件 | `resources/pi/agent/extensions/bridge/index.ts:4` |
| 维度 | 品味 — 魔数消除 ✅ |

将 `2000` 提取为 `SYNC_INTERVAL_MS` 常量是好的改进，消除了 magic number。同步的 catch 块从 `catch { /* retry */ }` 改为 `catch (e) { console.debug(...); return }` 也更清晰。

---

## 总结

| 优先级 | 数量 | 关键问题 |
|--------|------|----------|
| MUST_FIX | 5 | WS 命名约定违反 (#1)、重复定义 (#2)、`require()` 混用 (#4)、source 类型不匹配 (#6)、bridge throw 破坏事件循环 (#9) |
| LOW | 4 | `export *` 不一致 (#3)、未使用导入 (#5)、过时测试描述 (#7, #8)、`source` 字段类型松散 (#12) |
| INFO | 4 | 测试策略差异 (#10, #11)、vitest 合规 ✅ (#13)、目录整合 ✅ (#14)、魔数消除 ✅ (#15) |

**最需关注的 3 个问题**:
1. **#1** — `extension.widget`/`extension.status` 违反了 CLAUDE.md 明确规定的 WS 命名约定，应改为冒号格式
2. **#9** — bridge/statusline 中的 `throw e` 可能导致 extension 进程崩溃，事件循环中断
3. **#6** — `ExtensionInfo.source` 的二值分类无法准确表达 resolver 的 5 种来源，映射逻辑有歧义
