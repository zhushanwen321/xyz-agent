# PanelView 派生收敛与 Flow 生命周期绑定 实施计划

基线: 本文件首次 commit（见 git log） | 来源设计: docs/design/panel-view-derivation-and-flow-lifecycle.md | 日期: 2026-08-29

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（G1 输入面稳定 / G2 流程状态不越权 / G3 决策可穷举 + in/out scope） |
| 终态/机制 | §3.1 终态（场景 A-D）+ §3.3 决策 D1-D7 |
| 验收场景表 | §4（V1 / V1' / V2 / V3 / V3' / V4 / V5） |
| 下一层拆分 | §5（T1-T5 单元表 + 文件改动地图） |
| 待验证检查点 | §5 末尾（① Landing 渲染条件语义差异实测 ② D4 卸载守卫 overlay 时序实测 + 「turn 活跃+无消息→conversation 空白」边界组合） |

审查证据: docs/design/panel-view-derivation-and-flow-lifecycle.review.md（R1 2 must-fix → R2 1 → R3 收敛 0 must-fix）

## 1 目标快照（逐字摘录）

- **G1 输入面稳定**：会话中任何时刻 composer 可见可用；turn 状态翻转（streaming→complete）、compacting 等运行态不改变输入面的存在性。
- **G2 流程状态不越权**：新建任务流程（landing 及其 overlay）只影响「无会话承接时」的渲染，永不影响已有会话的任何渲染决策。
- **G3 决策可穷举**：输入面选择逻辑收敛为单一纯函数，全输入组合有机器守卫（组合表测试），非法组合（如有消息且 landing）在输入设计上不可表达。

Out of scope：split 多 panel 重启；flow 状态机 10 态内部重构；ask-user 交互本身；MessageStream 内部。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| T1 | PanelView 类型 + derivePanelView 纯函数 + 全组合表测试（含回归用例「有消息+flowActive→conversation」与「dead 吞 ask-user」与「turn 活跃+无消息→conversation」） | `packages/core/src/domain/session/panel-view.ts`（新）`packages/core/src/domain/session/__tests__/panel-view.test.ts`（新） | 无（foundation） | plain | V5 |
| T2 | `transition('completed')` 上移到 pushChat 后（send 前）；flow.test.ts 增「send reject → state=completed」用例 | `packages/core/src/domain/new-task-search/flow.ts` `packages/core/src/domain/new-task-search/__tests__/flow.test.ts` | 无 | plain | 单测过 + 现有 flow 测试不破 |
| T3 | Panel.vue 模板 switch(panelView) 重写 + composer-band 判据收敛（删 isSessionActive/isCompacting 兜底；ask-user ⟺ conversation&&input；WidgetArea 映射）+ renderer 输入收集 composable | `packages/renderer/src/components/panel/Panel.vue` `packages/renderer/src/composables/features/panel/usePanelView.ts`（新）`packages/renderer/src/__tests__/panel/panel-view.test.ts`（新或并入现有 Panel 测试） | T1 | plain | V1/V2/V4 判据 + renderer 测试绿 |
| T4 | Landing onUnmounted 卸载守卫（isActive 才 cancel）+ useSidebar 删除路径 4 处空态出口统一 helper（排除 newSession L258） | `packages/renderer/src/components/new-task/Landing.vue` `packages/renderer/src/composables/features/sidebar/useSidebar.ts` | 无 | plain | V3/V3' + 相关测试绿 |
| T5 | constraints.json 登记新约束 + render-constraints 重新生成 + 全量验证 + review.md 补实施记录 | `docs/constraints.json` `docs/constraints.md`（生成） | T1-T4 | plain | 全量测试绿 + Gate A/B |

## 3 DAG 图

```mermaid
graph TD
    T1[T1 derivePanelView] --> T3[T3 Panel.vue 重写]
    T2[T2 flow 交接原子化] --> T5[T5 收尾]
    T3 --> T5
    T4[T4 Landing 守卫+空态 helper] --> T5
```

T1/T2/T4 首波并行（无相互依赖），T3 次波，T5 收尾。

## 4 测试策略

增量（单元开发期）：
- `cd packages/core && npx vitest run src/domain/session/__tests__/panel-view.test.ts`
- `cd packages/core && npx vitest run src/domain/new-task-search/__tests__/flow.test.ts`
- renderer Panel 相关：`cd packages/renderer && npx vitest run src/__tests__/panel/`（目录以实际存在为准，执行时核实）
- lint：`npx eslint <改动文件>` + `.githooks/vue_rules_checker.py`（.vue 改动）

全量（T5 收尾）：
- `cd packages/core && npx vitest run`
- `cd packages/renderer && npx vitest run`

## 5 合理偏差登记表

（初始为空）

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| T1 | committed | 1 | commit 见本行下次提交；panel-view.test.ts 5 passed（64 组合表 + 完整性守卫 + 3 回归断言）；session 域 55 passed 既有零破坏；tsc/eslint 零问题；deviations=[] |
| T2 | committed | 1 | commit 5e0db4001；flow.test.ts 14 passed（含 TC-6e send reject→completed）；2 deviations（transition 置于 pushChat 后 loadTree 前 / TC-6e 增强断言）待一致性审查裁决 |
| T3 | pending | 0 | — |
| T4 | pending | 0 | — |
| T5 | pending | 0 | — |

## 7 残留风险与变更历史

- 残留风险：§5 检查点①②需实施期实测（Landing 渲染条件语义差异 / overlay 卸载时序）；V1-V4 真实场景验收依赖 dev app 可运行（最后统一做）。
- 变更历史：2026-08-29 创建（设计三轮审查收敛后）。
