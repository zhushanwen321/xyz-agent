/**
 * i18n-frontend-p2 U2: SearchModal 走 kind-based 判定（W1）。
 *
 * 验证目标：
 * (a) SearchModal.vue 源码不再含 's.label === \'最近\'' 硬编码字面量
 * (b) en-US locale + activeType=file 时 recents 分组仍恒显（AH-S3）
 * (c) SearchModal 内 labelToType 映射基于 s.kind 而非 s.label
 *
 * 红灯基线：当前 SearchModal.vue L225 含 `s.label === '最近'`，静态断言 fail。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SearchModal from '@/components/overlays/SearchModal.vue'
import i18n, { setLocale } from '@/i18n'

const mockQuery = vi.fn()
vi.mock('@/composables/features/useSearch', () => ({
  useSearch: () => ({ query: (...args: unknown[]) => mockQuery(...(args as [string, unknown])) }),
}))

const mockConfirm = vi.fn()
vi.mock('@/composables/features/useSearchJump', () => ({
  useSearchJump: () => ({ confirm: mockConfirm }),
}))

vi.mock('@/composables/features/useRecents', () => ({
  useRecents: () => ({ read: () => [], write: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  mockQuery.mockReset()
  mockConfirm.mockReset()
  setLocale('en-US')
})

describe('U2: SearchModal kind-based 判定 + en-US recents 恒显', () => {
  it('SearchModal.vue 源码不再含 s.label === \'最近\' 硬编码字面量', () => {
    // 静态源码检测：读 SearchModal.vue 源文件，断言不含 `s.label === '最近'` 等中文字面量比较
    const sourcePath = resolve(__dirname, '../../components/overlays/SearchModal.vue')
    const source = readFileSync(sourcePath, 'utf-8')
    expect(source).not.toMatch(/s\.label\s*===\s*['"]最近['"]/)
    expect(source).not.toMatch(/s\.label\s*===\s*['"]建议命令['"]/)
  })

  it('en-US locale + activeType=file 时 recents 分组仍恒显（kind-based 过滤）', async () => {
    // mock Section.label 走 i18n 翻译（模拟 W1 改完的 useSearch 行为）
    const recentLabel = i18n.global.t('search.recent')
    const fileLabel = i18n.global.t('search.sectionFile')
    mockQuery.mockResolvedValue([
      { kind: 'recent', label: recentLabel, items: [{ type: 'file', title: 'a.ts', sub: 'p' }] },
      { kind: 'file', label: fileLabel, items: [{ type: 'file', title: 'b.ts', sub: 'p' }] },
    ])

    const wrapper = mount(SearchModal, {
      props: { open: true, activeSessionId: 'sid-1' },
      global: { mocks: { $t: i18n.global.t } },
    })
    await nextTick()
    await nextTick()

    // 切到 file（按 Tab 一次：null→command，再按一次：command→file）
    const input = wrapper.find('input[type="text"], input')
    if (input.exists()) await input.trigger('focus')
    await wrapper.trigger('keydown', { key: 'Tab' })
    await wrapper.trigger('keydown', { key: 'Tab' })
    await nextTick()

    const html = wrapper.html()
    // en-US 下 recents 翻译为 'Recent'，断言 DOM 含 'Recent'（kind='recent' 不被 activeType 过滤）
    expect(html).toContain('Recent')
    // kind='file' 仍显示
    expect(html).toContain(fileLabel)
  })
})
