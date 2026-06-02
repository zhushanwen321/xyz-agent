---
verdict: fail
must_fix: 3
---

# 健壮性审查报告

**审查范围**: `git diff a3b1ea4..HEAD`（5 个重点文件）
**审查时间**: 2026-06-02

---

## D1 错误处理

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | extension-resolver.ts | 72-76 | `JSON.parse(raw)` 无防护：恶意/损坏的 `package.json`（非 JSON）会抛异常，但 catch 块静默吞掉。问题在于 catch 范围过大——包含了 `readFileSync` 和 `JSON.parse`，如果 `readFileSync` 因权限问题失败（非 ENOENT），错误也被吞掉且没有任何日志 | 将 `readFileSync` 和 `JSON.parse` 分离到独立 try-catch，`readFileSync` 失败时记录 `console.warn`；`JSON.parse` 失败可静默降级 |
| LOW | extension-resolver.ts | 40-47 | `resolve()` 中 `scanNpmExtensions` 的 catch 静默吞掉所有异常（EACCES、EMFILE 等），不做日志。如果 `node_modules/@zhushanwen` 目录存在但权限不足，npm extension 全部丢失且无任何排查线索 | 在最外层 catch 加 `console.warn('[ExtensionResolver] Failed to scan npm extensions:', err)` |
| LOW | extension-resolver.ts | 107-109 | `scanBundledExtensions` → `scanDirectory` 内部 catch 静默吞掉异常。bundled 是最低优先级源，但开发者模式下 bundled 消失会导致困惑 | 在 `scanDirectory` catch 中加 `console.debug` 级别日志 |
| INFO | extension-resolver.ts | 118-122 | `scanThirdPartyExtensions` 使用 `process.env.HOME ?? process.env.USERPROFILE ?? ''`，两个环境变量都为空时返回空 Map。在容器/CI 环境中可能意外丢失 third-party extensions | 考虑使用 `os.homedir()` 替代手动环境变量拼接 |

## D2 异常管理

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| LOW | useExtensionWidget.ts | 18-20 | `onWidget` / `onStatus` 回调中对 `msg.payload` 做 `?.` 短路返回，但 event-bus 的消息类型约定是 `{ payload: T }`。如果 event-bus 发出格式不符的消息（如 debug 测试），此处静默丢弃，前端无任何反馈 | 可以在 debug 模式下 `console.warn` 丢弃的消息 |
| LOW | event-adapter.ts | 268-270 | `setStatus` handler 同时调用 `onStatusSetUpdate` 回调和 `this.send()` WS 消息。如果 `this.send()` 抛异常（WS 连接断开），整个 `translate()` 会 reject，`attach()` 中的 catch 只记了 `console.error`，不影响后续事件处理。但 `onStatusSetUpdate` 已执行，造成"内部状态已更新但前端未收到"的不一致 | 在 `this.send()` 外加 try-catch，发送失败时记录日志但不影响回调逻辑 |

## D3 日志

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | extension-resolver.ts | 全文件 | 全文件零日志。四个扫描方法中所有 catch 块都是空注释 `// xxx不可读` 或 `// package.json 不存在或解析失败`。生产环境中 extension 消失时无法排查 | 在每个 catch 块加 `console.warn('[ExtensionResolver] ...')` 日志，至少包含失败路径 |
| LOW | session-service.ts | 559-571 | 旧代码在 extension 文件不存在时有 `console.warn` 日志，新代码删除了该日志。`userExtPaths` 中如果路径不存在（`existsSync` 返回 false），完全静默跳过 | 在 `getExtensionPaths` 中恢复对无效 `this.extensionPath` 的 warn 日志 |
| INFO | useExtensionWidget.ts | 全文件 | composable 无日志。refCount 状态变更、事件注册/注销时无 trace，split mode 下的调试完全依赖开发者手动断点 | 考虑在 cleanup refCount 归零时加 `console.debug('[useExtensionWidget] cleanup')` |

## D4 Fail-fast

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | extension-resolver.ts | 152-167 | `deduplicate()` 的注释说"高优先级先写入 Map，低优先级遇到已存在的 key 跳过"，但实际 `resolve()` 中 sources 添加顺序是 bundled→third-party→user→npm（低到高），而 `deduplicate` 又按优先级排序后遍历。两套排序逻辑混用导致意图不清晰。代码功能正确（因为 deduplicate 独立排序），但 `resolve()` 的注释说"高优先级后写覆盖低优先级"是错误的——实际是 deduplicate 内排序决定，不是添加顺序决定 | 修正 `resolve()` 注释，移除"first-write-wins"描述，明确说明 deduplicate 内部按 PRIORITY_ORDER 排序后 first-write-wins |
| LOW | extension-resolver.ts | 38-44 | `resolve()` 不校验 `projectRoot` 参数。如果传入空字符串或相对路径，所有 `join()` 调用产生无意义路径，`existsSync` 返回 false，方法返回空数组但不报错 | 在 `resolve()` 开头加前置校验：`if (!projectRoot) throw new Error('ExtensionResolver.resolve: projectRoot is required')` |
| LOW | useExtensionWidget.ts | 23-28 | refCount 没有下溢保护。如果 cleanup 被多次调用（组件 unmount 竞态），`--refCount` 可以变成负数，导致后续组件实例永远无法注册 listener | 在 cleanup 中加 `if (refCount <= 0) return` 保护 |
| INFO | extension-resolver.ts | 96-98 | `scanUserExtensions` 只检查 `isDirectory()`，不验证目录内容（是否有 `index.ts`/`index.js`）。传入空目录也会被当作有效 extension 路径 | 按需增加 index 文件存在性检查（取决于 pi 是否需要这个校验） |

## D5 测试友好

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| LOW | extension-resolver.ts | 全文件 | `ExtensionResolver` 直接调用 `existsSync`/`readdirSync`/`statSync`/`readFileSync`，无法注入 mock fs。单元测试需要依赖真实文件系统或使用 `vi.mock('node:fs')`。看测试文件 `extension-resolver.test.ts` 确认已用 mock | 当前测试策略可接受。如需提升可测试性，可将 fs 操作抽为可注入的 `FileSystem` 接口 |
| LOW | useExtensionWidget.ts | 全文件 | composable 依赖 `on`/`off` 从 `../lib/event-bus` 直接导入，测试需要 mock 模块。refCount 是模块级变量，多个测试间需要手动重置 | 考虑暴露 `_resetForTesting()` 方法或在 `cleanup` 时确保 refCount 归零 |
| INFO | event-adapter.ts | 271-291 | `setStatus` / `setWidget` 新增的 `this.send()` 调用嵌在 translate 方法中，需要完整构造 pi event 才能测试。已有 `event-adapter-extension.test.ts` 覆盖 | 已有测试覆盖，无需额外改动 |

## D6 调试友好

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| LOW | extension-resolver.ts | 45 | `resolve()` 返回 `{ extensionDirs: string[] }` 但不返回每个路径的来源（npm/bundled/user/third-party）。当同名 extension 被覆盖时，无法从返回值判断最终用的是哪个源 | 返回值增加 `debugInfo?: Map<string, SourceName>` 或在 dev 模式下 console.info 去重结果 |
| LOW | useExtensionWidget.ts | 13-15 | 模块级 `widgets` / `statuses` ref 在 cleanup 时被清空（new Map），但 component unmount 后如果另一组件仍在使用，数据会丢失。这是设计意图，但调试时容易误认为是 bug | 在 cleanup 中加 debug 日志，显示 refCount 和是否清理数据 |
| INFO | event-adapter.ts | 275, 287 | `extension.status` 和 `extension.widget` 的 `type` 用 `as ServerMessageType` 硬编码字符串。如果 `ServerMessageType` 中移除这两个类型，编译不会报错（as 强制断言） | 改为直接赋值——`ServerMessageType` 已包含这两个字符串字面量，去掉 `as` 断言即可获得编译时检查 |

---

## 总结

3 个 MUST_FIX 问题：

1. **extension-resolver.ts 全文件零日志**（D3）— 四个扫描方法的 catch 块全部静默，生产环境 extension 消失无法排查
2. **extension-resolver.ts JSON.parse 无防护 + catch 范围过大**（D1）— npm 扫描的 package.json 解析失败与文件读取失败混在同一 catch，可能吞掉权限错误
3. **deduplicate 注释与实际逻辑矛盾**（D4）— `resolve()` 注释声称"高优先级后写覆盖低优先级"，实际由 `deduplicate()` 内排序决定，注释误导维护者
