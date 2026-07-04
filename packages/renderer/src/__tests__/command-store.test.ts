/**
 * Command store 单测。
 *
 * 核心回归：slashCommands 归位 store 后，数据持久化、不随组件重建丢失（修复
 * 「slash 浮层对话一次后失效」：原 CommandPopover 局部 ref 被 v-if 销毁重建即空）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/command-store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { useCommandStore, type RawCommand } from '@/stores/command'

beforeEach(() => {
  setActivePinia(createPinia())
})

const RAW: RawCommand[] = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', description: '代码审查', source: 'extension' },
  { name: '/fix', description: '修复问题', source: 'skill' },
  { name: '/compact', source: 'builtin' },
]

describe('command store', () => {
  it('applyCommands → getCommands 返回归一化项（icon 按 source 推断，description 透传）', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW)
    const cmds = store.getCommands('s1')
    expect(cmds).toHaveLength(4)
    expect(cmds[0]).toEqual({ id: '/commit', name: '/commit', kind: 'extension', icon: 'terminal', description: '提交改动' })
    expect(cmds[2]).toEqual({ id: '/fix', name: '/fix', kind: 'skill', icon: 'star', description: '修复问题' })
    // builtin 默认 wrench，无 description
    expect(cmds[3]).toEqual({ id: '/compact', name: '/compact', kind: 'builtin', icon: 'wrench', description: undefined })
  })

  it('getCommands 未知 session → 空数组（不写入 Map）', () => {
    const store = useCommandStore()
    expect(store.getCommands('unknown')).toEqual([])
  })

  it('applyCommands 覆盖写：同 session 二次 apply 替换不残留旧项', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW)
    expect(store.getCommands('s1')).toHaveLength(4)
    store.applyCommands('s1', [{ name: '/new', source: 'extension' }])
    expect(store.getCommands('s1')).toHaveLength(1)
    expect(store.getCommands('s1')[0].name).toBe('/new')
  })

  it('session 隔离：s1/s2 各自独立', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW.slice(0, 2))
    store.applyCommands('s2', RAW.slice(2))
    expect(store.getCommands('s1')).toHaveLength(2)
    expect(store.getCommands('s2')).toHaveLength(2)
    expect(store.getCommands('s1')[0].name).toBe('/commit')
    expect(store.getCommands('s2')[0].name).toBe('/fix')
  })

  it('clearCommands 移除指定 session（不触及其他）', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW)
    store.applyCommands('s2', RAW)
    store.clearCommands('s1')
    expect(store.getCommands('s1')).toEqual([])
    expect(store.getCommands('s2')).toHaveLength(4)
  })

  it('findCommandByName 精确匹配（用户气泡 chip 解析用）', () => {
    const store = useCommandStore()
    store.applyCommands('s1', RAW)
    expect(store.findCommandByName('s1', '/commit')?.icon).toBe('terminal')
    expect(store.findCommandByName('s1', '/fix')?.icon).toBe('star')
    expect(store.findCommandByName('s1', '/nonexistent')).toBeUndefined()
  })

  // ── 核心回归：跨「组件重建」数据持久 ──
  it('数据不随 effectScope（≈组件）销毁丢失：apply 后新 scope 仍可读', () => {
    // 模拟：组件 A（scope A）写入 store，卸载后组件 B（scope B）读取仍有数据
    const scopeA = effectScope()
    scopeA.run(() => {
      const store = useCommandStore()
      store.applyCommands('s1', RAW)
    })
    scopeA.stop()

    const scopeB = effectScope()
    const result = scopeB.run(() => {
      const store = useCommandStore()
      return store.getCommands('s1')
    })
    expect(result).toHaveLength(4)
    expect(result![0].name).toBe('/commit')
    scopeB.stop()
  })
})
