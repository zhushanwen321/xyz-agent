# Plugin System — 剩余工作清单

> 日期: 2026-05-29
> 分支: feat-plugin-arch-6
> PR: #59（已实现 10 个 FR）
> 本文档记录 PR #59 之后仍需完成的插件系统工作。

---

## 一、代码已存在但未接线（Should Fix，优先级最高）

这 4 项功能在 PR #59 中已实现核心逻辑，但调用点缺失，导致功能不生效。

### SF-1: SessionData 启动恢复

- **现状**: `loadSessionData()` 函数存在于 `plugin-storage.ts`，但 `PluginService.initialize()` 中未调用
- **影响**: sidecar 重启后 sessionData 缓存为空，`sessionData.get()` 返回 undefined。UC-1（重启后恢复进度）完全失效
- **修复**: 在 `PluginService.initialize()` 中遍历 `~/.xyz-agent/plugins/session-data/` 目录，调用 `loadSessionData()` 恢复已有 session 的缓存
- **工作量**: ~15 行

### SF-2: SessionData 清理

- **现状**: `deleteSessionData()` 函数存在于 `plugin-storage.ts`，但 session 销毁/插件 deactivate 时未调用
- **影响**: session 销毁后 JSON 文件残留磁盘，长期运行后产生文件泄漏
- **修复**: 在 `PluginService.deactivatePlugin()` 和 session 销毁回调中调用 `deleteSessionData()`
- **工作量**: ~10 行

### SF-3: PermissionChecker 未注入 Activator

- **现状**: `PluginActivator` 构造函数支持 `options.permissionChecker`，但 `PluginService` 创建 Activator 时未传入
- **影响**: 权限审批流程完全不生效——sandbox 插件激活时不检查权限、不广播 `plugin:permissionRequest`。UC-5（权限审批）完全失效
- **修复**: 在 `PluginService` 创建 Activator 时传入 `{ permissionChecker: this.permissionChecker, onPermissionRequest: (payload) => this.broadcast(...) }`
- **工作量**: ~5 行

### SF-4: Worker Rebuild 后不重新加载插件

- **现状**: `rebuildWorker()` 创建新 Worker 并分配 pluginIds，但不调用 `loadPlugin()` 和 `activatePlugin()`
- **影响**: trusted Worker 崩溃后重建的新 Worker 是空的——插件代码未加载、未激活，功能完全丢失
- **修复**: `rebuildWorker()` 中创建新 Worker 后，对每个 pluginId 调用 `loadPlugin()` + `activatePlugin()`
- **工作量**: ~15 行
- **注意**: 需要处理重建过程中的异步错误和部分加载失败

---

## 二、Stub/空实现（代码存在但返回硬编码值）

### ST-1: getThinkingLevel / setThinkingLevel

- **现状**: `getThinkingLevel()` 返回硬编码 `'high'`，`setThinkingLevel()` 空操作
- **影响**: 插件无法读取/设置 thinking level
- **修复**: 从 `IConfigService` 或 active session 读取/写入 thinkingLevel
- **工作量**: ~10 行

### ST-2: Demo 插件缺少 slash command

- **现状**: `manifest.yml` 中有 `commands` 声明，但 `package.json` 的 `contributes` 中没有 `slashCommands`（registry 读取 package.json，不读 manifest.yml）
- **影响**: demo 插件没有 slash command，只能通过 tool 和 hook 交互
- **修复**: 在 demo 插件的 `package.json` 的 `xyzAgent.contributes` 中添加 `slashCommands`，或在 `index.ts` 中通过 `api.ui.notify()` 替代
- **工作量**: ~5 行

### ST-3: plugin-service.ts L116 的 TODO 注释

- **现状**: 有一行 `// TODO (Phase 2): trusted Worker 崩溃后自动重建 + 重新加载插件` 的注释，但此功能已在 PR #59 中实现
- **修复**: 删除该 TODO 注释
- **工作量**: 1 行

---

## 三、类型缺口

### TY-1: handleUiResponse 未在 IPluginService 接口声明

- **现状**: `PluginService.handleUiResponse()` 是 public 方法，但 `IPluginService` 接口（`interfaces.ts`）中未声明
- **影响**: 通过接口引用调用 `handleUiResponse` 时 TypeScript 报错。当前 `server.ts` 直接引用 `PluginService` 实例所以运行时无问题，但类型不完整
- **修复**: 在 `IPluginService` 中添加 `handleUiResponse(requestId: string, result: unknown): void`
- **工作量**: ~2 行

### TY-2: SDK 类型包同步维护

- **现状**: `packages/plugin-sdk/src/types.ts` 是从 `plugin-types.ts` 手动复制的类型定义
- **影响**: `plugin-types.ts` 修改后需要手动同步到 SDK 包，否则两处类型不一致
- **修复方案**:
  - A) SDK 包直接 re-export `plugin-types.ts`（简单但引入路径耦合）
  - B) 用 build 脚本自动提取同步（推荐但需维护脚本）
- **工作量**: 1-2 小时

---

## 四、Spec 明确排除的功能（Out of Scope → 未来按需实现）

以下是 spec 中标记为"Out of Scope"的 10 项功能，按实用性排序：

### P1 — 有实际需求时优先做

| # | 功能 | 设计来源 | 前置条件 | 预计工期 |
|---|------|---------|---------|---------|
| OS-1 | **contributes 声明式渲染** | design-part2.md | 前端 PluginSlot 组件 | 3-5 天 |
| OS-2 | **npm install 集成** (`plugin-installer.ts`) | design-part1.md §6 | npm registry 或 GitHub | 2-3 天 |
| OS-3 | **create-xyz-plugin 脚手架** | design-part1.md §8 | SDK 类型包就绪 | 1-2 天 |
| OS-4 | **版本兼容性检查** (`engines.xyz-agent` semver) | plugin-types.ts | manifest 规范确定 | 0.5 天 |

#### OS-1: contributes 声明式渲染

插件通过 manifest 的 `contributes` 声明 UI 贡献（panels、settings、statusBarItems、slashCommands、messageDecorators），框架自动渲染。

当前状态：
- `PluginContributes` 类型已定义（`plugin-types.ts`）
- `PluginRegistry.scan()` 已解析 `contributes` 到 `PluginDescriptor`
- 缺失：前端消费 `contributes` 的渲染机制——`PluginSlot` 组件、`StatusBarItem` 渲染、`SettingsSection` 渲染等

设计参考：`design-part2.md` 的 "Extension Points" 章节。

#### OS-2: npm install 集成

用户通过 UI 或 CLI 安装第三方插件（`plugin install <name>`），自动下载到 `~/.xyz-agent/plugins/`。

当前状态：
- `plugin-installer.ts` 文件存在但是空 stub
- 安装路径 (`~/.xyz-agent/plugins/`) 已确定
- 缺失：npm registry 集成、下载/解压、manifest 校验、安全审计

#### OS-3: create-xyz-plugin 脚手架

CLI 工具生成插件项目骨架（package.json + manifest + index.ts + 测试模板）。

前置条件：SDK 类型包（`xyz-agent-plugin-sdk`）已就绪（PR #59 已完成）。

#### OS-4: 版本兼容性检查

加载插件时校验 `engines.xyz-agent` semver 与当前 xyz-agent 版本是否兼容。

当前状态：`PluginRegistry.scan()` 已读取 `engines` 字段到 descriptor，但不校验。

### P2 — 远期增强

| # | 功能 | 说明 |
|---|------|------|
| OS-5 | Worker idle recycling（60s 超时回收） | 当前 Worker 创建后永不释放。长期运行可能内存累积 |
| OS-6 | API 稳定性分层（stable/proposed/internal） | 标记 API 成熟度，允许 proposed API 变更不视为 breaking change |
| OS-7 | 跨 Worker 插件通信（`api.events`） | 不同 Worker 的插件之间通过事件总线通信 |
| OS-8 | 开发者文档（developer-guide + api-reference） | 无外部受众时优先级低 |
| OS-9 | 压力测试（100 并发插件） | 当前只有 2 个内置插件，无压力场景 |
| OS-10 | 插件市场/版本更新 | 需要完整的分发体系（OS-2）和大量外部插件 |

---

## 五、设计文档中已规划但未开始的功能

参考 `design-part1.md` 和 `design-part2.md`：

| # | 功能 | 设计文档位置 | 当前状态 |
|---|------|-------------|---------|
| D-1 | Plugin Hot Reload（外部插件开发时自动重载） | design-part1.md §5 | `plugin-host.ts` 有 `fs.watch` 骨架，`plugin-hot-reload.test.ts` 测试通过，但未接入 PluginService 生命周期 |
| D-2 | Extension ↔ Plugin 统一桥接 | design-part2.md | Extension（pi extension）和 Plugin（xyz-agent plugin）走不同代码路径，未来应统一 |
| D-3 | Bridge Tool Execute 增强（超时控制、结果缓存） | plugin-service.ts | 当前 30s 超时硬编码，无缓存 |
| D-4 | Plugin 生命周期事件（onInstall/onUninstall/onUpdate） | plugin-types.ts | 未设计 |
| D-5 | 插件间依赖声明（`extensionDependencies`） | plugin-types.ts | 类型已定义但 Registry 不校验 |

---

## 六、建议执行顺序

```
第一批（接线修复，1-2 小时）:
  SF-3 → SF-4 → SF-1 → SF-2 → ST-1 → ST-3 → TY-1

第二批（SDK 维护，半天）:
  TY-2（SDK 类型同步机制）

第三批（按需求触发）:
  OS-1 → OS-2 → OS-3 → OS-4 → ...

第四批（远期）:
  OS-5 ~ OS-10
```

第一批的 7 项改动量极小（总计 ~60 行），但修复后插件系统的 4 个关键用例（UC-1 SessionData 恢复、UC-3 Hook 拦截、UC-5 权限审批、Worker 崩溃恢复）才能真正端到端生效。
