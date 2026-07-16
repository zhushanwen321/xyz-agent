/**
 * DetailPane 选区 bubble 测试（W4, U13）。
 *
 * 验证 FR-4 选区 bubble：
 * - U13: 选中文本后 mouseup → bubble 显出 → click 引用当前 → 注入 path+行范围（不含文本）
 * - U13b: bubble "新对话" 按钮走 target=new
 *
 * jsdom selection 限制：window.getSelection 在 jsdom 下功能有限，本测试直接设
 * selectionRange ref 驱动 bubble 显隐（绕过 selection API），验证注入逻辑正确性。
 * selection API 的真实行为留手动/E2E 验证。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/composables/features/useDetailPane', () => ({
  useDetailPane: () => ({
    state: ref({
      path: 'src/foo.ts',
      content: 'line1\nline2\nline3\nline4',
      viewMode: 'preview',
      kind: 'code',
      status: 'success',
      hasGitChange: false,
    }),
    toggleView: vi.fn(),
    sessionCwd: () => '/cwd',
  }),
}))
vi.mock('@/composables/effects/useCopy', () => ({
  useCopy: () => ({ copied: ref(null), copy: vi.fn() }),
}))
vi.mock('@/composables/logic/file-type', () => ({ extToLang: () => 'ts' }))
vi.mock('@/lib/path-utils', () => ({ resolvePreviewPath: () => ({ absolute: '/cwd/src/foo.ts' }) }))
vi.mock('@/components/panel/message-stream/MarkdownRenderer.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('@/components/panel/detail-renderers/CodeBlock.vue', () => ({
  default: { template: '<div />' },
}))

import DetailPane from '@/components/panel/DetailPane.vue'
import { useComposerInjectionStore } from '@/stores/composer-injection'

beforeEach(() => {
  setActivePinia(createPinia())
})

const SIMPLE = { template: '<div />' }

function mountDetailPane() {
  return mount(DetailPane, {
    props: { sessionId: 's1' },
    global: {
      stubs: {
        HoverCard: SIMPLE, HoverCardContent: SIMPLE, HoverCardTrigger: SIMPLE,
        CodeBlock: SIMPLE, DiffView: SIMPLE, MarkdownRenderer: SIMPLE,
      },
    },
  })
}

describe('W4: DetailPane 选区 bubble（FR-4）', () => {
  it('U13: 无选区时 bubble 不存在', () => {
    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-selection-bubble"]').exists()).toBe(false)
  })

  it('U13b: bubble "引用当前" 按钮注入 path+行范围 target=current（不含 text）', async () => {
    const wrapper = mountDetailPane()
    const store = useComposerInjectionStore()
    // mock window.getSelection 返回模拟选区（content 第 2-3 行）
    const contentEl = wrapper.find('[data-testid="detail-content"]').element
    const fakeRange = { commonAncestorContainer: contentEl }
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => fakeRange,
      toString: () => 'line2\nline3',
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    } as unknown as Selection)

    await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
    const bubble = wrapper.find('[data-testid="detail-selection-bubble"]')
    expect(bubble.exists()).toBe(true)

    await wrapper.find('[data-testid="bubble-inject-current"]').trigger('click')
    expect(store.pendingInjection).not.toBeNull()
    expect(store.pendingInjection?.path).toBe('src/foo.ts')
    expect(store.pendingInjection?.lineStart).toBe(2)
    expect(store.pendingInjection?.lineEnd).toBe(3)
    expect(store.pendingInjection?.target).toBe('current')
    // FR-8: payload 不含 text
    expect((store.pendingInjection as Record<string, unknown>).text).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('U13c: bubble "新对话" 按钮走 target=new', async () => {
    const wrapper = mountDetailPane()
    const store = useComposerInjectionStore()
    const contentEl = wrapper.find('[data-testid="detail-content"]').element
    const fakeRange = { commonAncestorContainer: contentEl }
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => fakeRange,
      toString: () => 'line1',
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    } as unknown as Selection)

    await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
    await wrapper.find('[data-testid="bubble-inject-new"]').trigger('click')
    expect(store.pendingInjection?.target).toBe('new')
    expect(store.pendingInjection?.path).toBe('src/foo.ts')
    expect(store.pendingInjection?.sessionId).toBeNull()
    vi.restoreAllMocks()
  })
})
