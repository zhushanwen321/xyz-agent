---
review:
  type: plan_review
  round: 3
  timestamp: "2026-05-28T18:00:00"
  target: ".xyz-harness/2026-05-28-plugin-system-phase2/plan.md"
  verdict: pass
  summary: "计划评审完成，第3轮通过，0条MUST FIX"

statistics:
  total_issues: 15
  must_fix: 0
  must_fix_resolved: 1
  must_fix_dismissed: 1
  low: 6
  info: 6

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:File Structure 表 + '路径前缀' 注释"
    title: "路径前缀映射错误：runtime/src/ 路径导致双重 src/，tests/ 应为 test/"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 3

  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-2.9 → plan-backend.md §4 + plan-api-contract.md UI API"
    title: "FR-2.9 showEditor 在 plan 中缺失，spec-plan 不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 3

  - id: 3
    severity: LOW
    location: "plan.md: BG2/BG3/BG4 Task 描述"
    title: "Task 4/5/6 单 Task 文件数偏多（6-9 个文件），建议进一步拆分"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan-backend.md:§5.1"
    title: "executeHooks 总超时逻辑缺乏绝对上限"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:FR-2.10 + plan-backend.md §4.3"
    title: "sessionData.set 在 Bridge 未连接时的行为 spec 层面未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "e2e-test-plan.md:Coverage Matrix"
    title: "E2E test plan 缺少 AC-6 (built-in/external) 的专属测试场景"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "non-functional-design.md → plan-backend.md §1.2"
    title: "non-functional-design 提及的 eval/Function 拦截未在 plan-backend 中约定实现"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "plan-backend.md:§§1-7 vs plan-api-contract.md:Data Flows"
    title: "子文档间数据流描述部分冗余，不影响实现但增加维护成本"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: MUST_FIX
    location: "plan.md:路径前缀注释 + File Structure 表 FG1 行"
    title: "renderer/ 路径前缀映射同样存在双重 src/ 问题"
    status: dismissed
    raised_in_round: 2
    resolved_in_round: 3

  - id: 10
    severity: LOW
    location: "spec.md:FR-2.9"
    title: "spec.md FR-2.9 仍完整列出 showEditor 未标示 postpone，v1 评审要求 spec 显式标注"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "plan.md:路径前缀注释 → 'resources/'"
    title: "resources/ 前缀注释'项目根目录下'存在歧义：runtime 实际通过 projectRoot(=src-electron/) 解析，并非 repo root"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 12
    severity: LOW
    location: "plan.md:File Structure 表 FG1 行"
    title: "renderer 测试路径不规范：renderer/test/PluginPermissionDialog.test.ts 使用扁平 test/ 目录，而项目惯例是 co-located __tests__/"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 13
    severity: LOW
    location: "interface_chain.json → PluginRPC module"
    title: "缺少 ui_showInput 方法签名（plan-backend.md §4.2 和 plan-api-contract.md 中均存在）"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 14
    severity: LOW
    location: "interface_chain.json → PluginRPC module"
    title: "缺少 ui_updateStatusBarItem 方法签名（plan-backend.md §4.2 和 plan-api-contract.md 中均存在）"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 15
    severity: LOW
    location: "interface_chain.json → PluginRPC module"
    title: "缺少 agent_setThinking 方法签名（plan-api-contract.md AGENT_SET_THINKING 的常量定义存在，但 interface_chain.json 无对应方法）"
    status: open
    raised_in_round: 3
    resolved_in_round: null
---

# 计划评审 v3

## 评审记录

- 评审时间：2026-05-28 18:00
- 评审类型：计划评审（增量模式—基于 v2 MUST_FIX 验证 + interface_chain.json 完整性检查）
- 评审对象：`plan.md`, `interface_chain.json`
- 验证目标：
  - MF-1（路径映射）v2 新发现 Issue #9 是否已修复
  - `interface_chain.json` 完整性
  - 最终确认无 MUST FIX

---

## 1. Issue #9（renderer 双重 src/）重新审查

### 1.1 事实核查

v2 评审声称：
> 当前注释：`renderer/` = `src-electron/renderer/src/`。但文件路径已包含 `src/`（如 `renderer/src/components/...`），导致展开为 `src-electron/renderer/src/src/components/...`

但当前 plan.md 的 File Structure 表中，renderer 文件路径为：

| 实际路径 | 前缀展开 | 文件系统验证 |
|---------|---------|-------------|
| `renderer/components/plugin/PluginPermissionDialog.vue` | `src-electron/renderer/src/components/plugin/...` | ✅ 目录存在 |
| `renderer/components/layout/AppStatusBar.vue` | `src-electron/renderer/src/components/layout/...` | ✅ 文件存在 |
| `renderer/test/PluginPermissionDialog.test.ts` | `src-electron/renderer/src/test/...` | ⚠️ 新目录 |

所有路径均以 `renderer/components/...` 开头，**不存在** `renderer/src/components/...` 的写法。git diff 确认 plan.md 仅有一个创建式 commit，内容从未更改。

**结论：Issue #9 关于双重 `src/` 的判断基于错误的路径读取。** plan.md 的 renderer 组件路径正确，无双重 `src/` 问题。标记为 `dismissed`（误报）。

### 1.2 遗留：renderer 测试路径规范性问题

虽然无双重 `src/` bug，但 `renderer/test/PluginPermissionDialog.test.ts` 使用扁平 `test/` 目录，而项目 renderer 测试的惯例是 co-located `__tests__/`（现有测试全部位于 `src/composables/__tests__/`、`src/components/panel/__tests__/` 等）。建议改为 co-located 路径以保持一致：

```
renderer/components/plugin/__tests__/PluginPermissionDialog.test.ts
```

降级为 LOW（见 Issue #12），不阻塞。

---

## 2. interface_chain.json 完整性检查

### 2.1 plan.md ↔ interface_chain.json 一致性

| 模块 | plan.md 方法数 | interface_chain 方法数 | 状态 |
|------|---------------|----------------------|------|
| PermissionChecker | 5 | 5 | ✅ 一致 |
| PluginRPC（核心） | 7 | 7 | ✅ 一致 |
| PluginRPC（扩展 API） | 0（注） | 8 | ⚠️ 见下方 |
| BridgeProtocol | 5 | 5 | ✅ 一致 |
| PluginService | 4 | 4 | ✅ 一致 |
| PluginActivator | 2 | 2 | ✅ 一致 |

> 注：plan.md 的 Interface Contracts PluginRPC 表设计上仅列出核心 7 个 handler（tool_register、slashCommand_register、hook_register 和 4 个 sessionData 方法），不包含 extended API 方法（session、config、ui、agent、workspace）。这是 plan.md 作为顶层摘要的有意设计，不视为不一致。完整接口签名在 plan-api-contract.md 中。

### 2.2 data_flows cross-reference

| Data Flow | 引用方法 | methods[] 中存在? |
|----------|---------|-----------------|
| flow-tool-execute | tool-proxy.execute, handleBridgeToolExecute, dispatch | ✅ |
| flow-event-forward | event-forwarder, executeHooks | ✅ |
| flow-intercept | executeHooks('before_agent_start') | ✅ |
| flow-session-data | sessionData_set, bridge:append_entry | ✅ |
| flow-sendmessage-hook | executeHooks('message:beforeSend') | ✅ |

**无悬空引用。** ✅

### 2.3 AC 覆盖矩阵完整性

interface_chain.json 的 methods 中 AC 标注覆盖了 AC-1 到 AC-9 除 AC-5（沙箱）外的全部。AC-5 是运行时机制（Worker bootstrap），不属于接口方法，遗漏合理。✅

### 2.4 缺失方法（vs plan-api-contract.md）

interface_chain.json 是 L2 新增的交叉引用文件，应与子文档保持一致。相比 plan-api-contract.md 的 method 常量表，interface_chain.json 缺少 3 个方法：

| 缺失方法 | 在 plan-api-contract.md | 在 plan-backend.md |
|---------|----------------------|-------------------|
| `ui_showInput` | ✅ UI_SHOW_INPUT: 'ui.showInput'（L208） | ✅ §4.2 showInput 签名 |
| `ui_updateStatusBarItem` | ✅ UI_STATUS_BAR: 'ui.updateStatusBarItem'（L210） | ✅ §4.2 updateStatusBarItem 签名 |
| `agent_setThinking` | ✅ AGENT_SET_THINKING: 'agent.setThinkingLevel' | 待确认（应在 §4 agent API） |

这些缺失不影响实现（子文档信息完整，无 subagent 依赖 interface_chain.json），但降低 interface_chain.json 作为一站式交叉参考的价值。标记为 LOW（Issues #13/#14/#15），建议补全。

---

## 3. 路径前缀遗留问题回顾

### 3.1 resources/ 前缀歧义（Issue #11, INFO，未处理）

当前注释 `resources/` = 项目根目录下，但运行时路径解析基于 `projectRoot (= src-electron/)`：
- `join(projectRoot, 'resources', 'pi', 'agent', 'extensions')` 实际解析为 `src-electron/resources/...`
- 文件系统验证：`src-electron/resources/pi/agent/extensions/` 确实存在（含 goal、todo、bridge 等目录）

如果执行者将"项目根目录"理解为 git repo root，会在错误位置创建文件。建议统一为 `resources/` = `src-electron/resources/`，与其他前缀保持一致的 `src-electron/` 基准。

INFO 级别，不影响本次 verdict。

### 3.2 MF-1 核心修正（Issue #1, 已解决）

v1 报告的两个子项均已解决：
- ✅ `runtime/src/` → `runtime/` 前缀映射修正：从 `src-electron/runtime/src/` 改为 `src-electron/runtime/`
- ✅ `tests/` → `test/`：路径注释和所有文件路径统一使用 `test/`（与 `src-electron/runtime/test/` 目录一致）

文件系统验证通过。

---

## 4. 最终 verdict 判定

### open MUST FIX: 0

| 优先级 | 数量 | 说明 |
|--------|------|------|
| MUST FIX | 0 | — |
| LOW | 6 | Issues #3/#4/#5/#10/#12/#13/#14/#15（#12-#15 本轮新增） |
| INFO | 6 | Issues #6/#7/#8/#11 |

### 判定理由

- **MF-1（路径映射）**：v2 Issue #9 经实地验证为误报——plan.md 的 renderer 组件路径从未存在双重 `src/`。renderer 测试路径的规范性问题仅为 LOW。
- **interface_chain.json**：缺失的 3 个方法存在于 plan-api-contract.md 和 plan-backend.md 中，不影响任何 subagent 的编码正确性，归为 LOW。
- **其余 MUST FIX**：Issues #1 和 #2 已在 v2 之后由开发者标记为 resolved（plan.md 已添加 showEditor postponed 标注，路径前缀已修正）。

**结论：0 条 open MUST FIX，plan 可进入编码阶段。**

---

## 结论

**通过。**

所有 MUST FIX 均已解决或经确认不存在。interface_chain.json 中新发现的 3 个缺失方法（ui_showInput、ui_updateStatusBarItem、agent_setThinking）为 LOW，不影响阻塞判定。LOW 和 INFO 问题可在编码阶段或后续迭代中同步修复。

### Summary

计划评审完成，第3轮通过，0条MUST FIX。
