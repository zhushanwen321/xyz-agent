---
verdict: pass
all_passing: true
---

# Test Results — markdown-render

## Automated Tests

**环境**: Node.js v24.11.1 + jsdom (DOMPurify) + esbuild + shiki + katex + markdown-it-texmath

**测试方式**: esbuild 编译 `markdown.ts` 到 ESM，在 Node.js 中用 jsdom 初始化 DOMPurify 后执行 `renderLightweight` 和 `renderFull`，断言 HTML 输出包含预期的元素/属性/class。

### Results: 19/19 PASS

| # | Test | Result |
|---|------|--------|
| 1 | renderMarkdown 向后兼容 (strong tag) | PASS |
| 2 | renderLightweight 空字符串 | PASS |
| 3 | renderLightweight 粗体 | PASS |
| 4 | renderLightweight 删除线 | PASS |
| 5 | renderLightweight 表格 | PASS |
| 6 | renderLightweight 不高亮代码块 | PASS |
| 7 | renderFull 空字符串 | PASS |
| 8 | renderFull Python 代码高亮 (code-block wrapper + lang + copy + line-numbers) | PASS |
| 9 | renderFull 文件名标签 (```ts:main.ts) | PASS |
| 10 | renderFull 长代码块折叠 (>20行) | PASS |
| 11 | renderFull 短代码块不折叠 | PASS |
| 12 | renderFull GFM 表格 | PASS |
| 13 | renderFull Mermaid 占位 (mermaid-source + data-mermaid) | PASS |
| 14 | renderFull 任务列表 (task-list-item + checkbox) | PASS |
| 15 | renderFull KaTeX 行内公式 | PASS |
| 16 | renderFull 标题 h1/h2 | PASS |
| 17 | renderFull 引用块 blockquote | PASS |
| 18 | renderFull 无语言代码块 | PASS |
| 19 | renderFull 亮色主题 | PASS |

## Build Verification

| Check | Result |
|-------|--------|
| Vite build (`npx vite build`) | PASS — built in 1.05s |
| TypeScript 类型检查 (markdown.ts + MessageBubble.vue) | PASS — 0 errors |

## Bug Found & Fixed During Testing

**占位符 bug**: 原实现使用 `\x00CODEBLOCK_N\x00` 作为占位符，markdown-it 在解析时会将 `\x00` 替换为 `\uFFFD`（Unicode Replacement Character），导致后处理正则无法匹配。修复为 `{{CODEBLOCK_N}}`，markdown-it 不做任何转义。

**Fix commit**: `1ad1f20` — use double-brace placeholders instead of null bytes

**Code review 修复**:
- `f260a47` — race condition: renderVersion 防止并发 renderFull 覆盖
- `f260a47` — mermaid ID: 递增计数器替代 Date.now() 避免 ID 冲突
