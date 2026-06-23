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
 * XSS 安全：markdown-it 关 html:false（不透传用户原始 HTML），shiki codeToHtml 转义所有
 * 非 token 文本（只发 scoped <span>），linkify 自动补全的 <a> 加 rel/target 安全属性。
 */
import MarkdownIt from 'markdown-it'
import { createHighlighter } from 'shiki'
import type { Highlighter } from 'shiki'

/** 代码块高亮覆盖的语言（按 wave review 要点：ts/vue/json/bash/md + 常见派生） */
const SHIKI_LANGS = ['typescript', 'javascript', 'vue', 'json', 'bash', 'shell', 'markdown', 'css', 'html', 'yaml', 'python', 'go', 'rust']

/** 双主题：dark-plus（VSCode 暗默认，review 要求的 VSCode 级高亮）/ light-plus（亮配套） */
const SHIKI_DARK = 'dark-plus'
const SHIKI_LIGHT = 'light-plus'

/** shiki 单例（全局一次，避免重复 WASM/语法加载） */
let highlighterPromise: Promise<Highlighter> | null = null
let cachedMarkdown: MarkdownIt | null = null

/** 获取（惰性创建）shiki highlighter 单例 */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_DARK, SHIKI_LIGHT],
      langs: SHIKI_LANGS,
    })
  }
  return highlighterPromise
}

/**
 * 取（惰性创建）配置好的 markdown-it。highlighter 经 await 后 codeToHtml 同步可用，
 * 故 markdown-it 的 highlight 回调内直接同步调 codeToHtml。
 */
async function getMarkdown(): Promise<MarkdownIt> {
  if (cachedMarkdown) return cachedMarkdown
  const hl = await getHighlighter()
  const md = new MarkdownIt({
    html: false, // 不透传用户原始 HTML（XSS 防线）
    linkify: true, // 自动识别裸 URL
    typographer: true, // 排版引号/省略号
    breaks: false, // 不把单 \n 转 <br>（保留 markdown 语义，软换行由 CSS white-space 处理）
    highlight: (code, lang): string => {
      const resolved = hl.getLoadedLanguages().includes(lang) ? lang : 'typescript'
      try {
        return hl.codeToHtml(code, {
          lang: resolved,
          themes: { dark: SHIKI_DARK, light: SHIKI_LIGHT },
          defaultColor: false,
        })
      } catch {
        // 未知语言/解析失败：返回转义后的 <pre><code>（markdown-it 默认行为）
        return ''
      }
    },
  })
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
  cachedMarkdown = md
  return md
}

/**
 * 把 markdown 文本渲染成 HTML 字符串。
 * 首次调用 await shiki 加载（异步）；之后 markdown-it 实例缓存，渲染同步。
 */
export async function renderMarkdown(content: string): Promise<string> {
  const md = await getMarkdown()
  return md.render(content)
}
