/**
 * ComposerInput.getText 单测 —— contenteditable 文本提取（换行保留 + chip 过滤）。
 *
 * 重点回归：Shift+Enter 产生的 <br> 必须提取为 \n，否则发送文本丢失软换行，
 * 用户气泡无法保留换行（whitespace-pre-wrap 容器内 <p>...</p> 里的 \n 不再可见）。
 *
 * mock 策略：happy-dom 支持 TreeWalker + createTreeWalker。直接 mount ComposerInput，
 * 设 [role="textbox"] 的 innerHTML 构造 contenteditable DOM，调 vm.getText() 断言。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/composer-input-get-text.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ComposerInput from '@/components/panel/ComposerInput.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ComposerInput.getText（换行保留 + chip × 过滤）', () => {
  /**
   * 构造 contenteditable 内容：直接写 innerHTML 到 [role="textbox"] div。
   * 返回该 div 的 element（调用方需要时可进一步断言 DOM 结构）。
   */
  function setup(html: string): ReturnType<typeof mount> {
    const wrapper = mount(ComposerInput)
    const div = wrapper.find('[role="textbox"]')
    ;(div.element as HTMLDivElement).innerHTML = html
    return wrapper
  }

  it('纯文本：原样返回', () => {
    const wrapper = setup('hello world')
    expect(wrapper.vm.getText()).toBe('hello world')
  })

  it('<br> 保留为 \\n（Shift+Enter 产生的换行不丢失）', () => {
    const wrapper = setup('line1<br>line2')
    expect(wrapper.vm.getText()).toBe('line1\nline2')
  })

  it('多个 <br> 保留多个 \\n', () => {
    const wrapper = setup('a<br><br>b')
    expect(wrapper.vm.getText()).toBe('a\n\nb')
  })

  it('末尾 <br> 保留（用户敲 Shift+Enter 后未输文字，发送时换行应可见）', () => {
    const wrapper = setup('text<br>')
    expect(wrapper.vm.getText()).toBe('text\n')
  })

  it('slash-chip 文本读入（命令名作为发送文本前缀）', () => {
    // chip label 文本 /goal 会被 getText 读入，与 composer 发送时 chip 扁平化一致
    const wrapper = setup('<span class="slash-chip"><span class="chip-label">/goal</span></span> do something')
    expect(wrapper.vm.getText()).toBe('/goal do something')
  })

  it('chip × 按钮文本不混入发送内容', () => {
    // × 按钮在 chip 内，其 "×" 文本必须被 TreeWalker 跳过
    const wrapper = setup('<span class="slash-chip"><span class="chip-label">/goal</span><span class="chip-x">×</span></span>')
    expect(wrapper.vm.getText()).toBe('/goal')
  })

  it('chip + 后续 <br> 换行：命令名 + 软换行 + 后续文本', () => {
    const wrapper = setup('<span class="slash-chip"><span class="chip-label">/goal</span><span class="chip-x">×</span></span><br>详细描述')
    expect(wrapper.vm.getText()).toBe('/goal\n详细描述')
  })

  it('nbsp 转普通空格，零宽空格过滤', () => {
    // chip 后插的零宽空格（\u200B）作光标锚点，发送时必须过滤
    // nbsp（\u00A0）转普通空格，与 textarea 行为对齐
    const wrapper = setup('a\u00A0b\u200Bc')
    expect(wrapper.vm.getText()).toBe('a bc')
  })
})
