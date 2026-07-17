# Review — default-prompt-reference

日期：2026-07-17 · 任务极简（2 wave 5 文件），三维度自审

## 审查范围
- W1: `packages/shared/src/pi-default-prompt.ts` + `index.ts` re-export
- W2: `SystemPromptPage.vue`（可折叠参考区）+ zh-CN/en-US i18n

## 六维度结论

| 维度 | 结论 |
|------|------|
| type-safety | ✓ 无 any，常量类型 string，import 正确 |
| error-handling | N/A 纯展示无错误路径 |
| edge-case | ✓ 默认折叠不干扰常用流程；pre select-text 可复制；max-h 限高可滚动 |
| test-quality | ✓ 5 cases 覆盖常量导出 + 折叠/展开 DOM + 文案断言 |
| plan-completeness | ✓ CL1-CL3 全落地 |
| design-consistency | ✓ 只读参考区不动 textarea，与 clarify 确认一致 |

## 问题清单

无 must-fix / should-fix。1 个 nit：DEFAULT_PI_SYSTEM_PROMPT 的 pi 版本号绑定 0.80.3，pi 升级后需 diff 检查（已用 VERSION 常量标注，retrospect 记录）。

## 结论

0 must-fix / 0 should-fix。可进 test。
