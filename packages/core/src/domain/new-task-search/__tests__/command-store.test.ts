/**
 * createCommandStore 单测（IF1）。
 *
 * 覆盖 plan TC-1..TC-6：applyCommands 归一化（source→icon key）/ per-session 分区隔离 /
 * clearCommands 幂等 / registerApp 覆盖不碰 commandsBySession / pendingSlash 写-消费-清 /
 * shortcutOverrides 经 mock storage 持久化（async 读写 + 失败降级）。
 * node 环境实测 vue reactivity（ref/computed），storage 用 Map 实现 mock。
 */
import { describe, expect, it } from 'vitest'
import type { KVStorage } from '../../../platform/port'
import { createCommandStore, type RawCommand } from '../command-store'

/** Map 实现 KVStorage（async 语义对齐 PlatformPort.storage 契约） */
function makeMockStorage(initial?: Record<string, string>): KVStorage & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
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

/** 构造 RawCommand 的辅助函数 */
function raw(name: string, source: string, extra?: Partial<RawCommand>): RawCommand {
  return { name, source, ...extra }
}

describe('createCommandStore', () => {
  it('TC-1: applyCommands 归一化（source → icon key 映射 + 字段透传）', () => {
    const store = createCommandStore(makeMockStorage())
    store.applyCommands('s1', [
      raw('goal', 'extension'),
      raw('skill:code-review', 'skill'),
      raw('plain', 'other'),
    ])

    const cmds = store.getCommands('s1')
    expect(cmds.map((c) => c.icon)).toEqual(['terminal', 'star', 'wrench'])
    expect(cmds.map((c) => c.name)).toEqual(['goal', 'skill:code-review', 'plain'])
    // id = name，kind = source
    expect(cmds[0]).toMatchObject({ id: 'goal', kind: 'extension' })
    expect(cmds[1]).toMatchObject({ id: 'skill:code-review', kind: 'skill' })
    // description / sourceInfo 透传
    store.applyCommands('s1', [raw('doc', 'extension', { description: 'desc', sourceInfo: { path: '/x/SKILL.md', source: 'skill' } })])
    expect(store.getCommands('s1')[0]).toMatchObject({
      description: 'desc',
      sourceInfo: { path: '/x/SKILL.md', source: 'skill' },
    })
  })

  it('TC-2: commandsBySession per-session 分区隔离', () => {
    const store = createCommandStore(makeMockStorage())
    store.applyCommands('s1', [raw('a', 'extension')])
    store.applyCommands('s2', [raw('b', 'skill')])

    expect(store.getCommands('s1').map((c) => c.name)).toEqual(['a'])
    expect(store.getCommands('s2').map((c) => c.name)).toEqual(['b'])
    // 未写入的 session 返回空数组且不落键
    expect(store.getCommands('s3')).toEqual([])
    expect(store.commandsBySession.value.has('s3')).toBe(false)
    // 响应式视图按 session 隔离
    expect(store.slashCommandsOf('s1').value.map((c) => c.name)).toEqual(['a'])
    expect(store.slashCommandsOf('s2').value.map((c) => c.name)).toEqual(['b'])
  })

  it('TC-3: clearCommands 删除分区（幂等）', () => {
    const store = createCommandStore(makeMockStorage())
    store.applyCommands('s1', [raw('a', 'extension')])
    store.clearCommands('s1')

    expect(store.getCommands('s1')).toEqual([])
    expect(store.commandsBySession.value.has('s1')).toBe(false)
    // 对不存在 session 调用无副作用不抛错
    expect(() => store.clearCommands('nope')).not.toThrow()
  })

  it('TC-4: registerApp 幂等覆盖（不碰 commandsBySession）', () => {
    const store = createCommandStore(makeMockStorage())
    const cmdA = { id: 'a', name: 'A', action: () => {} }
    const cmdB = { id: 'b', name: 'B', action: () => {} }
    const cmdC = { id: 'c', name: 'C', action: () => {} }

    store.registerApp([cmdA, cmdB])
    expect(store.appCommands.value).toEqual([cmdA, cmdB])

    // 覆盖非累加
    store.registerApp([cmdC])
    expect(store.appCommands.value).toEqual([cmdC])

    // D-016 物理隔离：registerApp 不写 commandsBySession
    store.applyCommands('s1', [raw('x', 'extension')])
    store.registerApp([cmdA])
    expect(store.getCommands('s1').map((c) => c.name)).toEqual(['x'])
  })

  it('TC-5: pendingSlash 写-消费-清（一次性通道 + 覆盖更新 ts）', () => {
    const store = createCommandStore(makeMockStorage())
    expect(store.pendingSlash.value).toBeNull()

    store.requestSlashInjection({ command: '/goal', sessionId: 's1' })
    expect(store.pendingSlash.value).toMatchObject({ command: '/goal', sessionId: 's1' })
    expect(typeof store.pendingSlash.value?.ts).toBe('number')

    const ts1 = store.pendingSlash.value!.ts
    store.requestSlashInjection({ command: '/todo', sessionId: 's1' })
    expect(store.pendingSlash.value?.command).toBe('/todo')
    // ts 更新（覆盖旧值，非累加）
    expect(store.pendingSlash.value!.ts).toBeGreaterThanOrEqual(ts1)

    store.clearPendingSlash()
    expect(store.pendingSlash.value).toBeNull()
  })

  it('TC-6: shortcutOverrides 经 mock storage 持久化（async 读写 + 失败降级）', async () => {
    const storage = makeMockStorage({ 'xyz-agent-shortcut-overrides': '{"new-session":"j"}' })
    const store = createCommandStore(storage)

    // 初始化从 storage 回填
    await store.initShortcutOverrides()
    expect(store.shortcutOverrides.value).toEqual({ 'new-session': 'j' })

    // 写：内存态立即更新 + 异步持久化
    await store.setShortcutOverride('new-session', 'k')
    expect(store.shortcutOverrides.value).toEqual({ 'new-session': 'k' })
    expect(storage.store.get('xyz-agent-shortcut-overrides')).toBe('{"new-session":"k"}')

    // null 清除自定义键
    await store.setShortcutOverride('new-session', null)
    expect(store.shortcutOverrides.value).toEqual({})
    expect(storage.store.get('xyz-agent-shortcut-overrides')).toBe('{}')

    // 写入失败（配额满）降级内存态，不抛出
    const failingStorage = makeMockStorage()
    failingStorage.set = async () => {
      throw new Error('QuotaExceededError')
    }
    const store2 = createCommandStore(failingStorage)
    await expect(store2.setShortcutOverride('a', '1')).resolves.toBeUndefined()
    expect(store2.shortcutOverrides.value).toEqual({ a: '1' })
  })

  it('TC-6b: initShortcutOverrides 解析失败/异常降级空对象', async () => {
    // 非法 JSON → {}
    const badJson = makeMockStorage({ 'xyz-agent-shortcut-overrides': 'not-json{' })
    const store1 = createCommandStore(badJson)
    await store1.initShortcutOverrides()
    expect(store1.shortcutOverrides.value).toEqual({})

    // storage.get 抛错 → {}
    const failing = makeMockStorage()
    failing.get = async () => {
      throw new Error('storage unavailable')
    }
    const store2 = createCommandStore(failing)
    await store2.initShortcutOverrides()
    expect(store2.shortcutOverrides.value).toEqual({})
  })
})
