/**
 * ALS async-context 透传测试（P5 clientId 注入）。
 *
 * 覆盖 TC4:
 * - sessionContext.run 内 getStore 返回 { clientId }
 * - run 外 getStore 返回 undefined
 * - 异步链路（setTimeout）透传 clientId
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/__tests__/async-context.test.ts
 */
import { describe, it, expect } from 'vitest'
import { sessionContext } from '../async-context.js'

describe('sessionContext ALS（P5 clientId 透传）', () => {
  it('TC4a: run 内 getStore 返回 { clientId }，run 外返回 undefined', () => {
    expect(sessionContext.getStore()).toBeUndefined()

    let inside: { clientId?: string } | undefined
    sessionContext.run({ clientId: 'client-x' }, () => {
      inside = sessionContext.getStore()
    })

    expect(inside).toEqual({ clientId: 'client-x' })
    // run 结束后 store 复位
    expect(sessionContext.getStore()).toBeUndefined()
  })

  it('TC4b: 异步链路（setTimeout/Promise）透传 clientId', async () => {
    let asyncStore: { clientId?: string } | undefined
    await new Promise<void>((resolve) => {
      sessionContext.run({ clientId: 'client-async' }, () => {
        setTimeout(() => {
          asyncStore = sessionContext.getStore()
          resolve()
        })
      })
    })

    expect(asyncStore).toEqual({ clientId: 'client-async' })
  })

  it('TC4c: 嵌套 run 各自独立（内层不污染外层 store）', () => {
    const stores: Array<{ clientId?: string } | undefined> = []
    sessionContext.run({ clientId: 'outer' }, () => {
      stores.push(sessionContext.getStore())
      sessionContext.run({ clientId: 'inner' }, () => {
        stores.push(sessionContext.getStore())
      })
      stores.push(sessionContext.getStore())
    })

    expect(stores).toEqual([
      { clientId: 'outer' },
      { clientId: 'inner' },
      { clientId: 'outer' },
    ])
  })
})
