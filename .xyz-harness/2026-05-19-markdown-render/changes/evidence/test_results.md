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

## E2E Visual Verification (CDP + 真实 Session 数据)

**验证方式**: Chrome DevTools Protocol (CDP) 连接运行中的 Electron 渲染进程，加载 `~/.xyz-agent/sessions/` 中的真实 session 数据（code-tracer 含表格，slash 含代码块），检查 DOM 结构和 computed styles。

| Check | Result |
|-------|--------|
| CSS 生效（`<style scoped` → `<style>` 修复） | PASS — computed styles 匹配预期值 |
| Table wrapper (`overflowX: auto, border: 1px, borderRadius: 8px`) | PASS |
| TH border (`borderBottomWidth: 2px`) + 背景色 | PASS |
| TD border (`borderWidth: 1px`) | PASS |
| Code block header (`display: flex, padding: 8px 12px`) | PASS |
| Code block 外层边框 + 圆角 | PASS |
| Shiki 高亮 (`pre.shiki.one-dark-pro`, span 颜色 `#abb2bf`) | PASS |
| 行号元素 (`.line-numbers`) | PASS |
| 复制按钮 (`.code-copy-btn`) | PASS |
| 表格结构 (4 行 × 3 列) | PASS |

**Bug Found & Fixed During Phase 4**:

**Scoped CSS bug**: markdown 渲染内容通过 `v-html` 注入，Vue `<style scoped>` 不会给 `v-html` 内容添加 `data-v-*` attribute，导致所有 `.table-wrapper`、`.code-block` 等选择器匹配失败（computed styles 全为 0px/none）。修复：将 markdown 样式块改为 `<style>`（非 scoped），选择器已有 `.msg__body` 前缀保证作用域隔离。

**Fix commit**: `8c748b0` → amended to unscoped `<style>`

## Bug Found & Fixed During Testing

**占位符 bug**: 原实现使用 `\x00CODEBLOCK_N\x00` 作为占位符，markdown-it 在解析时会将 `\x00` 替换为 `\uFFFD`（Unicode Replacement Character），导致后处理正则无法匹配。修复为 `{{CODEBLOCK_N}}`，markdown-it 不做任何转义。

**Fix commit**: `1ad1f20` — use double-brace placeholders instead of null bytes

**Code review 修复**:
- `f260a47` — race condition: renderVersion 防止并发 renderFull 覆盖
- `f260a47` — mermaid ID: 递增计数器替代 Date.now() 避免 ID 冲突
