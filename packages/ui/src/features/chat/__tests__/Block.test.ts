/**
 * Block.vue text 分支样式测试（block-rendering M0，TC-M0-4）。
 *
 * [block-rendering M0] 文字样式模型统一：所有 text 全 inline 统一正文级
 * （text-base/leading-7），颜色跟随所属 assistant streaming 态（streaming→neutral-mid，
 * complete/缺省→neutral-fg，单调不随兄弟 message 翻转）。旧「过程文字暗色小字」两级
 * 视觉层级已取消（text-sm/leading-relaxed/恒 neutral-mid 移除）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/Block.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Block } from '@xyz-agent/ui'

function mountTextBlock(streaming?: boolean) {
  return mount(Block, {
    props: {
      type: 'text',
      content: 'hello',
      ...(streaming !== undefined ? { streaming } : {}),
    },
    global: {
      stubs: { MarkdownRenderer: true },
    },
  })
}

describe('block-rendering M0: Block text 分支正文样式（TC-M0-4）', () => {
  it('text 分支统一正文级样式：text-base/leading-7，不含 text-sm/leading-relaxed', () => {
    const wrapper = mountTextBlock()
    const textEl = wrapper.find('.trace-blk > div')
    expect(textEl.classes()).toContain('text-[length:var(--text-base)]')
    expect(textEl.classes()).toContain('leading-7')
    expect(textEl.classes()).not.toContain('text-[length:var(--text-sm)]')
    expect(textEl.classes()).not.toContain('leading-relaxed')
  })

  it('streaming=true → text-neutral-mid（流式暗色）', () => {
    const wrapper = mountTextBlock(true)
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-mid')
  })

  it('streaming=false/缺省 → text-neutral-fg（完成全色）', async () => {
    const wrapper = mountTextBlock(false)
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-fg')
    // 缺省（undefined）同样 fallback 到 fg
    const defaultWrapper = mountTextBlock()
    expect(defaultWrapper.find('.trace-blk > div').classes()).toContain('text-neutral-fg')
    // streaming 布尔切换驱动颜色（单调，不随兄弟 message 翻转）
    // .vue shim 下 VTU setProps 的 $props 类型解析为 attrs-only（Block.vue 自定义 props 不可见），
    // 运行时 setProps 走 Record<string, unknown>，cast 仅为满足 tsc（同 search-modal.test.ts:86 模式）。
    await wrapper.setProps({ streaming: true } as never)
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-mid')
  })
})
