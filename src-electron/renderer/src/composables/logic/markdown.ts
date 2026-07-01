/**
 * Markdown 渲染纯逻辑（R2 logic 层）。
 *
 * 组合 markdown-it（结构解析：标题/列表/表格/链接/行内代码）+ shiki（代码块高亮）。
 * - shiki 用双主题（dark-plus / light-plus）+ defaultColor:false，产出带 CSS 变量
 *   (--shiki-0 暗色 / --shiki-1 亮色) 的 span，由 MarkdownRenderer.vue 的样式层切换
 *   —— 适配 design-tokens 的 :root(暗默认) / [data-theme="light"] 双主题（ADR-0021-B）。
 * - shiki highlighter 创建是异步的，故 renderMarkdown 返回 Promise；highlighter 全局单例，
 *   首次 await 后后续渲染同步走 markdown-it（仅 shiki 的 codeToHtml 同步可用）。
 *
 * fence 规则覆盖（代码块增强）：
 *  - mermaid 块 → 占位容器（不调 shiki），由 MermaidRenderer 异步渲染成图表
 *  - 普通代码块 → shiki 高亮 + 语言标签 + 复制按钮（code 经 base64 进 data 属性）
 *  不再使用 MarkdownIt 构造选项的 highlight 回调，fence 规则完全自控（单一职责，
 *  避免与 highlight 回调的 `<pre` 跳过机制双重逻辑）。
 *
 * XSS 安全：markdown-it 关 html:false（不透传用户原始 HTML），shiki codeToHtml 转义所有
 * 非 token 文本（只发 scoped <span>），linkify 自动补全的 <a> 加 rel/target 安全属性。
 * 代码块/mermaid 源码进 data 属性前用 base64 编码（UTF-8 安全），杜绝引号/HTML 注入。
 */
import MarkdownIt from 'markdown-it'
import { createHighlighter } from 'shiki'
import type { Highlighter } from 'shiki'

/**
 * markdown-it StateInline 的最小结构类型（@types/markdown-it 极简，未导出 StateInline）。
 * 仅声明 filepath rule 用到的字段。
 */
interface InlineState {
  src: string
  pos: number
  posMax: number
  pending: string
  push(type: string, tag: string, nesting: number): InlineStateToken
}
interface InlineStateToken {
  content: string
  attrSet(key: string, value: string): void
}

/** markdown-it 实例上 inline ruler 的最小结构类型（@types 未暴露 md.inline.ruler） */
interface InlineRulerHost {
  inline: { ruler: { before(beforeName: string, ruleName: string, fn: (s: InlineState, silent: boolean) => boolean): void } }
}

/** 代码块高亮覆盖的语言（按 wave review 要点：ts/vue/json/bash/md + 常见派生） */
const SHIKI_LANGS = ['typescript', 'javascript', 'vue', 'json', 'bash', 'shell', 'markdown', 'css', 'html', 'yaml', 'python', 'go', 'rust']

/** 双主题：dark-plus（VSCode 暗默认，review 要求的 VSCode 级高亮）/ light-plus（亮配套） */
const SHIKI_DARK = 'dark-plus'
const SHIKI_LIGHT = 'light-plus'

/** shiki 单例（全局一次，避免重复 WASM/语法加载） */
let highlighterPromise: Promise<Highlighter> | null = null
let cachedMarkdown: MarkdownIt | null = null

/**
 * 获取（惰性创建）shiki highlighter 单例。
 * 导出供 CodeBlock / DiffView 等组件复用同一单例，避免重复 WASM/语法加载。
 */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_DARK, SHIKI_LIGHT],
      langs: SHIKI_LANGS,
    })
  }
  return highlighterPromise
}

/** UTF-8 安全 base64 编码（兼顾含中文/emoji 的代码与 mermaid 源码） */
function encodeBase64(text: string): string {
  // TextEncoder 产出 UTF-8 字节，再 btoa；解码侧用 atob + TextDecoder 对称还原
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return btoa(binary)
}

/**
 * 用 shiki 单例同步高亮一段代码（调用前需 await getHighlighter）。
 * 返回双主题 HTML（带 --shiki-dark/--shiki-light 变量的 span），未知语言 fallback typescript。
 * XSS 安全：shiki codeToHtml 转义所有非 token 文本，只发 scoped <span>。
 */
function highlightShikiSync(hl: Highlighter, code: string, lang: string): string {
  const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'typescript'
  try {
    return hl.codeToHtml(code, {
      lang: resolved,
      themes: { dark: SHIKI_DARK, light: SHIKI_LIGHT },
      defaultColor: false,
    })
  } catch {
    // 未知语言/解析失败：返回空串，调用方降级为 <pre><code> 纯文本
    return ''
  }
}

/**
 * 取（惰性创建）配置好的 markdown-it。highlighter 经 await 后 codeToHtml 同步可用，
 * fence 规则内直接同步调 highlightShikiSync。
 */
async function getMarkdown(): Promise<MarkdownIt> {
  if (cachedMarkdown) return cachedMarkdown
  const hl = await getHighlighter()
  const md = new MarkdownIt({
    html: false, // 不透传用户原始 HTML（XSS 防线）
    linkify: true, // 自动识别裸 URL
    typographer: true, // 排版引号/省略号
    breaks: false, // 不把单 \n 转 <br>（保留 markdown 语义，软换行由 CSS white-space 处理）
    // 不配 highlight 回调：fence 走下方自定义规则，完全自控（避免双重逻辑）
  })

  // ── fence 规则覆盖：代码块增强（语言标签 + 复制按钮）+ mermaid 占位 ──
  md.renderer.rules.fence = (tokens, idx): string => {
    const token = tokens[idx]
    const info = token.info ? token.info.trim() : ''
    const lang = info.split(/(\s+)/)[0] ?? ''
    const code = token.content

    // mermaid 块：输出占位容器，由 MermaidRenderer 异步渲染成 SVG（不调 shiki）
    // base64 编码源码进 data-source，杜绝引号/HTML 注入
    if (lang.toLowerCase() === 'mermaid') {
      return `<div class="md-mermaid" data-source="${encodeBase64(code)}"></div>\n`
    }

    // 普通代码块：shiki 高亮 + 语言标签 + 复制按钮
    const shikiHtml = highlightShikiSync(hl, code, lang)
    const langLabel = lang || 'text'
    const dataCode = encodeBase64(code)
    // shiki 失败时降级为 <pre><code> 纯文本（escapeHtml 由 markdown-it 保证？不——我们已跳出默认规则，
    // 需自己 escape。复用 shiki 失败空串场景：拼一个转义的 pre>code）
    const codeHtml = shikiHtml || `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`
    return (
      `<div class="md-codeblock">` +
      `<div class="md-codeblock__header">` +
      `<span class="md-codeblock__lang">${escapeHtml(langLabel)}</span>` +
      `<button class="md-codeblock__copy" data-code="${dataCode}" type="button" title="复制"></button>` +
      `</div>` +
      codeHtml +
      `</div>\n`
    )
  }

  // 外链安全属性：linkify 产生的 <a> 加 target/rel，防 opener 钓鱼
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  // ── 文件路径识别（inline rule）：正文里含 / 的路径片段 → 可点击 <a data-path> ──
  // 仅识别含路径分隔符的（如 src/foo.ts、a/b/c.vue），单独 foo.ts 不识别（避免误伤版本号/小数）。
  // 在 text 规则前注册：markdown-it 逐字符推进 pos，每到一个 pos 先试本规则——
  // 仅当 pos 正好是路径起始（且前一字符是边界符）时消费，否则 return false 让后续规则（text 等）推进。
  // 不识别行内 code 内的路径：backticks 规则在 text 之前，反引号内容会被 backticks 消费成 code token，
  // 不会进入 text 流；本规则虽排在 text 前，但 backticks 已先把 code 内容拿走。
  // @types/markdown-it 未暴露 md.inline.ruler，运行时确存在（parser_inline.mjs）。用结构类型断言。
  ;(md as unknown as InlineRulerHost).inline.ruler.before('text', 'filepath', filepathRule)
  // 自定义 token type 的 renderer：输出 <a class="md-filepath" data-path="...">
  // data-path base64 编码（与 code/mermaid 同 XSS 防线，防引号注入）
  md.renderer.rules.filepath_open = (tokens, idx) => {
    const path = tokens[idx].attrGet('data-path') ?? ''
    return `<a class="md-filepath" data-path="${path}">`
  }
  md.renderer.rules.filepath_close = () => '</a>'

  cachedMarkdown = md
  return md
}

/**
 * 文件路径 inline rule（markdown-it StateInline 签名）。
 *
 * 匹配「至少含一个 / 且以源码扩展名结尾」的路径片段。
 * 仅在 pos 正好是路径首字符、且前一字符是边界符（或行首）时消费——
 * 这样普通文本 `see src/foo.ts` 中，text 规则会吃到 `see `（空格是路径前边界），
 * 到 `src` 时本规则命中。中间含 markdown 语法的文本不被跳过。
 *
 * 故意保守：单独 foo.ts（无 /）不识别，避免污染版本号/小数/普通词。
 */
// 字符集内 `-` 转义为 `\-`（防 `_-`/`/-` 倒序范围触发 "Range out of order"）
// g 标志 + 从 pos 之后找第一个含/路径。捕获组 1 = 路径（去掉前导边界符）。
// 前导边界符故意不含反引号 ` —— 行内 code `src/foo.ts` 内的路径不应识别（backticks
// 在 text 之后，filepath 在 text 之前会先吃掉路径；靠反引号不作为边界符来排除 code 内路径）。
const FILEPATH_RE = /(?:^|[\s(>"'(\[,{;:])([a-zA-Z0-9._\-]+(?:\/[a-zA-Z0-9._\-]+)+\.[a-zA-Z0-9]{1,8})(?![a-zA-Z0-9._\-/])/g

function filepathRule(state: InlineState, silent: boolean): boolean {
  const pos = state.pos
  // 从当前 pos 起搜索第一个含/路径。text rule 会一次吃掉整段非 terminator 文本
  // （空格不是 terminator），故本规则必须在 text 之前主动扫描并拦截路径。
  const rest = state.src.slice(pos)
  FILEPATH_RE.lastIndex = 0
  const match = FILEPATH_RE.exec(rest)
  if (!match) return false

  // match.index = 边界符位置（或 0）；路径起点 = match.index + 前导边界符长度
  const leadLen = match[0].length - match[1].length
  const pathStartInRest = match.index + leadLen
  const path = match[1]
  const pathEndInRest = pathStartInRest + path.length

  if (silent) return true

  // 前置文本（边界符 + 之前）累积进 pending —— state.push 会把 pending 自动 flush 成 text token
  if (pathStartInRest > 0) {
    state.pending += rest.slice(0, pathStartInRest)
  }

  // push filepath_open + text + filepath_close（push 前会自动 flush pending 为 text token）
  const openToken = state.push('filepath_open', 'a', 1)
  openToken.attrSet('data-path', encodeBase64(path))
  const textToken = state.push('text', '', 0)
  textToken.content = path
  state.push('filepath_close', 'a', -1)

  // pos 推进到路径结尾（前置文本已通过 pending 记录，不丢）
  state.pos = pos + pathEndInRest
  return true
}

/** markdown-it 的 escapeHtml（复用其与 fence 一致的转义语义） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 把 markdown 文本渲染成 HTML 字符串。
 * 首次调用 await shiki 加载（异步）；之后 markdown-it 实例缓存，后续渲染同步。
 */
export async function renderMarkdown(content: string): Promise<string> {
  const md = await getMarkdown()
  return md.render(content)
}

/** markdown 渲染段（供 MarkdownRenderer 按 segment 分别渲染，mermaid 段走 MermaidRenderer 组件） */
export interface MarkdownSegment {
  /** text 段：渲染后的 HTML 字符串（含代码块/链接等，走 v-html）；mermaid 段：原始 mermaid 源码 */
  type: 'text' | 'mermaid'
  /** text: HTML；mermaid: 源码（MermaidRenderer 渲染） */
  content: string
}

/** 占位正则：匹配 fence 规则产出的 mermaid 占位（data-source base64） */
const MERMAID_PLACEHOLDER_RE = /<div class="md-mermaid" data-source="([^"]*)"><\/div>/g

/**
 * 把 markdown 渲染成 segment 数组：text 段（HTML）+ mermaid 段（源码）交替。
 * MarkdownRenderer 用 v-for 渲染：text 走 v-html，mermaid 走 <MermaidRenderer> 组件。
 * 替代 v-html 占位 + Vue render 函数动态挂载的脆弱模式——segments 让 mermaid 成为
 * template 里的正常组件，响应式可靠。
 */
export async function renderMarkdownSegments(content: string): Promise<MarkdownSegment[]> {
  const html = await renderMarkdown(content)
  const segments: MarkdownSegment[] = []
  let lastIndex = 0
  MERMAID_PLACEHOLDER_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MERMAID_PLACEHOLDER_RE.exec(html)) !== null) {
    // 占位之前的 HTML 作为 text 段
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: html.slice(lastIndex, match.index) })
    }
    // mermaid 段：解码 base64 source
    const source = decodeBase64(match[1])
    segments.push({ type: 'mermaid', content: source })
    lastIndex = match.index + match[0].length
  }
  // 剩余 HTML 作为 text 段
  if (lastIndex < html.length) {
    segments.push({ type: 'text', content: html.slice(lastIndex) })
  }
  return segments
}

/** base64 解码（UTF-8 安全，与 encodeBase64 对称） */
export function decodeBase64(b64: string): string {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * 用 shiki 单例高亮一段代码，返回双主题 HTML（带 --shiki-dark/--shiki-light 变量的 span）。
 *
 * 供 CodeBlock.vue / DiffView.vue 等非 markdown 场景复用同一 highlighter 单例。
 * 调用方需 await 首次加载（highlighter 单例建好后，codeToHtml 同步）。
 *
 * XSS 安全（与 markdown fence 规则同论证）：shiki codeToHtml 转义所有非 token 文本，
 * 只发 scoped <span>，输出可由调用方在受控 v-html 点注入。
 *
 * @param code 代码文本
 * @param lang shiki 语言名（未加载的 lang fallback 'typescript'）
 * @returns shiki 产出的 HTML 字串（含 <pre class="shiki">）；未知语言/失败返回 ''
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()
  return highlightShikiSync(hl, code, lang)
}
