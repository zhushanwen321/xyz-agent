/**
 * useCommandRegistry composable 单测（#2 命令注册表聚合）。
 *
 * 覆盖：
 * - AC-2.1 list() 返回应用命令 + slash 命令统一列表
 * - AC-2.2 session 切换 appCommands 不重算（D-016 物理隔离）
 * - AC-2.3 同名不撞（slash 带 / 前缀，D-009）
 * - AC-4.8 activeSessionId=null → list() 只含 appCommands（slash 空）
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/useCommandRegistry.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useCommandRegistry } from '@/composables/features/useCommandRegistry'
import { useCommandStore } from '@/stores/command'
import type { AppCommand } from '@/lib/search-types'

beforeEach(() => {
  setActivePinia(createPinia())
})

const noop = vi.fn()

describe('AC-2.1 list() 聚合应用命令 + slash 命令', () => {
  it('registerApp([appCmd]) + applyCommands(sid,[slashCmd]) + activeSessionId=sid → list 含两者', () => {
    const appCmd: AppCommand = { id: 'new', name: '新建', action: noop }
    const store = useCommandStore()
    const sid = ref<string | null>('s1')
    const { list, registerApp } = useCommandRegistry(sid)

    registerApp([appCmd])
    store.applyCommands('s1', [{ name: '/commit', source: 'extension' }])

    const items = list().value
    expect(items).toHaveLength(2)
    // app 命令在前，slash 命令在后
    expect(items[0]).toEqual(appCmd)
    expect(items[1].name).toBe('/commit')
  })

  it('无应用命令 + 有 slash → list 只含 slash', () => {
    const store = useCommandStore()
    const sid = ref<string | null>('s1')
    const { list } = useCommandRegistry(sid)

    store.applyCommands('s1', [{ name: '/review', source: 'skill' }])
    const items = list().value
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('/review')
  })

  it('有应用命令 + 无 slash（未 apply）→ list 只含 app', () => {
    const appCmd: AppCommand = { id: 'new', name: '新建', action: noop }
    const sid = ref<string | null>('s1')
    const { list, registerApp } = useCommandRegistry(sid)
    registerApp([appCmd])
    expect(list().value).toEqual([appCmd])
  })
})

describe('AC-2.2 session 切换 appCommands 不重算（D-016 物理隔离）', () => {
  it('appCmd 注册后，activeSessionId 从 sid1 切到 sid2，app 部分始终在 list 结果中', () => {
    const appCmd: AppCommand = { id: 'new', name: '新建', action: noop }
    const store = useCommandStore()
    const sid = ref<string | null>('s1')
    const { list, registerApp } = useCommandRegistry(sid)

    registerApp([appCmd])
    store.applyCommands('s1', [{ name: '/commit', source: 'extension' }])
    store.applyCommands('s2', [{ name: '/review', source: 'skill' }])

    // sid1：app + s1 slash
    sid.value = 's1'
    let items = list().value
    expect(items.find((c) => c.id === 'new' && c.name === '新建')).toBeTruthy()
    expect(items.find((c) => c.name === '/commit')).toBeTruthy()
    expect(items.find((c) => c.name === '/review')).toBeUndefined()

    // 切到 sid2：app 仍在（物理隔离不重算/不丢失），slash 换成 s2
    sid.value = 's2'
    items = list().value
    expect(items.find((c) => c.id === 'new' && c.name === '新建')).toBeTruthy() // app 始终在
    expect(items.find((c) => c.name === '/review')).toBeTruthy()
    expect(items.find((c) => c.name === '/commit')).toBeUndefined()
  })

  it('app 命令区在 list() 中始终完整（多个 app 命令跨 session 切换不丢）', () => {
    const app1: AppCommand = { id: 'new', name: '新建', action: noop }
    const app2: AppCommand = { id: 'search', name: '搜索', shortcut: '⌘K', action: noop }
    const store = useCommandStore()
    const sid = ref<string | null>('s1')
    const { list, registerApp } = useCommandRegistry(sid)

    registerApp([app1, app2])
    store.applyCommands('s2', [{ name: '/fix', source: 'builtin' }])

    sid.value = 's2'
    const items = list().value
    const names = items.map((c) => c.name)
    expect(names).toContain('新建')
    expect(names).toContain('搜索')
    expect(names).toContain('/fix')
  })
})

describe('AC-2.3 同名不撞（slash 带 / 前缀，D-009）', () => {
  it('appCmd name="commit" + slashCmd name="/commit" → list 含两者', () => {
    const appCmd: AppCommand = { id: 'commit', name: 'commit', action: noop }
    const store = useCommandStore()
    const sid = ref<string | null>('s1')
    const { list, registerApp } = useCommandRegistry(sid)

    registerApp([appCmd])
    store.applyCommands('s1', [{ name: '/commit', source: 'extension' }])

    const items = list().value
    expect(items).toHaveLength(2) // 天然不撞：name 不同（commit vs /commit）
    const names = items.map((c) => c.name)
    expect(names).toContain('commit')
    expect(names).toContain('/commit')
  })
})

describe('AC-4.8 边界：activeSessionId=null → slash 空', () => {
  it('null session → list() 只含 appCommands（slash 空）', () => {
    const appCmd: AppCommand = { id: 'new', name: '新建', action: noop }
    const store = useCommandStore()
    const sid = ref<string | null>(null)
    const { list, registerApp } = useCommandRegistry(sid)

    registerApp([appCmd])
    // 即便 store 里有 slash 命令，null session 也不应带出
    store.applyCommands('s1', [{ name: '/commit', source: 'extension' }])

    const items = list().value
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual(appCmd) // 只剩 appCommands
  })

  it('从有效 session 切到 null → slash 项消失，app 保留', () => {
    const appCmd: AppCommand = { id: 'new', name: '新建', action: noop }
    const store = useCommandStore()
    const sid = ref<string | null>('s1')
    const { list, registerApp } = useCommandRegistry(sid)

    registerApp([appCmd])
    store.applyCommands('s1', [{ name: '/commit', source: 'extension' }])

    // 有效 session：两者都在
    expect(list().value).toHaveLength(2)

    // 切到 null：slash 消失
    sid.value = null
    const items = list().value
    expect(items).toEqual([appCmd])
  })
})
