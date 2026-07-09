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
 * 非 token 文本（只发 scoped <span>），linkify 识别的 <a> 加 rel/target 安全属性。
 * linkify fuzzyLink:false：只识别带 scheme（http(s)://、ftp://、//）的 URL，不识别裸域名，
 * 避免 .md/.io 等 ccTLD 把文件名误判成 URL（见 getMarkdown 内注释）。
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
  /** md.render(content, env) 的第二参 env，markdown-it 运行时注入（见 StateInline 构造） */
  env?: MarkdownEnv
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

/**
 * renderMarkdown 的 env 参数：贯穿 inline rule（state.env）+ renderer rule（第 4 参）。
 *
 * - localFiles：当前 session 项目里的文件 basename 集合（如 {'design.md', 'README.md', ...}）。
 *   裸 basename（无 / 前缀，如 design.md）若在此集合里 → 识别为本地文件链接（.md-filepath），
 *   否则维持纯文本（linkify fuzzyLink:false 已让裸域名不当 URL）。
 *   数据源：fileSearchStore 的全量递归 file.search 结果，扁平化为 basename Set。
 *   首渲染时可能为空集（fileSearch 未加载）→ basename 降级纯文本，加载完成后响应式重渲染。
 */
export interface MarkdownEnv {
  localFiles?: Set<string>
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
    linkify: true, // 自动识别 URL（识别范围由下方 fuzzyLink:false 收紧）
    typographer: true, // 排版引号/省略号
    // breaks:true：单 \n 转 <br>，让用户气泡里软换行可见（不靠 CSS whitespace-pre-wrap）。
    // [HISTORICAL] 曾用 breaks:false + 气泡外层 whitespace-pre-wrap 兜底软换行，但 pre-wrap
    // 会把 markdown-it 产出的块级元素间 \n（如 <ol>\n<li>）也渲染成可见空行，导致编号列表
    // 项之间多出空行。改 breaks:true 后软换行显式变 <br>，HTML 结构 \n 走默认 normal 折叠，
    // 块级结构不再被 pre-wrap 污染。breaks 只影响段落内单 \n，代码块/表格等块级规则不受影响。
    breaks: true,
    // 不配 highlight 回调：fence 走下方自定义规则，完全自控（避免双重逻辑）
  })

  // 关掉 fuzzyLink（无 scheme 的裸域名匹配）：linkify-it 把 ccTLD（如 .md=马其顿、.io=英属印度洋
  // 领地）当 TLD，导致 design.md / foo.io 这类**裸文件名**被误识别成 http://design.md 链接，
  // 点击走 openExternal 打开浏览器。AI 输出里真正的 URL 几乎都带 http(s):// scheme，
  // 关掉 fuzzyLink 只损失 www.xxx.com 这类裸域名识别（少见且歧义大），换取文件名不被误判。
  // 显式 scheme（http://、https://、ftp://、//）的 URL 仍正常识别。
  md.linkify.set({ fuzzyLink: false })

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

  // ── 文件路径识别：含 / 的路径片段 → 可点击 <a data-path> ──
  // 两层覆盖，确保正文裸路径与反引号 `src/foo.ts` 内路径都能点击：
  //  1. filepath inline rule（在 text 前）：拦截正文裸路径，push filepath_open/text/close token
  //  2. code_inline renderer 覆盖：反引号内路径也链接化。backticks rule 先于 filepath rule
  //     执行，反引号内容被消费成 code_inline token，filepath rule 接触不到——只能在渲染期二次识别
  // AI 用反引号标注文件路径是 markdown 惯例，最该可点击的恰恰是这些反引号内的路径。
  // @types/markdown-it 未暴露 md.inline.ruler，运行时确存在（parser_inline.mjs）。用结构类型断言。
  ;(md as unknown as InlineRulerHost).inline.ruler.before('text', 'filepath', filepathRule)
  // 自定义 token type 的 renderer：输出 <a class="md-filepath" data-path="...">
  // data-path base64 编码（与 code/mermaid 同 XSS 防线，防引号注入）
  md.renderer.rules.filepath_open = (tokens, idx) => {
    const path = tokens[idx].attrGet('data-path') ?? ''
    return `<a class="md-filepath" data-path="${path}">`
  }
  md.renderer.rules.filepath_close = () => '</a>'
  // 反引号内路径链接化：覆盖 code_inline renderer，内容跑 linkifyFilePathsHtml，
  // 产出 <code>...<a class="md-filepath" data-path="...">path</a>...</code>——
  // 保留等宽 code 视觉，路径可点击（点击处理统一走 useMarkdownInteractions）。
  md.renderer.rules.code_inline = (tokens, idx, _options, env) => {
    return `<code>${linkifyFilePathsHtml(tokens[idx].content, (env as MarkdownEnv | undefined)?.localFiles)}</code>`
  }

  cachedMarkdown = md
  return md
}

/**
 * 文件路径识别正则（filepath inline rule 与 code_inline 二次识别共用）。
 *
 * 匹配「至少含一个 / 且以源码扩展名结尾」的路径片段。三条判别：
 *  1. 至少一个路径分隔符 / —— 单独 foo.ts（无 /）不识别，避免误伤版本号/小数/普通词
 *  2. 扩展名前瞻 (?=\d*[a-zA-Z]) 要求至少含一个字母 —— 纯数字扩展名 .2/.0 不识别，
 *     挡掉模型名（glm-5.2）、版本号（node/18.0）、小数（pi/3.14）等 a/b.<数字> 形态；
 *     .7z 这类数字开头的真实扩展名仍可匹配（前瞻只要求「数字之后必有字母」）
 *  3. 可选前缀 (?:~\/|\/)? —— 支持绝对路径（/var/folders/.../x.md）和家目录路径
 *     （~/Code/project/foo.ts）。不加此前缀时，以 / 开头的路径在起点匹配失败，
 *     等 markdown-it inline 解析器把 pos 推进到路径中间的 _ 等 punctuation 时，
 *     state.src.slice(pos) 的 ^ 分支让后半段被误识别为路径起点（只匹配后半段）。
 */
// 字符集内 `-` 转义为 `\-`（防 `_-`/`/-` 倒序范围触发 "Range out of order"）
// g 标志 + 捕获组 1 = 路径（含可选前缀，去掉前导边界符）。前导边界符：行首或空白/括号/引号/标点。
const FILEPATH_RE = /(?:^|[\s(>"'(\[,{;:])((?:~\/|\/)?[a-zA-Z0-9._\-]+(?:\/[a-zA-Z0-9._\-]+)+\.(?=\d*[a-zA-Z])[a-zA-Z0-9]{1,8})(?![a-zA-Z0-9._\-/])/g

/**
 * 裸 basename 识别正则（无 / 前缀的文件名，如 design.md / README.md）。
 *
 * 与 FILEPATH_RE 的差异：去掉 `(?:\/[a-zA-Z0-9._\-]+)+` 段（不要求含 /）。
 * 扩展名前瞻与 FILEPATH_RE 一致（要求数字之后必有字母，挡掉版本号/小数）。
 *
 * 用途：filepathRule 内 FILEPATH_RE 匹配失败后，用此正则扫 basename 候选，
 * 再过滤 state.env.localFiles 集合——只在「项目里真有该文件」时识别为本地文件链接，
 * 避免误把 design.md 这类裸文件名当 URL（linkify fuzzyLink:false 已让裸域名不当 URL，
 * 但也导致裸 basename 默认是纯文本不可点击，此正则 + localFiles 集合打开识别通道）。
 */
const BASENAME_RE = /(?:^|[\s(>"'(\[,{;:])([a-zA-Z0-9._\-]+\.(?=\d*[a-zA-Z])[a-zA-Z0-9]{1,8})(?![a-zA-Z0-9._\-/])/g

function filepathRule(state: InlineState, silent: boolean): boolean {
  const pos = state.pos
  // 从当前 pos 起搜索第一个含/路径或裸 basename。text rule 会一次吃掉整段非 terminator 文本
  // （空格不是 terminator），故本规则必须在 text 之前主动扫描并拦截路径。
  const rest = state.src.slice(pos)
  FILEPATH_RE.lastIndex = 0
  let match = FILEPATH_RE.exec(rest)
  // 含/路径未命中时，尝试裸 basename（仅在 env.localFiles 非空时，避免无谓扫描）
  if (!match && state.env?.localFiles && state.env.localFiles.size > 0) {
    BASENAME_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BASENAME_RE.exec(rest)) !== null) {
      if (state.env.localFiles.has(m[1])) {
        match = m
        break
      }
    }
  }
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
  // data-path 存 path（含/路径场景）或 basename（裸 basename 场景），base64 编码
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
 * 在已转义的 code_inline HTML 文本中识别文件路径，包成可点击 <a class="md-filepath">。
 *
 * code_inline renderer 用：反引号内容被 backticks rule 消费成 code_inline token，
 * filepath inline rule 接触不到（backticks 先于 filepath 执行），只能在渲染期二次识别。
 *
 * 输入是已 escapeHtml 的文本（renderer 拿到的 token.content 是原文，但 code_inline 的输出
 * 会直接进 HTML，所以这里对非路径片段先 escape 再拼接）。匹配到的路径同样 escapeHtml，
 * data-path 用 base64 编码（与 filepath rule 一致的 XSS 防线）。
 */
function linkifyFilePathsHtml(content: string, localFiles?: Set<string>): string {
  // FILEPATH_RE 前导边界符含 [;: 等，但 code_inline 内容是孤立片段——
  // 为让行首即路径（如 `src/foo.ts`，反引号内就一个路径，前面无边界符）也能识别，
  // 用「相同正则」对原文跑一次：FILEPATH_RE 已含 ^ 行首分支，能覆盖这种情况。
  // localFiles 非空时，额外用 BASENAME_RE 扫裸 basename（与 filepathRule 对称）。
  FILEPATH_RE.lastIndex = 0
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null
  // 收集所有命中（含/路径 + localFiles 里的裸 basename），按 index 排序后顺序拼接
  const hits: Array<{ index: number; leadLen: number; path: string }> = []
  while ((match = FILEPATH_RE.exec(content)) !== null) {
    const leadLen = match[0].length - match[1].length
    hits.push({ index: match.index, leadLen, path: match[1] })
  }
  if (localFiles && localFiles.size > 0) {
    BASENAME_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BASENAME_RE.exec(content)) !== null) {
      if (localFiles.has(m[1])) {
        const leadLen = m[0].length - m[1].length
        hits.push({ index: m.index, leadLen, path: m[1] })
      }
    }
  }
  hits.sort((a, b) => a.index - b.index)
  for (const hit of hits) {
    const pathStart = hit.index + hit.leadLen
    const pathEnd = pathStart + hit.path.length
    // 跳过与上一命中重叠的（含/路径与 basename 同位时，含/优先已在前，basename 在后被 pathStart<lastIndex 过滤）
    if (pathStart < lastIndex) continue
    // 前置文本（含边界符）转义后追加
    if (pathStart > lastIndex) {
      result += escapeHtml(content.slice(lastIndex, pathStart))
    }
    // 路径片段包成 .md-filepath 链接（data-path base64，路径文本 escapeHtml）
    result += `<a class="md-filepath" data-path="${encodeBase64(hit.path)}">${escapeHtml(hit.path)}</a>`
    lastIndex = pathEnd
  }
  // 剩余文本转义后追加
  if (lastIndex < content.length) {
    result += escapeHtml(content.slice(lastIndex))
  }
  // 无匹配时整段 escape（等价于原 code_inline 默认行为）
  return result || escapeHtml(content)
}

/**
 * 把 markdown 文本渲染成 HTML 字符串。
 * 首次调用 await shiki 加载（异步）；之后 markdown-it 实例缓存，后续渲染同步。
 * @param env 透传给 markdown-it inline rule + renderer rule（见 MarkdownEnv）
 */
export async function renderMarkdown(content: string, env?: MarkdownEnv): Promise<string> {
  const md = await getMarkdown()
  // trimEnd：markdown-it 输出末尾带格式化 \n（如 "<p>hi</p>\n"），在 whitespace-pre-wrap
  // 容器里会被渲染成可见空行（用户气泡比实际内容多一行）。HTML 结构不受影响（块级元素
  // 末尾的空白文本节点是无意义的）。
  return md.render(content, env ?? {}).trimEnd()
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
export async function renderMarkdownSegments(content: string, env?: MarkdownEnv): Promise<MarkdownSegment[]> {
  const html = await renderMarkdown(content, env)
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
