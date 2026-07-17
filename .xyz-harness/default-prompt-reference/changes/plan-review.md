# Plan Review — default-prompt-reference

日期：2026-07-17 · 审查方法：三维度自审（plan 极简，2 wave 5 文件）

## 审查范围

- W1: shared 常量（pi-default-prompt.ts + index.ts）
- W2: 前端 UI（SystemPromptPage.vue + 2 份 i18n）
- 依赖：W2 dependsOn W1（消费 DEFAULT_PI_SYSTEM_PROMPT）

## 三维度结论

### coverage
- CL1（可折叠参考区）→ W2 落地 ✓
- CL2（shared 常量）→ W1 落地 ✓
- CL3（三点文案）→ W2 i18n defaultHint 落地 ✓
- SR1 nit（默认折叠 + 可复制）→ W2 description 已明确 ✓

### architecture
- 依赖链无环（W1→W2 线性）✓
- 常量放 shared 层（SSOT），不硬编码到组件 ✓
- 无打包配置变更（纯源码，不触发规则 #12）✓

### feasibility
- W1：新建文件 + re-export，无风险 ✓
- W2：SystemPromptPage.vue 加折叠区（ref + v-if），i18n 加 3 key，都是现有模式的增量 ✓
- 文件数：W1=2, W2=3，均 ≤4 ✓

## 结论

无 must-fix / should-fix。plan 完整覆盖 CL1-CL3 + SR1，依赖链正确，文件粒度合理。进 tdd_plan。
