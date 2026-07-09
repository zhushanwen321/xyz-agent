# 归档确认：统一 session 执行态信号

**topic**: cw-2026-07-09-unify-session-active-state
**归档日期**: 2026-07-09
**状态**: 已归档

## 沉淀去向

| 决策/结论 | 沉淀位置 | 说明 |
|-----------|---------|------|
| isActive 是 UI 层执行态 SSOT（isGenerating ∨ pendingSend） | `CONTEXT.md` isActive 章节 + `sessionStatus.ts` JSDoc | deriveStatus 第三参数语义更新 |
| isCompacting 独立于 isActive（compact 互斥不可干预） | `CONTEXT.md` isActive 章节 + `sessionStatus.ts` JSDoc | compact 期间圆点 running，但 isActive=false（不可 steer/abort） |
| useSessionDerivations 移除 activeId 限定 | `useSessionDerivations.ts` 注释 | 非焦点 session 也反映执行态 |
| Panel.vue isGenerating 改用 chat.isActive | `Panel.vue` HISTORICAL 注释 | 消除提交→流式空窗期圆点显示 done |

## 未沉淀项（低优先级）

- Panel.vue 变量名 `isGenerating` → `isExecuting`（命名优化，非架构决策）
- Panel.vue `showPanelComposer` 缺 `isCompacting` 分支（体验优化，非架构决策）

## 代码变更

- commit: `63ed453b` (cherry-pick from `33931044`)
- 4 文件：sessionStatus.ts / useSessionDerivations.ts / Panel.vue / toolcall-anchor.test.ts
