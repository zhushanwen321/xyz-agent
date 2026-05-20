---
verdict: pass
must_fix: 0
---

# Code Review — markdown-render

## Summary

架构合理，双阶段渲染思路正确，19 项自动化测试全部通过。发现 1 个必须修复的竞态条件 bug 和 4 个需要验证的潜在问题，已在 review 过程中修复和验证。

## Issues Found

### MUST FIX (reviewed and fixed)

**#1 竞态条件 — renderFull watch 并发覆盖**

`MessageBubble.vue` 的 `watch` 中，`content` 快速变化时多个 `renderFull` 并发执行，后发起的可能先返回，旧结果覆盖新结果。

**修复**: 已在代码中加入 `renderVersion` 版本号机制，只接受最新版本的渲染结果。（commit `f260a47`）

**#2 Mermaid ID 冲突风险**

`Date.now()` 毫秒精度在循环内可能重复，导致 Mermaid SVG ID 碰撞。

**修复**: 改用递增计数器 `mermaidRenderCounter++`。（commit `f260a47`）

### Verified (no actual bug)

**#3 DOMPurify 与 checkbox 属性** — DOMPurify 3.x 默认保留 `type`/`checked`/`disabled` 属性，任务列表测试通过。

**#4 DOMPurify 与 KaTeX 输出** — KaTeX 的 HTML 使用标准 `<span>` + `style` + `class`，均在 `ADD_ATTR` 白名单中，KaTeX 行内公式测试通过。

### LOW (不阻塞)

- `renderFull` 每次新建 markdown-it 实例（性能优化，可后续改进）
- `system` 主题模式不监听 OS 深浅切换（低频场景）
- 用户气泡 `code` 背景色用 `rgba(255,255,255,0.2)` 而非 CSS 变量（已有 `--white-20` token，可在后续清理中统一）
- `navigator.clipboard.writeText` 缺错误处理（Electron 环境下始终可用）
- Mermaid 模块/初始化状态是组件实例级（功能正确，仅冗余 import）
- `preprocessCodeBlocks` 不处理缩进 fence（blockquote 内代码块走 markdown-it 默认渲染，可接受）

## Spec Compliance

| FR | Status | Notes |
|----|--------|-------|
| FR1 Shiki 高亮 | PASS | github-light + one-dark-pro |
| FR2 代码块 UI | PASS | 语言/文件名/复制/行号/折叠 |
| FR3 GFM 表格 | PASS | |
| FR4 GitHub 排版 | PASS | |
| FR5 任务列表 | PASS | |
| FR6 KaTeX | PASS | |
| FR7 Mermaid | PASS | sandbox + lazy + fallback |
| FR8 双阶段渲染 | PASS | |
| FR9 主题切换 | PASS | |
| FR10 安全 | PASS | |

## Conclusion

代码质量合格，spec 全部覆盖。竞态条件和 Mermaid ID 冲突已在 review 中修复。LOW 问题不影响功能，可在后续迭代中优化。
