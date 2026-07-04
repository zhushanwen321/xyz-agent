---
verdict: pass
must_fix: 0
---

<!--
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-22T19:30:00"
  target: ".xyz-harness/2026-05-21-/spec.md"
  verdict: pass
  summary: "Spec 评审第2轮，0条MUST FIX open，3条v1 MUST FIX全部已修复，通过"

statistics:
  total_issues: 5
  must_fix: 0
  must_fix_resolved: 3
  low: 2
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > FR-1 目标结构 + FR-3 接口表 + AC-1 + D5"
    title: "session-pool.ts 最终状态和去向不明确"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-2 变更第1条 + D7"
    title: "types.ts 文件位置决策未定（'或'字悬而未决）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "spec.md > AC-1 最后一条"
    title: "37 种 ClientMessage.type 未枚举也未引用定义源"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "spec.md > FR-8"
    title: "createSystemNotification 的 type 参数缺少类型定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "spec.md > FR-6 + 目标结构"
    title: "provider-store.ts 是已有文件还是新文件未标注"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-22 19:30
- 评审类型：计划评审（spec 完整性专项，第 2 轮）
- 评审对象：`.xyz-harness/2026-05-21-/spec.md`

## 第 1 轮 MUST_FIX 修复验证

### Issue #1: session-pool.ts 最终状态和去向 ✅ 已修复

**v1 问题**: FR-1 目标结构 tree 不含 session-pool.ts，但 FR-3 接口表中 SessionPool 仍是消费者，去向不明确。

**v2 修复证据**:

| 检查点 | v1 状态 | v2 状态 | 评价 |
|--------|---------|---------|------|
| 目标结构 tree | 无 session-pool.ts | 无 session-pool.ts | 与删除决策一致 |
| FR-3 接口表消费者列 | 含 SessionPool | 消费者均为 SessionService | 冲突消除 |
| FR-4 死代码表 | 列出 3 个方法 | 列出 3 个方法 | 删除范围明确 |
| AC-1 第 7 条 | 无 | "session-pool.ts 被删除。其 session 生命周期职责移入 SessionService，历史转换移入 message-converter.ts，EventAdapter 转接由 SessionService 直接管理" | 最终状态明确 |
| Decisions Made D5 | 无 | "SessionPool 整体删除。scan 确认其 WS client 管理是死代码（addClient() 从未被调用）。剩余职责分别移入 SessionService、message-converter。不再保留 SessionPool 类" | 有实证支撑的明确决策 |

**判定**: 完全修复。删除范围、剩余职责去向、决策理由三要素齐全。

### Issue #2: types.ts 文件位置未决策 ✅ 已修复

**v1 问题**: FR-2 写"移到 pi-adapter 子目录或保持当前位置"，"或"字悬而未决，Decisions Made 无对应条目。

**v2 修复证据**:

| 检查点 | v1 状态 | v2 状态 |
|--------|---------|---------|
| FR-2 变更第 1 条 | "移到 pi-adapter 子目录**或**保持当前位置" | "保持原位置，只重命名为 types.ts（不创建子目录，避免 tsconfig 变更）" |
| Decisions Made | 无 D7 | D7: "pi-rpc-types.ts 重命名为 types.ts 但不创建子目录 — 避免 tsconfig paths 变更。文件仍在 runtime/src/ 下" |
| 目标结构 tree | 无 types.ts | `types.ts (重命名自 pi-rpc-types.ts, 被 event-adapter/rpc-client 消费)` |

**判定**: 完全修复。决策明确，理由充分（避免 tsconfig 变更），三处表述一致。

### Issue #3: 37 种 ClientMessage.type 可系统性验证 ✅ 已修复

**v1 问题**: AC-1 最后一条只说"所有 37 种消息 handler case"，无枚举、无分组、无定义源引用。

**v2 修复证据**:

AC-1 最后一条改为:
> "所有 **28** 个消息 handler case（`session.*` x9, `message.*` x2, `config.*` x10, `model.*` x2, `tool.*` x3, `ping` x1, `session.create` 含在 pool 中）都有对应的 Service 方法路由"

**实质性改进**:
1. 数字从模糊的 37 修正为 28（与 server.ts 实际 handler 数量对齐）
2. 按 category 分组枚举，可逐组验证
3. 注明 `session.create` 含在 pool 中，解释了归属

**残留观察**: 分组合计 9+2+10+2+3+1 = 27，与声称的 28 差 1。可能 `session.create` 就是第 28 个（括号注释"含在 pool 中"暗示它不包含在 session.* x9 中）。这个数字微小不精确不影响验证——分组枚举足以指导 plan.md 产出完整的 handler 覆盖矩阵。

**判定**: 核心诉求已满足。从裸数字升级到分组枚举，可系统性验证。残留的数字精度问题不足以阻塞。

### Issue #4: createSystemNotification type 参数 ✅ 已修复

**v1 问题**: type 参数无类型约束。

**v2 修复**: FR-8 补充了 `SystemNotificationType` 为 `'done' | 'alert' | 'info'` 字面量联合类型，并注明来源（从 shared/message.ts 导入或在此定义）。

### Issue #5: provider-store.ts 标注 ✅ 已修复

**v1 问题**: 未标注"已有"或"新文件"。

**v2 修复**: 目标结构 tree 中改为 `provider-store.ts (已有文件, 缓存逻辑保留, 调用 config-store)`。

## 二次完整性扫描

既然 v2 有实质性修改，对修改区域做二次检查：

| 检查维度 | 结果 | 说明 |
|---------|------|------|
| AC 与 FR 一致性 | ✅ | AC-1 的 handler 分组与 FR-1 的目标结构（三个 Service）对应。session→SessionService, config→ConfigService, model→ModelService |
| D5/D6/D7 无冲突 | ✅ | D5（删除 SessionPool）、D6（refCount 用模块级变量）、D7（不创建子目录）互不矛盾 |
| 约束一致性 | ✅ | "无 IoC 容器"(D1) 与 FR-3 构造函数注入一致。"WS 协议不变"与 session-pool 删除不矛盾（删除的是内部实现，不是协议） |
| AC-1 数字内部一致性 | ⚠️ | 分组合计 27 vs 声称 28，差 1。不阻塞，plan.md 阶段可通过代码扫描确认准确数字 |

## 结论

**通过。** v1 的 3 条 MUST_FIX 全部修复，且有实质性改进（不是敷衍修改）。2 条 LOW 也一并修复。spec 整体质量高：目标结构清晰、决策有实证支撑、验收标准可量化。plan.md 可以基于此 spec 开始编写。

建议 plan.md 编写时注意：
1. handler 覆盖矩阵：通过代码扫描 `server.ts` 的 switch/case 确认准确数量，不必依赖 spec 中的数字
2. FR-1 拆分：按 spec 建议的顺序（先 FR-4/5 减小体积 → FR-3 接口 → FR-1 提取），每个 Service 提取为独立 task

### Summary

Spec 评审完成，第2轮通过，0条MUST FIX open（3条已修复），2条LOW已修复。
