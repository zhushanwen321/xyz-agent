# Runtime 代码品味审查报告

**分支**: `feat-integration-pi-extension` vs `main`
**范围**: `src-electron/runtime/src/`（30 文件，+2091 / -1257 行）
**日期**: 2026-06-04

---

## 总体评价

本次变更大致做了三件事：
1. **server.ts 拆分**：将巨型 `SidecarServer` 拆为 handler mixin 类（`SettingsMessageHandler`、`PluginMessageHandler`、`TreeMessageHandler`、`BridgeHandler`）+ `ExtensionTimeoutManager`
2. **ExtensionService 重写**：引入 `ExtensionResolver` 做五源扫描去重，替换旧的 `~/.xyz-agent/extensions/` 单目录扫描
3. **常量提取 + eslint-disable 注释补全**：魔数提取为命名常量，`taste/no-silent-catch` 添加 eslint-disable

拆分方向正确，但手法上有几处值得商榷。

---

## 问题清单

### 1. MUST_FIX — server.ts 的 handler 通过 `this as unknown as` 注入

**文件**: `server.ts:39-41`
**描述**: 三个 handler 类在构造时通过 `this as unknown as XxxHandlerContext` 传入 `SidecarServer` 自身。`SidecarServer` 不实现 `SettingsHandlerContext` 等接口，需要 `unknown` 中转才能编译通过。这是一个 type hole — 编译器不再检查 `SidecarServer` 是否真的满足所有 handler 需要的方法（`send`、`sendError`、`broadcastProviderList` 等）。如果 `SidecarServer` 删除了某个方法，编译不会报错，运行时才炸。
**修复方向**: 让 `SidecarServer implements SettingsHandlerContext, PluginHandlerContext, TreeHandlerContext`，或者改为在 `setServices()` / `constructor` 中显式构造 handler 需要的闭包对象（函数引用），而非传整个 server。

---

### 2. MUST_FIX — `BridgeHandler` 的 pluginService 可能为 null 但缺少防护

**文件**: `bridge-handler.ts:10`, `server.ts:38`
**描述**: `BridgeHandler` 构造时接收 `IPluginService | null`，在 `server.ts:38` 初始化为 `new BridgeHandler(null)`。虽然 `setServices()` 后会重新赋值 `new BridgeHandler(plugin)`，但 `handleBridgeRequest` 中多处使用 `this.pluginService?.` 的 optional chain。问题在于 `handleStatusSetUpdate` 不做 null 检查就调用 `this.pluginService?.handleBridgeEvent` — 这部分 ok。但 `handleBridgeRequest` 中 `bridge:tool_execute` 的 fallback `await client.sendCommand(...)` 在 `pluginService` 为 null 时虽然会返回 `{ content: 'Plugin system not available', isError: true }`，但这不是在构造时就该阻止的吗？一个 null pluginService 的 BridgeHandler 不应该处理任何请求。
**修复方向**: 在 `handleBridgeRequest` 入口加 null guard 直接 reject，或者在 `setServices` 中确保 pluginService 非空才赋值 bridgeHandler，构造时用 `null` 的初始态不值得暴露给运行时路径。

---

### 3. MUST_FIX — `plugin-rpc-setup.ts` 的 `notify` 实现依赖可选的 `broadcastFn`，但不走 `IMessageBroker`

**文件**: `plugin-rpc-setup.ts:86-95`, `plugin-rpc-setup.ts:171-175`
**描述**: 提取后的 `registerAllRpcMethods` 中，`plugin.notify` 和 `ui-api` 的 `notify` 都依赖 `deps.broadcastFn`。而 `broadcastFn` 是 `IPluginServiceDeps` 上的可选字段。如果 `broadcastFn` 为 undefined，通知静默丢失 — 没有 warn、没有 fallback 到 broker。这与提取前通过 `this.broker.broadcast()` 的行为不同（broker 是非可选的）。
**修复方向**: 要么让 `broadcastFn` 成为必需字段，要么提供一个 fallback（如 `console.warn('[plugin] notify dropped: no broadcastFn configured')`）。静默丢弃 notification 是调试噩梦。

---

### 4. MUST_FIX — `ExtensionService.installExtension` 通过 bracket 访问 private 方法

**文件**: `extension-service.ts:169`
**描述**: `this.resolver['isValidPiExtension'](pkgInstallDir)` — 用 bracket notation 访问 `ExtensionResolver` 的 `private` 方法。这绕过了 TypeScript 的访问控制检查，在 CJS 运行时碰巧能用（没有真正的 private），但语义上是一个明确的封装破坏。
**修复方向**: 将 `isValidPiExtension` 改为 `public` 或 `internal`（如果项目约定允许），或者在 `ExtensionResolver` 上暴露一个 `validateExtension(dir: string): boolean` 公共方法。

---

### 5. MUST_FIX — `BYTES_PER_KB` / `MB` / `TEN` 常量重复定义且语义可疑

**文件**: `plugin-storage.ts:5-9`, `api/session-data-api.ts:24-27`
**描述**: `BYTES_PER_KB = 1024`、`MB = BYTES_PER_KB * BYTES_PER_KB`（= 1,048,576）、`TEN = 10` 在两个文件中各定义了一份。`TEN * MB` 实际上不如直接写 `10 * 1024 * 1024` 或 `10_485_760` 清晰。`BYTES_PER_KB` 这个名字本身没问题，但 `TEN` 作为常量名不携带语义 — 它不是 "十个什么东西"，它只是乘数 10。真正有语义的是 `MAX_TOTAL_SIZE = 10 * MB`，提取 `TEN` 是过度提取。
`BYTES_PER_KB * BYTES_PER_KB` 也是反模式 — `1024 * 1024` 一看就知道是 1MB，`BYTES_PER_KB * BYTES_PER_KB` 要在脑子里算一遍。
**修复方向**: 
- 提取共享的 `const MB = 1024 * 1024` 到一个公共位置（如 `constants.ts`），两个文件共用
- 删除 `TEN`，直接写 `10 * MB`
- 或者直接 `const MAX_TOTAL_SIZE = 10_485_760`（注释 `// 10MB`）

---

### 6. MUST_FIX — `RADIX_BASE36` 和 `SLICE_START` 在两个文件中重复定义

**文件**: `plugin-storage.ts:13-14`, `plugin-service.ts:21-22`
**描述**: `RADIX_BASE36 = 36` 和 `SLICE_START = 2` 完全相同的常量在两个文件中各定义一次。`toString(36)` + `.slice(2)` 是生成随机 ID 的惯用写法，每个 JS 开发者都认识。提取 `RADIX_BASE36` 和 `SLICE_START` 反而降低了可读性 — 读者需要跳转才知道 "哦，36 就是 36，2 就是 2"。
**修复方向**: 要么提取一个 `generateRandomId(prefix: string): string` 工具函数消除重复，要么就地保留 `36` 和 `2` 不提取。单独为 `36` 和 `2` 命名是典型的过度提取。

---

### 7. LOW — `PluginHost` 的 static readonly 赋值给 module-level const 再赋值回 static readonly

**文件**: `plugin-host.ts:104-108, 127-129`
**描述**: 模式是 `const MAX_REBUILD_ATTEMPTS = 3` → `private static readonly MAX_REBUILD_ATTEMPTS = MAX_REBUILD_ATTEMPTS`。三层赋值（字面量 → module const → class static readonly），`static readonly` 本身就是常量声明，不需要中间的 module-level const 转发。而且 `this.rebuildCooldownMs = PluginHost.REBUILD_COOLDOWN_MS` 这种写法很绕。
**修复方向**: 直接 `private static readonly MAX_REBUILD_ATTEMPTS = 3` 即可。如果需要 module-level 使用，保留 module const + 去掉 static readonly。

---

### 8. LOW — `ExtensionTimeoutManager` 的 timeout 值从 300s 变为 30s，无 changelog 说明

**文件**: `extension-timeout-manager.ts:6` vs 旧 `server.ts`
**描述**: 旧值 `EXTENSION_UI_REQUEST_TIMEOUT_MS = 300_000`（5 分钟），新值 `30_000`（30 秒）。这是一个 10x 行为变更，对用户体验有直接影响。diff 中没有任何注释解释为什么缩短了 10 倍。
**修复方向**: 如果是有意为之，在常量旁加注释说明原因。如果是迁移失误，恢复为 300s。

---

### 9. LOW — `TreeMessageHandler` 中 error handling 模式重复

**文件**: `tree-message-handler.ts:30-88`
**描述**: 每个 case 分支都有相同的 `try { ... } catch (e) { if (e instanceof Error && e.message.includes('not found')) { ... } throw e }` 模式，重复 5 次。这可以提取为一个 `withSessionNotFoundFallback<T>(fn: () => Promise<T>, fallback: T)` 高阶函数。
**修复方向**: 如果认为重复可接受（每个分支的 fallback 值不同），至少提取 error type 判断为 `isSessionNotFoundError(e: unknown): boolean`。

---

### 10. LOW — `session-data-flush.ts` 硬编码 `homedir()` 路径

**文件**: `session-data-flush.ts:35, 59`
**描述**: `join(homedir(), '.xyz-agent')` 硬编码在提取出的 flush 函数中。提取前这个路径来自 `PluginService` 的 `this.baseDir`（从构造函数注入）。现在 flush 函数不再接受 baseDir 参数，而是自己算，降低了可测试性和可配置性。
**修复方向**: `flushSessionData` / `flushSessionDataForSession` 接受 `baseDir: string` 参数，由调用方传入 `join(homedir(), '.xyz-agent')`。

---

### 11. LOW — `ExtensionResolver` 的 `log` 对象 debug 方法是空函数但签名接受 `..._args`

**文件**: `extension-resolver.ts:18-19`
**描述**: `debug: (..._args: unknown[]) => {}` — 生产环境 debug 日志被吞掉，调试时无法打开。如果要支持 debug 级别控制，应该用环境变量或日志库。当前写法意味着 debug 信息在生产环境彻底丢失，开发者排查问题时无法获取。
**修复方向**: 至少用 `console.debug`，或引入项目的日志工具。如果确定不需要 debug 日志，就不要声明 debug 方法。

---

### 12. INFO — `settings-message-handler.ts` 和 `plugin-message-handler.ts` 的 Handler 模式

**文件**: `settings-message-handler.ts`, `plugin-message-handler.ts`
**描述**: 这两个 handler 类本质上是"从 server 搬出来的 switch-case"，没有独立状态。它们的 `handleXxxMessage` 方法接收 `msg` + `ws`，通过 `ctx` 调用 server 的方法。这不是真正的"关注点分离" — 只是文件级别的拆分，依赖关系（通过 ctx 接口）仍然绑定到 server 的完整 API surface。
好处是 server.ts 从 ~800 行降到 469 行，可维护性提升。坏处是增加了间接层 — 要理解一个消息的处理流程需要跳 3 个文件。
**结论**: 作为代码组织手段可以接受，但不要进一步细分（如再从 SettingsMessageHandler 里拆出 SkillHandler、AgentHandler 等），那样跳转成本会超过收益。

---

### 13. INFO — `PluginService.getExtensionPaths()` 委托给 `ExtensionService`，但 `SessionService` 也持有 `ExtensionService` 并调用其 `getExtensionPaths()`

**文件**: `session-service.ts:496-501`, `extension-service.ts:115-127`
**描述**: `SessionService.getExtensionPaths()` 直接调用 `this.extensionService.getExtensionPaths()`。而 `PluginService` 内部也持有对 `ExtensionService` 的引用（通过 deps）。这意味着 extension 路径解析有两条独立路径。当前 `PluginService` 已经不再有自己的 `getExtensionPaths` 逻辑（全委托给 rpc-setup），所以不存在不一致的风险，但架构上 `SessionService` 和 `PluginService` 都直接依赖 `ExtensionService` 是可以改进的。

---

### 14. INFO — `plugin-rpc-setup.ts` 中大量 `as string` 类型断言

**文件**: `plugin-rpc-setup.ts:59-91`
**描述**: RPC params 解析中有约 15 处 `params.pluginId as string`、`params.key as string` 等断言。这是从 `PluginService.registerRpcMethods()` 原样搬过来的，不是新引入的问题。RPC 参数的 typed 解析应该是后续改进方向（定义 params interface 而非 `Record<string, unknown>` + 断言）。

---

### 15. INFO — `PluginStorage` 中 `JSON_FORMAT_INDENT = 2` 和 `plugin-permission-storage.ts` 中 `JSON_INDENT = 2` 命名不一致

**文件**: `plugin-storage.ts:11`, `plugin-permission-storage.ts:62`
**描述**: 同样是 JSON.stringify 的缩进参数，一个叫 `JSON_FORMAT_INDENT`，另一个叫 `JSON_INDENT`。虽然是不同文件独立提取的，但如果要提取就应该统一命名。
**修复方向**: 统一为 `JSON_STRINGIFY_INDENT` 或直接保留字面量 `2`（这个值真的不需要命名常量）。

---

## 改进做得好的部分

1. **server.ts 行数从 ~800 降至 469** — 虽然手法有 `as unknown as` 的瑕疵，但方向正确
2. **`ExtensionResolver` 的五源扫描架构** — 清晰的优先级去重，可测试性强
3. **`git-info.ts`、`session-history.ts`、`session-file-utils.ts` 的提取** — 从巨型类中抽出纯函数，职责边界清晰
4. **`taste/no-silent-catch` 的 eslint-disable 注释** — 每处都有明确的理由说明为什么静默 catch 是合理的
5. **`Promise.allSettled` 替换 `Promise.all`** — `plugin-host.ts` 和 `workspace-api.ts` 中的修正
6. **`ExtensionTimeoutManager`** — 将 server 中的 3 个 Map + 散落的 timer 逻辑封装为独立类，好
