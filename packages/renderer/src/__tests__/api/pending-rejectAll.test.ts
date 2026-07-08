/**
 * pending.rejectAll 单测 —— WS 断连 / runtime 崩溃时批量 reject 防永挂。
 *
 * 锁定 R4（WS 断连时 pendingMap 不清理，Promise 永挂 + 内存泄漏）。
 * pending 模块级的 pendingMap 是模块单例，跨测试共享，因此每个 it 必须自行清场
 * （rejectAll 会在结束时清空，正常用例结束 pendingMap 为空；reject 失败用例需兜底清场）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/api/pending-rejectAll.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as pending from '@/api/pending'

describe('pending.rejectAll', () => {
  beforeEach(() => {
    // 确保模块单例 pendingMap 在每个用例前为空
    pending.rejectAll(new Error('setup cleanup'))
  })

  it('reject 所有已注册的 pending 请求（多条同时清理）', async () => {
    const p1 = pending.register<string>(pending.create())
    const p2 = pending.register<number>(pending.create())
    const p3 = pending.register<boolean>(pending.create())

    pending.rejectAll(new Error('WS 断连'))

    await expect(p1).rejects.toThrow('WS 断连')
    await expect(p2).rejects.toThrow('WS 断连')
    await expect(p3).rejects.toThrow('WS 断连')
  })

  it('rejectAll 后 pendingMap 被清空（后续 resolve/reject 为 no-op）', async () => {
    const id = pending.create()
    const p = pending.register<string>(id)

    pending.rejectAll(new Error('清空'))

    await expect(p).rejects.toThrow('清空')

    // pendingMap 已空：后续对同一 id 的 resolve/reject 不应抛错，也不应 resolve 已 reject 的 p
    expect(() => pending.resolve(id, 'late')).not.toThrow()
    expect(() => pending.reject(id, new Error('late'))).not.toThrow()
  })

  it('rejectAll 空的 pendingMap 时不抛错', () => {
    expect(() => pending.rejectAll(new Error('noop'))).not.toThrow()
  })

  it('rejectAll 后新注册的请求不受影响（可正常 resolve）', async () => {
    pending.rejectAll(new Error('first batch'))

    const id = pending.create()
    const p = pending.register<string>(id)
    pending.resolve(id, 'new value')

    await expect(p).resolves.toBe('new value')
  })

  it('rejectAll 透传 error 对象（含 code 等附加属性的场景）', async () => {
    const id = pending.create()
    const p = pending.register<string>(id)

    const customError = Object.assign(new Error('runtime crashed'), { code: 'E_RUNTIME' })
    pending.rejectAll(customError)

    await expect(p).rejects.toMatchObject({ message: 'runtime crashed', code: 'E_RUNTIME' })
  })
})
