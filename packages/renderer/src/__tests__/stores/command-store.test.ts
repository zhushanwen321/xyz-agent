/**
 * command store 单测 —— pendingSlash 一次性消息通道（U1-U4）。
 *
 * 覆盖：
 * - U1 requestSlashInjection 写入 pendingSlash（含 ts 时间戳）
 * - U2 clearPendingSlash 清除
 * - U3 连续 requestSlashInjection 幂等覆盖（非累加）
 * - U4 pendingSlash 初值 null
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/stores/command-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCommandStore } from '@/stores/command'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('U4 pendingSlash 初值', () => {
  it('新建 pinia + useCommandStore() 未调任何方法 → pendingSlash 初值为 null', () => {
    const store = useCommandStore()
    expect(store.pendingSlash).toBeNull()
  })
})

describe('U1 requestSlashInjection 写入', () => {
  it('requestSlashInjection({command,icon,sessionId}) → pendingSlash 含全部字段 + ts 为 number', () => {
    const store = useCommandStore()
    vi.spyOn(Date, 'now').mockReturnValue(12345)

    store.requestSlashInjection({ command: '/goal', icon: 'star', sessionId: 's1' })

    expect(store.pendingSlash).toEqual({
      command: '/goal',
      icon: 'star',
      sessionId: 's1',
      ts: 12345,
    })

    vi.restoreAllMocks()
  })
})

describe('U2 clearPendingSlash 清除', () => {
  it('先 requestSlashInjection 再 clearPendingSlash → pendingSlash 为 null', () => {
    const store = useCommandStore()
    store.requestSlashInjection({ command: '/goal', icon: 'star', sessionId: 's1' })
    expect(store.pendingSlash).not.toBeNull()

    store.clearPendingSlash()

    expect(store.pendingSlash).toBeNull()
  })
})

describe('U3 requestSlashInjection 幂等覆盖', () => {
  it('连续两次 requestSlashInjection（不同 command）→ pendingSlash 为第二次值（覆盖非累加）', () => {
    const store = useCommandStore()
    let now = 100
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    store.requestSlashInjection({ command: '/goal', icon: 'star', sessionId: 's1' })
    expect(store.pendingSlash!.command).toBe('/goal')

    now = 200
    store.requestSlashInjection({ command: '/commit', icon: 'terminal', sessionId: 's2' })

    // 覆盖：第二次值，非累加
    expect(store.pendingSlash).toEqual({
      command: '/commit',
      icon: 'terminal',
      sessionId: 's2',
      ts: 200,
    })

    vi.restoreAllMocks()
  })
})
