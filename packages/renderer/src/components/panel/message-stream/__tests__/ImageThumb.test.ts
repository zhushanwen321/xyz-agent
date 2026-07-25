/**
 * ImageThumb + Turn image segment 渲染单测（W2-image-history-render P2-a）。
 *
 * 覆盖：
 * - W2TC1：正常 path → 渲染 img，src 含编码后 path
 * - W2TC2：img error 事件 → 降级绿色 badge，含 name 文本
 * - W2TC3：空 path → 不渲染 img，直接降级 badge
 * - W2TC4：Turn 传入无 image 的 segments → 既无 img 也无 fallback badge（回归保护）
 * - W2TC5：Turn 传入 3 个 image segment → 渲染 3 个缩略图/badge
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/ImageThumb.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import ImageThumb from '@/components/panel/message-stream/ImageThumb.vue'
import Turn from '@/components/panel/message-stream/Turn.vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message, Segment } from '@xyz-agent/shared'

// Turn 依赖的 composable mock（与 turn-file-badge.test.ts 同套，避免触发真实 store/IPC）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn() }),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn() }),
}))
vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ selectFile: vi.fn() }),
}))

beforeEach(() => setActivePinia(createPinia()))

describe('ImageThumb（W2TC1-3）', () => {
  it('W2TC1: 正常 path 渲染 img，src 含编码后 path', () => {
    const wrapper = mount(ImageThumb, {
      props: { path: '/tmp/foo.png', name: 'foo.png' },
    })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    // src 含 encodeURIComponent('/tmp/foo.png') 后的编码串
    expect(img.attributes('src')).toBe('local-file://' + encodeURIComponent('/tmp/foo.png'))
    expect(img.attributes('src')).toContain('foo.png')
    // 正常态不渲染降级 badge
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(false)
  })

  it('W2TC2: img error → 降级绿色 badge，含 name 文本', async () => {
    const wrapper = mount(ImageThumb, {
      props: { path: '/nonexistent/missing.png', name: 'missing.png' },
    })

    expect(wrapper.find('img').exists()).toBe(true)
    await wrapper.find('img').trigger('error')
    await nextTick()

    // error 后 img 消失，降级 badge 出现
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(true)
    expect(wrapper.text()).toContain('missing.png')
  })

  it('W2TC3: 空 path → 不渲染 img，直接降级 badge', () => {
    const wrapper = mount(ImageThumb, {
      props: { path: '', name: 'empty.png' },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(true)
    expect(wrapper.text()).toContain('empty.png')
  })
})

describe('Turn image segment 集成（W2TC4-5）', () => {
  function makeTurn(content: Segment[]): MessageTurn {
    return {
      index: 1,
      user: {
        id: 'u1',
        role: 'user',
        content,
        status: 'complete',
        timestamp: Date.now(),
      } satisfies Message,
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    }
  }

  function mountTurn(turn: MessageTurn, sessionId = 's1') {
    return mount(Turn, {
      props: { turn, sessionId },
      global: { plugins: [createPinia()] },
    })
  }

  it('W2TC4: 无 image segment → 不渲染 img.image-thumb 也不渲染 fallback badge', () => {
    const turn = makeTurn([
      { type: 'text', text: '看下这个文件' },
      { type: 'file', path: 'src/foo.ts' },
    ])
    const wrapper = mountTurn(turn)

    expect(wrapper.find('img.image-thumb').exists()).toBe(false)
    expect(wrapper.find('.image-fallback-badge').exists()).toBe(false)
  })

  it('W2TC5: 3 个 image segment → 渲染 3 个缩略图/badge', () => {
    const turn = makeTurn([
      { type: 'image', id: 'img1', path: '/tmp/a.png', name: 'a.png' },
      { type: 'image', id: 'img2', path: '/tmp/b.png', name: 'b.png' },
      { type: 'image', id: 'img3', path: '', name: 'c.png' },
    ])
    const wrapper = mountTurn(turn)

    // 2 个有 path → img.image-thumb；1 个空 path → fallback badge；合计 3
    const items = wrapper.findAll('img.image-thumb, .image-fallback-badge')
    expect(items).toHaveLength(3)
  })
})
