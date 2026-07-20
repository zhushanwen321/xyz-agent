# Markdown 文件路径识别重构设计

> 状态：Draft · 2026-07-20
> 关联代码：`packages/renderer/src/composables/logic/markdown.ts`
> 关联事故：emphasis 失效（`**折中**` 不加粗，实测同段所有 emphasis 全部失效）

## 1. 背景与问题

### 1.1 现状

markdown 渲染器（`markdown.ts`）自定义了一个 inline rule `filepathRule`，注册位置：

```ts
md.inline.ruler.before('text', 'filepath', filepathRule)
```

它在 markdown-it **inline rulechain 的 `text` rule 之前**抢跑，用正则 `FILEPATH_RE` 扫描 `state.src.slice(pos)` 整段剩余文本，命中形似文件路径的片段后，push `filepath_open/text/filepath_close` token，包成 `<a class="md-filepath" data-path="...">` 链接。

### 1.2 问题

**P0 — emphasis 全段失效**（用户实际遇到）

`**每层同一套**（necessity/sufficiency/tradeoffs/risks ...）... **折中**：...` 这段，`necessity/sufficiency/tradeoffs/risks` 被误识别为路径，filepathRule push filepath token 把原本连续的 inline text 切成多块。markdown-it 的 emphasis 配对在 inline parser 的 `ruler2` 后处理（`balance_pairs` + `emphasis.postProcess`）阶段进行，要求 `**` 开/闭标记在同一连续 text token 序列里——被 filepath token 切断后配对失败，**整段所有 `**xxx**` 降级为字面 `**`**。"折中"只是最显眼的一个。

**P1 — 误识别需要堆 hack**

`FILEPATH_RE` 已用一堆前瞻/后顾防御：版本号（`glm-5.2`）、小数（`pi/3.14`）、纯数字段（`src/123`）、绝对路径无扩展名（`/usr/bin`）。这些防御让正则越来越复杂。

**P2 — ReDoS 历史**

正则曾因嵌套量词（双层 `(?:[chars]+(?: [chars]+)*)+`）导致灾难性回溯，26 字符纯 word 序列 146ms、40 字符挂死（见 `markdown-filepath.test.ts` AC-1/AC-9 [HISTORICAL]）。已修复为线性结构，代价是取消空格路径支持。

### 1.3 根因

**架构性错误**：在 inline rulechain 的 `text` rule **之前**抢跑、扫整段剩余文本、产生独立 token。这会切断 emphasis 配对所需的 text 序列连续性。再怎么修补正则都治标不治本。

## 2. 调研结论（事实依据）

详见同目录 `research.md`（调研记录）。关键事实（已本地验证）：

| 事实 | 验证方式 | 结论 |
|---|---|---|
| markdown-it 官方 `linkify` 注册位置 | 读源码 `lib/parser_inline.mjs` | inline rulechain 内、`text` rule **之后**，只在 `:` 字符处触发，不扫整段文本 |
| emphasis 配对真实位置 | `md.parse()` 输出 + 读 `parser_inline.mjs` ruler2 | inline parser 内部 `ruler2`（`balance_pairs` + `emphasis.postProcess`），在所有 inline rules 之后 |
| core rulechain 看到的 token 树 | `md.parse()` 实测 | `**bold**` 已是 `strong_open/text/strong_close` 三段——**任何 core rule hook 看到的都是已配对 token 树** |
| core ruler hook 列表 | `md.core.ruler.__rules__` | `normalize → block → inline → linkify → replacements → smartquotes → text_join` |
| 业界是否用「正则猜裸路径」 | 调研 GitHub/GitLab/VSCode/Obsidian/AI agent | **无**。GitHub 故意不做、Obsidian 靠文件索引白名单、AI agent 靠显式语法 |
| core rule 重写 text token 是否破坏 emphasis | PoC 实测 | **不破坏**。拆 text token 等于在「已确定无 emphasis 边界的纯文本」内部插 link |
| renderer 能否直接 `fs.existsSync` | 查 preload/RPC | **不能**。Electron renderer 沙箱无 Node fs，白名单必须数据驱动 |

## 3. 方案选型

### 3.1 候选方案对比

| 方案 | emphasis 安全 | 误识别风险 | 改动量 | 性质 |
|---|---|---|---|---|
| **A. core rule 重写 text token + 数据白名单**（推荐） | ✅ 已验证 | 极低（白名单） | 中 | 长期 |
| B. HTML 后处理 | ✅ | 低（仍需白名单） | 中（额外 XSS 加固） | 长期 |
| C. 换 remark/micromark（AST 重写） | ✅（AST 保证） | 低 | 大（换渲染器） | 长期（不现实） |
| D. 显式语法（要求模型用 `` `path:src/foo.ts` ``） | ✅ | 零 | 小 | 短期，依赖模型 |
| E. 现状 inline 抢跑 | ❌ | 高 | — | 反模式，必须废弃 |

### 3.2 选 A 的理由

- **emphasis 安全已实测**：PoC 验证 `**bold** and src/foo.ts and necessity/sufficiency` 同段，bold 正确渲染、真实路径链接、非路径不链接，三者同时满足
- **复用现有数据通路**：`fileSearchStore` 已有 per-session 的 `FileNode[]` 全量递归结果（`file.search` RPC 缓存），`FileNode.path` 正是相对 cwd 的路径（如 `src/index.ts`），与正文裸路径形态完全一致——天然白名单
- **误识别靠白名单而非正则**：`pi/3.14`、`glm-5.2`、`node/18.0`、`necessity/sufficiency` 全部因不在项目文件集合里被否决，**无需任何正则 hack**
- **改动聚焦两个文件**：`markdown.ts`（逻辑层）+ `MarkdownRenderer.vue`（数据注入），无外部依赖

### 3.3 不选 B/C 的理由

- **B（HTML 后处理）**：要在 markdown-it 渲染完的 HTML 上重新解析，XSS 面扩大（需手动 escape），且无法复用 markdown-it 的 link_open token 结构（现有 click handler 依赖 `data-path` 属性）
- **C（换渲染器）**：迁移成本巨大，shiki/mermaid 集成都要重做，收益不抵成本

### 3.4 D 作为补充

D（显式语法）不与本方案冲突，未来可在 system prompt 追加「文件引用用反引号包裹」约定，减少误识别窗口。但短期不依赖模型配合。

## 4. 详细设计

### 4.1 数据通路改造

**现有**（仅裸 basename）：

```
MarkdownRenderer.vue
  └─ refreshLocalFiles(sid)
      └─ useFileSearch.load(sid) → FileNode[]
      └─ collectBasenames(nodes) → Set<string>  // 只取 basename
  └─ renderMarkdownSegments(text, { localFiles: basenameSet })
```

**改造后**（basename + 完整 path 双集合）：

```
MarkdownRenderer.vue
  └─ refreshLocalFiles(sid)
      └─ useFileSearch.load(sid) → FileNode[]
      └─ collectFilePaths(nodes) → { paths: Set<string>, basenames: Set<string> }
          // paths：所有 FileNode.path（含/路径白名单）
          // basenames：所有 FileNode.name（裸 basename 白名单，复用 collectBasenames）
  └─ renderMarkdownSegments(text, { filePaths, localFiles })
```

**MarkdownEnv 扩展**：

```ts
export interface MarkdownEnv {
  /** 项目内文件的完整路径集合（含/路径，如 'src/index.ts'）。含/路径识别的白名单。 */
  filePaths?: Set<string>
  /** 项目内文件的 basename 集合（裸 basename，如 'index.ts'）。裸 basename 识别的白名单。 */
  localFiles?: Set<string>
}
```

**为什么白名单必须来自数据**：Electron renderer 沙箱无 Node fs（已验证），不能 `fs.existsSync`。fileSearchStore 是唯一文件存在性真相源，所有判断退化为 `Set.has(candidate)`。

**`collectFilePaths` 实现要点**：
- 输入：`FileNode[]`（fileSearchStore 缓存，已是全量递归结果）
- 遍历：深度优先，收集每个 `type === 'file'` 节点的 `path`
- 路径规范化：保持原样（相对 cwd、无前导 `/`），与正文裸路径形态一致
- 容量：大仓库可能上万文件，Set 构建一次 O(n)，后续每次渲染 `has()` 是 O(1)
- 缓存生命周期：复用 fileSearchStore 现有失效机制（`useFileSearch.setupInvalidation` watch fileChanges），无需新失效逻辑

### 4.2 markdown.ts 逻辑层改造

#### 4.2.1 删除的代码

- `filepathRule` 函数（inline rule）
- `md.inline.ruler.before('text', 'filepath', filepathRule)` 注册
- `FILEPATH_RE`、`BASENAME_RE` 两个复杂正则
- `isAcceptableFilePath` 语义过滤函数
- `filepath_open` / `filepath_close` renderer rule
- `InlineState` / `InlineStateToken` / `InlineRulerHost` 三个仅服务于 inline rule 的类型
- 一大堆 `[HISTORICAL]` 注释（ReDoS 修复、版本号防御等，对应正则删除后一并清理）

#### 4.2.2 新增的代码

**候选正则（宽松）**：

```ts
/**
 * 含/路径候选正则（宽松）。
 *
 * 设计哲学：只做「形似路径」的廉价预筛，存在性判断交给 env.filePaths 白名单。
 * 因此正则可大幅简化——不再需要段含字母前瞻、绝对路径必须有扩展名等防御。
 *
 * 匹配规则：[非边界符或行首] + 2+ 段标识符（每段 [a-zA-Z0-9._-]+，段间用 / 连接）。
 * 边界符集合：空白/括号/引号/方括号/逗号/分号/冒号。
 *
 * 线性无回溯（单层量词 + 非捕获组），无 ReDoS 风险。
 *
 * 不在此正则处理的：
 *  - 裸 basename（无 /）：走 BASENAME_CANDIDATE_RE + env.localFiles 白名单
 *  - 反引号内路径：由 code_inline renderer 的 linkifyFilePathsHtml 处理（独立通路，不受本次重构影响）
 */
const PATH_CANDIDATE_RE = /(?:^|[\s(>"'\[,{;:])([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)(?![a-zA-Z0-9._-\/])/g

/** 裸 basename 候选正则（必须有扩展名，避免误伤普通词）。形态同旧 BASENAME_RE 但去掉复杂前瞻。 */
const BASENAME_CANDIDATE_RE = /(?:^|[\s(>"'\[,{;:])([a-zA-Z0-9._-]+\.[a-zA-Z][a-zA-Z0-9]{1,8})(?![a-zA-Z0-9._-\/])/g
```

**core rule 实现**：

```ts
/**
 * 文件路径识别 core rule（注册于 replacements 之后）。
 *
 * 此时 emphasis 已在 inline parser 的 ruler2 后处理阶段配对完毕，token 树里的
 * **bold** 已是 strong_open/text/strong_close 三段。本 rule 遍历所有 inline token
 * 的 children，对 text token 的 .content 做路径候选扫描 + 白名单校验，命中则把
 * 该 text token 拆成 [text(前缀), link_open, text(路径), link_close, text(后缀)]。
 *
 * 为什么安全：拆分发生在「已确定无 emphasis 边界的纯 text token 内部」，不影响
 * 任何相邻 strong/emphasis/code/link token 的开闭配对（那些配对在更外层已成立）。
 *
 * 为什么不破坏 code_inline：code_inline 是独立 token 类型，遍历时直接 push 不动。
 * 反引号内路径的链接化由 code_inline renderer 独立处理（见 linkifyFilePathsHtml）。
 */
function filepathCoreRule(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue
    const newChildren: Token[] = []
    for (const child of token.children) {
      if (child.type !== 'text') {
        newChildren.push(child)
        continue
      }
      rewriteTextToken(child, newChildren, state.Token, state.env)
    }
    token.children = newChildren
  }
}

/** 把单个 text token 按白名单命中拆分为多个 token（无命中则原样 push）。 */
function rewriteTextToken(textToken: Token, out: Token[], TokenCtor: typeof Token, env?: MarkdownEnv): void {
  const content = textToken.content
  const hits = collectHits(content, env)
  if (hits.length === 0) {
    out.push(textToken)
    return
  }
  let last = 0
  for (const hit of hits) {
    if (hit.start > last) {
      out.push(makeTextToken(TokenCtor, content.slice(last, hit.start)))
    }
    out.push(makeFilepathLink(TokenCtor, hit.path))
    last = hit.end
  }
  if (last < content.length) {
    out.push(makeTextToken(TokenCtor, content.slice(last)))
  }
}

/** 扫描 content，返回白名单内的路径命中（含/路径优先，裸 basename 次之）。 */
function collectHits(content: string, env?: MarkdownEnv): Array<{ start: number; end: number; path: string }> {
  const hits: Array<{ start: number; end: number; path: string }> = []
  const pathSet = env?.filePaths
  const basenameSet = env?.localFiles

  // 含/路径
  if (pathSet && pathSet.size > 0) {
    PATH_CANDIDATE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATH_CANDIDATE_RE.exec(content)) !== null) {
      if (pathSet.has(m[1])) {
        const leadLen = m[0].length - m[1].length
        hits.push({ start: m.index + leadLen, end: m.index + m[0].length, path: m[1] })
      }
    }
  }
  // 裸 basename（仅当含/路径集合也提供时才扫，否则裸 basename 误伤面太大）
  if (basenameSet && basenameSet.size > 0) {
    BASENAME_CANDIDATE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BASENAME_CANDIDATE_RE.exec(content)) !== null) {
      if (basenameSet.has(m[1])) {
        const leadLen = m[0].length - m[1].length
        hits.push({ start: m.index + leadLen, end: m.index + m[0].length, path: m[1] })
      }
    }
  }
  // 按 start 排序，丢弃重叠（含/路径与 basename 同位时含/路径优先）
  hits.sort((a, b) => a.start - b.start)
  return dedupeOverlaps(hits)
}

function makeTextToken(TokenCtor: typeof Token, content: string): Token {
  const t = new TokenCtor('text', '', 0)
  t.content = content
  return t
}

function makeFilepathLink(TokenCtor: typeof Token, path: string): Token[] {
  const open = new TokenCtor('link_open', 'a', 1)
  // data-path base64 编码（与现有 code_inline / mermaid 同 XSS 防线，防引号注入）
  open.attrs = [['class', 'md-filepath'], ['data-path', encodeBase64(path)]]
  const text = new TokenCtor('text', '', 0)
  text.content = path
  const close = new TokenCtor('link_close', 'a', -1)
  return [open, text, close]
}
```

**注册位置**：

```ts
md.core.ruler.after('replacements', 'filepath', filepathCoreRule)
```

为什么 `after('replacements')`：`replacements` 是 typography 替换（如直引号变弯引号），跑完后文本进入最终形态；`smartquotes` 和 `text_join` 在其后但仍在本 rule 之前/之后无交互（filepath 不依赖它们）。`after('linkify')` 也可，但 `replacements` 是更稳定的锚点。

#### 4.2.3 保留的代码

- `code_inline` renderer 覆盖（`linkifyFilePathsHtml`）：独立通路，反引号内路径链接化。**不受本次重构影响**，但需同步改造：
  - 删除 `FILEPATH_RE` / `BASENAME_RE` 引用，改用新的 `PATH_CANDIDATE_RE` / `BASENAME_CANDIDATE_RE`
  - 接收 `env.filePaths` + `env.localFiles` 双集合（现有签名已透传 env）
- `link_open` renderer 的安全属性注入（target/rel）：不动
- shiki highlighter / fence 规则 / mermaid 占位：不动
- `encodeBase64` / `decodeBase64`：不动

### 4.3 click handler 兼容性

`useMarkdownInteractions.ts` 通过 `data-path` 属性识别点击的路径，对 link_open token 产出 `<a class="md-filepath" data-path="...">` 无感知——**完全兼容，零改动**。

`AmbiguousFilePopover.vue`（裸 basename 多匹配歧义浮层）：依赖 `fileSearchStore` 按 basename 反查 FileNode[]。裸 basename 链接化仍由本次重构保留（走 `BASENAME_CANDIDATE_RE` + `localFiles` 白名单），歧义浮层数据通路不变——**零改动**。

### 4.4 测试改造

`packages/renderer/src/__tests__/composables/markdown-filepath.test.ts`：

| AC | 现状 | 改造后 |
|---|---|---|
| AC-1 FILEPATH_RE 性能 | 删除（正则不再存在） | 新增 PATH_CANDIDATE_RE 性能断言（线性无回溯） |
| AC-7 BASENAME_RE 性能 | 删除 | 新增 BASENAME_CANDIDATE_RE 性能断言 |
| AC-9 静态结构断言 | 保留（新正则同样要求无嵌套量词） | 同 |
| AC-3 含/路径识别 | 通过 renderMarkdown 验证 | **改造**：测试需注入 `env.filePaths` 白名单（否则任何路径都不链接） |
| AC-4 无扩展名路径（src/Makefile） | 直接 renderMarkdown | 改造：白名单需含 `'src/Makefile'` |
| AC-8 反引号内路径 | 通过 renderMarkdown 验证 | 保留（code_inline 通路不变），白名单注入同上 |
| AC-5 误识别防御（glm-5.2 等） | 靠正则前瞻防御 | **简化**：白名单不含即不链接，断言简化为"env.filePaths 不含 glm-5.2 → 不链接" |
| AC-6 取消空格路径 | 靠线性正则不支持 | 保留（PATH_CANDIDATE_RE 同样不支持空格段） |
| AC-2 真实渲染不卡顿 | 性能断言 | 保留 |

**新增 AC（P0 回归防护）**：

```
AC-10 emphasis 不被路径识别破坏（P0 回归）
  输入：'**bold** and src/foo.ts and necessity/sufficiency/tradeoffs'
  env.filePaths = {'src/foo.ts'}
  断言：
    - html 含 <strong>bold</strong>
    - html 含 <a class="md-filepath" data-path="...">src/foo.ts</a>
    - html 不含字面 **（即 emphasis 正确配对，无降级）
    - html 中 necessity/sufficiency/tradeoffs 为纯文本（无 a 标签包裹）

AC-11 白名单外路径不链接
  输入：'see pi/3.14 and glm-5.2 and node/18.0'
  env.filePaths = {} (空集)
  断言：html 无任何 md-filepath 链接
```

### 4.5 数据注入时机

`MarkdownRenderer.vue` 现有 `localFiles` 的响应式机制（`refreshLocalFiles(sid)` 异步 load + 赋值触发 watch 重渲染）**直接复用**，只需把 `collectBasenames(nodes)` 改为 `collectFilePaths(nodes)`（同时返回 paths 和 basenames 两个 Set）。

**首渲染降级语义保持**：fileSearch 未加载时 `filePaths` / `localFiles` 为空集 → markdown 正文无任何路径链接化（纯文本），与现状一致，无回归。load 完成后赋值 → watch 触发重渲染 → 路径变可点击链接。

### 4.6 边界与不变式

| 不变式 | 验证点 |
|---|---|
| core rule 只处理 text token，不处理 code_inline/link/emphasis | `if (child.type !== 'text') push & continue` |
| 路径链接化只在 env 白名单非空时生效 | `if (pathSet && pathSet.size > 0)` 守卫 |
| data-path base64 编码（XSS 防线） | `makeFilepathLink` 用 `encodeBase64` |
| 候选正则线性无回溯（无嵌套量词） | AC-9 静态结构断言 |
| emphasis 配对不被破坏 | AC-10 回归测试 |

### 4.7 性能

- core rule 每次 render 跑一次，遍历 `state.tokens`（段落级，通常几十个）+ 每个 inline token 的 children（通常几十个）
- 每个 text token 跑两次正则（PATH + BASENAME），`Set.has` O(1)
- 白名单 Set 构建在 `refreshLocalFiles` 时一次完成（fileSearchStore 缓存命中时同步，否则等 RPC）
- 大仓库（万级文件）下 Set 内存占用：每个 path 平均 30 字节，3 万文件约 1MB，可接受
- 正则线性无回溯（AC-9 保证），无 ReDoS 风险

## 5. 迁移路径

单 PR 完成，不需要分阶段。改动范围：

| 文件 | 改动 |
|---|---|
| `packages/renderer/src/composables/logic/markdown.ts` | 删 filepathRule + 旧正则 + 类型；新增 core rule + 候选正则 + 辅助函数 |
| `packages/renderer/src/components/panel/message-stream/MarkdownRenderer.vue` | `collectBasenames` → `collectFilePaths`；env 注入 `filePaths` |
| `packages/renderer/src/__tests__/composables/markdown-filepath.test.ts` | AC 改造 + 新增 AC-10/11 |

不涉及 runtime / main / shared 层。

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| core rule 遍历 children 遗漏嵌套结构（如 link 内部的 text） | link 内部 text 遍历到也会被处理，但 link 嵌套 link 是非法 HTML，markdown-it 不会产生；常规 `<a>text</a>` 内部 text 命中路径会嵌套 a，需验证是否要跳过「父级是 link_open」的 text。**初始实现保守：跳过 link_open 之后到 link_close 之前的 text**（避免嵌套 a） |
| fileSearchStore 缓存未命中时首渲染无链接 | 现有机制已处理（load 完成后重渲染），无回归 |
| 白名单路径形态与正文裸路径不一致（如正文写 `./src/foo.ts`，白名单是 `src/foo.ts`） | 初始实现不处理 `./` 前缀，作为已知限制记录在 AC。未来可加规范化层（strip `./`） |
| 模型输出的绝对路径（`/Users/foo/bar.ts`） | 不在白名单（白名单只有相对 cwd 路径），不链接。与现状一致（现状靠 isAcceptableFilePath 防御，更严格） |

**回滚**：单 PR git revert 即可，无数据迁移、无 schema 变更。

## 7. 已知限制（接受）

1. **路径必须出现在项目文件白名单内才链接**。`pi/3.14`、模型名、版本号、英文词组（necessity/sufficiency）一律不链接——这是期望行为，不是 bug。
2. **绝对路径不链接**（renderer 无法 fs 校验，白名单只有相对路径）。
3. **带空格路径不链接**（`docs/My Document.md`）——继承现状（D1 决策），换取线性正则。
4. **首渲染降级为纯文本**（fileSearch 未加载时）——继承现状。

## 8. 与现状的对照表

| 维度 | 现状 | 重构后 |
|---|---|---|
| 注册位置 | `inline.ruler.before('text', ...)` | `core.ruler.after('replacements', ...)` |
| 扫描对象 | `state.src.slice(pos)` 整段剩余文本 | 已解析 token 树的 text token `.content` |
| emphasis 影响 | **破坏**（切断 text 序列） | 无（text token 已在 emphasis 配对后） |
| 误识别防御 | 正则前瞻/后顾堆 hack | 数据白名单（`Set.has`） |
| 正则复杂度 | 高（嵌套量词历史 + 多层前瞻） | 低（线性 + 单层量词） |
| ReDoS 风险 | 已修复但需持续警惕 | 结构性消除（线性 + AC-9 静态断言） |
| 白名单数据源 | basename only（`localFiles`） | basename + path 双集合（`localFiles` + `filePaths`） |
| 反引号内路径 | code_inline renderer 通路 | 同（保留） |
| click handler | 不动 | 不动 |
| 改动文件数 | — | 3（markdown.ts + MarkdownRenderer.vue + test） |

## 9. 验收标准

- [ ] `**bold** and src/foo.ts and necessity/sufficiency` 正确渲染（AC-10）
- [ ] 白名单外路径不链接（AC-11）
- [ ] 含/路径识别（AC-3，改造后注入白名单）
- [ ] 反引号内路径识别（AC-8，保留）
- [ ] 无扩展名路径 src/Makefile（AC-4，改造后注入白名单）
- [ ] 取消空格路径支持（AC-6，保留）
- [ ] 正则线性无回溯（AC-1/7/9，新正则同样通过）
- [ ] 真实渲染不卡顿（AC-2，保留）
- [ ] 现有 `useMarkdownInteractions` / `AmbiguousFilePopover` 零改动验证
- [ ] `npm run lint` 通过
- [ ] `vue-tsc` / `tsc` 类型检查通过
