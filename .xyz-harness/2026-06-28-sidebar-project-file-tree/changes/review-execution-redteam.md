---
verdict: CHANGES_REQUESTED
machine_check: PASS
reviewed_by: redteam-group
review_dimension: 反过度编排（necessity + proportionality）
reviewed_object: execution-plan.md
---

# 红队评审 — 反过度编排（1 维）

> 立场默认「质疑必要性」。机器检查 PASS（7/8，唯一 FAIL 是本审查文件自身不存在；consistency-final 已 `--no-consistency-final` 跳过）。本评审只看一维：**有没有可以合并/删除的 Wave，编排复杂度是否与系统复杂度匹配**。

## 0. 机器检查

- `check_execution.py --no-consistency-final` → 7/8 PASS。
- 唯一 ❌ `review-execution 存在` = 本文件（本次产出）；`consistency-final` 按指示跳过。
- **machine_check = PASS**。

系统画像（用于校准比例性）：「文件树 + git 标注 + 预览」，⑤§2 已裁决**核心计算是技术编排、领域贫乏、不引入 domain 层**。编排对象是 ~20 个文件横跨 4 层（shared/runtime/renderer/e2e）。这个规模下，10 个 Wave 是否匹配，逐项审。

---

## 1. 逐条必要性立场（4 个具体质疑）

### 质疑 1：W0（Playwright harness）独立 vs 并入 W9？

**立场：保持独立（APPROVED），但 e2e spec 作者归属有 GAP 需澄清（非阻断）。**

- **支持独立的硬理由 = 并行性**。W0 `Blocked by: 无`，触及 `main.ts` + `package.json` + `e2e/`，与 W1（`runtime/src/`、`shared/src/`）文件完全不相交。这意味着 W0 可与 W1/W2 **真正并行**，而非并入 W9 后被迫等到所有功能 Wave 完成才动手——白白损失一个可早期启动、早期用 E2E-1 冒烟验证 harness 是否真能跑通的真实并行窗口。
- **并入 W9 的代价 > 收益**：并入会让「e2e harness 构建」这个有实质工作量的前置任务排到 DAG 末尾，且让 W9 从「纯验收」膨胀为「建 harness + 写 spec + 跑测试」的混合 Wave，破坏 W9 作为独立 gate 的语义。
- ⚠️ **但发现一个规划空洞（与该拆分相关）**：`e2e/file-tree.spec.ts` 由 W0 建为**占位**（plan 行 100：「W9 填实现」），而 W9 的职责（行 419）是「读清单→跑三层测试→映射覆盖→**任一用例无对应测试即未完成**」——即 W9 **只跑不写**。E2E-1~E2E 四条（行 489-493）与 T1.8（行 454）都挂在 W9，但**没有任何一个功能 Wave 被指派去写这些 e2e spec 的实现**。这是 **e2e spec 作者的 orphan**。
  - 这不是过度编排，是**编排空洞**，但正因为它质疑 W0/W9 拆分时暴露，必须登记。
  - **修复（二选一，非阻断 verdict 但建议在编码前定）**：(a) W0 在建 harness 时同步写一条真实 E2E-1 冒烟（切 tab→顶层节点 DOM 可见）证明 harness 端到端可用，E2E-2/3/4 由各自功能 Wave 落地或显式归 W9 并把 W9 改名为「e2e 实现 + 验收」；(b) 显式声明 W9 同时负责「补齐缺失 e2e spec」，并从职责描述里去掉「无对应测试 = 未完成」的纯验收措辞。

### 质疑 2：W8（file.write 骨架）独立 vs 并入 W1？

**立场：建议并入 W1（CHANGES_REQUESTED 主项）。这是本次最明确的可合并 Wave。**

- **文件重叠 = 完全重叠**。W8 修改的 3 个文件——`protocol.ts`、`file-service.ts`、`file-message-handler.ts`——**全部**是 W1 创建（后两者）或已在修改（前者，W1 已在其内定义 file.tree/expand + git.diff 类型）的文件。W8 **不触及任何 W1 不触及的文件**。这是「在 W1 刚创建的文件上做第二轮小改」的典型人工切片。
- **拆分制造了它自己要修的「疑点」**。W8 的 AC-14.4「handler 必须 try-catch 转 FileWriteResult 非 500」被标注为「演进帧疑点修复」。但若 W1 一次性写 `file-message-handler.ts` 时对所有 `file.*` 消息采用**统一的错误信封模式**（W1 本就该为自己的 file.tree/expand handler 这么做），file.write.* handler 沿用同模式即天然闭环——**这个「疑点」只有在 W8 被拆出去、由 fresh subagent 二次打开 handler 时才会出现**。拆分 → 制造不一致风险 → 再设一个 Wave 去「修」它，是过度编排的闭环症状。
- **协调税确定发生**：W8 subagent（fresh context）需重新加载 W1 刚写的 3 个文件，仅为加 3 个 `throw NotImplemented` 桩 + 几条路由。fresh-context 重载成本与产出（3 桩）不成比例。
- **反方论点（保留 W8 的合理依据，诚实列出）**：
  - **P 级隔离**：W1 是 P0 唯一阻塞项，W8 是 P1 延后骨架。并入会让 P0 的完成被 P1 桩的任何摩擦（如 `not_implemented` 错误码归属讨论）牵制。
  - **D-018 显式性**：裁决要求「协议骨架不延后、实现延后」，独立 Wave 让「骨架」边界更显眼。
  - **但权衡**：桩是平凡的（throw NotImplemented），P1 桩阻塞 P0 的概率低；而「独立 Wave 的协调税 + 制造疑点」是确定的。低概率阻塞 vs 确定成本 → 倾向合并。
- **具体动作（must-address）**：把 W8 的 `protocol.ts` file.write.* 类型 + `file-service.ts` 三个桩方法并入 W1（W1 本就拥有这些文件的创建权）；W1 在写 `file-message-handler.ts` 时即对全部 file.* 路由采用统一 try-catch→结构化结果模式，AC-14.4 闭环在 W1 内达成。若团队判定 P0 隔离优先级更高而坚持保留 W8，**需在 plan 内显式记录该权衡**（当前 plan 未说明为何不为合并），否则按默认应合并。

### 质疑 3：W7（showIgnored）独立 vs 并入 W4（FileView 重写）？

**立场：保持独立（APPROVED），但它是全 DAG 最小、入边比例最失衡的 Wave，列为「若要进一步压缩则首选合并项」（非阻断）。**

- **垂直切片一致性支持独立**：plan 明示原则为「每 Wave = 一个垂直切片（切穿各层可独立验证）」（行 10、16）。showIgnored（#16, D-020）作为独立功能，其垂直切片横跨 store + composable + view 三层——**这正是 plan 自身定义的 Wave 粒度**。把它的 view 部分塞进 W4 会把功能 #16 拆散到两个 Wave（W4 做 view、W7 做 store+composable），反而破坏 AC-16.1~16.5 的单 Wave 可追溯性，是**更糟**的编排。
- **代价 = FileView.vue 二次打开**：W4 重写 FileView.vue，W7 又改它加开关 UI + 灰斜体。这是真实的二次触碰成本。
- **比例性质疑**：showIgnored 实质 ≈ 一个 boolean state + 一个 toggle + 一个 CSS（muted+italic）。为一个这么小的功能开一个 Wave、且带 3 条入边（W3→W7、W4→W7、W6→W7），**入边复杂度相对功能体量偏高**。
- **结论**：独立有原则支撑、可接受；但若团队目标是「压缩 Wave 数」，W7 因「最小 + 二次触碰 FileView.vue」是比 W8 次优、但仍成立的合并候选（并入 W4，让 W4 一并承担 store+composable 的 showIgnored 部分，W4 已 blocked_by W3，不新增阻塞边）。

### 质疑 4：10 Wave 是否可压缩到 6-7 个？

**立场：6 太激进（会造 mega-Wave、丢专注）；7 可达成；当前 10 偏保守但不离谱。**

可达成的压缩路径（按确定性排序）：

| 合并 | 文件重叠 | 收益 | 判定 |
|------|---------|------|------|
| W8→W1 | **完全重叠**（3/3 文件） | 消二次触碰 + 消 W2→W8 串行边 + 消「演进帧疑点」 | **建议采纳（阻断项）** |
| W7→W4 | 部分（FileView.vue） | 消 W7 三入边；代价=功能 #16 跨 Wave | 可选（非阻断） |
| W0→W9 | 无重叠 | 损失 W0 早期并行窗口 | **不建议**（并行性损失>收益） |

- **激进压到 6 需要额外合并 W2→W1（不可行：protocol.ts 冲突 + 不同 feature #5 vs #1/#2）或 W6→W3（不可行：W6 含 runtime 侧 G1/G5 修复，跨层且文件不同）**。强行合会造出多 feature 的 mega-Wave，违背 subagent 专注原则，得不偿失。
- **温和压到 9**：仅合 W8→W1，零争议收益。
- **压到 7**：合 W8→W1 + W7→W4，可达但 W7 合并为可选。
- **当前 10 的定性**：保守、显式、每个 Wave 都有干净 feature/issue + AC + test 映射，**无任何一个 Wave 是冗余（做无用功）**。过度编排的风险集中在「最小 Wave（W7/W8）的协调开销可能超过其内容」与「并行组标签（见下）」，而非整体臃肿。

---

## 2. 比例性（Proportionality）

### 三层并行组 A/B/C：并行性真实存在，但 A/B/C「标签」是名义的、可简化（非阻断）

- **并行性非虚**：核验后存在真实 3-way 并行窗口——W1/W2/W3 落地后，**W5 ‖ W6 ‖ W8** 文件完全不相交（W5=DetailPane/SideDrawer/useDetailPane；W6=useFileTree.ts+runtime index/event-adapter/message-converter；W8=protocol.ts+file-service.ts+file-message-handler.ts），正好用满 ≤3 subagent 上限。组 A/B/C 不是凭空编排。
- **但 A/B/C 标签与真实并行集错位**：真实并行三元组 W5(B)‖W6(C)‖W8(C) **跨越 B、C 两组**。且组 A 内 W1→W2 因 protocol.ts 冲突实际串行、组 C 内 W6→W7 因 useFileTree.ts 实际串行——**组内多数「并行」被串行约束抵消**。
- **真相源是 DAG（blocked_by 边）而非组标签**。组标签是额外一层标注，给读者带来「组内可并行」的错觉，而实际并行由文件冲突边决定。
- **建议（非阻断）**：保留 DAG 为唯一真相源；A/B/C 改为「advisory 备注」或直接删除，避免名义分组与实际并行集混淆。这是文档开销而非执行开销，低害。

### Subagent 配置粒度（注入上下文/读取文件/修改文件）：比例恰当，非过度

- 每个 Wave 的 subagent 配置表（含 `读取文件: 具体文件:行号`）看似过细，但**执行模型是 fresh-context subagent（方式 B 手动执行，零记忆）**。对零记忆 subagent，精确的上下文注入与文件定位是**必需**而非冗余——粒度与执行模型匹配。
- 不构成过度编排，**本项无异议**。

---

## 3. 必须处理（阻断，对应 verdict）

1. **【W8 并入 W1】** 评估并执行合并（或显式记录保留 W8 的权衡理由）。依据：完全文件重叠 + 拆分制造「演进帧疑点」+ 确定的 fresh-context 协调税。这是 verdict=CHANGES_REQUESTED 的主因。

## 4. 可优化但非阻断（即使按 1 处理后也建议顺手做）

- **【e2e spec 作者归属 GAP】** 澄清 E2E-1~4 由谁写（W0 写 E2E-1 冒烟 / 各功能 Wave 落 / 显式归 W9 并改 W9 语义）。属编排空洞，与 W0/W9 拆分强相关。
- **【W7 并入 W4】可选**：若追求更少 Wave，W7 是次优合并候选（最小 + 二次触碰 FileView.vue）；不合并亦可（垂直切片一致性支持独立）。
- **【并行组标签 A/B/C 简化】**：DAG 为真相源，组标签降级为 advisory 或删除，避免名义分组误导。
- **【「待确认」节】**：plan 末尾「待确认（Step 1 必问决策点）」遗留 W0 范围与并行组划分两题，建议在编码启动前定锚，避免执行期返工。

## 5. 一句话结论

编排整体精简、无冗余 Wave，每个切片都有干净 feature/AC/test 映射；**但 W8 与 W1 完全文件重叠、且其拆分制造了自身要修的「疑点」，是明确的可合并 Wave**——按红队规则判 **CHANGES_REQUESTED**，主项为 W8→W1 合并，其余为非阻断优化。
