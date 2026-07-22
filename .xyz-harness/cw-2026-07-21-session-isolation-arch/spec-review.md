# spec_review · session-isolation-arch

## 审查方法

第一轮：派 reviewer subagent 做「禁读重建」（不读 specSections，只读 objective + clarifyRecords + ADR-0036 + 源码），重建 spec 应覆盖的 FR/AC，与初稿 diff。报告 5 must-fix + 4 should-fix。

主 agent 逐条评估，确认 5 个 must-fix 全为真问题，回 clarify 修订（CL4/CL5）+ 更新 ADR-0036。

第二轮（本报告）：验证修订是否到位 + 是否引入新问题。直接自审（上一轮深度禁读重建已完成，边际收益低）。

## 第一轮 must-fix 修订验证

| # | 问题 | 修订位置 | 状态 |
|---|------|---------|------|
| #1 | useSessionEvents 是否迁移未决 | CL4 background「不迁移项」+ D3 决策 + ADR-0036 Decision 第 3 步 | ✓ 已决：不迁移 |
| #2 | cleanup 调用点未约束 | 新增 FR-4 + AC-8 + ADR-0036 Decision 第 4 步 | ✓ 已加 |
| #3 | ESLint 规则检测精度 | D4 决策 + ADR-0036 防护层表删除 ESLint 行 | ✓ 已决：放弃 |
| #4 | 现状 vs 目标未厘清 | CL4 background「现状厘清」段 + 术语澄清 | ✓ 已厘清 |
| #5 | useComposerHistory 特殊性 | FR-3 细化 + D5 决策 + AC-5 | ✓ 已识别 |

## 第一轮 should-fix 处理

| # | 问题 | 处理 |
|---|------|------|
| #6 | null sessionId 边界 | FR-2 已约束：「null sid 时 current 返回 init() 默认实例但不写入 Map」 |
| #7 | SideDrawer 回归风险无 AC | AC-4 已加：「切 sid 时缓冲清空时序与 useSessionEvents 退订时序一致」 |
| #8 | Map 分区 vs 实例级隔离术语混用 | CL4 background 术语澄清段 + ADR-0036 术语澄清段，3 个概念区分 |
| #9 | complexity=high 必要性论证 | 未显式论证，但 CL2 评估已写 rationale（范围广+风险高）。spec_review 不阻断，留 plan 阶段评估 |

## 第二轮新发现问题

无 must-fix。无 should-fix。

## 残留风险（不阻断，留 plan 阶段处理）

1. **progressive append 导致 FR/AC 重复**：CL2 的旧 FR/AC 与 CL4/CL5 的新 FR/AC 并存（2 份 background + 2 份 FR + 2 份 AC）。gen-spec 渲染时可能重复显示。plan 阶段以 CL4/CL5 最新版为准。nit 级别。

2. **complexity 评级**：CL2 标 high。删 ESLint 规则后实际工作量降低（抽工厂 + 改 useExtensionUI + 迁 2 个 composable + cleanup 接入 + 文档）。但 SideDrawer 迁移的多状态字段 + 缓冲清空时序竞态仍是高风险点。high 合理。

3. **session 销毁时机**（Open Question #3 残留）：FR-4 约束 plan 阶段产出调用点 deliverable。plan 必须先调研 session 生命周期（session close / panel unmount / session-tree 删除节点），定义唯一调用点。

## 审查结论

spec 修订到位，5 个 must-fix 全部解决，无新问题。进 plan 阶段。
