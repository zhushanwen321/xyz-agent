# Plan Review — virtual-scroll

> 审查方法：spec 阶段已对 FR/AC/决策做深度禁读重建审查（17 issue 闭环）。plan 是 FR→Wave 映射，重建价值低。本阶段自审 coverage + architecture + feasibility。

## 审查范围

- spec FR 清单：FR-V2-1..9（9 项，覆盖 computeWindow/heights/估算/窗口结构/RO/钉扎/sticky-bottom/节流session/折叠态）
- plan waves：W1（useVirtualTurnList composable 核心）/ W2（useResizeReport composable）/ W3（MessageStream 窗口化）/ W4（Turn.vue inject + useChatScroll 集成）
- AC 清单：AC-1..9

## FR → Wave 覆盖核对

| FR | Wave | changes 覆盖 |
|----|------|-------------|
| FR-V2-1（computeWindow 纯派生） | W1 | ✅ 二分查找 + INVAR-1a/1b |
| FR-V2-2（heights/offsets/首消息 id 键） | W1 | ✅ SR1/D7 首消息 id + INVAR-3 |
| FR-V2-3（估算+视口锚定+批量测量取舍） | W1 | ✅ INVAR-2 + SR14 |
| FR-V2-4（窗口化结构+spacer+空态） | W1（INVAR-9 空态）+ W3（template） | ✅ |
| FR-V2-5（useResizeReport+RO 通信+disconnect+防抖） | W2（composable）+ W4（Turn inject） | ✅ SR7/9/15 |
| FR-V2-6（末项钉扎+editing 钉扎） | W1（算法 endIndex）+ W3（template 消费） | ✅ SR3/5 |
| FR-V2-7（sticky-bottom INVAR-7 触发源隔离） | W4（useChatScroll） | ✅ SR2 |
| FR-V2-8（scroll rAF 节流+session 重置） | W1（节流算法）+ W4（useChatScroll session） | ✅ SR10/11 |
| FR-V2-9（折叠态+回归） | W4（不改=零代价） | ✅ 决策 4 |

**CW 的 mustFix warning（FR-1..6+X+V2-9 未覆盖）是编号匹配问题**：CW 用旧编号前缀匹配，FR-V2 命名不匹配旧 FR-1..6。实际 9 项 FR-V2 全覆盖，无缩范围。

## 架构审查

- **Wave 拆分**：W1（纯逻辑）→ W2（RO composable）→ W3（template 集成）→ W4（sticky-bottom/session 集成）。垂直切片，每个 Wave 产出一个可独立验证的增量。W1/W2 可独立单测（纯逻辑），W3/W4 是集成层。
- **依赖链**：W2→W1，W3→W1+W2，W4→W1+W2+W3。无环。
- **文件粒度**：每 Wave 1-2 文件（W1 一个 composable，W2 一个 composable，W3 一个 vue，W4 一个 vue + 一个 ts）。清晰不混。
- **无巨型 Wave**：W1 内容最多（6 个 FR-V2 的算法部分），但都在一个 composable 文件内（高内聚），合理。

## 发现的问题

无 must-fix / should-fix。

### nit（只记录不进 issues）

- W4 把 Turn.vue（inject+RO）和 useChatScroll（sticky-bottom 集成）放一起，两者逻辑不同但都是"集成层"依赖 W1-W3 基建，放同一 Wave 合理（避免 W5 过碎）。
- plan 的 FR 引用用 FR-V2-x 编号，与 CW 的 FR 覆盖率检查（用旧编号）不匹配，产生 warning。不影响实际覆盖。

## 审查结论

plan **就绪进 tdd_plan**。FR-V2 全 9 项覆盖，依赖链无环，文件粒度清晰，无未识别依赖。AC 验收路径在 plan 留了出口（W1 纯逻辑单测验 AC-2/3/4/9，W3 集成测验 AC-1，W4 集成测验 AC-5/6，AC-7/8 manual）。
