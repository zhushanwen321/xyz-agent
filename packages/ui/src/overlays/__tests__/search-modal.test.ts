/**
 * SearchModal 首屏冒烟（C-NT-5，w4 new-task-search UI 迁移）。
 *
 * 首屏冒烟：mount SearchModal（open=true, deps=mock SearchDeps）断言
 * [data-testid=search-input] DOM 存在（inline overlay，无 Teleport，wrapper 内直接断言）；
 * 空查询 recents/suggested 分组 + 非空查询命令命中 → 断言 search-section/search-item DOM；
 * open=false 时不渲染 overlay。断言 DOM 结构（data-testid），不断言文案。
 *
 * deps 构造对齐 w3 core search.test.ts 先例：ports 全 vi.fn + core 真实 factory
 * （createCommandStore/createFileSearchStore，规避 mock 漏方法运行时崩溃 R1）+ storage
 * KVStorage mock。fake timers 推进 debounce 120ms / loading 200ms。
 *
 * 运行：cd packages/ui && npx vitest run src/overlays
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createCommandStore, createFileSearchStore, resetSearchModal } from '@xyz-agent/core'
import type { SearchDeps } from '@xyz-agent/core'
import type { FileNode, SessionGroup } from '@xyz-agent/shared'
import SearchModal from '../SearchModal.vue'

/** Map 实现 KVStorage（对齐 w3 command-store.test.ts makeMockStorage 模式） */
function makeMockStorage() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async set(key: string, value: string) {
      store.set(key, value)
    },
    async remove(key: string) {
      store.delete(key)
    },
  }
}

/** 构造 mock SearchDeps（每测试独立实例，断言 per-test） */
function makeDeps(): SearchDeps {
  return {
    ports: {
      isMock: false,
      isMac: false,
      searchMock: vi.fn(async () => []),
      fileRead: vi.fn(async () => {}),
      fileCandidates: vi.fn(async () => [] as FileNode[]),
      sessionList: vi.fn(async () => [] as SessionGroup[]),
      selectSession: vi.fn(async () => {}),
      watchFileChanges: vi.fn(() => () => {}),
      t: vi.fn((key: string) => key),
    },
    commandStore: createCommandStore(makeMockStorage()),
    fileSearchStore: createFileSearchStore(),
    storage: makeMockStorage(),
    fileTree: { loadTree: vi.fn(async () => {}), selectFile: vi.fn() },
    appCommandActions: {
      newSession: vi.fn(),
      goOverview: vi.fn(),
      toggleSidebar: vi.fn(),
      requestPresetOpen: vi.fn(),
    },
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetSearchModal() // core 单例隔离（R5，C-NT-6）
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SearchModal 首屏冒烟', () => {
  it('搜索输入框 DOM：open=true 时 search-input 存在，open=false 时不渲染 overlay', () => {
    const deps = makeDeps()
    const wrapper = mount(SearchModal, {
      props: { open: false, deps },
    })
    expect(wrapper.find('[data-testid="search-modal-overlay"]').exists()).toBe(false)

    const wrapperOpen = mount(SearchModal, {
      props: { open: true, deps },
    })
    expect(wrapperOpen.find('[data-testid="search-modal-overlay"]').exists()).toBe(true)
    expect(wrapperOpen.find('[data-testid="search-input"]').exists()).toBe(true)
  })

  it('结果列表 DOM：注册 app 命令，空查询 recents/suggested 分组渲染 search-item', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([
      { id: 'nt', name: '新建任务', action: vi.fn() },
      { id: 'ov', name: '概览', action: vi.fn() },
    ])
    const wrapper = mount(SearchModal, {
      props: { open: true, deps },
    })
    // open=true immediate loadResults：空查询 → suggested 分组（suggested 命令前 3 个）
    await flushPromises()
    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="search-item-0"]').exists()).toBe(true)
  })

  it('非空查询命令命中：debounce 120ms 后 search-section/search-item 渲染', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.commandStore.registerApp([
      { id: 'nt', name: '新建任务', action: vi.fn() },
    ])
    const wrapper = mount(SearchModal, {
      props: { open: true, deps },
    })
    await flushPromises()
    // 输入查询词 → debounce 120ms → loadResults → 3 源 allSettled（command 命中）
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('新建')
    await vi.advanceTimersByTimeAsync(150) // debounce 120ms + 微任务
    // loading 200ms 防闪烁 timer 未到 → loading 不显，直接显结果
    expect(wrapper.find('[data-testid="search-item-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid^="search-section-"]').exists()).toBe(true)
  })
})
