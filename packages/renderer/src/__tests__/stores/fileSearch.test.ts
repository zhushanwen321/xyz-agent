/**
 * fileSearchStore 单测（U20-U23）。
 *
 * 覆盖 session 级缓存语义：
 * - U20 首次 load：写缓存，api 调 1 次
 * - U21 缓存命中：api 不再调
 * - U22 多 session 隔离
 * - U23 invalidate 后重拉
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/stores/fileSearch.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// mock composer api（store 不直接调 api，但 useFileSearch 调；store 测试通过 useFileSearch 间接验证缓存）
const mockGetFileCandidates = vi.fn()
vi.mock('@/api', () => ({
  composer: { getFileCandidates: (...args: unknown[]) => mockGetFileCandidates(...args) },
}))

import { useFileSearch } from '@/composables/features/useFileSearch'
import { useFileSearchStore } from '@/stores/fileSearch'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('fileSearchStore session 级缓存', () => {
  it('U20 首次 load：写缓存，getFileCandidates 调 1 次', async () => {
    const nodes = [{ path: 'a', name: 'a', type: 'dir' }]
    mockGetFileCandidates.mockResolvedValueOnce([...nodes, { path: 'b', name: 'b', type: 'dir' }])
    const { load } = useFileSearch()
    const store = useFileSearchStore()

    await load('s1')

    expect(mockGetFileCandidates).toHaveBeenCalledTimes(1)
    expect(store.get('s1')).toHaveLength(2)
  })

  it('U21 缓存命中：getFileCandidates 不再调', async () => {
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'a', name: 'a', type: 'file' }])
    const { load } = useFileSearch()

    await load('s1')
    await load('s1') // 第二次应命中缓存

    expect(mockGetFileCandidates).toHaveBeenCalledTimes(1)
  })

  it('U22 多 session 隔离：load s1 后 load s2，各调 1 次', async () => {
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'a', name: 'a', type: 'file' }])
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'b', name: 'b', type: 'file' }])
    const { load } = useFileSearch()
    const store = useFileSearchStore()

    await load('s1')
    await load('s2')

    expect(mockGetFileCandidates).toHaveBeenCalledTimes(2)
    expect(store.get('s1')).toHaveLength(1)
    expect(store.get('s2')).toHaveLength(1)
  })

  it('U23 invalidate 后 load 重拉', async () => {
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'a', name: 'a', type: 'file' }])
    mockGetFileCandidates.mockResolvedValueOnce([{ path: 'b', name: 'b', type: 'file' }])
    const { load } = useFileSearch()
    const store = useFileSearchStore()

    await load('s1')
    store.invalidate('s1')
    await load('s1')

    expect(mockGetFileCandidates).toHaveBeenCalledTimes(2)
  })
})
