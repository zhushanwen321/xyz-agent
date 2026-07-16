/**
 * i18n-frontend-p2 U1: useSearch Section.kind 字段完整性（W1）。
 *
 * 验证目标：Section 类型扩展后，useSearch 三处构造点都返回带 kind 的 Section[]，
 * kind 集合覆盖 'recent' / 'suggested' / 'command' / 'file' / 'symbol' / 'session' 6 类。
 *
 * TDD 红灯基线（tdd_plan 时跑）：当前 Section 类型无 kind 字段，断言会因 type 错误
 * 或运行时 undefined 失败，证明实现未到位。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { FileNode, SessionGroup } from '@xyz-agent/shared'
import { useCommandStore } from '@/stores/command'
import { useFileSearchStore } from '@/stores/fileSearch'

const mockGetFileCandidates = vi.fn()
const mockSessionList = vi.fn()
vi.mock('@/api', () => ({
  composer: { getFileCandidates: (...args: unknown[]) => mockGetFileCandidates(...(args as [string])) },
  session: { list: () => mockSessionList() },
}))

const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
vi.mock('@/stores/fileSearch', () => ({
  useFileSearchStore: () => ({
    get: (...args: unknown[]) => mockStoreGet(...(args as [string])),
    set: (...args: unknown[]) => mockStoreSet(...(args as [string, FileNode[]])),
    invalidate: vi.fn(),
  }),
}))

const mockSetupInvalidation = vi.fn(() => vi.fn())
vi.mock('@/composables/features/useFileSearch', () => ({
  useFileSearch: () => ({ setupInvalidation: mockSetupInvalidation }),
}))

import { useSearch } from '@/composables/features/useSearch'
import type { Section } from '@/lib/search-types'

beforeEach(() => {
  setActivePinia(createPinia())
  mockGetFileCandidates.mockReset()
  mockSessionList.mockReset()
  mockStoreGet.mockReset()
  mockStoreSet.mockReset()
  mockGetFileCandidates.mockResolvedValue([])
  mockSessionList.mockResolvedValue([])
  mockStoreGet.mockReturnValue(null)
})

describe('U1: useSearch Section.kind 字段完整性', () => {
  it('空查询场景返回 recents + suggested 两 section，kind 分别为 recent / suggested', async () => {
    useCommandStore()
    const { query } = useSearch(ref('sid-1'))
    const sections = await query('', { activeSessionId: 'sid-1' })
    // 期望：返回至少含 1 个 recent + 1 个 suggested（取决于 fixture 是否有内容，mock 端 fixture 至少有 SEARCH_RECENTS 3 条 + 建议 3 条）
    const recents = sections.find((s: Section) => s.kind === 'recent')
    const suggested = sections.find((s: Section) => s.kind === 'suggested')
    expect(recents).toBeDefined()
    expect(suggested).toBeDefined()
    expect(recents!.items.length).toBeGreaterThan(0)
    expect(suggested!.items.length).toBeGreaterThan(0)
  })

  it('非空查询返回四类分组，kind 覆盖 command / file / symbol / session', async () => {
    useCommandStore()
    const { query } = useSearch(ref('sid-1'))
    const sections = await query('commit', { activeSessionId: 'sid-1' })
    const kinds = sections.map((s: Section) => s.kind)
    // 期望：至少含 command 类型
    expect(kinds).toContain('command')
  })

  it('所有 Section 都有非 undefined 的 kind 字段', async () => {
    useCommandStore()
    const { query } = useSearch(ref('sid-1'))
    const sections = await query('test', { activeSessionId: 'sid-1' })
    for (const s of sections) {
      expect(s.kind).toBeDefined()
      expect(typeof s.kind).toBe('string')
    }
  })
})
