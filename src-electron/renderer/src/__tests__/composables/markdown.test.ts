/**
 * markdown.ts fence 规则覆盖单测（W3，对话流 markdown 渲染增强）。
 *
 * 覆盖代码块增强（语言标签 + 复制按钮 data-code）+ mermaid 占位。
 * mock 策略：vi.mock('shiki') stub createHighlighter 返回假 highlighter，
 * codeToHtml 返回固定 `<pre class="shiki">…</pre>`，使测试聚焦 fence 逻辑而非 shiki 真实渲染。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/markdown.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// stub shiki：避免真实 WASM/语法加载，测试聚焦 fence 包装逻辑
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki', () => ({
  createHighlighter: vi.fn(() =>
    Promise.resolve({
      codeToHtml: fakeCodeToHtml,
      getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
    }),
  ),
}))

// renderMarkdown 内部缓存了 markdown-it 实例（cachedMarkdown）+ highlighter 单例。
// 各用例需独立实例 → 动态 import 后重置模块，或在 beforeEach vi.resetModules + 重新 import。
// 采用 resetModules 方案：每个 it 拿到干净的 markdown 模块。
async function freshRender(content: string): Promise<string> {
  vi.resetModules()
  // 重新 mock（resetModules 会清掉 mock 注册）
  vi.doMock('shiki', () => ({
    createHighlighter: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdown } = await import('@/composables/logic/markdown')
  return renderMarkdown(content)
}

describe('markdown fence 规则覆盖（W3）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('U4: 普通代码块含语言标签 + 复制按钮 + shiki 高亮', async () => {
    const html = await freshRender('```ts\nconst x=1\n```\n')
    expect(html).toContain('class="md-codeblock"')
    expect(html).toContain('class="md-codeblock__lang"')
    expect(html).toContain('>ts<') // 语言标签文本
    expect(html).toContain('class="md-codeblock__copy"')
    expect(html).toContain('data-code="')
    expect(html).toContain('class="shiki"') // shiki 高亮产出
    expect(fakeCodeToHtml).toHaveBeenCalled()
  })

  it('U5: mermaid 块输出占位容器，不调 shiki', async () => {
    const html = await freshRender('```mermaid\ngraph TD;A-->B\n```\n')
    expect(html).toContain('class="md-mermaid"')
    expect(html).toContain('data-source="')
    expect(html).not.toContain('class="shiki"') // mermaid 不走 shiki
    expect(fakeCodeToHtml).not.toHaveBeenCalled()
  })

  it('U5b: mermaid data-source 是 base64 编码（可解码还原源码）', async () => {
    const html = await freshRender('```mermaid\ngraph TD;A-->B\n```\n')
    const m = html.match(/data-source="([^"]+)"/)
    expect(m).not.toBeNull()
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe('graph TD;A-->B\n')
  })

  it('U6: 无语言代码块不报错，标签降级为 text', async () => {
    const html = await freshRender('```\nplain code\n```\n')
    expect(html).toContain('class="md-codeblock__lang"')
    expect(html).toContain('>text<') // 无 lang 降级标签
    expect(html).not.toThrow
  })

  it('U7: 代码含 HTML 注入字符，data-code 为 base64（非原文注入）', async () => {
    const malicious = '"><img onerror=x>'
    const html = await freshRender('```ts\n' + malicious + '\n```\n')
    // data-code 不含原文的危险字符（base64 编码后只有 A-Za-z0-9+/=）
    const m = html.match(/data-code="([^"]+)"/)
    expect(m).not.toBeNull()
    expect(m![1]).not.toContain('<img')
    expect(m![1]).not.toContain('onerror')
    // base64 解码后才是原文
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toContain(malicious)
  })

  it('U8: 普通段落与代码块混合，仅代码块被包容器', async () => {
    const html = await freshRender('正文段落\n\n```ts\ncode\n```\n')
    // 段落正常渲染（<p>），代码块被包 .md-codeblock
    expect(html).toContain('<p>正文段落</p>')
    expect(html).toContain('class="md-codeblock"')
    // 段落文本不被包进 codeblock
    expect(html.indexOf('正文段落')).toBeLessThan(html.indexOf('md-codeblock'))
  })

  it('U9: 含/的文件路径识别为可点击 .md-filepath', async () => {
    const html = await freshRender('修改了 src/foo.ts 文件\n')
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('data-path="')
    // 路径文本在链接内
    expect(html).toContain('>src/foo.ts<')
  })

  it('U10: 单独文件名(无/)不识别，避免误伤版本号/小数', async () => {
    const html = await freshRender('版本 v1.0.0 和 foo.ts\n')
    expect(html).not.toContain('md-filepath')
  })

  it('U11: 文件路径 base64 编码（防 XSS 注入）', async () => {
    const html = await freshRender('见 a/b.ts\n')
    const m = html.match(/data-path="([^"]+)"/)
    expect(m).not.toBeNull()
    // base64 解码后才是路径
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe('a/b.ts')
    // data-path 不含原始路径字符的注入风险（base64 只有 A-Za-z0-9+/=）
    expect(m![1]).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('U12: 行内 code 内的路径不识别为链接', async () => {
    const html = await freshRender('运行 `src/foo.ts` 命令\n')
    // 反引号内是 code token，不应被 filepath rule 消费
    expect(html).not.toContain('md-filepath')
    expect(html).toContain('<code>')
  })
})
