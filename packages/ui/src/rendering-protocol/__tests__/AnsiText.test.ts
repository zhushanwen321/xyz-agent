/**
 * AnsiText 组件测试（W3 · v6 新建）。
 * v6：use_classes=true + 16 fg class 映射 + bg 丢弃 + XSS 转义 + 降级回退。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/AnsiText.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { AnsiUp } from 'ansi_up'
import AnsiText from '../primitives/AnsiText.vue'

const ESC = String.fromCharCode(27)

/** ANSI fg 码 30-37（normal 8 色）+ 90-97（bright 8 色）→ ansi_up class 名映射 */
const FG_CASES: Array<{ code: number; cls: string }> = [
  { code: 30, cls: 'ansi-black-fg' },
  { code: 31, cls: 'ansi-red-fg' },
  { code: 32, cls: 'ansi-green-fg' },
  { code: 33, cls: 'ansi-yellow-fg' },
  { code: 34, cls: 'ansi-blue-fg' },
  { code: 35, cls: 'ansi-magenta-fg' },
  { code: 36, cls: 'ansi-cyan-fg' },
  { code: 37, cls: 'ansi-white-fg' },
  { code: 90, cls: 'ansi-bright-black-fg' },
  { code: 91, cls: 'ansi-bright-red-fg' },
  { code: 92, cls: 'ansi-bright-green-fg' },
  { code: 93, cls: 'ansi-bright-yellow-fg' },
  { code: 94, cls: 'ansi-bright-blue-fg' },
  { code: 95, cls: 'ansi-bright-magenta-fg' },
  { code: 96, cls: 'ansi-bright-cyan-fg' },
  { code: 97, cls: 'ansi-bright-white-fg' },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnsiText', () => {
  it('16 fg class 输出：use_classes=true 时 16 色 ANSI → 对应 ansi-{color}-fg class', () => {
    for (const { code, cls } of FG_CASES) {
      const wrapper = mount(AnsiText, { props: { content: `${ESC}[${code}mX${ESC}[0m` } })
      const html = wrapper.find('[data-testid="ansi-text"]').html()
      expect(html, `code ${code} 应输出 ${cls}`).toContain(cls)
    }
  })

  it('bg class 输出存在但无样式（ansi_up 输出 -bg class，CSS 不定义故丢弃）', () => {
    // ESC[41m = red bg
    const wrapper = mount(AnsiText, { props: { content: `${ESC}[41mX${ESC}[0m` } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    // ansi_up 正常输出 ansi-red-bg class
    expect(html).toContain('ansi-red-bg')
    // bg span 不应有内联 style（CSS 不定义 -bg 规则，ansi_up use_classes 不输出内联色）
    expect(html).not.toContain('style')
    expect(html).not.toContain('background')
    expect(html).not.toContain('color:')
  })

  it('escape_html 默认 true：XSS 输入被转义（<script> → &lt;script&gt;）', () => {
    const wrapper = mount(AnsiText, { props: { content: '<script>alert(1)</scr' + 'ipt>' } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('降级回退：ansi_to_html 抛错时 catch 返回原 content 纯文本', () => {
    const spy = vi.spyOn(AnsiUp.prototype, 'ansi_to_html').mockImplementation(() => {
      throw new Error('parse fail')
    })
    const content = 'raw-fallback-text'
    const wrapper = mount(AnsiText, { props: { content } })
    const el = wrapper.find('[data-testid="ansi-text"]')
    // catch 分支：v-html 注入原 content 文本
    expect(el.text()).toContain(content)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('纯文本无 ANSI：原样输出无 span 着色', () => {
    const wrapper = mount(AnsiText, { props: { content: 'hello world' } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    expect(html).toContain('hello world')
    // 纯文本无 ANSI 着色 span（ansi_up 不生成 class="ansi-* 着色 span）
    expect(html).not.toContain('class="ansi-')
  })
})
