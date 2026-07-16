/**
 * useDetailPane 并发守卫测试（W3 / L3）。
 *
 * 锁定请求版本号 token 机制：快速连续 openPreview 两个文件时，第一个请求的慢响应
 * 不会覆盖第二个请求的新内容（stale write 防护）。
 *
 * 运行：npx vitest run src/__tests__/composables/useDetailPane-concurrency.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// mock @/api 聚合门面：useDetailPane 源码 import { file, git } from '@/api'，
// vitest VITE_MOCK=true 下须在聚合门面层覆盖 file/git 导出，否则走 mockApi fixture。
// 第一次 read 延迟，第二次立即返回
const mockFileRead = vi.fn()
const mockGitGetDiff = vi.fn()
vi.mock('@/api', () => ({
  file: { read: (...args: unknown[]) => mockFileRead(...(args as [string, string?])) },
  git: { getDiff: (...args: unknown[]) => mockGitGetDiff(...(args as [string, string])) },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ list: [] }),
}))

import { useDetailPane } from '@/composables/features/useDetailPane'
import { useFileTreeStore } from '@/stores/fileTree'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
})

describe('U6: useDetailPane 并发守卫（W3 / L3）', () => {
  it('快速切换文件时旧请求的慢响应不覆盖新内容（stale write 防护）', async () => {
    const store = useFileTreeStore()
    const sid = 's1'
    const sessionId = ref<string | null>(sid)

    // 第一个文件 read 延迟返回 'old-content'，第二个立即返回 'new-content'
    // 用 promise 手动控制延迟
    let resolveFirst: (val: unknown) => void = () => {}
    const firstPromise = new Promise((r) => { resolveFirst = r })
    mockFileRead.mockImplementationOnce(() => firstPromise)
    mockFileRead.mockResolvedValueOnce({ content: 'new-content', truncated: false })
    mockGitGetDiff.mockResolvedValue({ patch: '', binary: false })

    const { state, openPreview } = useDetailPane(sessionId)

    // 连续调 openPreview，不等第一个完成
    void openPreview(sid, 'file-a')
    void openPreview(sid, 'file-b')

    // 等第二个（立即返回）resolve
    await vi.advanceTimersByTimeAsync(0)

    // 第二个请求已完成，content 应为 'new-content'
    expect(state.value.content).toBe('new-content')

    // 现在让第一个（延迟）resolve —— 旧请求的 'old-content' 应被丢弃
    resolveFirst({ content: 'old-content', truncated: false })
    await vi.advanceTimersByTimeAsync(0)

    // content 仍为 'new-content'（旧请求未覆盖）
    expect(state.value.content).toBe('new-content')

    vi.useRealTimers()
  })
})
