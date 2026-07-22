# Markdown 文件路径识别 — 调研记录

> 时间：2026-07-20
> 目的：为 `markdown.ts` 的 `filepathRule` 重构提供事实依据
> 方法：源码阅读（markdown-it / linkify-it）+ npm 生态检索 + PoC 验证 + researcher 调研

## 1. markdown-it 内部架构（源码验证）

### 1.1 rulechain 与注册顺序

读 `node_modules/markdown-it/lib/parser_inline.mjs` 和实测 `md.core.ruler.__rules__`：

```
core ruler:    normalize → block → inline → linkify → replacements → smartquotes → text_join
inline ruler:  text → linkify → newline → escape → backticks → strikethrough → emphasis → link → image → autolink → html_inline → entity
inline ruler2: balance_pairs → strikethrough.postProcess → emphasis.postProcess → fragments_join
```

### 1.2 emphasis 配对机制

- emphasis 的**识别**在 inline ruler 的 `emphasis` rule（tokenize 阶段）
- emphasis 的**配对**在 inline ruler2 的 `balance_pairs` + `emphasis.postProcess`（后处理阶段）
- ruler2 在所有 inline rules 之后跑，但仍在 inline parser 内部（即 core ruler 的 `inline` rule 内）
- **结论**：到 core rulechain 任何自定义 hook 时，token 树里 `**bold**` 已是 `strong_open/text/strong_close` 三段

实测验证：

```js
const tokens = md.parse('hello **world** end', {});
// tokens[1].children =
//   [text "hello "] [strong_open] [text "world"] [strong_close] [text " end"]
```

### 1.3 markdown-it 官方 linkify 为何不破坏 emphasis

读 `lib/rules_inline/linkify.mjs`：

- 注册位置：inline ruler 内、`text` rule **之后**
- 触发条件：**只在 `state.src.charCodeAt(pos) === 0x3A`（冒号 `:`）时触发**
- 触发后：回头检查 `state.pending` 末尾是否合法 scheme（如 `https`）
- 不扫整段剩余文本，不切断 text 序列

读 `lib/rules_inline/text.mjs`：

- text rule 把 `*` `_` `` ` `` 等当 **terminator char**，遇到就停
- 所以 `**bold**` 的第一个 `*` 让 text 停下，后续 emphasis rule 接管

**对比 filepathRule 的错误**（实测复现）：

- 用 `ruler.before('text', 'filepath', ...)` 抢在 text 之前
- `const rest = state.src.slice(pos)` 扫整段剩余文本
- 命中后 push filepath token 切断 text 序列
- emphasis 后处理无法跨 filepath token 配对 `**`，降级为字面输出

## 2. PoC 验证：core rule 重写 text token

```js
md.core.ruler.after('replacements', 'filepath', (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue
    // 遍历 children，对 text token 做候选扫描 + 白名单校验
    // 命中则拆成 [text, link_open, text, link_close, text]
  }
});
```

测试结果（全部通过）：

| 输入 | 输出 |
|---|---|
| `**bold** and src/foo.ts and necessity/sufficiency/tradeoffs` | `<strong>bold</strong> and <a ...>src/foo.ts</a> and necessity/sufficiency/tradeoffs` |
| `version glm-5.2 and pi/3.14 not linked` | 都不链接（白名单不含） |
| `**每层同一套**（...）...- **折中**：如 src/foo.ts 文件` | 三个加粗全正确，src/foo.ts 链接 |

**决定性结论**：core rule 重写 text token **不破坏 emphasis**（因为 emphasis 已配对完毕）。

## 3. 业界方案对比（researcher 调研 + 事实核对）

| 产品/库 | 文件路径链接化做法 | 切入阶段 |
|---|---|---|
| markdown-it linkify | 识别 URL/email，text 之后触发，只在 `:` 处 | inline 内 |
| GitHub (cmark-gfm) | **不识别裸路径**，只 URL/@mention/#issue/SHA | HTML 后处理 |
| GitLab (Banzai) | 只在「已知仓库根」上下文识别相对路径 | HTML 后处理 |
| VSCode Markdown | 不自动识别，走 webview link provider | DOM 后处理 |
| Obsidian | 靠 vault 文件索引白名单 | 自有解析器 |
| remark/micromark | 工作在 mdast AST 的 text 节点 | AST 层 |
| Continue/Cline/Cursor | 不自动识别，靠模型显式语法（`@file:` / code fence） | 显式语法 |

**核心发现**：**没有成熟产品用「正则猜裸路径」**。GitHub 故意不做、Obsidian 靠白名单、AI agent 靠显式语法。

## 4. linkify-it 扩展能力

读 `node_modules/linkify-it/index.mjs`：

- `linkify.add(schema, definition)` 可注册自定义 scheme（如 `file:`、`mailto:`）
- 但只能识别**带 scheme 前缀**的，识别不了裸文件路径 `src/foo.ts`

结论：linkify-it 不能直接用于裸路径识别。

## 5. renderer fs 能力

查 preload / RPC：renderer 沙箱无 Node fs，无 `fs.existsSync` / `file.exists` RPC。

结论：白名单必须**数据驱动**（从 runtime 经 fileSearchStore 拿 FileNode[] 推导），不能在 renderer 做 fs 校验。

## 6. fileSearchStore 数据形态

读 `packages/renderer/src/stores/fileSearch.ts` + `packages/shared/src/file-tree.ts`：

- `fileSearchStore.files: Map<sessionId, FileNode[]>`
- FileNode.path：相对 cwd 的完整路径（如 `'src/index.ts'`，无前导 `/`）
- FileNode.name：basename（如 `'index.ts'`）
- 数据源：`file.search` RPC 全量递归，per-session 缓存

结论：FileNode.path 集合天然是含/路径白名单，FileNode.name 集合天然是裸 basename 白名单。

## 7. 设计决策（基于以上事实）

详见 `design.md`。核心：

1. 删 inline rule `filepathRule`（架构性错误）
2. 新增 core rule（注册于 `replacements` 之后，emphasis 已配对）
3. 正则从「严格防御型」退化为「宽松候选型」
4. 白名单（`filePaths` + `localFiles` 双 Set）接管所有误识别过滤
5. 数据源复用 fileSearchStore 现有通路
