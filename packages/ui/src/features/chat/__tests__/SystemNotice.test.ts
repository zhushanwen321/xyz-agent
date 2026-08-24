/**
 * SystemNotice.vue 组件测试（U2b 定向气泡渲染）。
 *
 * 覆盖（composer-symbol-system §3.3.3a）：
 * - subagent-directive custom message（reload 形态：role system + customType + details +
 *   display:true）→ 渲染「→ @slug：text」定向气泡 DOM（左对齐轻量样式，testid 锚定）
 * - parseSubagentDirective 返回 null（details 畸形）→ 不渲染定向气泡，降级兜底 system 行
 *   （消息不静默消失——「渲染过滤不丢消息」规则 9）
 * - 普通 compactionSummary 消息 → 现有 system 行形态不受影响（回归）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/SystemNotice.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { SystemNotice } from '@xyz-agent/ui'
import type { Message } from '@xyz-agent/shared'

const NOW = Date.now()

/** 构造 reload 形态的 subagent-directive Message（mapSessionEntries 覆写 display:true 后的投影） */
function directiveMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'cm-1',
    role: 'system',
    customType: 'subagent-directive',
    content: '刚才的测试结果再展开讲讲',
    details: { subagentId: 'rec-1', slug: 'build-api', direction: 'user' },
    display: true,
    status: 'complete',
    timestamp: NOW,
    ...over,
  } as Message
}

describe('SystemNotice subagent 定向气泡（U2b）', () => {
  it('subagent-directive 消息 → 渲染「@slug：text」定向气泡 DOM（slug 高亮 + 正文可见）', () => {
    const wrapper = mount(SystemNotice, { props: { message: directiveMessage() } })
    const bubble = wrapper.find('[data-testid="subagent-directive-bubble"]')
    expect(bubble.exists()).toBe(true)
    // slug 高亮（accent 色 mono）+ 文本正文都在用户可见 DOM 中
    const slug = bubble.find('[data-testid="subagent-directive-slug"]')
    expect(slug.text()).toBe('@build-api')
    expect(slug.classes()).toContain('text-accent')
    expect(bubble.text()).toContain('刚才的测试结果再展开讲讲')
    // 定向气泡形态区别于普通 system 行（无居中两侧横线结构）
    expect(wrapper.find('.system-notice').exists()).toBe(false)
  })

  it('details 畸形（parseSubagentDirective null）→ 不渲染定向气泡，降级兜底 system 行', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: directiveMessage({ details: { subagentId: 123 }, content: '畸形留痕' }),
      },
    })
    expect(wrapper.find('[data-testid="subagent-directive-bubble"]').exists()).toBe(false)
    // 兜底 system 行仍可见（消息不静默消失）：居中行 + content 文本
    const fallback = wrapper.find('.system-notice')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toContain('畸形留痕')
  })

  it('content 空串（防御场景：parse 契约「content 非 string 时 text 归空串」的合法对应态）→ 气泡仍渲染，携带 @slug 去向', () => {
    const wrapper = mount(SystemNotice, {
      props: { message: directiveMessage({ content: '' }) },
    })
    const bubble = wrapper.find('[data-testid="subagent-directive-bubble"]')
    expect(bubble.exists()).toBe(true)
    expect(bubble.find('[data-testid="subagent-directive-slug"]').text()).toBe('@build-api')
  })

  it('compactionSummary 消息 → 现有 system 行形态（回归，不进定向分支）', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: {
          id: 'sys-1',
          role: 'system',
          content: '',
          status: 'complete',
          timestamp: NOW,
          compactionSummary: { summary: '已压缩', tokensBefore: 1000 },
        } as Message,
      },
    })
    expect(wrapper.find('[data-testid="subagent-directive-bubble"]').exists()).toBe(false)
    expect(wrapper.find('.system-notice').exists()).toBe(true)
  })
})
