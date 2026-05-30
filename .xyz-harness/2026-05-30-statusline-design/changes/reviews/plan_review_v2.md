---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-30T23:30:00"
  target: ".xyz-harness/2026-05-30-statusline-design/plan.md"
  verdict: fail
  summary: "计划评审完成，第2轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 10
  must_fix: 1
  must_fix_resolved: 2
  low: 5
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md → File Structure table + BG1 section"
    title: "缺少 index.ts 文件追踪 — setStatus 管道将断裂"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "plan-frontend.md §2.1 Data Sources → contextOutputTokens"
    title: "contextOutputTokens 无数据源，tokenUsage 代理可能语义错误"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "plan.md → Task 5 (Emit context.update) + plan-backend.md 缺少对应设计章节"
    title: "context.update 后端 Task 缺少详细设计 — plan-backend.md 无 §Task 5 章节"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan-frontend.md §3.1 → SessionStrip branch data source"
    title: "gitBranch 字段不存在，cwd 目录名是分支名的弱代理"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "plan-frontend.md §4.3 → piVersion data source"
    title: "piVersion 数据源未确认"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "plan-backend.md §1.2 + §2.2 方案A"
    title: "plugin:statusSetUpdate 加入 ServerMessageType 但实际是死代码"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "test_cases_template.json → AC-5, AC-2 边界"
    title: "测试用例缺少 AC-5 chip 路由规则和 AC-2 模型切换失败 toast 的显式验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "plan.md → Wave Schedule"
    title: "FG1 依赖 BG1 Task 1 的 protocol types，但 Task 6 同时需要 BG1 Task 4 的广播格式确定"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "plan-backend.md → section numbering vs plan.md Task numbering"
    title: "plan-backend.md §节编号与 plan.md Task 编号不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "plan-backend.md §2.2 → onStatusSetUpdate 方案 A"
    title: "Task 4 (index.ts 回调连接) 的设计混入 Task 2 章节，缺乏独立实现指导"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-30 23:30
- 评审类型：计划评审（增量审查模式）
- 评审对象：`.xyz-harness/2026-05-30-statusline-design/plan.md` + 子文档（plan-backend.md, plan-frontend.md, plan-api-contract.md）
- 上一轮评审：`plan_review_v1.md`

## 上一轮 MUST FIX 修复验证

### [FIXED] Issue #1: index.ts 文件遗漏

**v1 问题:** plan.md 的 File Structure 表和 BG1 Files 未列出 `index.ts`，setStatus 管道断裂。

**v2 验证:**
- ✅ File Structure 表已新增 `src-electron/runtime/src/index.ts`（modify, BG1）
- ✅ Task List 新增 Task 4："Wire onStatusSetUpdate callback in index.ts"，depends on Tasks 2+3
- ✅ BG1 文件数更新为 8 个（0 create + 8 modify）
- ✅ BG1 Subagent 配置的"读取文件"和"修改/创建文件"列表包含 `index.ts`
- ✅ BG1 Execution Flow 新增 Task 4 的 subagent 步骤（TDD → implement → review）
- ✅ plan-backend.md §2.4 详细描述了 `index.ts` 中 adapter factory 的 `onStatusSetUpdate` 回调连接
- ✅ plan-api-contract.md §5.1 定义了 `EventAdapterOptions.onStatusSetUpdate` 签名

**结论: RESOLVED** ✅

---

### [FIXED] Issue #2: contextOutputTokens 无数据源

**v1 问题:** `contextOutputTokens` 标注 "*(needs discovery)*"，用 `tokenUsage` 代理可能语义错误。

**v2 验证:**
- ✅ plan-frontend.md §2.1 Data Sources 已改为 `tokenUsage` + `contextInputTokens`
- ✅ plan.md Context Discovery Notes #2 明确了新策略：`tokenUsage` 显示为总 token（↑total），不再试图分离 input/output
- ✅ plan-frontend.md §2.5 Token Stats 使用 `contextInputTokens` 显示 ↑input，`tokenUsage` 显示 ↓total
- ✅ 理由充分：`contextInputTokens` 来自 `context.update`，`outputTokens` 来自 `message.complete`，两者数据源不同、时序不同，合并显示会造成混乱
- ✅ "Placeholder 扫描" 中不再有 `*(needs discovery)*` 标记

**结论: RESOLVED** ✅

---

### [NOT FIXED] Issue #3: context.update 后端 Task 缺少详细设计

**v1 问题:** `context.update` 后端未实现但无 Task 解决，InputToolbar context bar 永远显示 0%。

**v2 验证:**

plan.md 确实新增了 Task 5："Emit context.update from event-adapter"，且在 Task List 中标注了依赖（depends on Task 1）和 Spec Ref（FR-3, AC-2）。Spec Coverage Matrix 的 AC-2 行也更新为 Tasks 5+9。这些结构性改进是正确的。

**但问题在于 plan-backend.md 缺少 Task 5 的详细设计章节：**

plan-backend.md 的 5 个 § 节与 plan.md Task 编号对应关系如下：

| plan-backend.md § | 覆盖的 plan.md Task | 匹配 |
|-------------------|-------------------|-------|
| §1 Task 1 | Task 1 (protocol types) | ✅ |
| §2 Task 2 | Task 2 (event-adapter) + Task 4 (index.ts callback，内联在 §2.4) | ⚠️ 部分内联 |
| §3 Task 3 | Task 3 (server.ts bridge:event) | ✅ |
| §4 Task 4 | **实际是 Task 6** (plugin-service + ui-api) | ❌ 编号错位 |
| §5 Task 5 | **实际是 Task 7** (statusline plugin) | ❌ 编号错位 |

**plan.md Task 5 (Emit context.update from event-adapter) 在 plan-backend.md 中完全没有对应的设计章节。** plan.md Context Discovery Notes #1 只有一段概括性描述：

> "event-adapter 的 agent_end case 在返回 message.complete 后，额外计算 contextUsagePercent 并发送 context.update 消息。"

这对 subagent 实现来说是不够的——没有说明：
1. `agent_end` case 的具体修改位置和代码结构
2. `contextUsagePercent` 如何计算（从哪些字段提取？公式是什么？）
3. 发送 `context.update` 消息的 payload 结构
4. 前端 `useChat.ts` 需要如何修改来接收并存储到 chatStore
5. 边界条件（context 数据缺失、agent_end 中 usage 为空等）

**这属于"功能失效"级别的 MUST FIX**：如果 subagent 拿到的设计指导只有 Context Discovery Notes 中的一句话，实现很可能不完整或不正确，导致 AC-2 的 context bar 仍无法工作。

**修改建议:**
1. 在 plan-backend.md 新增 §（如 §3.5 或独立 §）专门描述 Task 5 的实现设计
2. 包含：event-adapter.ts `agent_end` case 的修改代码、contextUsagePercent 计算逻辑、context.update payload 结构、前端 useChat.ts 的配套修改
3. 或者至少在 Task 5 的 subagent 注入上下文中提供完整的实现指导（包括代码位置、数据格式、计算公式）

---

## 上一轮 LOW 问题验证

### Issue #4: gitBranch 数据源 (LOW)
- **状态: 未变** — plan-frontend.md §3.1 仍使用 `cwd` 目录名作为分支名代理
- **评估:** 作为 MVP 可接受，plan-frontend.md 已明确标注了实现方式。维持 LOW。

### Issue #5: piVersion 数据源 (LOW)
- **状态: 未变** — plan-frontend.md §4.3 仍建议 fallback 省略
- **评估:** MVP fallback 合理，不影响 AC-4 核心功能（连接状态 + global chips）。维持 LOW。

### Issue #6: ServerMessageType 死类型 (LOW)
- **状态: 未变** — `plugin:statusSetUpdate` 仍在 ServerMessageType union 中
- **评估:** plan-api-contract.md §1.3 已注明"仅用于 sidecar 内部消息路由"。虽然方案 A 用回调而非 WsSender，但类型定义有助于代码可读性和 `handleBridgeEvent` 的类型安全。维持 LOW，建议加注释说明。

### Issue #7: 测试覆盖缺口 (LOW)
- **状态: 未变** — test_cases_template.json 仍未包含 AC-5 chip routing 显式测试和 AC-2 模型切换失败测试
- **评估:** 这两个测试场景对验证 scope routing 正确性和错误处理很重要。维持 LOW，但建议在 Task 10/11 的 subagent 注入上下文中明确补充这两个场景。

---

## 新发现的问题

### Issue #9: plan-backend.md §节编号与 plan.md Task 编号不一致 (LOW)

**位置:** plan-backend.md §4 → 实际覆盖 plan.md Task 6；§5 → 实际覆盖 plan.md Task 7

**问题:** plan.md 修改后新增了 Task 4 和 Task 5，导致后续 Task 编号整体后移。但 plan-backend.md 的 § 节标题仍使用旧编号（§4 Task 4 实际是 plan.md 的 Task 6）。

这对 subagent 注入上下文时的交叉引用造成混乱——subagent 收到的 Task 描述引用 plan-backend.md §4，但 plan.md Task 6 的描述也引用 plan-backend.md，编号不匹配可能导致 subagent 找错设计章节。

**修改建议:** 更新 plan-backend.md §节标题为 plan.md 的实际 Task 编号：
- §4 → "Task 6: Extend plugin-service + ui-api statusBarUpdate"
- §5 → "Task 7: Create statusline built-in plugin"

---

### Issue #10: Task 4 (index.ts callback) 设计嵌入 Task 2 章节 (LOW)

**位置:** plan-backend.md §2.4

**问题:** Task 4（Wire onStatusSetUpdate callback in index.ts）的实现指导完全内嵌在 §2 Task 2 (event-adapter) 的 §2.4 段落中，没有独立章节。这导致：
1. Task 4 的 subagent 注入上下文需要引用另一个 Task 的章节来获取自己的设计指导
2. Task 4 的测试要点和边界条件混在 Task 2 的列表中，容易遗漏

**修改建议:** 将 §2.4-2.5 中关于 `onStatusSetUpdate` 回调和 `handleStatusSetUpdate` 的内容提取为独立的 §（§2.5 或 §3.5），专门描述 Task 3+4 的 server.ts 和 index.ts 修改。或者至少在 Task 4 的 subagent 注入上下文中明确列出具体的代码修改点和测试要点。

---

## 回归检查

本轮修复未引入新的结构性问题。检查点：
- ✅ File Structure 表文件数与 Task 列表一致（BG1=8 files, BG2=2, FG1=6, FG2=1）
- ✅ Dependency Graph 正确反映新增 Task 4/5 的依赖
- ✅ Wave Schedule 更新正确（Wave 1 包含 BG1 所有 6 个 Tasks）
- ✅ Spec Coverage Matrix 的 AC-2 行已更新为 Tasks 5+9
- ✅ plan-api-contract.md 与 plan.md 的接口定义一致
- ✅ plan-frontend.md Data Sources 与 plan.md Context Discovery Notes 一致

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | ~~MUST FIX~~ | ~~plan.md File Structure~~ | ~~index.ts 文件遗漏~~ | ~~已修复~~ ✅ |
| 2 | ~~MUST FIX~~ | ~~plan-frontend.md §2.1~~ | ~~contextOutputTokens 数据源~~ | ~~已修复~~ ✅ |
| 3 | MUST FIX | plan-backend.md 缺少 Task 5 (context.update) 设计章节 | plan.md Task 5 在 plan-backend.md 中无对应 §，Context Discovery Notes 只有一句概括，subagent 实现指导不足 | 在 plan-backend.md 新增专门 § 描述 agent_end case 修改、contextUsagePercent 计算逻辑、payload 结构、useChat.ts 配套修改 |
| 4 | LOW | plan-frontend.md §3.1 | gitBranch 用 cwd 目录名代理 | MVP 可接受，后续优化 |
| 5 | LOW | plan-frontend.md §4.3 | piVersion 数据源未确认 | MVP fallback 省略 |
| 6 | LOW | plan-backend.md §1.2 | `plugin:statusSetUpdate` 在 ServerMessageType 中可能为死代码 | 加注释说明用途 |
| 7 | LOW | test_cases_template.json | 缺少 AC-5 chip routing 和 AC-2 模型切换失败测试 | 补充测试用例 |
| 8 | INFO | plan.md Wave Schedule | FG1 对 BG1 Task 4 的隐含数据格式依赖 | 无需操作 |
| 9 | LOW | plan-backend.md §节编号 | §4 实际是 Task 6，§5 实际是 Task 7，编号与 plan.md 不一致 | 更新 §节标题编号 |
| 10 | LOW | plan-backend.md §2.4 | Task 4 设计混入 Task 2 章节，缺乏独立实现指导 | 提取为独立 § 或在 subagent 上下文中明确指引 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

---

### 结论

需修改后重审（1 条 MUST FIX）。

### Summary

计划评审完成，第2轮，1条MUST FIX，需修改后重审。v1 的 3 条 MUST FIX 中 2 条已修复（index.ts 文件追踪 ✅、contextOutputTokens 数据源 ✅），1 条部分修复（Task 5 已加入 Task List 但 plan-backend.md 缺少详细设计章节，subagent 实现指导不足）。
