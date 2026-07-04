---
phase: spec
verdict: pass
---

# Spec Phase Retrospective

## 1. Phase Execution Review

### Summary

完成了 xyz-agent Runtime + Front-end 架构重构的 spec 编写。交付物包括：

- **infrastructure-scan.md** — 对 Runtime（15 文件 3,518 行）和 Renderer（~100 文件 12,129 行）的全面架构扫描，识别出 god class、死代码、类型安全缺失、refCount bug 等问题
- **spec.md** — 9 个功能需求（FR-1~9），覆盖 Service 层提取、类型绑定、DI 接口、死代码清理、config-store 拆分、scanner 去重、消息工厂、refCount 修复。7 条决策记录（D1~D7），10 组验收标准

Spec 经历了 3 轮评审（v1 fail → v2 pass → v3 确认 pass）。v1 发现 3 条 MUST FIX（session-pool 去向未定义、types.ts 位置未决策、handler 枚举缺失），v2 全部修复，v3 做深度扫描后确认通过，仅余 2 条 LOW（AC 与 D5 的文字残留不一致、数据迁移路径未规划）和 2 条 INFO。

### Problems Encountered

1. **session-pool.ts 的最终状态是最大的决策盲区**。初始 spec 写了"提取 Service"但没明确 session-pool 本身是保留还是删除。v1 评审准确指出：目标结构 tree 中没有 session-pool.ts，但 FR-3 接口表仍引用它。根源是先写了提取计划（FR-1/3），后做了代码扫描（D5 的实证：`addClient()` 从未被调用），但扫描结论没有反馈到 spec 全文的每一个相关位置。
2. **handler 数量从不精确到精确**。最初写 "37 种消息类型" 是粗略估计，评审要求枚举后修正为 28 个 handler case 并按 category 分组。分组合计 27 vs 声称 28 的微小差异说明写 spec 时没有逐行计数，而是凭记忆。
3. **v3 发现 AC 与 D5 的残留不一致**（AC-5 仍写"session-pool.ts import convertPiHistory"，但 D5 已决定删除该文件）。这是修改决策后未全文扫描所有相关 AC 子项的典型失误。

### What Would You Do Differently

1. **决策先行，FR/AC 后写**。这次是边扫描边写 spec，导致决策分散在 FR 描述和 Decisions Made 两个地方，修改时容易漏一处。下次先确定所有关键决策（哪些文件删、哪些文件新建、接口怎么切），再基于决策写 FR 和 AC。
2. **AC 全文搜索验证**。每次修改决策后，全文搜索被删除/重命名的文件名，确保每条 AC 与最新决策一致。这 5 分钟的检查可以省掉一轮评审。
3. **handler 枚举应该从代码直接生成**。不应手写计数，而应在 spec 中引用定义源（`shared/src/protocol.ts` 的 `ClientMessageType` 联合类型），让 plan 阶段做精确映射。

### Key Risks for Later Phases

1. **FR-1 Service Layer 提取是 1174L 的代码重组**，是整个 spec 中复杂度最高、风险最大的变更。Plan 阶段必须拆分为多个独立 task（按 Service 拆分），每个 task 有独立的编译验证点。
2. **config-store 拆分涉及数据迁移**（v3 Issue #7）。当前数据全在 config.json 中，拆分后 skills/agents 各有独立文件。Plan 阶段需要设计一次性迁移逻辑，否则用户数据会"消失"。
3. **server.ts ≤ 250L 的行数约束可能过紧**。v3 估算纯分发逻辑约 300L。如果实现者为了卡行数而过度压缩代码，反而降低可读性。

---

## 2. Harness Usability Review

### Flow Friction

整体流畅。Infrastructure scan → spec 编写 → 评审 → 修复 → 再评审的流程自然。三轮评审的节奏合理（v1 发现结构性问题 → v2 修复验证 → v3 深度扫描）。

唯一摩擦点：**评审轮次较多**。3 轮评审中 v2 和 v3 的间隔很近（19:30 → 20:00），v3 发现的问题（AC 残留不一致、数据迁移）在 v2 阶段理论上可以发现。如果评审者在 v2 时做一次"决策变更影响分析"（D5 删除 session-pool → 搜索 spec 中所有 "session-pool" 出现 → 逐条检查），可以合并为 2 轮。

### Gate Quality

Gate check 有效。v1 的 3 条 MUST FIX 都是真正的阻塞项：
- session-pool 去向不明确 → 实现者无法确定是删是留 → 阻塞
- types.ts 位置未决策 → 文件路径不确定 → 阻塞 plan 编写
- handler 枚举缺失 → 1174L 重组无法系统性验证 → 阻塞

没有出现 false positive。v3 发现的 2 条 LOW 也是有价值的问题（AC 一致性和数据迁移），不是鸡蛋里挑骨头。

### Prompt Clarity

Spec 阶段的 prompt 描述充分，没有歧义导致返工的情况。Infrastructure scan 的覆盖范围（Runtime + Renderer + Shared）在 spec 中有明确的文件清单和行数统计，为 spec 编写提供了扎实的基础。

### Automation Gaps

1. **Handler 枚举可以自动化**。从 `server.ts` 的 switch/case 或 `ClientMessageType` 联合类型自动提取 handler 清单，不必手写。可以在 plan 阶段用脚本生成"handler 覆盖矩阵"。
2. **决策变更影响分析可以自动化**。每次新增/修改 Decision 后，全文搜索相关文件名/模块名，列出所有出现位置供人工确认。目前靠人工扫描，容易遗漏（v3 的 AC 残留不一致就是例证）。

### Time Sinks

1. **Spec 评审 3 轮**是最大的时间消耗。v1→v2 的修复实际只改了 3 处（加 D5/D7、修正 handler 枚举、补充 type 参数），但每轮评审需要完整重读 spec + 重新评估所有 AC。如果评审者在 v1 阶段就做了更彻底的"决策影响分析"，可能 2 轮就够了。
2. **Infrastructure scan 的信息密度很高**，但部分扫描结果在 spec 中被简化引用而非全文引用（如"37 种消息类型"的来源）。在评审时需要回溯 scan 原文确认数字，增加了评审者的上下文切换成本。
