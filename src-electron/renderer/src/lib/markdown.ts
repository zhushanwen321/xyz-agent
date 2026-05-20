// @ts-expect-error markdown-it has no types
import MarkdownIt from 'markdown-it'
// @ts-expect-error markdown-it-texmath has no types
import texmath from 'markdown-it-texmath'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { codeToHtml } from 'shiki'

// ── 主题映射 ──
const SHIKI_THEMES: Record<string, string> = {
  light: 'github-light',
  dark: 'one-dark-pro',
}

/** 代码块超过此行数时自动折叠 */
const COLLAPSE_THRESHOLD = 20

/** 随机 token 生成基数（0-9a-z） */
const TOKEN_BASE = 36
/** 跳过 Math.random().toString() 的 "0." 前缀 */
const TOKEN_SKIP_PREFIX = 2
/** 随机 token 长度（取到第 N 个字符） */
const TOKEN_END = 8

// ── DOMPurify 共享配置：允许代码块/KaTeX/task list 所需的属性和标签 ──
const PURIFY_CONFIG = {
  ADD_ATTR: ['class', 'style', 'aria-*', 'data-action', 'data-mermaid', 'data-lines', 'data-collapsed', 'data-lang'],
  ADD_TAGS: ['input'],
}

// ── 占位符：双花括号形式，markdown-it 不做任何转义，原文保留 ──
const PH_TOKEN = Math.random().toString(TOKEN_BASE).slice(TOKEN_SKIP_PREFIX, TOKEN_END)
const PH_PREFIX = `{{CODEBLOCK_${PH_TOKEN}_`
const PH_SUFFIX = '}}'

interface CodeBlockInfo {
  lang: string
  filename: string
  code: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 解析 fence info 为语言和可选文件名
 * "python:main.py" → { lang: "python", filename: "main.py" }
 */
function parseFenceInfo(info: string): { lang: string; filename: string } {
  const trimmed = info.trim()
  const colonIdx = trimmed.indexOf(':')
  if (colonIdx > 0) {
    return { lang: trimmed.slice(0, colonIdx), filename: trimmed.slice(colonIdx + 1) }
  }
  return { lang: trimmed, filename: '' }
}

// ══════════════════════════════════════════════════════════════
// 阶段一：轻量渲染（同步，用于流式阶段）
// ══════════════════════════════════════════════════════════════

const mdLight = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
}).enable(['strikethrough', 'table'])

// ══════════════════════════════════════════════════════════════
// 阶段二：完整渲染（异步，用于完成阶段）

const mdFull = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
}).enable(['strikethrough', 'table'])

mdFull.use(texmath, {
  engine: katex,
  delimiters: 'dollars',
  katexOptions: { throwOnError: false },
})

export function renderLightweight(text: string): string {
  if (!text) return ''
  let html = mdLight.render(text)
  html = postprocessTables(html)
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/** 向后兼容 */
export const renderMarkdown = renderLightweight

/**
 * 预处理：提取所有 fenced code block，替换为占位符。
 * mermaid 块直接输出专用 div，不走 Shiki。
 */
function preprocessCodeBlocks(src: string): {
  processed: string
  blocks: CodeBlockInfo[]
} {
  const blocks: CodeBlockInfo[] = []

  // 注意：此正则不匹配缩进的 fence（列表/引用内的代码块）。
  // 缩进的代码块会走 markdown-it 默认渲染（无 Shiki 高亮），属于可接受的降级。
  // 匹配 ```lang:filename ... ```
  const fenceRe = /^```([^\n`]*)\n([\s\S]*?)^```$/gm
  const processed = src.replace(fenceRe, (_match, info: string, code: string) => {
    const trimmedInfo = (info as string).trim()

    if (trimmedInfo === 'mermaid') {
      const index = blocks.length
      blocks.push({ lang: 'mermaid', filename: '', code })
      return `${PH_PREFIX}${index}${PH_SUFFIX}`
    }

    const { lang, filename } = parseFenceInfo(trimmedInfo)
    const index = blocks.length
    blocks.push({ lang, filename, code })
    return `${PH_PREFIX}${index}${PH_SUFFIX}`
  })

  return { processed, blocks }
}

/**
 * 后处理：将 markdown-it 输出中的占位符替换为 Shiki 高亮后的完整代码块 HTML
 */
async function postprocessCodeBlocks(
  html: string,
  blocks: CodeBlockInfo[],
  theme: string,
): Promise<string> {
  let result = html

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const placeholder = `${PH_PREFIX}${i}${PH_SUFFIX}`
    let rendered: string
    if (block.lang === 'mermaid') {
      rendered = `<div class="mermaid-source" data-mermaid>${escapeHtml(block.code)}</div>`
    } else {
      rendered = await renderCodeBlock(block, theme)
    }
    // 占位符可能被 markdown-it 包裹在 <p> 中，也处理这种情况
    result = result.replace(new RegExp(`(?:<p>)?${escapeRegex(placeholder)}(?:</p>)?`, 'g'), rendered)
  }

  return result
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Task list 后处理：将 markdown-it 渲染的 checkbox 模式转换为带 input 的 li
 * markdown-it 会把 `- [x] text` 渲染为 `<li>[x] text</li>`
 *
 * 注意：依赖 vanilla markdown-it 不解析 task list 的行为。
 * 如果将来引入 markdown-it-task-lists 插件，需移除此后处理。
 */
function postprocessTaskLists(html: string): string {
  return html.replace(
    /<li>\[(x| )\] (.+?)<\/li>/g,
    (_match, checked: string, text: string) => {
      const isChecked = checked === 'x'
      return `<li class="task-list-item"><input type="checkbox"${isChecked ? ' checked' : ''} disabled>${text}</li>`
    },
  )
}

/**
 * 表格后处理：给 <table> 包裹滚动容器，让宽表格可以水平滚动，窄表格占满宽度
 */
function postprocessTables(html: string): string {
  return html.replace(
    /(<table[\s>][\s\S]*?<\/table>)/g,
    '<div class="table-wrapper">$1</div>',
  )
}

export async function renderFull(text: string, theme: 'light' | 'dark'): Promise<string> {
  if (!text) return ''

  // 阶段 1：预处理提取代码块 → markdown-it 渲染 → task list 后处理
  const { processed, blocks } = preprocessCodeBlocks(text)

  let html = mdFull.render(processed)
  html = postprocessTaskLists(html)

  // 阶段 2：Shiki 高亮替换占位符
  const shikiTheme = SHIKI_THEMES[theme] ?? SHIKI_THEMES['dark']
  html = await postprocessCodeBlocks(html, blocks, shikiTheme)

  // 阶段 3：给 <table> 包裹滚动容器
  html = postprocessTables(html)

  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/**
 * 用 Shiki 高亮单个代码块并包裹为完整的 HTML 结构
 */
async function renderCodeBlock(block: CodeBlockInfo, theme: string): Promise<string> {
  const { lang, filename, code } = block
  const lines = code.split('\n')
  // markdown-it fence content 通常以换行结尾，去掉末尾空行
  const trimmedLines = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const lineCount = trimmedLines.length
  const effectiveLang = lang || 'text'

  let highlightedHtml: string
  try {
    highlightedHtml = await codeToHtml(code, { lang: effectiveLang, theme })
  } catch {
    // 不支持的语言 fallback 到纯文本
    try {
      highlightedHtml = await codeToHtml(code, { lang: 'text', theme })
    } catch {
      highlightedHtml = `<pre><code>${escapeHtml(code)}</code></pre>`
    }
  }

  const lineNumbers = trimmedLines.map((_, i) => i + 1).join('\n')
  const isCollapsed = lineCount > COLLAPSE_THRESHOLD
  const collapseAttr = isCollapsed ? ' data-collapsed="true"' : ''
  const collapseBtn = isCollapsed
    ? '\n  <button class="code-expand-btn" data-action="expand">展开</button>'
    : ''
  const filenameHtml = filename
    ? `\n      <span class="code-block-filename">${escapeHtml(filename)}</span>`
    : ''

  return (
    `<div class="code-block" data-lines="${lineCount}"${collapseAttr}>` +
    '\n  <div class="code-block-header">' +
    `\n      <span class="code-block-lang">${escapeHtml(effectiveLang)}</span>` +
    filenameHtml +
    `\n      <button class="code-copy-btn" data-action="copy">复制</button>` +
    '\n  </div>' +
    '\n  <div class="code-block-body">' +
    `\n    <span class="line-numbers">${lineNumbers}</span>` +
    `\n    ${highlightedHtml}` +
    '\n  </div>' +
    `${collapseBtn}` +
    '\n</div>'
  )
}
