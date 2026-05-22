---
verdict: "pass"
must_fix: 0
review:
  type: spec_review
  round: 3
  timestamp: "2026-05-22T20:00:00"
  target: ".xyz-harness/2026-05-21-/spec.md"
  summary: "Spec 评审第3轮（最终轮），0条MUST FIX open，发现2条LOW（AC与D5不一致、数据迁移路径），2条INFO，整体通过"

statistics:
  total_issues: 9
  must_fix: 0
  must_fix_resolved: 3
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "FR-1 目标结构 + FR-3 接口表 + AC-1 + D5"
    title: "session-pool.ts 最终状态和去向不明确"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "FR-2 变更第1条 + D7"
    title: "types.ts 文件位置决策未定（'或'字悬而未决）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "AC-1 最后一条"
    title: "37 种 ClientMessage.type 未枚举也未引用定义源"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "FR-8"
    title: "createSystemNotification 的 type 参数缺少类型定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "FR-6 + 目标结构"
    title: "provider-store.ts 是已有文件还是新文件未标注"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: LOW
    location: "AC-5 第3条 + AC-4 第2条"
    title: "AC-5/AC-4 仍假设 session-pool.ts 留存，与 D5 完全删除决策矛盾"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "FR-6"
    title: "config-store 拆分缺少数据迁移路径"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "AC-1 第1条"
    title: "server.ts ≤ 250L 目标可能偏紧"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "FR-2 变更第4条"
    title: "FR-2 '删除 session-pool.ts 内的重复 PiHistoryMessage' 在 D5 删除决策下已冗余"
    status: open
    raised_in_round: 3
    resolved_in_round: null
---

# Spec 评审 v3

## 评审记录
- 评审时间：2026-05-22 20:00
- 评审类型：计划评审（spec 完整性专项，第 3 轮）
- 评审对象：`.xyz-harness/2026-05-21-/spec.md`

## 前两轮修复状态

| 轮次 | MUST_FIX open | 结论 |
|------|--------------|------|
| v1 | 3 | fail |
| v2 | 0 | pass — 3条 MUST_FIX 全部修复: session-pool 去向已明确(D5)、types.ts 位置已决策(D7)、28种 handler 已分组枚举(AC-1) |

## 第 3 轮深度扫描

v2 的修复质量好——spec 的主体结构、约束、AC 可验证性、决策记录均达到高质量。本轮聚焦 v2 可能遗漏的深层问题。

### 发现问题

#### Issue #6: AC-5/AC-4 与 D5 的矛盾 — AC 未完全对齐 session-pool.ts 删除决策

**位置**: AC-5 第3条、AC-4 第2条

**描述**:

D5 明确决定"SessionPool 整体删除"，AC-1 第7条也声明"session-pool.ts 被删除"。但以下 AC 子项仍假设 session-pool.ts 留存：

| AC | 原文 | 隐含假设 |
|----|------|---------|
| AC-5 第3条 | `session-pool.ts` import `convertPiHistory` 而非内联实现 | session-pool.ts 仍存在，且需要导入 convertPiHistory |
| AC-4 第2条 | `SessionPool` 不再包含 `addClient`/`removeClient`/`send` 方法 | SessionPool 类/文件仍存在，只是删除这3个方法 |

**为什么是问题**:

这些 AC 在 D5（删除决策）之前编写，决策更新后未被同步。如果实现者严格按 AC 逐条验证：
- AC-5 第3条要求 `session-pool.ts` 导入 `convertPiHistory` → 但 D5 要求删除该文件 → 冲突
- 如果保留 session-pool.ts 只为满足 AC-5，则违背 D5 和 AC-1
- 如果按 D5 删除，AC-5 第3条和 AC-4 第2条在验证时状态不明

**修复方向**:

- **AC-5 第3条**: 改为"`convertPiHistory` 的调用方（`SessionService` 或其他消费者）从 `message-converter.ts` 导入而非内联实现"
- **AC-4 第2条**: 改为"`SessionPool` 文件不存在（确认已删除，含 `addClient`/`removeClient`/`send` 方法）"或直接删除此子项（AC-1 第7条已覆盖文件删除）

**优先级判定**: LOW。这不是逻辑缺陷——实现者会自然地按 D5 删除文件，AC 的验证记录在 plan 阶段可澄清。但不修复会导致验收阶段的 Reviewer 困惑。

---

#### Issue #7: FR-6 config-store 拆分缺少数据迁移路径

**位置**: FR-6

**描述**:

FR-6 声明 config-store.ts 拆分后：
- `config-store.ts` — 只管 `~/.xyz-agent/config.json`（providers, defaults, toolPermissions）
- `skill-store.ts` — 管 `<project>/.xyz-agent/skills.json`
- `agent-store.ts` — 管 `<project>/.xyz-agent/agents.json`

但**当前** config.json 是单一文件，同时包含 providers + skills + agents 数据。拆分后，如果 skill-store.ts 直接读 skills.json 而 agent-store.ts 读 agents.json，现有用户的 providers/skills/agents 数据（全部在 config.json 中）会在首次启动时消失。

**为什么是问题**:

- "功能不变"约束要求所有现有数据不丢失
- FR-6 被标注为"Low / Very Low — 函数搬家"，但实际不是纯搬家——存储路径变了
- 缺少一次性迁移逻辑（启动时检查 → 从 config.json 提取 → 写入新文件）或渐进兼容方案（读时 fallback）

**修复方向**:

在 FR-6 或 Constraints 中补充数据迁移策略，例如：
- **选项 A**: 在 skill-store.ts/agent-store.ts 的初始化中，如果目标文件不存在但 config.json 中存在对应 section，执行一次性提取并写入新文件。完成后 config-store 不再读取这些 section。
- **选项 B**: 在 spec 中标记为"假设用户数据可丢失（首次启动重建）"，但这会违反"功能不变"不变量，风险较高。

建议选项 A。plan.md 需要一个独立 task 处理迁移。

**优先级判定**: LOW。数据不会在代码被删除的瞬间丢失——只有新文件写入但旧文件未迁移时才会丢失。plan 阶段可以处理。但不规划会被忽略。

---

### 附加观察

#### Issue #8 (INFO): server.ts ≤ 250L 目标可能偏紧

**位置**: AC-1 第1条

当前 server.ts 574L（包含所有业务逻辑）。即使全部提取到 Service：
- WS 连接管理（handleConnection ~60L）
- 心跳（heartbeat ~30L）
- client set 管理（~30L）
- 消息分发 switch/case（28个 case ~120L）
- 统一广播 + MessageBroker 适配（~30L）
- import 语句 + 类型定义（~30L）

合计 ~300L，加上其他零散逻辑，达到 ≤250L 有难度。如果实现后行数略超（如 280L），这是重构成功的——核心目标是职责分离，不是行数竞赛。

**建议**: AC-1 可改为 ≤ 300L 或 "≤ 250L（允许 ±20% 浮动）"，避免实现者为卡行数而过度压缩代码（合并 switch case 分支、删除必要注释等）。

---

#### Issue #9 (INFO): FR-2 第4条在 D5 下已冗余

**位置**: FR-2 变更第4条

> "删除 `session-pool.ts` 内的重复 `PiHistoryMessage` 定义，引用 `types.ts`"

D5 决定 session-pool.ts 整体删除，所以"从 session-pool.ts 删除 PiHistoryMessage"是冗余指令——文件都没了，里面的类型定义自然也没了。无实际影响，但可以在第4条加注"（该文件按 D5 整体删除，本条自动满足）"避免困惑。

---

### v1→v2→v3 问题趋势

| 维度 | v1 | v2 | v3 | 趋势 |
|------|----|----|----|------|
| MUST_FIX | 3 | 0 | 0 | ✅ 全部解决 |
| 问题类型 | 决策缺失、枚举不足 | — | 逻辑一致性、迁移路径 | 从结构性问题到精细问题 |
| 修复难度 | 高 | — | 低（每条5-10分钟） | 递减趋势 |
| 范围 | spec 主干 | — | spec 边界 | 收敛 |

### 综合评估

**不变量检查**:
- "功能不变" — Issue #7（数据迁移）是唯一潜在违反项。如果在 plan 中处理迁移，则不变量保持。
- "WS 协议不变" — 不受影响。
- "无 IoC 容器" — 一致。
- "单进程" — 一致。

**AC 可验证性**:
- 除 Issue #6 的冲突外，全部 AC 机械可验证。
- Issue #6 在 plan 阶段澄清后可验证。

**整体质量**: 高。spec 满足所有必要元素 (Outcomes/Scope/Constraints/Decisions/AC)，前后轮次修复认真，v3 发现的问题均为边界精细问题。

## 结论

**通过。** 0 条 MUST_FIX open。2 条 LOW 可在 plan 阶段处理（或由 spec 所有者快速修复），2 条 INFO 记录备查。spec 可进入 plan 编写阶段。

### Summary

Spec 评审完成，第3轮通过，0条MUST FIX open（3条历史已修复），2条LOW（AC与D5不一致、数据迁移路径需规划），2条INFO，整体通过。
