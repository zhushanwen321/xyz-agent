---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-28T23:40:00"
  target: ".xyz-harness/2026-05-28-plugin-system-frontend-dx/"
  verdict: pass
  summary: "计划评审完成，第1轮，0条MUST FIX，3条LOW建议，3条INFO观察"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 0
  low: 3
  info: 3

issues:
  - id: 1
    severity: LOW
    location: "plan.md:Task List"
    title: "T13 依赖关系与 Wave 编排不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "plan.md:Interface Contracts → WS Protocol"
    title: "approvePermissions/revokePermissions/executeCommand 响应类型缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan-api-contract.md §1.2 vs spec FR-B1"
    title: "plugin.toggle 的 trustLevel 参数未在 spec 和 plan.md 中确认"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: INFO
    location: "plan-api-contract.md §1.2 vs plan.md"
    title: "plugin.config.get 的 key 参数可选性不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "plan-frontend.md §1 vs plan.md File Structure"
    title: "FG1 文件数统计与主文件结构表不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "plan-frontend.md §1.1 vs plan.md File Structure"
    title: "types/plugin.ts 未纳入主文件结构表"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-28 23:40
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-28-plugin-system-frontend-dx/`（plan.md + plan-backend.md + plan-frontend.md + plan-api-contract.md + e2e-test-plan.md + use-cases.md + non-functional-design.md）
- 参考文档：spec.md, CLAUDE.md

---

## 1. Spec 完整性检查

### 结论：✅ 完整

| 维度 | 状态 | 说明 |
|------|------|------|
| 目标明确 | ✅ | 一段话说清：修复后端 stub + 构建前端 UI + 质量补强 + 文档化 |
| 范围合理 | ✅ | In Scope 13 项 / Out of Scope 明确列出（Phase 4/5+），边界清晰 |
| AC 可量化 | ✅ | 全 18 条 AC 均有明确可验证条件，无模糊描述 |
| [待决议] 项 | ✅ | 无待决议项 |

**额外确认：**
- Complexity Assessment 准确识别了 3 层复杂度（后端修复 / 前端集成 / 质量补强）
- 错误场景覆盖表全面（7 种场景各有处理方案）

---

## 2. Plan 可行性检查

### 结论：✅ 可行

**Task 拆分粒度（13 个 Task）：**

| Task | 粒度 | 依赖 | 可独立完成 | 说明 |
|------|------|------|-----------|------|
| T1 | 适中 | 无 | ✅ | handleBridgeToolExecute RPC 路由 |
| T2 | 适中 | T1 | ✅ | executeHooks 串行化 |
| T3 | 适中 | T1 | ✅ | WS 协议类型 + 服务端 handler |
| T4 | 适中 | T2 | ✅ | sessionData 缓存 |
| T5 | 适中 | T2 | ✅ | 热重载 |
| T6 | 适中 | T3 | ✅ | Bridge 重连测试 |
| T7 | 适中 | 无 | ✅ | Goal/Todo 单元测试 |
| T8 | 适中 | T3 | ✅ | Plugin Store + Composable |
| T9 | 适中 | T8 | ✅ | PluginsPane |
| T10 | 适中 | T8 | ✅ | PluginSettingsForm |
| T11 | 适中 | T8 | ✅ | 权限对话框 |
| T12 | 适中 | T8 | ✅ | 状态栏 + 装饰器 + SlashMenu |
| T13 | 适中 | 见 Issue #1 | ✅ | 文档化 |

**依赖图正确性：** ✅ 整体正确
- T1 → T2 → T3 串行（BG1 内部），符合逻辑
- T2 → T4/T5（sessionData + hot reload 基于 BG1 的 plugin-service.ts 模式）
- T3 → T6（测试需要 protocol types）/ T8（前端需要 WS 类型）
- T8 → T9/T10/T11/T12（前端 Store 是 UI 组件的前提）

**Wave 编排：** ✅ 合理

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 无依赖，核心修复 |
| Wave 2 | BG2, BG3, FG1, DG1 | 可并行（无文件冲突） |
| Wave 3 | FG2, FG3 | 依赖 FG1 store |

**Wave 内部无文件冲突确认：**
- Wave 2：BG2 修改 `plugin-service.ts` / `plugin-activator.ts` / `session-data-api.ts`；FG1 创建 `stores/plugin.ts` / `composables/usePlugin.ts`；BG3 只创建测试文件；DG1 修改 `CLAUDE.md` / `README.md` — **无交叉**
- Wave 3：FG2 操作 PluginsPane / PluginSettingsForm / PluginPermissionDialog；FG3 操作 MessageDecoration / AppStatusbar / SlashMenu — **无交叉**

---

## 3. Spec 与 Plan 一致性检查

### 3.1 FR → Task 覆盖矩阵

| FR | 描述 | Task | 状态 |
|----|------|------|------|
| FR-A1 | handleBridgeToolExecute 路由到 Worker | T1 | ✅ |
| FR-A2 = FR-C3 | executeHooks 串行化 | T2 | ✅ |
| FR-B1 | Plugin Pinia Store + WS 消息扩展 | T3, T8 | ✅ |
| FR-B2 | PluginsPane 插件管理 UI | T9 | ✅ |
| FR-B3 | PluginSettingsForm 动态配置 | T10 | ✅ |
| FR-B4 | 状态栏 + 消息装饰器 + SlashMenu | T12 | ✅ |
| FR-B5 | 权限审批对话框 | T11 | ✅ |
| FR-C1 | Bridge 重连自动化测试 | T6 | ✅ |
| FR-C2 | Goal/Todo 插件独立单元测试 | T7 | ✅ |
| FR-C4 | sessionData 本地缓存兜底 | T4 | ✅ |
| FR-C5 | 插件热重载 | T5 | ✅ |
| FR-D1 | 插件架构写入 CLAUDE.md | T13 | ✅ |
| FR-D2 | 更新 README.md | T13 | ✅ |

**结论：所有 13 个 FR 均被覆盖，无遗漏。**

### 3.2 AC → Task 覆盖矩阵

| AC | 描述 | Task | 状态 |
|----|------|------|------|
| AC-A1 | Tool RPC 到 Worker 执行 | T1 | ✅ |
| AC-A2 | Hook 阻止链（trusted 阻止，sandbox 不执行） | T2 | ✅ |
| AC-A3 | Hook transformedContent 传递 | T2 | ✅ |
| AC-A4 | plugin.executeCommand WS 定义 + 前端发送 | T3, T12 | ✅ |
| AC-B1 | PluginsPane 渲染插件列表 | T8 | ✅ |
| AC-B2 | Toggle 启用/禁用 | T8, T9 | ✅ |
| AC-B3 | 配置表单渲染 + 值持久化 | T10 | ✅ |
| AC-B4 | 状态栏项显示 | T12 | ✅ |
| AC-B5 | SlashMenu 插件命令 | T12 | ✅ |
| AC-B6 | 消息装饰器 | T12 | ✅ |
| AC-B7 | 权限对话框 | T11 | ✅ |
| AC-C1 | Bridge 重连测试 | T6 | ✅ |
| AC-C2 | Goal/Todo 单元测试 | T7 | ✅ |
| AC-C3 | executeHooks 串行化测试 | T2 | ✅ |
| AC-C4 | sessionData 缓存测试 | T4 | ✅ |
| AC-C5 | 热重载测试 | T5 | ✅ |
| AC-D1 | CLAUDE.md 插件架构 | T13 | ✅ |
| AC-D2 | README.md 更新 | T13 | ✅ |

**结论：所有 18 条 AC 均被覆盖，无遗漏。**

### 3.3 额外工作检查

Plan 中无 spec 未提及的额外工作。所有实现细节（如 `PluginRpcServer.invoke()` 新方法、`InterceptResult` 类型扩展）均为 spec 需求的合理展开，未新增范围。

---

## 4. Execution Groups 合理性检查

### 4.1 分组统计

| Group | Tasks | 文件数 | 类型 | 状态 |
|-------|-------|--------|------|------|
| BG1 | T1-T3 | 5 (3 modify + 2 create) | Backend | ✅ ≤ 10 |
| BG2 | T4-T5 | 5 (3 modify + 2 create) | Backend | ✅ ≤ 10 |
| BG3 | T6-T7 | 3 (all create) | Backend | ✅ ≤ 10 |
| FG1 | T8 | 2 (all create) | Frontend | ⚠️ 见 Issue #5 |
| FG2 | T9-T11 | 3 (2 create + 1 modify) | Frontend | ✅ ≤ 10 |
| FG3 | T12 | 3 (1 create + 2 modify) | Frontend | ✅ ≤ 10 |
| DG1 | T13 | 2 (all modify) | Docs | ✅ ≤ 10 |

### 4.2 类型划分

所有 Group 均为纯类型（BG=Backend, FG=Frontend, DG=Docs），无混合类型 Group。✅

### 4.3 功能关联度

- **BG1**（T1/T2/T3 串行）：handleBridgeToolExecute + executeHooks + WS handlers — 高度关联，核心修复链条 ✅
- **BG2**（T4/T5 串行）：sessionData cache + hot reload — 两者独立但有相同的修改模式 ✅
- **BG3**（T6/T7 串行）：Bridge reconnect 测试 + Goal/Todo 测试 — 两者独立，放在一组简化管理 ✅
- **FG1**（T8 单 Task）：Store + Composable — 前端基础层 ✅
- **FG2**（T9/T10/T11 串行）：PluginsPane + SettingsForm + PermissionDialog — 三个 UI 组件关联紧密 ✅
- **FG3**（T12 单 Task）：状态栏 + 装饰器 + SlashMenu — 三者都是集成点 ✅
- **DG1**（T13 单 Task）：两篇文档更新 ✅

### 4.4 Subagent 配置完整性

| Group | Agent | Model | 注入上下文 | 读取文件 | 修改/创建文件 | 状态 |
|-------|-------|-------|-----------|---------|-------------|------|
| BG1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| BG2 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| BG3 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| FG1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| FG2 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| FG3 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| DG1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

所有 Group 的 Subagent 配置均包含 Agent、Model、注入上下文、读取文件、修改/创建文件，配置充分。✅

### 4.5 跨 Group 文件冲突（同 Wave 内）

**Wave 2**（BG2, BG3, FG1, DG1）：
| 文件 | 操作者 | 操作类型 | 冲突？ |
|------|--------|---------|-------|
| `plugin-service.ts` | BG2（T4） | 修改 | 仅 BG2 在 Wave 2 修改该文件（BG1 在 Wave 1 已完成修改）✅ |
| `plugin-activator.ts` | BG2（T5） | 修改 | 仅 BG2 ✅ |
| `api/session-data-api.ts` | BG2（T4） | 修改 | 仅 BG2 ✅ |
| `plugin-session-data-cache.test.ts` | BG2（T4） | 创建 | 仅 BG2 ✅ |
| `plugin-hot-reload.test.ts` | BG2（T5） | 创建 | 仅 BG2 ✅ |
| `bridge-reconnect.test.ts` | BG3（T6） | 创建 | 仅 BG3 ✅ |
| `goal.test.ts` | BG3（T7） | 创建 | 仅 BG3 ✅ |
| `todo.test.ts` | BG3（T7） | 创建 | 仅 BG3 ✅ |
| `stores/plugin.ts` | FG1（T8） | 创建 | 仅 FG1 ✅ |
| `composables/usePlugin.ts` | FG1（T8） | 创建 | 仅 FG1 ✅ |
| `CLAUDE.md` | DG1（T13） | 修改 | 仅 DG1 ✅ |
| `README.md` | DG1（T13） | 修改 | 仅 DG1 ✅ |

**Wave 3**（FG2, FG3）：
| 文件 | 操作者 | 操作类型 | 冲突？ |
|------|--------|---------|-------|
| `PluginsPane.vue` | FG2（T9） | 创建 | 仅 FG2 ✅ |
| `PluginSettingsForm.vue` | FG2（T10） | 创建 | 仅 FG2 ✅ |
| `PluginPermissionDialog.vue` | FG2（T11） | 修改 | 仅 FG2 ✅ |
| `MessageDecoration.vue` | FG3（T12） | 创建 | 仅 FG3 ✅ |
| `AppStatusbar.vue` | FG3（T12） | 修改 | 仅 FG3 ✅ |
| `SlashMenu.vue` | FG3（T12） | 修改 | 仅 FG3 ✅ |

**结论：所有 Wave 内无文件冲突。** ✅

---

## 5. 接口契约一致性检查

### 5.1 plan.md Interface Contracts vs plan-api-contract

**WS Client → Server 对比：**

| 类型 | plan.md Payload | plan-api-contract Payload | 一致？ |
|------|-----------------|--------------------------|--------|
| plugin.list | `{}` | `{}` | ✅ |
| plugin.toggle | `{ pluginId, enabled }` | `{ pluginId, enabled, trustLevel? }` | ⚠️ 见 Issue #3 |
| plugin.uninstall | `{ pluginId }` | `{ pluginId }` | ✅ |
| plugin.approvePermissions | `{ pluginId, permissions }` | `{ pluginId, permissions }` | ✅ |
| plugin.revokePermissions | `{ pluginId }` | `{ pluginId }` | ✅ |
| plugin.executeCommand | `{ pluginId, commandId, args? }` | `{ pluginId, commandId, args? }` | ✅ |
| plugin.config.get | `{ pluginId, key }` | `{ pluginId, key? }` | ⚠️ 见 Issue #4 |
| plugin.config.set | `{ pluginId, key, value }` | `{ pluginId, key, value }` | ✅ |

**Response 类型对比：**

| 类型 | plan.md | plan-api-contract / plan-backend.md | 一致？ |
|------|---------|-------------------------------------|--------|
| plugin.approvePermissions | — | `config.plugins` | ⚠️ 见 Issue #2 |
| plugin.revokePermissions | — | `config.plugins` | ⚠️ 见 Issue #2 |
| plugin.executeCommand | — | ack (`pong`) | ⚠️ 见 Issue #2 |

**注意：** plan-backend.md T3 handler 实现明确返回 `config.plugins` 和 `pong`，plan-api-contract 也一致。plan.md 的 Interface Contracts 表未列出这些响应类型，属于文档覆盖不全，但不影响功能实现（前端不依赖这些响应）。

### 5.2 RPC 方法签名一致性

plan-api-contract.md §3 的 RPC 方法表与 plan-backend.md 中的设计细节一致。所有方法名、方向、参数均有定义。✅

### 5.3 Data Flow Chains

plan-api-contract.md §4 的 8 条数据流链均与 spec AC 对应：

| Data Flow | AC | 方法引用 | 一致？ |
|-----------|-----|---------|--------|
| Tool Execution | AC-A1 | handleBridgeToolExecute → invoke → Worker | ✅ |
| Hook Serialization | AC-A2/A3 | executeHooks → serial invoke → block/transform | ✅ |
| Plugin List | AC-B1 | fetchPlugins → plugin.list → config.plugins | ✅ |
| Plugin Toggle | AC-B2 | togglePlugin → plugin.toggle → config.plugins | ✅ |
| Plugin Config | AC-B3 | config.get/set → plugin.config.get/set → plugin:config | ✅ |
| Permission Approval | AC-B7 | permissionRequest → approvePermissions | ✅ |
| Hot Reload | AC-C5 | fs.watch → performReload → statusChange | ✅ |
| SessionData Cache | AC-C4 | cache.write → dirty → flush | ✅ |

### 5.4 AC 覆盖矩阵完整性

plan.md 的 Spec Coverage Matrix（§Spec Coverage Matrix）已覆盖所有 18 条 AC，无遗漏。✅

---

## 6. e2e-test-plan 覆盖度检查

### AC → Test Scenario 映射

| AC | TS | 覆盖度 | 说明 |
|----|----|--------|------|
| AC-A1 | TS-1 | ✅ 完整覆盖（7 个子场景含关键路径 + 3 个失败场景） |
| AC-A2 | TS-2 | ✅ 完整覆盖（4 个子场景 + 2 个 transform 子场景） |
| AC-A3 | TS-2 (transform) | ✅ 完整覆盖 |
| AC-A4 | TS-6 (slash command) | ⚠️ 部分覆盖 | TS-6 覆盖 slash command → executeCommand 路径，但未覆盖状态栏点击 → executeCommand 路径。两者使用相同 WS 消息，协议层的正确性可通过 T3 的单元测试保障 |
| AC-B1 | TS-3 | ✅ 完整覆盖（4 步验证） |
| AC-B2 | TS-4 | ✅ 完整覆盖（7 个子场景含 toggle/不可操作验证） |
| AC-B3 | TS-5 | ✅ 完整覆盖（7 个子场景含刷新验证） |
| AC-B4 | TS-6 | ✅ 覆盖（步骤 3 验证状态栏项） |
| AC-B5 | TS-6 | ✅ 覆盖（步骤 4-7 验证 SlashMenu） |
| AC-B6 | TS-7 | ✅ 完整覆盖（6 个子场景含 tag 点击） |
| AC-B7 | TS-8 | ✅ 完整覆盖（8 个子场景含部分批准 + 撤销） |
| AC-C1 | TS-11 | ✅ 完整覆盖（7 个子场景含超时放弃） |
| AC-C2 | TS-12 | ✅ 完整覆盖（10 + 9 个子场景） |
| AC-C3 | TS-2 | ✅ 覆盖（作为 hook 阻止的失败场景） |
| AC-C4 | TS-9 | ✅ 完整覆盖（7 个子场景含断连 + 恢复） |
| AC-C5 | TS-10 | ✅ 完整覆盖（8 个子场景含语法错误） |
| AC-D1 | N/A（文档化） | N/A | 
| AC-D2 | N/A（文档化） | N/A |

**结论：** 除 AC-A4 的状态栏点击路径在 e2e 中未显式覆盖（但 slash command 路径已验证相同 WS 消息），所有 AC 均有对应测试场景。e2e-test-plan 的质量良好。✅

**可测试性评价：** 测试场景设计合理，Mock 策略清晰（`vi.useFakeTimers()` 用于超时、mock SessionService 用于 bridge 测试），同时包含了正常路径和失败场景。

---

## 7. Use Cases 覆盖度检查

### UC → AC 覆盖映射

| UC | AC | 覆盖？ |
|----|----|--------|
| UC-1 查看插件列表 | AC-B1 | ✅ |
| UC-2 启用/禁用 | AC-B2 | ✅ |
| UC-3 卸载插件 | AC-B2 | ✅ |
| UC-4 Tool 调用 | AC-A1 | ✅ |
| UC-5 Hook 阻止 | AC-A2, AC-A3 | ✅ |
| UC-6 热重载 | AC-C5 | ✅ |
| UC-7 配置修改 | AC-B3 | ✅ |
| UC-8 权限审批 | AC-B7 | ✅ |

**未覆盖的 AC（use-cases.md 已标注）：** AC-A4, AC-B4, AC-B5, AC-B6, AC-C1, AC-C2, AC-C3, AC-C4, AC-D1, AC-D2

这些 AC 均为非交互性（测试覆盖或文档化），不阻碍功能验证。✅

**观察：** AC-B4（状态栏）、AC-B5（SlashMenu 命令）、AC-B6（消息装饰器）虽然是用户可见的交互功能，但作为辅助 UI 元素，不设独立 UC 是可接受的（它们被 TS-6/TS-7 测试覆盖）。⚠️ INFO

---

## 8. 后端设计充分性检查（L1 级别）

> 注：由于 plan.md 标注为 L2 复杂度，本 reviewer 仅检查后端设计充分性的整体层面（非详细后端设计）。详细后端设计审查由独立 subagent 执行。

### 8.1 设计理由

- T1 的 `PluginRpcServer.invoke()` 新增方法：plan-backend.md 解释了为什么需要（现有 dispatch 只处理 incoming，需要 outgoing），以及如何通过 `pendingInvokes` Map 实现——理由充分 ✅
- T2 的串行 await 替换 fire-and-forget：plan-backend.md 指出了当前 stub 的问题，说明串行是 content modification chains 的必要条件——理由充分 ✅
- T4 的 sessionData 缓存：解释了 write-through cache + 定时 flush 的折衷（性能 vs 最终一致性）——理由充分 ✅

### 8.2 存储变更
- T4 引入 sessionData dirty 追踪和容量限制，没有数据库变更
- Config 操作通过 PluginStorage（已存在的 KV 存储），无新增存储
- 所有 RPC 方法复用已有的 MessagePort 通道，无新增基础设施

### 8.3 API 端点
- WS handler 通过 server.ts 的 switch 语句新增 case（7 个新的 plugin.* handler）
- 无新增 HTTP 或 REST 端点（全部通过 WebSocket flat-type 消息）

### 8.4 边界条件和异常处理
- 所有错误场景均有处理（tool not found, Worker crash, timeout, 语法错误, 超时强制 terminate）✅
- `plugin.install` 返回 `not_implemented` 错误 ✅

---

## 9. 非功能性设计检查

### 稳定性
- 每个调用点有独立 try-catch ✅
- 单 Worker 超时 5s 视为放行 ✅
- RPC 调用的超时机制：tool 30s / hook 5s ✅

### 数据一致性
- sessionData 缓存：写入→缓存→异步 flush（5s 间隔） ✅
- deactivate 强制 flush（3s 超时） ✅
- PluginStore 乐观更新 + 重连自动刷新 ✅

### 性能
- executeHooks O(N) serial，当前 N ≤ 5 ✅
- 高频推送无节流方案（依赖 Worker 侧控制）— 已标注为风险，未来优化 ✅
- 热重载 300ms debounce ✅

### 安全
- Worker Thread 进程级隔离 ✅
- PluginStorage 与 pi 数据目录完全隔离 ✅
- WS 消息在 Electron 内部 WebSocket（localhost only） ✅

---

## 发现的问题

### 问题 #1 (LOW): T13 依赖关系与 Wave 编排不一致

- **位置**: `plan.md:Task List`（T13 的 Depends on 列）
- **描述**: Task List 中 T13（Documentation）的依赖关系标注为 `T1-T12`，但 Wave 编排查 DG1 在 Wave 2（与 BG2、BG3、FG1 并行）。实际上 T13 只需要 BG1 完成即可开始（文档内容主要基于架构决策，由 BG1 确认），不需要等待 BG2、BG3、FG2、FG3。Task List 的依赖关系过于保守。
- **影响**: 如果严格执行 Task List 的依赖，T13 会被推迟到所有后端和前端任务完成后才启动，浪费了 Wave 2 的并行能力。
- **修改方向**: 将 T13 的依赖改为 `BG1` 或 `T1, T8`（需要 BG1 架构确认 + FG1 store 类型），与 Wave 编排保持一致。

### 问题 #2 (LOW): plan.md Interface Contracts 响应类型缺失

- **位置**: `plan.md:Interface Contracts → WS Protocol` 表
- **描述**: 以下 WS 消息的 response 类型在 plan.md 中标记为 `—`，但 plan-api-contract §1.4 和 plan-backend.md T3 handler 实现明确指定了响应类型：
  - `plugin.approvePermissions` → `config.plugins`（plan-api-contract 定义，backend handler 实现）
  - `plugin.revokePermissions` → `config.plugins`（同上）
  - `plugin.executeCommand` → ack (`pong`)（plan-backend.md T3 handler 实现）
- **影响**: 前端不依赖这些响应（fire-and-forget 模式），无功能性影响。但计划文档不完整，后续维护者可能误以为无响应。
- **修改方向**: 在 plan.md 的 Interface Contracts 表中补充缺失的响应类型。

### 问题 #3 (LOW): plugin.toggle 的 trustLevel 参数未在 spec 和 plan.md 中确认

- **位置**: `plan-api-contract.md §1.2` vs `spec.md FR-B1` vs `plan.md Interface Contracts`
- **描述**: plan-api-contract §1.2 在 `plugin.toggle` 的 payload 中添加了 `trustLevel?: 'trusted' | 'sandbox'` 可选字段，但 spec FR-B1 的 `plugin.toggle` 定义为 `{ pluginId: string, enabled: boolean }`，plan.md 的 Interface Contracts 表也为 `{ pluginId, enabled }`。plan-frontend.md §2.7 也标注了"需要与后端确认"。这表明 trustLevel 切换的设计决策尚未最终确认，但 plan-api-contract 已包含该字段。
- **影响**: 如果被执行 subagent 当作已确认设计实现，而最终后端不支持，会导致信任等级切换功能不可用。或反之，如果 subagent 不实现，而侧边需要此字段，也会出问题。
- **修改方向**: 明确 trustLevel 切换的决策状态：(1) 如果已确认，更新 spec 和 plan.md；(2) 如果待定，从 plan-api-contract 中移除，改为注释标记未来扩展点。

### 问题 #4 (INFO): plugin.config.get 的 key 参数可选性不一致

- **位置**: `plan.md Interface Contracts` vs `plan-api-contract.md §1.2`
- **描述**: plan.md 的 WS Protocol 表将 `plugin.config.get` 的 payload 定义为 `{ pluginId, key }`（key 必填），但 plan-api-contract §1.2 定义为 `{ pluginId, key?: string }`（key 可选，省略时返回全量 config）。plan-backend.md §3.3 handler 中用 `key` 作查询，也展示了返回单个值的场景。但 `set` handler 中用 `__all__` 魔术字符串获取全量 config 来响应。
- **影响**: 极小。前端 PluginSettingsForm 以 key 为单位操作配置，不会触发 `key` 省略场景。但 `key?` 机制的设计尚未对齐（返回全量还是单值），如果未来需要批量获取配置，会出问题。
- **修改方向**: 对齐两处文档：确定 `key?` 省略时是全量返回还是报错，更新 handler 实现。

### 问题 #5 (INFO): FG1 文件数统计与主文件结构表不一致

- **位置**: `plan-frontend.md §1` vs `plan.md File Structure`
- **描述**: plan-frontend.md §1 说 "Files (3): 2 create + 1 modify（protocol.ts 类型已由 BG1 添加）"，但 plan.md 的 File Structure 表只列出 FG1 的 2 个创建文件（`stores/plugin.ts`, `composables/usePlugin.ts`），没有第 3 个文件。protocol.ts 的修改已明确归属 BG1。
- **影响**: 文件数统计错误可能导致执行 subagent 对 FG1 工作量估计偏差（实际 2 个文件 vs 声称的 3 个）。影响极小。
- **修改方向**: 将 plan-frontend.md 的 "Files (3)" 修正为 "Files (2)"。

### 问题 #6 (INFO): types/plugin.ts 未纳入主文件结构表

- **位置**: `plan-frontend.md §1.1` vs `plan.md File Structure`
- **描述**: plan-frontend.md §1.1 描述了创建 `types/plugin.ts` 来定义 `PluginViewModel`、`PluginStatusItem`、`MessageDecoration`、`PluginContributes`、`PluginSettingSchema` 等前端类型。但该文件未出现在 plan.md 的 File Structure 表中，也未分配到任何 Group。FG1 的 Subagent 配置也未显式列出此文件为创建文件。
- **影响**: 执行时 FG1 subagent 可能不会创建此文件，而是在 `stores/plugin.ts` 或 `composables/usePlugin.ts` 中内联定义类型，导致类型无法复用（FG2/FG3 的组件也需要这些类型）。
- **修改方向**: 将 `types/plugin.ts` 添加到 plan.md File Structure 表中，归属 FG1 Group。

---

## 结论

**通过**。无 MUST FIX 问题。

Plan 整体质量优秀，主要优势：
1. FR/AC 覆盖率达 100%，无遗漏需求
2. Execution Groups 分组合理，Wave 编排正确，同 Wave 内无文件冲突
3. 接口契约定义详细，前后端签名一致（仅有 minor 不一致）
4. e2e-test-plan 场景设计全面（正常路径 + 失败路径 + 边界条件）
5. use-cases.md 的 UC-AC 映射清晰
6. 后端设计理由充分，错误场景覆盖全面

需关注的问题（均为 LOW/INFO 级别，不阻塞流程）：
- T13 依赖关系需修正以对齐 Wave 编排
- 3 条 WS 消息的响应类型在 plan.md 中缺漏
- trustLevel 决策需确认
- 若干文档细节问题

## Summary

计划评审完成，第1轮，0条MUST FIX，3条LOW建议，3条INFO观察。
