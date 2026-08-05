# 主题 2：ExtensionHost 接线闭环（重构 2 + 重构 3）

## 现状（commit `c75898270` 后）

| 层 | 状态 | 证据 |
|---|---|---|
| core 基建 | ✅ 全交付 | InternalEventBus / MessageBusBridge / ViewHostStore / StatusBarController / MountPointRegistry / ContributionRegistry / bootstrap registries 真实化 |
| ui 组件 | ✅ 全交付 | ViewHost.vue / StatusBar.vue / CompanionBand.vue / dialog-request-queue.ts / GuiComponentRenderer + 8 原语 |
| renderer StatusBar 链路 | ✅ 闭环 | PanelContainer.vue:120 `<StatusBar>` 挂载，viewUpdate → ViewHostStore → StatusBar |
| renderer ViewHost 链路 | ❌ 半接线 | 数据进 store 但 `<ViewHost>` 未挂载（grep 零命中） |
| renderer CompanionBand/uiRequest | ❌ 未切 | useExtensionUI 仍走旧 extension.ui_request，`ui-request` bus 无消费方，`<CompanionBand>` 未挂 |

---

## 重构 2：ViewHost 挂载 + CompanionBand/uiRequest 接线（解锁 sidebar #10）

### ViewHost 挂载点设计（MountPointRegistry 4 点）

| 挂载点 | 位置 | 状态 |
|---|---|---|
| `statusbar` | PanelContainer.vue:120 | ✅ 已挂 |
| `sidebar.tab` | sidebar 第 5 tab（plugin tab）激活时 | ❌ 待挂 `<ViewHost view-id="sidebar.plugin" :session-id>` |
| `panel.header.action` | Panel header 右侧 | ❌ 待挂 `<ViewHost view-id="panel.header">` |
| `composer.toolbar` | Composer 工具栏 | ❌ 待挂 `<ViewHost view-id="composer.toolbar">` |

ViewHost.vue 空态自隐藏（已实现），未挂载 view 不破坏布局。

### CompanionBand + uiRequest 接线

**现状问题**：core MessageBusBridge 已把 `plugin:uiRequest` + `extension.ui_request` 归一为 `ui-request` bus 事件（逻辑层完成），但：
- renderer `useExtensionUI` 仍只消费旧的 `extension.ui_request`
- `ui-request` bus 事件无 renderer 消费方
- CompanionBand 未挂载

**修复步骤**（renderer）：
1. `useExtensionHostBridge.ts` 补 CompanionBand 接线：
   - 创建 `DialogRequestQueue` + `UiResponseTransport`
   - 订阅 bus `ui-request` 事件入队
   - `app.provide COMPANION_BAND_SOURCE_KEY`
2. 全局 overlay 挂载 `<CompanionBand>`（经 OverlayLifecycle 管 z-index）
3. `useExtensionUI.ts` 改为消费 `ui-request` bus 事件（删除只消费 extension.ui_request 旧路径）
   - ask-user 走 Panel inline / 其余走 CompanionBand modal 的分流逻辑保留
4. `UiResponseTransport` 经 runtime `plugin:uiResponse` RPC 回传用户选择给 plugin

### 验收

- `grep -rn "<ViewHost" packages/renderer/src/` 有命中
- `grep -rn "<CompanionBand" packages/renderer/src/` 有命中
- plugin 调 `api.ui.showSelect()` 后 CompanionBand 弹出；用户选择后 plugin 收到结果
- plugin 发 `views.update` 后 DOM 出现 `[data-testid=view-host]`
- sidebar 第 5 plugin tab 激活后渲染 plugin view

### 解锁

- sidebar #10 第 5 plugin tab（tab 内容区需挂 `<ViewHost view-id="sidebar.plugin">`）

### 性质

跨层变更（core MessageBusBridge + ui CompanionBand + renderer useExtensionUI 三层协同），需整体测试。

---

## 重构 3：sandbox 真隔离（非紧急，长期完整性）

### 现状（兜底完备）

| 防护层 | 状态 | 证据 |
|---|---|---|
| Worker Thread 隔离 | ✅ | `plugin-host.ts:340` `new Worker(bootstrapPath)` |
| CJS require 拦截 | ✅ | `plugin-sandbox.ts` BLOCKED_BUILTINS + `_resolveFilename` monkey-patch |
| **external 插件硬锁** | ✅ **fail-closed** | `plugin-security.ts` `EXTERNAL_PLUGIN_ENABLED = false`（commit `2b9066ad9`，2026-08-03） |

ESM import 漏洞理论存在（plugin-bootstrap.ts:82 `await import` 绕过 CJS monkey-patch），但 external 插件装不进来，只有 builtin/trusted（项目自己的代码）能跑。**现实风险已消除，非紧急**。

### 目标

`child_process.fork()` 子进程隔离（D-2 已裁定方向，VSCode ExtHost 模式）：
- untrusted 插件在子进程内执行，宿主经 IPC（JSON-RPC over stdin/stdout）通信
- 子进程 require/import 能力由启动参数控制（自定义 loader / NODE_OPTIONS 限制 / 可选 seccomp）
- trusted 插件保留 Worker Thread（现状）
- 消除 ESM 绕过，翻转 `EXTERNAL_PLUGIN_ENABLED` 为 true

### 设计要点

新增 `packages/runtime/src/services/plugin-service/plugin-host-process.ts`：
- `child_process.fork(bootstrapPath, [], { execArgv: [...] })`
- 子进程内 require/import 受控（自定义 ESM loader `register()` 限制 `node:` 前缀）
- IPC 复用 `plugin:uiRequest`/`plugin:viewUpdate` 消息族（跨进程序列化基础已具备）
- 子进程崩溃检测 + 重启（可选）

改动范围：
- `plugin-host.ts`：assignWorker(pluginId, trustLevel) 分流 trusted（Worker）/ untrusted（子进程）
- `plugin-lifecycle.ts`：trustLevel 驱动分配
- `plugin-bootstrap.ts`：子进程版 bootstrap（IPC 消息循环）

### ⚠ Electron 打包约束（AGENTS.md #12，项目高危区）

子进程 bootstrap 文件落地时必须遵守：
1. **tsup `entry` 独立条目**：`plugin-host-process.ts` 的 bootstrap 必须进 `packages/runtime/tsup.config.ts` 的 `entry`（输出独立 `.cjs`），参考现有 `plugin-bootstrap` 条目（`tsup.config.ts` entry 已含 `plugin-bootstrap`）
2. **`asarUnpack` 覆盖**：`apps/electron/electron-builder.yml` 的 `asarUnpack: dist/runtime/**/*` 已覆盖 runtime，新 .cjs 自动包含，但需核实
3. **子进程启动方式**：必须用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动，不能用 `node` 路径（打包后无独立 node）
4. **打包后路径**：子进程 bootstrap 路径用 `process.resourcesPath/app.asar.unpacked/...`，不能用 `app.getAppPath()`（返回 asar 虚拟路径）
5. **逐个 commit 验证**：tsup.config/electron-builder/plugin-host 改动必须逐个 commit + 每次跑 `bash scripts/validate-runtime-bundle.sh`（含 smoke test），禁止一个 commit 改多个打包子系统（v0.3.8 PR #61 事故教训）

这是本项目出过多次事故的高危区（AGENTS.md #12 明文约束），`plugin-bootstrap.cjs` 已有先例可照抄。

### 为何不用 ESM loader 过渡

Node ESM loader API 不稳定 + 版本敏感，只是把 CJS 拦截换成 ESM 拦截，隔离强度仍不及子进程。子进程是不可逆架构升级，一步到位避免两次重构。

### 性质

独立大工程（runtime 侧），不阻塞其他主题。external 插件开放需求驱动排期。

---

## 主题 2 验收（整体）

- ExtensionHost 三层（core/ui/renderer）接线闭环
- plugin view 能在 4 挂载点渲染
- plugin UI 请求（select/confirm/input）经 CompanionBand 响应
- external 插件经子进程隔离后可安全开放（EXTERNAL_PLUGIN_ENABLED 翻转）
