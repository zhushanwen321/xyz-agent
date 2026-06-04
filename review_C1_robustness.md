# C1 健壮性审查报告：Shared 类型变更

**审查范围**: `git diff main...HEAD -- src-electron/shared/src/`
**审查日期**: 2026-06-04

---

## MUST_FIX

### 1. `extension.install`/`extension.uninstall` 错误消息无 `sessionId`，被前端静默丢弃

- **文件**: `src-electron/runtime/src/server.ts:338, 351`
- **关联类型**: `src-electron/shared/src/protocol.ts` — `ServerMessage.payload`
- **描述**: `installExtension` / `uninstallExtension` 失败时，`sendError` 不传 `sessionId`（因为安装/卸载不是 session 级操作）。但 `PanelSessionView.vue:264` 的 `handleErrorMessage` 要求 `payload.sessionId` 存在才处理，否则直接 `return`。结果是安装失败错误被静默丢弃，用户看不到任何反馈。

- **连锁问题**（同根因）:
  - `ExtensionsPane.vue:36` — `handleInstall` 设置 `installing.value = true` 后，只在 `config.extensions` 成功响应时被隐式覆盖（`onExtensions` 覆写整个 `extensions` 数组），但 `installing` 永远不会重置为 `false`。按钮无限停留在 "Installing..." 状态。
  - `ExtensionsPane.vue` 没有监听 `error` 事件，无法感知安装失败。

- **修复方向**:
  - 方案 A（推荐）: `ExtensionsPane` 监听 `error` 事件，通过 `msg.id` 匹配安装请求，收到 `install_failed` 时重置 `installing = false` 并展示 `installError`。需要 `handleInstall` 记录当前请求的 `id`。
  - 方案 B: server 端在 install/uninstall 失败时仍然发送 `config.extensions`（附 error 信息），让 `onExtensions` 正常刷新列表，再额外发 error。
  - 方案 C: `sendError` 增加一个非 session 级别的 error 广播通道（如 `code: 'install_failed'`），前端全局 toast 展示。

### 2. `ExtensionWidgetPayload`/`ExtensionStatusPayload` 的 Map key 缺少 session 隔离

- **文件**: `src-electron/shared/src/extension.ts:3, 9` + `src-electron/renderer/src/composables/useExtensionWidget.ts:16, 22`
- **描述**: `useExtensionWidget.ts` 用 `widgetKey` / `statusKey` 作为全局 Map 的 key。当多个 session 的 extension 使用相同的 `widgetKey`（如 `"main"`、`"output"`）时，后到的 session 会覆盖前一个 session 的 widget。虽然 `PanelSessionView` 按 `sessionId` 过滤，但原始 Map 中的数据已被覆盖，导致前一个 session 的 widget 消失。

- **复现场景**: 两个 session 同时运行使用了相同 key 的 extension widget → split view 中只显示后一个 session 的 widget。

- **修复方向**: Map key 改为 `${sessionId}:${widgetKey}` / `${sessionId}:${statusKey}`。在 `PanelSessionView` 过滤时仍按 `sessionId` 前缀匹配，或维护 `sessionId` → `Map<key, payload>` 的二级结构。

### 3. `handleInstall` 中 `installing` 状态在成功路径也未显式重置

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:33-38`
- **描述**: `handleInstall` 是 `async` 函数，但只调用 `send()`（fire-and-forget），不 await 任何结果。`installing.value = true` 后，函数直接返回。成功路径依赖 `onExtensions` 回调刷新 `extensions` 数组，但 `installing` 始终为 `true`。按钮永久 disabled。

- **修复方向**: 在 `onExtensions` 回调中（或专门的响应处理中）将 `installing.value = false`。同时错误路径也需要重置。

---

## LOW

### 4. `extension.install` payload 的 `source` 类型过于宽泛

- **文件**: `src-electron/shared/src/protocol.ts:81`
- **描述**: `source: string` 允许任意字符串传入，但 runtime `installExtension` 只接受 `npm:` 前缀，否则 throw。类型层面无法提前约束。前端虽然有 placeholder 提示 `npm:pi-ask-user`，但不做前端校验。
- **修复方向**: 可考虑 `'npm:${string}'` 模板字面量类型，或在前端 `handleInstall` 中提前校验格式并展示错误提示，避免不必要的网络往返。

### 5. `ExtensionInfo.source` 可能错误分类非 npm extension

- **文件**: `src-electron/shared/src/protocol.ts:228`
- **描述**: `source: 'built-in' | 'user-installed'` 是封闭 union。Runtime 判定逻辑为：路径在 `settings.json packages[]` 中 → `user-installed`，否则 → `built-in`。但项目级 npm 依赖中可能包含 pi extension（不在 `settings.json` 中），会被错误标记为 `built-in`。这影响 UI 展示（"Uninstall" 按钮是否显示）。
- **修复方向**: 若项目级 extension 有实际场景，可扩展 union 为 `'built-in' | 'user-installed' | 'project'`。否则文档化当前分类规则即可。

---

## INFO

### 6. `EXTENSION_EVENTS` 常量值与 `ServerMessageType` 手动同步

- **文件**: `src-electron/shared/src/extension.ts:13-15` + `src-electron/shared/src/protocol.ts:180`
- **描述**: `EXTENSION_EVENTS` 的值（`'extension.widget'`, `'extension.status'`）是硬编码字符串，需要与 `ServerMessageType` 中的字面量手动保持一致。新增 extension event 类型时若遗漏 `EXTENSION_EVENTS`，无编译时错误。
- **当前状态**: 两个文件的值一致，无实际 bug。
- **改进方向**: 可让 `EXTENSION_EVENTS` 的 value 类型约束为 `ServerMessageType`（`as const satisfies Record<string, ServerMessageType>`），编译时检测拼写不一致。

### 7. `ServerMessage.payload` 为 `Record<string, unknown>` 需要消费端 unsafe cast

- **文件**: `src-electron/shared/src/protocol.ts:184`
- **描述**: 所有 `ServerMessage` 消费端都用 `msg.payload as { extensions?: ExtensionInfo[] }` 等 unsafe cast。新增的 `extension.widget` / `extension.status` 同样遵循此模式。这是既有架构决策，非本次变更引入。
- **改进方向**: 长期可为 `ServerMessage` 建立类似 `ClientMessage` 的 discriminated union（`type` → 具体 `payload` 类型），消除 cast。但影响面大，不建议在本次 PR 中处理。
