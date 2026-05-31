---
review:
  type: plan_review
  round: 3
  timestamp: "2026-05-30T23:50:00"
  target: ".xyz-harness/2026-05-30-statusline-design/plan.md"
  verdict: pass
  summary: "计划评审完成，第3轮（最终轮），0条MUST FIX，评审通过"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 3
  low: 7
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
    location: "plan-backend.md → §4a Task 5 (Emit context.update)"
    title: "context.update 后端 Task 缺少详细设计 — plan-backend.md 无 Task 5 章节"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 3

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
    location: "plan-backend.md §4 标题编号"
    title: "§4 标题仍为 'Task 4' 但实际覆盖 plan.md Task 6，§编号与 Task 编号不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "plan-backend.md §2.4"
    title: "Task 4 (index.ts callback) 设计混入 Task 2 章节，缺乏独立实现指导"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v3（最终轮）

## 评审记录
- 评审时间：2026-05-30 23:50
- 评审类型：计划评审（增量审查模式 — 仅验证 v2 MUST FIX）
- 评审对象：`.xyz-harness/2026-05-30-statusline-design/plan.md` + 子文档
- 上一轮评审：`plan_review_v2.md`

## v2 MUST FIX 修复验证

### [FIXED] Issue #3: context.update 后端 Task 缺少详细设计

**v2 问题:** plan.md 新增了 Task 5 (Emit context.update from event-adapter)，但 plan-backend.md 缺少对应设计章节，Context Discovery Notes 只有一句概括，subagent 实现指导不足。

**v3 验证:**

plan-backend.md 已新增 **§4a Task 5: Emit context.update from event-adapter**，包含以下完整设计要素：

| v2 要求 | §4a 覆盖情况 | 状态 |
|---------|-------------|------|
| agent_end case 的具体修改位置 | "EventAdapter 的 agent_end case（行 ~178-195），在返回 message.complete 之后" + 明确列出 3 个修改位置 | ✅ |
| contextUsagePercent 计算公式 | `usagePercent = Math.round((inputTokens / contextWindow) * 100)` | ✅ |
| 数据源分析 | message.complete 的 usage.inputTokens + ModelInfo.contextWindow | ✅ |
| context.update payload 结构 | `ContextUpdatePayload { usagePercent, inputTokens, contextLimit }` 完整定义 | ✅ |
| 前端 useChat.ts 配套修改 | 后端 Task 5 负责发出消息；前端接收侧在 Context Discovery Notes #2 描述策略，Task 9 负责 InputToolbar 展示 | ✅ 合理分工 |
| 边界条件（4 种场景） | usage undefined → 不发送；contextWindow undefined → 0；>100 → 上限 100 | ✅ |
| 测试要点（4 条） | 带 usage 发出、不带 usage 静默、contextWindow undefined、超限上限 | ✅ |
| 实现方案比较 | 方案 A（回调，推荐）vs 方案 B（直接传参），附理由 | ✅ |

**质量评估:**

1. **修改位置明确** — 3 个修改点（event-adapter.ts agent_end case、EventAdapterOptions 接口、server.ts/index.ts 注册回调）全部列出
2. **方案 A 与现有模式一致** — 采用 `onContextUpdate` 回调模式，与 `onStatusSetUpdate`/`onBridgeUIRequest` 一致，EventAdapter 不直接依赖 ModelService
3. **边界条件充分** — 覆盖了 usage 缺失、contextWindow 缺失、百分比超限三种异常场景
4. **Subagent 可独立实现** — 修改文件、代码位置、计算公式、payload 结构、方案选择全部具备，无需额外 discovery

**结论: RESOLVED** ✅

---

## 回归检查

§4a 新增内容未引入结构性问题：

- ✅ plan.md Task List 中 Task 5 已存在（depends on Task 1, BG1, FR-3/AC-2）
- ✅ BG1 Execution Flow 包含 Task 5 的 subagent 步骤（TDD → implement → review）
- ✅ Spec Coverage Matrix AC-2 行引用 Tasks 5+9
- ✅ §4a 放置位置合理（§4 Task 6 和 §5 Task 7 之间）
- ✅ BG1 文件数仍为 8 个（event-adapter.ts 修改同时覆盖 Task 2 + Task 5）
- ✅ Dependency Graph 正确（Task 5 depends on Task 1）

---

## 残留 LOW 问题状态

以下 LOW/INFO 问题自 v1/v2 以来未变，不阻塞通过：

| # | 优先级 | 位置 | 说明 | v3 评估 |
|---|--------|------|------|---------|
| 4 | LOW | plan-frontend.md §3.1 | gitBranch 用 cwd 代理 | MVP 可接受 |
| 5 | LOW | plan-frontend.md §4.3 | piVersion 数据源未确认 | MVP fallback 省略 |
| 6 | LOW | plan-backend.md §1.2 | `plugin:statusSetUpdate` 在 ServerMessageType 中可能为死代码 | 有注释说明即可 |
| 7 | LOW | test_cases_template.json | 缺少 AC-5/AC-2 边界测试 | 在 subagent 上下文中补充 |
| 8 | INFO | plan.md Wave Schedule | FG1 对 BG1 Task 6 的隐含依赖 | 无需操作 |
| 9 | LOW | plan-backend.md §4 标题 | "Task 4" 实际是 plan.md Task 6 | 不阻塞，但建议后续修正 |
| 10 | LOW | plan-backend.md §2.4 | Task 4 设计混入 Task 2 章节 | 在 subagent 注入上下文中明确指引 |

> 建议: Issue #9（§节编号不一致）可在 Phase 3 开始前快速修正，避免 subagent 交叉引用时混淆。Issue #10 同理。

---

## 总评

### 3 轮评审总结

| 轮次 | MUST FIX | 已修复 | 新发现 | 结论 |
|------|----------|--------|--------|------|
| v1 | 3 | 0 | 5 LOW + 1 INFO | fail |
| v2 | 1 | 2 | 2 LOW | fail |
| v3 | 0 | 3 (全部) | 0 | **pass** |

3 条 MUST FIX 全部修复：
1. ✅ index.ts 文件追踪 — File Structure 表 + Task 4 + BG1 配置完整
2. ✅ contextOutputTokens 数据源 — 策略改为 tokenUsage 显示 total，不再分离 input/output
3. ✅ context.update Task 5 设计 — plan-backend.md §4a 完整覆盖修改位置/计算逻辑/payload/边界条件

### 结论

**评审通过。** 计划可进入 Phase 3 (dev) 执行。

残留 7 条 LOW + 1 条 INFO 均不阻塞实施，建议在 dev 阶段通过 subagent 注入上下文覆盖（Issue #7、#10）和 Phase 3 前快速文档修正（Issue #9）。
