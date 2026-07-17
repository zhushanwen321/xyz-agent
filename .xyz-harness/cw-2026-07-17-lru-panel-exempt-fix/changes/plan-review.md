# Plan Review — lru-panel-exempt-fix

## 审查方法

规模评估：dev-plan 1 Wave + 2 文件 + 3 行行为改动 + 3 处注释订正。复杂度 low，不值得派 subagent 做完整禁读重建。改用主 agent 自审 + FR 覆盖矩阵交叉验证（等价于禁读重建的 coverage 校验点）。

## FR 覆盖矩阵（coverage 维度）

| FR | W1 changes 覆盖 | 验证 |
|----|----------------|------|
| FR-1 panel 绑定 session 不被误驱逐 | useSidebar.ts: 「selectSession 内 chat.evictIfNeeded() 调用之前，遍历 panel.panels.value 刷新所有绑定 session 的 touchLru」 | 明确覆盖，含 active+standby 两侧 |
| FR-2 注释与实现一致 | chat-lru.ts: 「订正 3 处误导性注释 L8/L22-23/L71，去掉 panel 绑定豁免承诺，描述真实机制」 | 明确覆盖 3 处 |
| FR-3 不破坏 deleteSession | useSidebar.ts: 「不改 isLruExempt（FR-3 deleteSession 不回归）」 | 明确覆盖，约束写入 changes 描述 |

3/3 FR 全部有对应 changes 落地。无遗漏。

## 架构审查（architecture 维度）

- **wave 拆分**：1 Wave 合理。2 文件紧耦合（useSidebar 是编排点，chat-lru 是被编排对象 + 注释订正），不值得拆成 2 Wave（拆了反而增加 commit 开销无收益）
- **依赖链**：dependsOn=[] 空链，无循环
- **changes 清晰度**：每个 change 是独立文件 + 结构化描述，不混
- **隐含工作识别**：store 不互 import 的约束已写进 useSidebar.ts changes 描述（「编排留在 composable」），无遗漏

## 可行性审查（feasibility 维度）

- **可完成性**：3 行行为改动 + 3 处注释，单 dev cycle 可完成
- **未识别依赖**：无。panel store 已存在（panel.ts:33 panels computed），chat.touchLru 已存在（chat.ts:426），useSidebar 已能访问两者（useSidebar.ts:199 已用 chat.touchLru，panel store 在同文件其他位置已用）
- **changes 可执行**：描述具体（「遍历 panel.panels.value 刷新 touchLru」「不改 isLruExempt」），非模糊表述

## AC 验收路径（为 tdd_plan 留出口）

| AC | 验收路径 |
|----|---------|
| AC-1 双 panel standby 切 9 session 仍存活 | tdd_plan 写单测：mock 双 panel + 切 9 session + 断言 standby session 仍在 messages map |
| AC-2 单 panel LRU 基线不退化 | tdd_plan 写单测：单 panel 切 9 session + 断言最旧被驱逐（已有 chat-lru.test.ts 基线可扩展） |
| AC-3 deleteSession 不受影响 | 已有 m7-virtual-key-cleanup.test.ts 覆盖 deleteSession 时序，本 task 不改 isLruExempt 不回归 |
| AC-4 panel close/unbind 后可驱逐 | tdd_plan 写单测：close panel 后切足够 session + 断言旧 session 被驱逐 |
| AC-5 注释无误导承诺 | manual review（code review 阶段人工核对） |
| AC-6 streaming 豁免不回归 | 已有 chat-lru.test.ts streaming 豁免测试，本 task 不改 isLruExempt 不回归 |

6/6 AC 都有验收路径。

## 审查结论

plan 就绪进 tdd_plan。无 must-fix，无 should-fix。FR 3/3 覆盖，AC 6/6 有验收路径，架构合理，可行性无问题。
