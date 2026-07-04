/**
 * useFileSearch composable 单测（U24-U26）。
 *
 * 覆盖：
 * - U24 debounce：连续 load 2 次（间隔0）→ fake timers advance 300，api 调 1 次
 * - U25 setupInvalidation：chatStore fileChanges 变化 → store.invalidate
 * - U26 invalidate 后不自动刷新（store.get 仍返回旧值，不触发 load）
 *
 * mock 策略：vi.mock('@/api') composer.getFileCandidates + fake timers（debounce）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/useFileSearch.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'

const mockGetFileCandidates = vi.fn()
vi.mock('@/api', () => ({
  composer: { getFileCandidates: (...args: unknown[]) => mockGetFileCandidates(...args) },
}))

import { useFileSearch } from '@/composables/features/useFileSearch'
import { useFileSearchStore } from '@/stores/fileSearch'
import { useChatStore } from '@/stores/chat'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useFileSearch debouncedLoad', () => {
  it('U24 debounce 300ms：debouncedLoad 连续 2 次（间隔0）→ api 调 1 次', async () => {
    vi.useFakeTimers()
    try {
      mockGetFileCandidates.mockResolvedValue([{ path: 'a', name: 'a', type: 'file' }])
      const { debouncedLoad } = useFileSearch()

      // 连续 2 次（间隔 0），第二次的 timer 覆盖第一次（debounce 语义）
      debouncedLoad('s1', () => {})
      debouncedLoad('s1', () => {})

      // 未 advance 前 api 未调
      expect(mockGetFileCandidates).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(300)

      expect(mockGetFileCandidates).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useFileSearch.setupInvalidation', () => {
  it('U25 fileChanges 变化 → store.invalidate', async () => {
    mockGetFileCandidates.mockResolvedValue([{ path: 'a.ts', name: 'a.ts', type: 'file' }])
    const { load, setupInvalidation } = useFileSearch()
    const store = useFileSearchStore()
    const chatStore = useChatStore()

    // 先 load 建立缓存
    await load('s1')
    expect(store.get('s1')).toHaveLength(1)

    // 订阅 invalidation
    const sidRef = ref('s1')
    const unwatch = setupInvalidation(sidRef)

    // 模拟 agent 改文件：往 chatStore 注入含 fileChanges 的 assistant message
    chatStore.messages.set('s1', [
      { role: 'assistant', content: 'done', fileChanges: [{ filePath: 'src/a.ts', changeType: 'edit' }] },
    ] as never)

    await nextTick() // 触发 Vue watch（ref<Map>.set 在 Vue 3 触发响应式）
    // 缓存被失效（G9：删缓存不重拉）
    expect(store.get('s1')).toBeUndefined()
    // 未自动重拉（load 未被触发）
    expect(mockGetFileCandidates).toHaveBeenCalledTimes(1)

    unwatch()
  })

  it('U26 invalidate 后不自动刷新：store.get 返回 undefined，下次 load 才重拉', async () => {
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'a.ts', name: 'a.ts', type: 'file' }])
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'b.ts', name: 'b.ts', type: 'file' }])
    const { load, setupInvalidation } = useFileSearch()
    const store = useFileSearchStore()
    const chatStore = useChatStore()
    const sidRef = ref('s1')
    const unwatch = setupInvalidation(sidRef)

    await load('s1')
    expect(store.get('s1')).toHaveLength(1)

    // 触发失效
    chatStore.messages.set('s1', [
      { role: 'assistant', content: 'done', fileChanges: [{ filePath: 'x.ts', changeType: 'edit' }] },
    ] as never)
    await nextTick()
    expect(store.get('s1')).toBeUndefined()

    // 下次 load 才重拉
    await load('s1')
    expect(mockGetFileCandidates).toHaveBeenCalledTimes(2)
    expect(store.get('s1')).toHaveLength(1)

    unwatch()
  })
})
