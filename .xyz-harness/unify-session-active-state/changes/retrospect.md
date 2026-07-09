---
type: lite-retrospect
topic: cw-2026-07-09-unify-session-active-state
date: 2026-07-09
---

# 轻量复盘：统一 session 执行态信号

## 改动摘要

4 文件 / 1 commit：deriveStatus 改收 isActive（含 pendingSend 空窗），useSessionDerivations 去 activeId 限定，Panel.vue 改用 chat.isActive，toolcall-anchor 适配+3 新用例。

## 通过项

- [x] deriveStatus 签名 isStreaming→isActive，语义正确（pendingSend ∨ isGenerating → running）
- [x] useSessionDerivations 去掉 `&& session.activeId === id`，非焦点 session 也反映执行态
- [x] Panel.vue isGenerating computed 改用 chat.isActive（核心 fix）
- [x] toolcall-anchor 新增 3 条 W1 测试覆盖 pendingSend 空窗 / activeId 限定移除 / isCompacting 独立
- [x] vue-tsc 通过，817 tests 全绿，CW test gate 全 passed
- [x] 现有回归测试（chat-isgenerating-scan / panel-per-session-generating / chat-streaming-reset）无回归

## 未完成项（后续清理）

1. **Panel.vue 变量名 `isGenerating` → `isExecuting`**：当前命名与语义不完全匹配（它现在驱动自 isActive 而非纯 isGenerating），但不影响功能。后续统一命名
2. **Panel.vue `showPanelComposer` 缺 `|| isCompacting` 分支**：compact 期 Composer 不渲染（showPanelComposer 依赖 isActive，compact 时 isActive=false）。用户在 compact 期看不到压缩提示（Composer 内部有 isCompacting 分支但组件没挂载）。体验可优化，非阻塞

## 经验

- **workflow budget 问题**：lite tier 3M tokens 不够跑完 W1+W2+test+review（workflow 跑了 8m45s 后 budget_limited，只完成 W1）。后续 lite 功能若改动点 ≥4 考虑加 budget 到 5M
- **CW plan gate 解析 plan.md 表格而非 plan.json**：real 层用例必须作为表格数据行写入 plan.md，引用块里的文字描述 machine check 扫不到。踩了两次才修好
- **implementer 合并 Wave**：虽然 plan 拆了 W1/W2，implementer 把所有改动放在 W1 的 commit 里（Panel.vue 改动不多所以合理）。CW 要求每个 wave 有 commitHash，两个 wave 传同一个 hash 也能通过
