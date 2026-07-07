/**
 * Command store 扩展单测（应用命令区 + slashCommandsOf）。
 *
 * 覆盖 D-016 物理隔离 + AC-2.4 幂等注册 + 现有 slash 功能回归。
 * 与 command-store.test.ts 互补：后者测 slash 分区，本文件测新增应用命令区与两区隔离。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/stores/command-app.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCommandStore, type RawCommand } from '@/stores/command'
import type { AppCommand } from '@/lib/search-types'

beforeEach(() => {
  setActivePinia(createPinia())
})

const APP_NEW: AppCommand = { id: 'new', name: '新建', action: vi.fn() }
const APP_SEARCH: AppCommand = { id: 'search', name: '搜索', shortcut: '⌘K', action: vi.fn() }

const RAW_SLASH: RawCommand[] = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', source: 'skill' },
]

describe('command store 应用命令区（registerApp / appCommands）', () => {
  it('AC-2.4 registerApp 写入 appCommands', () => {
    const store = useCommandStore()
    expect(store.appCommands).toEqual([]) // 初始空
    store.registerApp([APP_NEW])
    expect(store.appCommands).toHaveLength(1)
    expect(store.appCommands[0]).toEqual(APP_NEW)
  })

  it('AC-2.4 幂等覆盖：两次 registerApp 不同数据，结果是第二次（非累加）', () => {
    const store = useCommandStore()
    store.registerApp([APP_NEW, APP_SEARCH])
    expect(store.appCommands).toHaveLength(2)

    // 第二次覆盖（非追加）
    store.registerApp([APP_NEW])
    expect(store.appCommands).toHaveLength(1)
    expect(store.appCommands[0].id).toBe('new')
  })

  it('AC-2.4 registerApp 空数组合法（清空）', () => {
    const store = useCommandStore()
    store.registerApp([APP_NEW])
    store.registerApp([])
    expect(store.appCommands).toEqual([])
  })
})

describe('D-016 物理隔离：appCommands 与 commandsBySession 互不影响', () => {
  it('applyCommands 写 slash 区后 appCommands 不变', () => {
    const store = useCommandStore()
    store.registerApp([APP_NEW])
    const appBefore = [...store.appCommands]

    store.applyCommands('s1', RAW_SLASH)

    // slash 区写入
    expect(store.getCommands('s1')).toHaveLength(2)
    // app 区不变（物理隔离）
    expect(store.appCommands).toEqual(appBefore)
    expect(store.appCommands).toHaveLength(1)
  })

  it('registerApp 写应用命令区后 commandsBySession 不变', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW_SLASH)
    const slashBefore = store.getCommands('s1')

    store.registerApp([APP_NEW, APP_SEARCH])

    // app 区写入
    expect(store.appCommands).toHaveLength(2)
    // slash 区不变（物理隔离）
    expect(store.getCommands('s1')).toEqual(slashBefore)
    expect(store.getCommands('s1')).toHaveLength(2)
  })

  it('clearCommands 只清 slash 区，不动 appCommands', () => {
    const store = useCommandStore()
    store.registerApp([APP_NEW])
    store.applyCommands('s1', RAW_SLASH)

    store.clearCommands('s1')

    expect(store.getCommands('s1')).toEqual([])
    expect(store.appCommands).toHaveLength(1) // app 区未被 clear 波及
  })
})

describe('slashCommandsOf（显式 slash 响应式视图）', () => {
  it('applyCommands 后 slashCommandsOf(sid).value 含命令（归一化）', () => {
    const store = useCommandStore()
    store.applyCommands('s1', [{ name: '/commit', source: 'extension' }])
    const view = store.slashCommandsOf('s1')
    expect(view.value).toHaveLength(1)
    expect(view.value[0]).toEqual({
      id: '/commit',
      name: '/commit',
      kind: 'extension',
      icon: 'terminal',
      description: undefined,
    })
  })

  it('无数据的 session → slashCommandsOf 返 []（不写入 Map）', () => {
    const store = useCommandStore()
    const view = store.slashCommandsOf('never-existed')
    expect(view.value).toEqual([])
  })

  it('slashCommandsOf 与 commandsOf 同义（指向同一响应式源）', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW_SLASH)
    expect(store.slashCommandsOf('s1').value).toEqual(store.commandsOf('s1').value)
  })
})

describe('现有 slash 功能回归（不破坏）', () => {
  it('getCommands / commandsOf / applyCommands / clearCommands 仍正常', () => {
    const store = useCommandStore()
    // 初始空
    expect(store.getCommands('s1')).toEqual([])

    // apply + get
    store.applyCommands('s1', RAW_SLASH)
    expect(store.getCommands('s1')).toHaveLength(2)
    expect(store.commandsOf('s1').value[0].icon).toBe('terminal') // extension → terminal

    // 覆盖写
    store.applyCommands('s1', [{ name: '/x', source: 'builtin' }])
    expect(store.getCommands('s1')).toHaveLength(1)
    expect(store.getCommands('s1')[0].icon).toBe('wrench') // builtin 默认

    // clear
    store.clearCommands('s1')
    expect(store.getCommands('s1')).toEqual([])
    expect(store.commandsOf('s1').value).toEqual([])
  })

  it('findCommandByName 仍正常', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW_SLASH)
    expect(store.findCommandByName('s1', '/commit')?.icon).toBe('terminal')
    expect(store.findCommandByName('s1', '/nope')).toBeUndefined()
  })
})
