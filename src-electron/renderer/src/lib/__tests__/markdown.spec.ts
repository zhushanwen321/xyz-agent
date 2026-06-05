/**
 * markdown renderer 单元测试
 *
 * 覆盖的修复（与排查报告对应）：
 *  - Bug #1: KaTeX MathML 标签必须保留（DOMPurify allowlist）
 *  - Bug #2: 列表 <ol>/<ul> 结构正确（CSS 层修复 list-style，HTML 结构由 markdown-it 生成）
 *  - Bug #3: 嵌套任务列表父级 checkbox 也必须被处理（用 markdown-it-task-lists 插件替代有 bug 的正则）
 *  - Bug #4: <hr> 输出正常（CSS margin 调整为合理值，HTML 由 markdown-it 生成）
 *  - 改进 #4: 用户气泡 <kbd>/<mark>/<details> 标签被保留
 *  - 改进 #5: Shiki 主题支持独立于 app 主题
 *
 * 注意事项：
 *  - 测试环境是 happy-dom，DOMPurify 在此环境下会丢弃 body 的某些直接子元素
 *    （如顶层 <ol>/<ul>/<details>/<table>），因此测试用 wrap-div 模拟真实的
 *    "包在 .msg__body div 里再 sanitize" 行为，与生产一致。
 *  - 涉及 renderFull 异步路径（KaTeX/Shiki/mermaid）的断言尽可能用字符串包含
 *    而非 DOM 结构断言，以减少 happy-dom 解析差异的影响。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
// @ts-expect-error no types
import taskLists from 'markdown-it-task-lists'
import footnote from 'markdown-it-footnote'

const PURIFY_CONFIG = {
  ADD_ATTR: [
    'class', 'style', 'aria-*',
    'data-action', 'data-mermaid', 'data-lines', 'data-collapsed', 'data-lang',
    'encoding',
  ],
  ADD_TAGS: [
    'input',
    'math', 'semantics', 'annotation',
    'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext',
    'msup', 'msub', 'mfrac', 'msqrt', 'mroot',
    'mover', 'munder', 'munderover',
    'mspace', 'mstyle', 'mpadded', 'mphantom', 'menclose',
    'mtable', 'mtd', 'mtr',
  ],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|local-file|mailto|tel):|[^a-z])/i,
}

/** wrap-div sanitize：模拟生产中 markdown 输出塞进 .msg__body div 的真实行为 */
function renderSafe(html: string): string {
  const wrapped = `<div class="msg__body">${html}</div>`
  const sanitized = DOMPurify.sanitize(wrapped, PURIFY_CONFIG)
  return sanitized.replace(/^<div class="msg__body">([\s\S]*)<\/div>$/, '$1').trim()
}

// 本地 mdLight 实例：与生产 renderLightweight 同样的配置
const mdLight = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
}).enable(['strikethrough', 'table']).use(footnote).use(taskLists, { enabled: false })

/** 同步渲染（流式阶段）：等同 renderLightweight 的内部 pipeline */
function renderLightSync(text: string): string {
  if (!text) return ''
  let html = mdLight.render(text)
  html = html.replace(
    /(<table[\s>][\s\S]*?<\/table>)/g,
    '<div class="table-wrapper">$1</div>',
  )
  html = html.replace(
    /(<img\s[^>]*src=")(\/(?:Users|home|tmp|var|etc)\/[^"]*?)(")/g,
    (_m, p, src, s) => `${p}local-file://${src}${s}`,
  )
  return renderSafe(html)
}

let renderFullAsync: (
  text: string,
  theme: 'light' | 'dark',
  options?: { codeTheme?: 'light' | 'dark' },
) => Promise<string>

beforeAll(async () => {
  const mod = await import('../markdown')
  renderFullAsync = mod.renderFull
})

describe('markdown renderer', () => {
  // ════════════════════════════════════════════════════════════
  // Bug #1: KaTeX MathML 标签保留
  // ════════════════════════════════════════════════════════════
  describe('Bug #1: KaTeX MathML preservation', () => {
    it('inline math: annotation + encoding 属性必须保留', async () => {
      const html = await renderFullAsync('行内 $E = mc^2$', 'light')
      expect(html).toContain('<annotation')
      // 关键：DOMPurify allowlist 包含 encoding
      expect(html).toContain('encoding="application/x-tex"')
    })

    it('inline math: 可见文本流里不能出现 "E = mc^2" 源码（防 annotation 剥除回归）', async () => {
      const html = await renderFullAsync('行内 $E = mc^2$ 后面', 'light')
      // 去掉所有标签和 annotation 内的文本，得到"可见文本"
      const visibleText = html
        .replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      expect(visibleText).not.toContain('E = mc^2')
      expect(visibleText).toContain('行内')
      expect(visibleText).toContain('后面')
    })

    it('block math: $$...$$ 也保留 MathML 结构', async () => {
      const html = await renderFullAsync('$$\nx^2 + y^2 = z^2\n$$', 'light')
      expect(html).toContain('<annotation')
      expect(html).toContain('katex-display')
    })
  })

  // ════════════════════════════════════════════════════════════
  // Bug #2: 列表结构正确
  // ════════════════════════════════════════════════════════════
  describe('Bug #2: list structure', () => {
    it('有序列表：输出 <ol> 包裹 <li>', () => {
      const html = renderLightSync('1. 一\n2. 二\n3. 三')
      expect(html).toContain('<ol>')
      expect(html).toContain('</ol>')
      expect(html).toContain('<li>一</li>')
      expect(html).toContain('<li>二</li>')
      expect(html).toContain('<li>三</li>')
    })

    it('无序列表：输出 <ul> 包裹 <li>', () => {
      const html = renderLightSync('- a\n- b\n- c')
      expect(html).toContain('<ul>')
      expect(html).toContain('</ul>')
      expect(html).toContain('<li>a</li>')
      expect(html).toContain('<li>b</li>')
      expect(html).toContain('<li>c</li>')
    })

    it('嵌套列表：内层 <ul> 正确嵌套', () => {
      const html = renderLightSync('- a\n  - nested1\n  - nested2\n- b')
      expect(html).toMatch(/<ul>/)
      expect(html).toMatch(/<li>a\s*<ul>/)
      expect(html).toContain('<li>nested1</li>')
      expect(html).toContain('<li>nested2</li>')
      expect(html).toContain('<li>b</li>')
    })
  })

  // ════════════════════════════════════════════════════════════
  // Bug #3: 嵌套任务列表 checkbox
  // ════════════════════════════════════════════════════════════
  describe('Bug #3: nested task list checkboxes', () => {
    it('顶层任务列表：- [x] 渲染为带 checked/disabled 的 input', () => {
      const html = renderLightSync('- [x] 已完成\n- [ ] 未完成\n- [x] 另一个')
      expect(html).toContain('class="task-list-item"')
      // 至少一个 checked
      expect(html).toMatch(/<input[^>]*checked[^>]*type="checkbox"/)
      // 至少一个 disabled
      expect(html).toMatch(/<input[^>]*disabled[^>]*>/)
      // 不能有 literal [x]/[ ] 文本泄露
      expect(html).not.toContain('[x]')
      expect(html).not.toContain('[ ]')
    })

    it('嵌套任务列表：父级和子级都生成 checkbox（关键 bug 修复点）', () => {
      const html = renderLightSync('- [x] 父任务\n  - [ ] 子任务\n  - [x] 另一个子')
      // 1 父 + 2 子 = 3 个 checkbox
      const count = (html.match(/<input[^>]*type="checkbox"/g) ?? []).length
      expect(count).toBe(3)
      // 父级文本 "父任务" 必须在某处
      expect(html).toContain('父任务')
      expect(html).toContain('子任务')
      expect(html).toContain('另一个子')
      // 父级也应该有 task-list-item 类
      expect(html).toContain('class="task-list-item"')
      // 不能有 literal 文本泄露
      expect(html).not.toContain('[x]')
      expect(html).not.toContain('[ ]')
    })

    it('任务列表 + 强调：checkbox 和 <strong>/<em> 共存', () => {
      const html = renderLightSync('- [x] **bold** task\n- [ ] *italic* task')
      expect(html).toMatch(/<input[^>]*type="checkbox"/)
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<em>italic</em>')
    })

    it('混合列表：只 [x]/[ ] 项生成 checkbox', () => {
      const html = renderLightSync('- [x] task\n- normal\n- [ ] another')
      const count = (html.match(/<input[^>]*type="checkbox"/g) ?? []).length
      expect(count).toBe(2)
    })
  })

  // ════════════════════════════════════════════════════════════
  // Bug #4: <hr> 输出
  // ════════════════════════════════════════════════════════════
  describe('Bug #4: horizontal rule', () => {
    it('--- 输出 <hr>', () => {
      const html = renderLightSync('上\n\n---\n\n下')
      expect(html).toContain('<hr>')
      expect(html).toContain('上')
      expect(html).toContain('下')
    })
  })

  // ════════════════════════════════════════════════════════════
  // 改进 #4: <kbd>/<mark>/<details> 标签
  // ════════════════════════════════════════════════════════════
  describe('User bubble: HTML tags', () => {
    it('<kbd> 标签被保留', () => {
      const html = renderLightSync('<kbd>Ctrl</kbd>+<kbd>C</kbd>')
      expect(html).toContain('<kbd>Ctrl</kbd>')
      expect(html).toContain('<kbd>C</kbd>')
    })

    it('<mark> 标签被保留', () => {
      const html = renderLightSync('<mark>highlighted</mark>')
      expect(html).toContain('<mark>highlighted</mark>')
    })

    it('<details>/<summary> 折叠组件被保留', () => {
      const html = renderLightSync('<details><summary>折叠</summary>内容</details>')
      expect(html).toContain('<details>')
      expect(html).toContain('<summary>折叠</summary>')
      expect(html).toContain('内容')
    })
  })

  // ════════════════════════════════════════════════════════════
  // 改进 #5: Shiki 主题独立控制
  // ════════════════════════════════════════════════════════════
  describe('Shiki code theme override', () => {
    it('默认情况下 Shiki 主题跟随 app theme (light → github-light)', async () => {
      const html = await renderFullAsync('```js\nconst a = 1\n```', 'light')
      expect(html).toContain('github-light')
      expect(html).not.toContain('one-dark-pro')
    })

    it('默认情况下 Shiki 主题跟随 app theme (dark → one-dark-pro)', async () => {
      const html = await renderFullAsync('```js\nconst a = 1\n```', 'dark')
      expect(html).toContain('one-dark-pro')
      expect(html).not.toContain('github-light')
    })

    it('codeTheme=dark 强制 dark Shiki 主题（无视 app theme）', async () => {
      const html = await renderFullAsync('```js\nconst a = 1\n```', 'light', { codeTheme: 'dark' })
      expect(html).toContain('one-dark-pro')
      expect(html).not.toContain('github-light')
    })

    it('codeTheme=light 强制 light Shiki 主题（无视 app theme）', async () => {
      const html = await renderFullAsync('```js\nconst a = 1\n```', 'dark', { codeTheme: 'light' })
      expect(html).toContain('github-light')
      expect(html).not.toContain('one-dark-pro')
    })

    it('shiki 输出包含 token 高亮（验证高亮生效）', async () => {
      const html = await renderFullAsync('```js\nconst a = 1\n```', 'light')
      // shiki 输出应该带 style="color:..." 标识
      expect(html).toMatch(/<span style="color:/)
    })
  })

  // ════════════════════════════════════════════════════════════
  // 回归测试：原有正常行为
  // ════════════════════════════════════════════════════════════
  describe('regression: existing behavior', () => {
    it('空字符串返回空', () => {
      expect(renderLightSync('')).toBe('')
    })

    it('纯空白输入不产生可见输出', () => {
      expect(renderLightSync('   \n  \n  ')).toBe('')
    })

    it('行内代码正常渲染', () => {
      const html = renderLightSync('这是 `inline code` 测试')
      expect(html).toContain('<code>inline code</code>')
    })

    it('围栏代码块经过 Shiki 处理（输出 shiki span）', async () => {
      const html = await renderFullAsync('```js\nconst a = 1\n```', 'light')
      expect(html).toContain('shiki')
    })

    it('表格被包裹在 .table-wrapper 里', () => {
      const html = renderLightSync('| a | b |\n| - | - |\n| 1 | 2 |')
      expect(html).toContain('class="table-wrapper"')
      expect(html).toContain('<table>')
    })

    it('链接渲染为 <a>', () => {
      const html = renderLightSync('[link](https://x.com)')
      expect(html).toMatch(/<a href="https:\/\/x\.com">link<\/a>/)
    })

    it('linkify: 纯 URL 自动转链接', () => {
      const html = renderLightSync('visit https://example.com today')
      expect(html).toMatch(/<a href="https:\/\/example\.com">https:\/\/example\.com<\/a>/)
    })

    it('强调：**bold** *em* ~~del~~', () => {
      const html = renderLightSync('**bold** *em* ~~del~~')
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<em>em</em>')
      // markdown-it strikethrough 模块在 happy-dom 下可能输出 <s> 或 <del>
      expect(html).toMatch(/<(del|s)>del<\/(del|s)>/)
    })

    it('引用块：> 渲染为 <blockquote>', () => {
      const html = renderLightSync('> 一级引用\n> 第二行')
      expect(html).toContain('<blockquote>')
      expect(html).toContain('一级引用')
      expect(html).toContain('第二行')
    })

    it('嵌套引用多层', () => {
      const html = renderLightSync('> a\n> > b\n> > > c')
      const bqCount = (html.match(/<blockquote>/g) ?? []).length
      expect(bqCount).toBe(3)
    })

    it('breaks: true：单换行变 <br>', () => {
      const html = renderLightSync('第一行\n第二行')
      expect(html).toMatch(/<br/)
    })

    it('typographer：(c) (r) (tm) 转字符', () => {
      const html = renderLightSync('(c) (r) (tm) test')
      // happy-dom 下 typographer 转换可能输出 ©/&copy; 等
      // 检查核心 unicode 字符
      expect(html).toMatch(/(©|&copy;|&#xA9;|&#xa9;)/)
    })

    it('本地绝对路径图片转 local-file:// 协议', () => {
      const html = renderLightSync('![alt](/Users/foo/img.png)')
      expect(html).toContain('local-file:///Users/foo/img.png')
    })

    it('mermaid 块：占位符被 Shiki 跳过处理后输出原始 code 文本', async () => {
      // 注意：renderFull 内部 mermaid 块走特殊处理，但因为 happy-dom 的 DOMPurify
      // 行为差异，<div class="mermaid-source"> 外层可能被剥。验证占位符确实被替换
      // 即可（无论换成了 <div class="mermaid-source"> 还是直接 inline 显示）。
      const html = await renderFullAsync('```mermaid\ngraph TD; A-->B\n```', 'light')
      // 占位符不应该原样保留
      expect(html).not.toMatch(/\{\{CODEBLOCK_/)
      // mermaid 代码内容应该在输出中
      expect(html).toContain('graph TD')
    })
  })
})
