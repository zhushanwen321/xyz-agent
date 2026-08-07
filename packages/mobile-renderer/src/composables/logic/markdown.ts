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
 */
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import { createHighlighter } from 'shiki'
import type { Highlighter } from 'shiki'
import i18n from '@/i18n'

const t = i18n.global.t

/**
 * renderMarkdown 的 env 参数：贯穿 core rule（state.env）+ renderer rule（第 4 参）。
 *
 * - filePaths：当前 session 项目里文件的**完整路径**集合（如 {'src/index.ts', 'packages/x.ts'}）。
 *   含/路径识别的白名单——正文里的裸路径（如 src/foo.ts）必须命中此集合才链接化。
 *   数据源：fileSearchStore 的全量递归 file.search 结果（FileNode[]），扁平化为 FileNode.path Set。
 * - localFiles：当前 session 项目里文件的 **basename** 集合（如 {'design.md', 'README.md'}）。
 *   裸 basename（无 / 前缀，如 design.md）识别的白名单。
 *   数据源：同上，扁平化为 FileNode.name Set。
 *
 * 两者首渲染时可能为空集（fileSearch 未加载）→ 路径降级纯文本，加载完成后响应式重渲染。
 */
export interface MarkdownEnv {
  /** 含/路径识别的白名单（FileNode.path 集合，相对 cwd，无前导 /） */
  filePaths?: Set<string>
  /** 裸 basename 识别的白名单（FileNode.name 集合） */
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
      `<button class="md-codeblock__copy" data-code="${dataCode}" type="button" title="${t('composable.copyLabel')}"></button>` +
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

  // ── 文件路径识别（core rule，注册于 replacements 之后） ──
  // [HISTORICAL] 架构选型（2026-07-20 重构）：
  // 旧实现用 inline rule 在 `text` rule 之前抢跑、扫 state.src.slice(pos) 整段剩余文本，
  // 命中后 push filepath_open/text/close token。这会切断 emphasis 配对所需的 text 序列连续性
  // ——markdown-it 的 emphasis 配对在 inline parser 的 ruler2 后处理阶段（balance_pairs +
  // emphasis.postProcess），要求 ** 开/闭在同一连续 text token 序列里。被 filepath token 切断后
  // 配对失败，整段 **xxx** 降级为字面 **（P0 bug：**折中** 不加粗，实测同段所有 emphasis 全失效）。
  //
  // 新实现改为 core rule（注册于 replacements 之后）：此时 emphasis 已配对完毕，token 树里
  // **bold** 已是 strong_open/text/strong_close 三段。本 rule 遍历 inline token 的 children，
  // 对 text token 的 .content 做候选扫描 + 白名单校验，命中则把该 text token 拆成
  // [text(前缀), link_open, text(路径), link_close, text(后缀)]。拆分发生在「已确定无 emphasis
  // 边界的纯 text token 内部」，不影响任何相邻 strong/emphasis/code/link token 的开闭配对
  // （那些配对在更外层已成立）。PoC 实测验证 emphasis 完整保留。
  //
  // 误识别防御从「正则前瞻/后顾堆 hack」改为「数据白名单」：env.filePaths（含/路径）+
  // env.localFiles（裸 basename）任一命中才链接化。pi/3.14、glm-5.2、node/18.0、
  // necessity/sufficiency 全部因不在项目文件集合里被否决，无需任何正则 hack。
  md.core.ruler.after('replacements', 'filepath', filepathCoreRule)

  // 反引号内路径链接化：覆盖 code_inline renderer。backticks rule 在 inline 解析期把反引号内容
  // 消费成 code_inline token，core rule 接触不到（code_inline 不是 text），只能在渲染期二次识别。
  // 走与 core rule 对称的候选正则 + 白名单（env 透传），产出
  // <code>...<a class="md-filepath" data-path="...">path</a>...</code>——
  // 保留等宽 code 视觉，路径可点击（点击处理统一走 useMarkdownInteractions）。
  md.renderer.rules.code_inline = (tokens, idx, _options, env) => {
    const mdEnv = env as MarkdownEnv | undefined
    return `<code>${linkifyFilePathsHtml(tokens[idx].content, mdEnv?.filePaths, mdEnv?.localFiles)}</code>`
  }

  cachedMarkdown = md
  return md
}

/**
 * 含/路径候选正则（filepath core rule 与 code_inline 二次识别共用）。
 *
 * [HISTORICAL] 2026-07-20 架构重构：旧 FILEPATH_RE 是「严格防御型」——含段含字母前瞻、
 * 绝对路径必须有扩展名、可选前缀 ~/ / 等一堆 hack（为在「无白名单」语义下区分真路径 vs
 * 版本号/小数/模型名）。重构后误识别防御改为「数据白名单」（env.filePaths），正则退化为
 * 「宽松候选型」：只做形似路径的廉价预筛，存在性判断交给白名单。pi/3.14、glm-5.2、
 * node/18.0、necessity/sufficiency 全部因不在白名单被否决，正则无需任何前瞻/后顾防御。
 *
 * 匹配规则：[前导边界符或行首] + 可选 ~/ 或 / 前缀 + 2+ 段标识符（每段 [a-zA-Z0-9._-]+，段间用 / 连接）。
 * 前导边界符集合：空白 / 半角括号 / 引号 / 方括号 / 逗号 / 分号 / 冒号。
 * 可选前缀支持三种路径形态：相对路径（src/foo.ts）、绝对路径（/var/x.md）、家目录路径（~/Code/p.ts）。
 * 捕获组 1 = 边界符（行首命中时为空字符串 ''），捕获组 2 = 路径（含可选 ~/ / 前缀）。
 *
 * 线性无回溯（单层量词 (?:...)+ 外层无嵌套量词），无 ReDoS 风险。AC-9 静态结构断言防护。
 *
 * 不在此正则处理：
 *  - 裸 basename（无 /）：走 BASENAME_CANDIDATE_RE + env.localFiles 白名单
 *  - 反引号内路径：code_inline renderer 独立通路（渲染期二次识别，不走 core rule）
 */
// 字符集含 `-`（转义 `\-` 防 range 警告）。g 标志 + 捕获组 2 = 路径（无前导边界符）。
export const PATH_CANDIDATE_RE = /(^|[\s(>"'\[,{;:])(~?\/?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)(?![a-zA-Z0-9._\/-])/g

/**
 * 裸 basename 候选正则（必须有扩展名，避免误伤普通词）。
 *
 * 与 PATH_CANDIDATE_RE 的差异：去掉 (?:\/...)+ 段（不要求含 /）。
 * 扩展名必须以字母开头（`\.[a-zA-Z][a-zA-Z0-9]{1,8}`），挡住 version 18.0、3.14 这类
 * 纯数字扩展名。最终是否链接由 env.localFiles 白名单决定（与 PATH_CANDIDATE_RE 对称）。
 * 捕获组结构与 PATH_CANDIDATE_RE 一致（组1=边界符，组2=basename）。
 */
export const BASENAME_CANDIDATE_RE = /(^|[\s(>"'\[,{;:])([a-zA-Z0-9._-]+\.[a-zA-Z][a-zA-Z0-9]{1,8})(?![a-zA-Z0-9._\/-])/g

/** 路径命中（含/路径或裸 basename），供 core rule 与 code_inline renderer 共用 */
interface PathHit {
  /** 路径起点在 content 中的索引（已减去前导边界符） */
  start: number
  /** 路径终点在 content 中的索引（exclusive） */
  end: number
  /** 命中的路径文本（含/路径场景为完整路径；裸 basename 场景为 basename） */
  path: string
}

/**
 * 从一次正则 exec 结果提取 PathHit。
 * PATH_CANDIDATE_RE / BASENAME_CANDIDATE_RE 捕获组结构一致：组1=边界符（行首时 ''），组2=路径。
 */
function extractHit(m: RegExpExecArray): PathHit {
  const path = m[2] ?? ''
  const leadLen = (m[1] ?? '').length
  const start = m.index + leadLen
  return { start, end: start + path.length, path }
}

/**
 * 扫描 content，返回白名单内的路径命中。
 *
 * - 含/路径：PATH_CANDIDATE_RE 候选 + env.filePaths 白名单校验
 * - 裸 basename：BASENAME_CANDIDATE_RE 候选 + env.localFiles 白名单校验
 *
 * 白名单任一为空集（fileSearch 未加载）则对应识别通路关闭（降级纯文本，无回归）。
 * 返回结果按 start 升序排列，重叠命中以含/路径优先（裸 basename 同位的被丢弃）。
 */
function collectPathHits(content: string, env?: MarkdownEnv): PathHit[] {
  const hits: PathHit[] = []
  const pathSet = env?.filePaths
  const basenameSet = env?.localFiles

  if (pathSet && pathSet.size > 0) {
    PATH_CANDIDATE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATH_CANDIDATE_RE.exec(content)) !== null) {
      const hit = extractHit(m)
      if (hit.path && pathSet.has(hit.path)) hits.push(hit)
    }
  }
  if (basenameSet && basenameSet.size > 0) {
    BASENAME_CANDIDATE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BASENAME_CANDIDATE_RE.exec(content)) !== null) {
      const hit = extractHit(m)
      if (hit.path && basenameSet.has(hit.path)) hits.push(hit)
    }
  }
  hits.sort((a, b) => a.start - b.start)
  // 丢弃重叠：start 相同时含/路径先入（sort 稳定 + 含/路径 push 在前），后入的被过滤
  return hits.filter((h, i) => i === 0 || h.start >= hits[i - 1].end)
}

/** markdown-it Token 构造器的类型（用 new 签名保留构造能力；nesting 类型与 Token 一致： 1 | 0 | -1） */
type TokenCtor = new (type: string, tag: string, nesting: 1 | 0 | -1) => Token

/** 构造单个 text token */
function makeTextToken(TokenCtor: TokenCtor, content: string): Token {
  const t = new TokenCtor('text', '', 0)
  t.content = content
  return t
}

/** 构造 md-filepath 链接三件套 [link_open, text, link_close] */
function makeFilepathLink(TokenCtor: TokenCtor, path: string): Token[] {
  const open = new TokenCtor('link_open', 'a', 1)
  // data-path base64 编码（与 code_inline / mermaid 同 XSS 防线，防引号注入）
  open.attrs = [
    ['class', 'md-filepath'],
    ['data-path', encodeBase64(path)],
  ]
  const text = new TokenCtor('text', '', 0)
  text.content = path
  const close = new TokenCtor('link_close', 'a', -1)
  return [open, text, close]
}

/**
 * 文件路径识别 core rule（注册于 replacements 之后）。
 *
 * 此时 emphasis 已在 inline parser 的 ruler2 后处理阶段配对完毕。本 rule 遍历所有 inline token
 * 的 children，对 text token 的 .content 做候选扫描 + 白名单校验，命中则把该 text token 拆成
 * [text(前缀), link_open, text(路径), link_close, text(后缀)]。
 *
 * 安全性（emphasis 不被破坏）：拆分发生在「已确定无 emphasis 边界的纯 text token 内部」——
 * emphasis 的 ** 已在更早阶段被剥离为 strong_open/close，此处的 text token 是独立纯文本段。
 * 拆分它等于在该纯文本内部插 link，不影响任何相邻 strong/emphasis/code/link 的开闭配对。
 *
 * 跳过 code_inline / link 内部的 text：code_inline 是独立 token 类型不进入本 rule；
 * link_open/close 内部的 text 通过遍历时的 inLink 标志跳过（避免 <a> 嵌套 <a> 产生非法 HTML）。
 */
function filepathCoreRule(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue
    const newChildren: Token[] = []
    let inLink = false
    for (const child of token.children) {
      if (child.type === 'link_open') {
        inLink = true
        newChildren.push(child)
        continue
      }
      if (child.type === 'link_close') {
        inLink = false
        newChildren.push(child)
        continue
      }
      if (child.type !== 'text' || inLink) {
        newChildren.push(child)
        continue
      }
      rewriteTextToken(child, newChildren, state.Token, state.env)
    }
    token.children = newChildren
  }
}

/** 把单个 text token 按白名单命中拆分为多个 token（无命中则原样 push）。 */
function rewriteTextToken(
  textToken: Token,
  out: Token[],
  TokenCtor: TokenCtor,
  env?: MarkdownEnv,
): void {
  const content = textToken.content
  const hits = collectPathHits(content, env)
  if (hits.length === 0) {
    out.push(textToken)
    return
  }
  let last = 0
  for (const hit of hits) {
    if (hit.start > last) {
      out.push(makeTextToken(TokenCtor, content.slice(last, hit.start)))
    }
    for (const t of makeFilepathLink(TokenCtor, hit.path)) {
      out.push(t)
    }
    last = hit.end
  }
  if (last < content.length) {
    out.push(makeTextToken(TokenCtor, content.slice(last)))
  }
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
 * 在 code_inline 的内容里识别文件路径，包成可点击 <a class="md-filepath">。
 *
 * code_inline renderer 用：反引号内容被 backticks rule 消费成 code_inline token，
 * filepath core rule 接触不到（code_inline 不是 text token），只能在渲染期二次识别。
 *
 * 复用 collectPathHits（与 core rule 对称的候选正则 + 白名单），产出
 * <code>...<a class="md-filepath" data-path="...">path</a>...</code>——
 * 保留等宽 code 视觉，路径可点击。非路径片段 escapeHtml，data-path base64 编码
 * （与 core rule 一致的 XSS 防线）。
 */
function linkifyFilePathsHtml(content: string, filePaths?: Set<string>, localFiles?: Set<string>): string {
  const hits = collectPathHits(content, { filePaths, localFiles })
  if (hits.length === 0) return escapeHtml(content)
  let result = ''
  let lastIndex = 0
  for (const hit of hits) {
    if (hit.start > lastIndex) {
      result += escapeHtml(content.slice(lastIndex, hit.start))
    }
    result += `<a class="md-filepath" data-path="${encodeBase64(hit.path)}">${escapeHtml(hit.path)}</a>`
    lastIndex = hit.end
  }
  if (lastIndex < content.length) {
    result += escapeHtml(content.slice(lastIndex))
  }
  return result
}

/**
 * 把 markdown 文本渲染成 HTML 字符串。
 * 首次调用 await shiki 加载（异步）；之后 markdown-it 实例缓存，后续渲染同步。
 * @param env 透传给 markdown-it inline rule + renderer rule（见 MarkdownEnv）
 */
export async function renderMarkdown(content: string, env?: MarkdownEnv): Promise<string> {
  const md = await getMarkdown()
  // trimEnd：markdown-it 输出末尾带格式化 \n（如 "<p>hi</p>\n"），防御性清理。
  // breaks:true 后软换行走 <br>，不再依赖 pre-wrap 容器，但末尾空白文本节点无意义，保留清理。
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
