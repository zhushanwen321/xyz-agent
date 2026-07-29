/**
 * async-mutex 单测（P6 D1 / AC1-AC4）。
 *
 * 覆盖 run 的全部正确性维度：
 * - TC1 同 key 串行执行（第二个等第一个完成）
 * - TC2 不同 key 并发执行互不阻塞
 * - TC3 排队超过 timeoutMs 抛 TimeoutError（fn 未执行）
 * - TC4 无排队时 Map 条目自动删除防泄漏
 * - TC5 fn 抛错时 chain 仍推进（后续排队不永久阻塞）
 */
import { describe, it, expect } from 'vitest'
import { createKeyedMutex, TimeoutError } from './async-mutex.js'

/** 简单 delay helper（真实 setTimeout，vitest 默认不 mock timers）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createKeyedMutex (P6 D1)', () => {
  it('TC1: 同 key 的 async fn 串行执行（第二个等第一个完成才运行）', async () => {
    const mutex = createKeyedMutex()
    const order: string[] = []

    // fn1 内部延迟较长，fn2 记录执行顺序。串行化要求 f2.start 在 f1.end 之后。
    const fn1 = async (): Promise<void> => {
      order.push('f1-start')
      await delay(20)
      order.push('f1-end')
    }
    const fn2 = async (): Promise<void> => {
      order.push('f2-start')
      await delay(5)
      order.push('f2-end')
    }

    // 连续 run（不 await fn1 完成就 run fn2，验证串行）
    const p1 = mutex.run('repo-a', fn1)
    const p2 = mutex.run('repo-a', fn2)
    await Promise.allSettled([p1, p2])

    // 严格顺序：f2 的 start 必须在 f1 的 end 之后（无交错）
    expect(order).toEqual(['f1-start', 'f1-end', 'f2-start', 'f2-end'])
  })

  it('TC2: 不同 key 的 async fn 并发执行互不阻塞', async () => {
    const mutex = createKeyedMutex()

    const start = Date.now()
    // 两个不同 key 各延迟 30ms，并发触发应 ≈30ms（串行会 ≈60ms）
    const results = await Promise.allSettled([
      mutex.run('a', async () => { await delay(30); return 'a' }),
      mutex.run('b', async () => { await delay(30); return 'b' }),
    ])
    const elapsed = Date.now() - start

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('fulfilled')
    if (results[0].status === 'fulfilled') expect(results[0].value).toBe('a')
    if (results[1].status === 'fulfilled') expect(results[1].value).toBe('b')
    // 并发：总耗时 < 50ms（串行会 ≈60ms，留余量区分）
    expect(elapsed).toBeLessThan(50)
  })

  it('TC3: 排队超过 timeoutMs 抛 TimeoutError 且 fn 未执行', async () => {
    const mutex = createKeyedMutex()
    let fn2Executed = false

    // fn1 长延迟（占用 key），fn2 排队等 fn1，timeoutMs=20 远小于 fn1 的 200ms
    const p1 = mutex.run('x', async () => { await delay(200) })
    const p2 = mutex.run('x', async () => { fn2Executed = true; await delay(10) }, 20)

    // p2 应 reject TimeoutError
    await expect(p2).rejects.toBeInstanceOf(TimeoutError)
    expect(fn2Executed).toBe(false) // fn2 体未执行（超时在排队阶段拒绝）
    // p1 正常完成
    await p1
  })

  it('TC4: 无排队时 Map 条目自动删除防泄漏', async () => {
    const mutex = createKeyedMutex()

    // 连续 run 1000 个不同 key（每个只 run 一次完成即无排队），验证内部 chains 不泄漏。
    // 完成后所有 key 的 chain 应被 finally 清理（chains.get(key)?.promise === next 判断成立即删）。
    for (let i = 0; i < 1000; i++) {
      await mutex.run(`cleanup-${i}`, async () => i)
    }

    // 再次 run 某 key 应全新正常工作（证明无残留 chain 卡死）
    const result = await mutex.run('cleanup-0', async () => 'fresh')
    expect(result).toBe('fresh')

    // 间接验证无泄漏：连续 run 同一个 key 1000 次（每次完成无排队），应全部正常且快速完成。
    // 若 finally 未清理 Map，chain 引用会累积（虽不直接卡死但内存增长）——这里验证功能正常。
    let last = -1
    for (let i = 0; i < 1000; i++) {
      last = await mutex.run('same-key', async () => i)
    }
    expect(last).toBe(999)
  })

  it('TC5: fn 抛错时 chain 仍推进（后续排队不永久阻塞）+ 错误原样传播', async () => {
    const mutex = createKeyedMutex()

    // fn1 reject，fn2 紧接 run。fn2 必须仍执行（chain 不因 fn1 错误卡死）。
    const p1 = mutex.run('err-chain', async () => { throw new Error('boom') })
    const p2 = mutex.run('err-chain', async () => 'ok')

    // fn1 的错误原样传播
    await expect(p1).rejects.toThrow('boom')
    // fn2 正常执行（未被 fn1 错误阻塞）
    await expect(p2).resolves.toBe('ok')
  })

  it('不传 timeoutMs 时无限等待（fn2 等 fn1 完成才执行，不超时拒绝）', async () => {
    const mutex = createKeyedMutex()

    // fn1 延迟 50ms，fn2 不传 timeoutMs 应等 fn1 完成后正常执行（非超时拒绝）
    const p1 = mutex.run('no-timeout', async () => { await delay(50); return 'done1' })
    const p2 = mutex.run('no-timeout', async () => 'done2')

    await expect(p1).resolves.toBe('done1')
    await expect(p2).resolves.toBe('done2')
  })

  it('TC6: run 超时且无后续排队时，内部 chains Map 清理该 key（无泄漏）', async () => {
    // 覆盖超时后的清理路径：fn1 长占 key，fn2 排队超时（无 fn3 接力）。
    // fn2 的 finally 应判 chains.get(key)?.promise === fn2.next 命中并 delete，否则 Map 残留泄漏。
    const mutex = createKeyedMutex()
    // _chainsForTest 是测试钩子，暴露内部 chains Map 供泄漏断言（生产代码不应依赖）
    const chains = mutex._chainsForTest

    // fn1 占用 key 200ms，fn2 排队 timeout=20ms 必超时（fn1 尚未完成）
    const p1 = mutex.run('leak-check', async () => { await delay(200); return 'f1' })
    const p2 = mutex.run('leak-check', async () => 'f2', 20)

    // fn2 超时拒绝（排队阶段被 race 拒绝，fn 体未执行）
    await expect(p2).rejects.toBeInstanceOf(TimeoutError)
    // 关键断言：fn2 超时后，其 next 是最新尾部（无 fn3 接力），finally 应 delete 该 key。
    // 此时 fn1 仍在跑，但其 next_fn1 不是最新尾部（fn2 排队时已覆写为 next_fn2），
    // 故 chains.get('leak-check') 应为 undefined（fn2 的 delete 已生效）。
    expect(chains.has('leak-check')).toBe(false)

    await p1
  })
})
