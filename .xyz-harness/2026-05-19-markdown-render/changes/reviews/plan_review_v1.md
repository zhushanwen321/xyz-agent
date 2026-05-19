---
verdict: pass
must_fix: 0
---

# Plan Review — markdown-render

## Summary

Plan 覆盖了 spec 的 10 项功能需求（FR1-FR10），拆分为 8 个串行 Task，属于单个前端 Group（FG1）。任务依赖关系清晰，无并行冲突。文件变更集中在 4 个文件。

## Issues Found

无 must-fix 问题。

### LOW (建议优化)

1. **[低] Task 3 实际上不需要** — 代码块 HTML 结构在 Task 2 中已实现，Task 3 只是一个确认步骤。可合并到 Task 2。不阻塞，执行时可直接跳过。

2. **[低] Mermaid 懒加载时机** — plan 中 Mermaid 在 `renderFull` 后的 `nextTick` 中渲染。如果页面有很多 Mermaid 图表，应考虑 IntersectionObserver 只渲染可见区域的。这个优化可以在 Task 8 测试后根据实际性能决定是否添加。

3. **[低] 折叠/展开的状态管理** — 当前方案通过 CSS class 切换实现，代码块重新渲染时（如主题切换）折叠状态会重置。可接受——主题切换是低频操作。

## Spec Coverage Check

| Spec FR | Plan Task | 覆盖 |
|---------|-----------|------|
| FR1: Shiki 代码高亮 | Task 2, 7 | OK |
| FR2: 代码块 UI | Task 2, 3, 4, 5 | OK |
| FR3: GFM 表格 | Task 2, 5 | OK |
| FR4: GitHub 排版 | Task 5 | OK |
| FR5: 任务列表 | Task 2, 5 | OK |
| FR6: KaTeX | Task 2, 6 | OK |
| FR7: Mermaid | Task 2, 4 | OK |
| FR8: 流式渲染策略 | Task 2, 4 | OK |
| FR9: 主题切换 | Task 7 | OK |
| FR10: 安全性 | Task 2, 4 | OK |

所有 FR 均有对应 Task 覆盖。

## File Change Summary

| File | Change | Risk |
|------|--------|------|
| `lib/markdown.ts` | Rewrite (~15→~200 行) | 中 — 核心，需仔细测试 |
| `MessageBubble.vue` | Modify (script + style) | 中 — 交互逻辑 + CSS |
| `style.css` | Add 1 line (@import) | 低 |
| `package.json` | Add 4 deps | 低 |

## Conclusion

Plan 质量合格，可进入 Phase 3（dev）。建议执行时跳过 Task 3（确认性步骤），直接在 Task 2 中完成代码块结构。
