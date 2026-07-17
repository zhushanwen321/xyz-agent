# Spec Review — default-prompt-reference

日期：2026-07-17 · 审查方法：三维度自审（任务极简，跳过禁读重建）

## 审查范围

- Objective: Settings 替换卡下方加可折叠参考区，展示 pi 默认系统提示词
- CL1: 展示形态 = 可折叠只读参考区
- CL2: 来源 = pi 源码提取，shared 包常量
- CL3: 文案要点 = 三点说明

## 三维度结论

### completeness（完整性）
- objective 诉求「看到默认提示词」→ CL1 落地（参考区）✓
- 「从哪来」→ CL2 落地（shared 常量）✓
- 「需要说明什么」→ CL3 落地（三点文案）✓
- 隐含需求：参考区默认折叠还是展开？→ 需在 plan 明确（建议默认折叠，不干扰常用流程）
- 隐含需求：参考区文本可否复制？→ 应可复制（用户明确要「直接复制出来」），plan 需确保 pre 不禁选中

### consistency（一致性）
- CL1 说「不动替换 textarea」与 CL2「纯前端常量不走 RPC」一致 ✓
- CL3 说「动态段不受影响」与 CL2「不含动态段」一致 ✓

### reasonableness（合理性）
- 每个 FR 可实现、可验收 ✓
- 边界：pi 升级后默认提示词变化 → CL2 的 VERSION 标注覆盖（diff 检查）✓
- 无过度设计（纯只读展示，无编辑/同步逻辑）✓

## 问题清单

| id | severity | dimension | 描述 |
|---|---|---|---|
| SR1 | nit | completeness | 需在 plan 明确参考区默认折叠 + 文本可复制选中 |

## 结论

spec 完整、一致、合理。1 条 nit（plan 阶段明确即可，不阻塞）。可进 plan。
