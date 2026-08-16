/**
 * toRenderItemsIncremental 纯函数单测 —— D-4 turn 派生增量化（08-render-layer §3.3.1，perf W21）。
 *
 * 验收口径（plan W21）：
 * - ① 增量复用：同源数组引用第二次调用 cachedItems 引用恒等（零重算，filter 不再调用）
 * - ② 末位追加消息只重建末位 turn（前面 turn 对象引用 toBe 恒等）
 * - ③ forceWorking 变化只重算末位（源数组不变走快路径）
 * - ④ 非 turn 项（systemNotice/bashExecution）行为等价（快路径引用复用 + 重扫与全量版 deepEqual）
 * - ⑤ 缓存分区隔离：经 useSessionScopedState 工厂分区持有，sid A/B 互不污染、切回恢复、
 *   cleanup 后重建（ADR-0049 Map 分区语义）
 * - cache=undefined 退化路径与全量版输出 deepEqual；流式追加序列逐步与全量版等价
 *
 * 前提：D-1 不可变消息身份（成员引用未变 = 内容未变）——fixture 严格遵守「更新 = 新对象替换」。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/message-turns.incremental.test.ts
 */
import { describe, it, expect } from 'vitest'
import { effectScope, ref, shallowRef } from 'vue'
import {
  toRenderItems,
  toRenderItemsIncremental,
  createTurnRenderCache,
  filterDisplayableMessages,
} from '../message-turns'
import type { RenderItem, TurnRenderCache } from '../message-turns'
import { useSessionScopedState } from '../../../foundation/use-session-scoped-state'
import type { Message } from '@xyz-agent/shared'

// ── fixture 构造 helper ───────────────────────────────────────────────

let seq = 0
function makeMsg(over: Partial<Message> = {}): Message {
  seq += 1
  return { id: `m${seq}`, role: 'assistant', content: '', status: 'complete', timestamp: 0, ...over }
}

function bashMsg(id: string, over: Partial<Message> = {}): Message {
  return makeMsg({
    id,
    role: 'system',
    content: '',
    bashExecution: {
      command: 'echo hi',
      output: 'hi',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1000,
    },
    ...over,
  })
}

/** 收窄 helper：取 turn 项的 MessageTurn（非 turn 项抛错，测试自检用） */
function turnOf(item: RenderItem) {
  if (item.kind !== 'turn') throw new Error(`expected turn item, got ${item.kind}`)
  return item.turn
}

/** 混合 fixture：turn / systemNotice / bashExecution 全 kind 覆盖 */
function mixedFixture(): Message[] {
  return [
    makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
    makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
    makeMsg({ id: 'c1', role: 'system', content: '压缩记录' }),
    makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
    makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
    bashMsg('bash-1'),
  ]
}

describe('toRenderItemsIncremental —— 退化路径与等价性', () => {
  it('cache=undefined 退化为全量版：输出与 toRenderItems deepEqual（forceWorking 双态）', () => {
    for (const fw of [false, true]) {
      const msgs = mixedFixture()
      expect(toRenderItemsIncremental(msgs, filterDisplayableMessages, fw, undefined)).toEqual(
        toRenderItems(filterDisplayableMessages(msgs), fw),
      )
    }
  })

  it('流式追加序列逐步等价：末位 assistant 对象逐步替换 + 新 turn + system 穿插，每步与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user', content: 'q1' })
    const a1v1 = makeMsg({ id: 'a1', role: 'assistant', content: '部分', status: 'streaming' })
    const steps: Message[][] = [
      [u1],
      [u1, a1v1],
      // token 推进 = 末位 assistant 新对象替换（D-1 不可变语义）
      [u1, makeMsg({ id: 'a1', role: 'assistant', content: '部分回复', status: 'streaming' })],
      // 新 turn 追加（上一末位 streaming 态应被校正为 false）
      [
        u1,
        makeMsg({ id: 'a1', role: 'assistant', content: '完整回复', status: 'complete' }),
        makeMsg({ id: 'c1', role: 'system', content: 'notice' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      ],
      [
        u1,
        makeMsg({ id: 'a1', role: 'assistant', content: '完整回复', status: 'complete' }),
        makeMsg({ id: 'c1', role: 'system', content: 'notice' }),
        makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
        makeMsg({ id: 'a2', role: 'assistant', content: 'r2', status: 'streaming' }),
      ],
    ]
    for (const step of steps) {
      expect(toRenderItemsIncremental(step, filterDisplayableMessages, false, cache)).toEqual(
        toRenderItems(filterDisplayableMessages(step), false),
      )
    }
  })

  it('display:false 消息过滤语义不变（filter 在重扫路径按现状调用）', () => {
    const cache = createTurnRenderCache()
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'h1', role: 'system', customType: 'todo-context', display: false, content: 'hidden' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ]
    const items = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    expect(items.map((i) => i.kind)).toEqual(['turn'])
    expect(items).toEqual(toRenderItems(filterDisplayableMessages(msgs), false))
  })
})

describe('toRenderItemsIncremental —— ① 快路径零重算', () => {
  it('同源数组引用第二次调用：返回引用恒等 + filter 零调用 + turn 对象 toBe 恒等', () => {
    const cache = createTurnRenderCache()
    const msgs = mixedFixture()
    const filterSpy = (m: Message[]) => filterDisplayableMessages(m)
    const r1 = toRenderItemsIncremental(msgs, filterSpy, false, cache)
    expect(r1).toBe(cache.cachedItems)
    // 快路径：同引用再次调用直接复用 cachedItems（含非 turn 项），不进 filter 不重扫
    const r2 = toRenderItemsIncremental(msgs, filterSpy, false, cache)
    expect(r2).toBe(r1)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
    expect(cache.lastSourceRef).toBe(msgs)
  })
})

describe('toRenderItemsIncremental —— ② 末位追加只重建末位 turn', () => {
  it('追加 assistant 进末位 turn：前面 turn 对象 toBe 恒等，末位 turn 重建（签名变化）', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const r1 = toRenderItemsIncremental([u1, a1, u2], filterDisplayableMessages, false, cache)
    const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
    const r2 = toRenderItemsIncremental([u1, a1, u2, a2], filterDisplayableMessages, false, cache)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 复用（身份恒等）
    expect(turnOf(r2[1])).not.toBe(turnOf(r1[1])) // 末位 turn 重建（[u2] → [u2,a2]）
    expect(turnOf(r2[1]).assistants.map((m) => m.id)).toEqual(['u2', 'a2'].slice(1))
    expect(r2).toEqual(toRenderItems(filterDisplayableMessages([u1, a1, u2, a2]), false))
  })

  it('追加新 user turn：历史 turn 全部 toBe 复用，新 turn 新建', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const r1 = toRenderItemsIncremental([u1, a1], filterDisplayableMessages, false, cache)
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const a2 = makeMsg({ id: 'a2', role: 'assistant', content: 'r2' })
    const r2 = toRenderItemsIncremental([u1, a1, u2, a2], filterDisplayableMessages, false, cache)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
    expect(turnOf(r2[1])).not.toBe(turnOf(r1[0]))
    expect(turnOf(r2[1]).index).toBe(2)
  })

  it('上次末位 turn 的 streaming 态过期被校正：追加新 turn 后旧末位 isStreaming 翻 false（不可变替换）', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1s = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' })
    const r1 = toRenderItemsIncremental([u1, a1s], filterDisplayableMessages, false, cache)
    expect(turnOf(r1[0]).isStreaming).toBe(true)
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const r2 = toRenderItemsIncremental([u1, a1s, u2], filterDisplayableMessages, false, cache)
    // turn1 不再是末位：isStreaming 校正为 false，对象不可变替换（ assistants 引用保留）
    expect(turnOf(r2[0]).isStreaming).toBe(false)
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
    expect(turnOf(r2[0]).assistants).toBe(turnOf(r1[0]).assistants)
    expect(r2).toEqual(toRenderItems(filterDisplayableMessages([u1, a1s, u2]), false))
  })

  it('hasFoldable 随成员变化重算：追加带 thinking 的 assistant 后末位 turn hasFoldable=true', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const r1 = toRenderItemsIncremental([u1], filterDisplayableMessages, false, cache)
    expect(turnOf(r1[0]).hasFoldable).toBe(false)
    const a1 = makeMsg({
      id: 'a1',
      role: 'assistant',
      thinking: [{ id: 'th1', content: '推理', collapsed: false }],
    })
    const r2 = toRenderItemsIncremental([u1, a1], filterDisplayableMessages, false, cache)
    expect(turnOf(r2[0])).not.toBe(turnOf(r1[0]))
    expect(turnOf(r2[0]).hasFoldable).toBe(true)
  })
})

describe('toRenderItemsIncremental —— ③ forceWorking 变化只重算末位', () => {
  it('源数组不变 fw false→true：仅末位 turn 对象替换，历史 turn toBe 恒等；再次同参引用恒等', () => {
    const cache = createTurnRenderCache()
    const msgs = mixedFixture() // items = [turn, systemNotice, turn, bashExecution]，末位 turn 在 index 2
    const r1 = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    const r2 = toRenderItemsIncremental(msgs, filterDisplayableMessages, true, cache)
    expect(r2).not.toBe(r1)
    expect(turnOf(r2[0])).toBe(turnOf(r1[0])) // 历史 turn 复用
    const t1 = turnOf(r1[2])
    const t2 = turnOf(r2[2])
    expect(t2).not.toBe(t1) // 末位 turn 替换
    expect(t2.isStreaming).toBe(true)
    expect(t1.isStreaming).toBe(false)
    // bashExecution 项（末位 static 项）引用恒等复用
    expect(r2[3]).toBe(r1[3])
    // cache 自洽：替换后再次同参 → 引用恒等（零重算）
    const r3 = toRenderItemsIncremental(msgs, filterDisplayableMessages, true, cache)
    expect(r3).toBe(r2)
    // fw true→false 对称回退
    const r4 = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    expect(turnOf(r4[2]).isStreaming).toBe(false)
    expect(turnOf(r4[0])).toBe(turnOf(r1[0]))
  })

  it('快路径末位 turn 查找正确跳过 static 项（末位是 bashExecution 时仍驱动最后一个 turn）', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant', content: 'r1' })
    const bash = bashMsg('bash-1')
    const msgs = [u1, a1, bash]
    const r1 = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    expect(r1.map((i) => i.kind)).toEqual(['turn', 'bashExecution'])
    const r2 = toRenderItemsIncremental(msgs, filterDisplayableMessages, true, cache)
    expect(turnOf(r2[0]).isStreaming).toBe(true) // bash 项之后的最后一个 turn 被正确驱动
    // bash 项本身引用复用（static 项不依赖 forceWorking）
    expect(r2[1]).toBe(r1[1])
  })

  it('末位 assistant status=streaming 时 fw 翻转 isStreaming 期望不变：引用恒等返回（零重算）', () => {
    const cache = createTurnRenderCache()
    const msgs = [
      makeMsg({ id: 'u1', role: 'user' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' }),
    ]
    const r1 = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    expect(turnOf(r1[0]).isStreaming).toBe(true)
    const r2 = toRenderItemsIncremental(msgs, filterDisplayableMessages, true, cache)
    expect(r2).toBe(r1) // 期望值不变 → cachedItems 引用恒等
  })
})

describe('toRenderItemsIncremental —— ④ 非 turn 项行为等价', () => {
  it('快路径：systemNotice/bashExecution 项引用恒等复用（cachedItems 整体复用）', () => {
    const cache = createTurnRenderCache()
    const msgs = mixedFixture()
    const r1 = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    const r2 = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    expect(r2[1]).toBe(r1[1]) // systemNotice
    // items = [turn, systemNotice, turn, bashExecution]（长度 4，下标 0-3）
    expect(r2[3]).toBe(r1[3]) // bashExecution（真实下标 3——r2[5] 是 vacuous 恒真，W21 review Fix-2）
    expect(r2[3].kind).toBe('bashExecution') // 确认下标 3 确是 bashExecution（防再次写错下标退化成 vacuous）
  })

  it('重扫路径：system 项重建但 message 引用相同、kind 相同，整体与全量版 deepEqual', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1 = makeMsg({ id: 'a1', role: 'assistant' })
    const c1 = makeMsg({ id: 'c1', role: 'system', content: '压缩记录' })
    const bash = bashMsg('bash-1')
    const r1 = toRenderItemsIncremental([u1, a1, c1, bash], filterDisplayableMessages, false, cache)
    const u2 = makeMsg({ id: 'u2', role: 'user' })
    const src2 = [u1, a1, c1, bash, u2]
    const r2 = toRenderItemsIncremental(src2, filterDisplayableMessages, false, cache)
    expect(r2[1]).not.toBe(r1[1]) // static 项重扫重建（新 wrapper 对象）
    expect(r2[1]).toEqual(r1[1]) // 内容等价
    if (r2[1].kind !== 'systemNotice' || r1[1].kind !== 'systemNotice') throw new Error('expected systemNotice')
    expect(r2[1].message).toBe(r1[1].message) // message 引用不变
    expect(r2).toEqual(toRenderItems(filterDisplayableMessages(src2), false))
  })
})

describe('toRenderItemsIncremental —— ④b 平移场景（W21 review Fix-5）', () => {
  it('prepend 历史（load-more）：输出与全量版 deepEqual，旧末位 turn 经重算路径 streaming 校正正确', () => {
    const cache = createTurnRenderCache()
    const u1 = makeMsg({ id: 'u1', role: 'user' })
    const a1s = makeMsg({ id: 'a1', role: 'assistant', content: 'r', status: 'streaming' })
    const r1 = toRenderItemsIncremental([u1, a1s], filterDisplayableMessages, false, cache)
    expect(turnOf(r1[0]).isStreaming).toBe(true)

    // 头部 prepend：system notice + 一个完整 turn → 旧 turn 签名整体下移一位，
    // 同位置签名错位 → 全部重算（08 §3.3.1 失效条件 2：位置平移的 turn 重算）
    const sys = makeMsg({ id: 'sys0', role: 'system', content: 'notice' })
    const u0 = makeMsg({ id: 'u0', role: 'user', content: 'history q' })
    const a0 = makeMsg({ id: 'a0', role: 'assistant', content: 'history a' })
    const src2 = [sys, u0, a0, u1, a1s]
    const r2 = toRenderItemsIncremental(src2, filterDisplayableMessages, false, cache)

    // 正确性兜底：平移场景输出与全量版 deepEqual（错位复用会导致 index/user 错乱，此处兜住）
    expect(r2).toEqual(toRenderItems(filterDisplayableMessages(src2), false))
    expect(r2.map((i) => i.kind)).toEqual(['systemNotice', 'turn', 'turn'])
    // 旧末位 turn（现第 2 个 turn）仍为末位：重算后 isStreaming 正确保持 true（成员 a1s 仍 streaming）
    expect(turnOf(r2[2]).isStreaming).toBe(true)
    expect(turnOf(r2[2]).user?.id).toBe('u1')
    expect(turnOf(r2[2]).index).toBe(2)
  })

  it('中删一 turn（branch/fork 剪枝）：后续 turn 重算，index 连续不跳号，前缀 turn 引用复用', () => {
    const cache = createTurnRenderCache()
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'r3' }),
    ]
    const r1 = toRenderItemsIncremental(msgs, filterDisplayableMessages, false, cache)
    expect(r1.map((i) => i.kind)).toEqual(['turn', 'turn', 'turn'])

    // 删中间 turn2（[u2,a2] 整组移除）：位置 1 旧签名 [u2,a2] vs 新 [u3,a3] 错位 → 重算
    const src2 = msgs.filter((m) => m.id !== 'u2' && m.id !== 'a2')
    const r2 = toRenderItemsIncremental(src2, filterDisplayableMessages, false, cache)

    // 前缀 turn 引用复用（位置 0 签名对齐）
    expect(turnOf(r2[0])).toBe(turnOf(r1[0]))
    // 后续 turn 重算：index 连续（1,2 —— 非 1,3 跳号残留）
    expect(r2.map((i) => i.kind)).toEqual(['turn', 'turn'])
    expect(turnOf(r2[1]).index).toBe(2)
    expect(turnOf(r2[1]).user?.id).toBe('u3')
    expect(turnOf(r2[1])).not.toBe(turnOf(r1[2])) // 旧 turn3 对象不复用（签名错位重算）
    expect(r2).toEqual(toRenderItems(filterDisplayableMessages(src2), false))
  })
})

describe('toRenderItemsIncremental —— ⑤ 缓存分区隔离（useSessionScopedState 组合语义）', () => {
  /** 模拟 MessageStream 的消费形态：工厂分区持有 shallowRef 包裹的 TurnRenderCache */
  function setup() {
    const scope = effectScope()
    const store: Record<string, Message[]> = {
      a: [
        makeMsg({ id: 'ua1', role: 'user', content: 'A 的提问' }),
        makeMsg({ id: 'aa1', role: 'assistant', content: 'A 的回复' }),
      ],
      b: [
        makeMsg({ id: 'ub1', role: 'user', content: 'B 的提问' }),
        makeMsg({ id: 'ab1', role: 'assistant', content: 'B 的回复' }),
      ],
    }
    let deriveFor!: (sid: string, forceWorking?: boolean) => RenderItem[]
    let state: ReturnType<typeof useSessionScopedState<ReturnType<typeof makeCacheRef>>>
    function makeCacheRef() {
      return shallowRef<TurnRenderCache>(createTurnRenderCache())
    }
    scope.run(() => {
      const sidRef = ref<string | null>('a')
      state = useSessionScopedState(sidRef, makeCacheRef)
      deriveFor = (sid: string, forceWorking = false) => {
        sidRef.value = sid
        const cacheRef = state.current.value
        return toRenderItemsIncremental(store[sid], filterDisplayableMessages, forceWorking, cacheRef.value)
      }
    })
    return { deriveFor, state: () => state, store }
  }

  it('sid A/B 互不污染：切 B 再切回 A，A 的 cachedItems 引用恒等（快路径命中、分区保留）', () => {
    const { deriveFor } = setup()
    const ra1 = deriveFor('a')
    const rb = deriveFor('b')
    // B 的派生内容正确（不串台）
    expect(turnOf(rb[0]).user?.id).toBe('ub1')
    expect(turnOf(rb[0]).user?.content).toBe('B 的提问')
    // 切回 A：分区保留 → 源数组引用未变 → 快路径命中（被 B 污染则会重扫或内容错乱）
    const ra2 = deriveFor('a')
    expect(ra2).toBe(ra1)
    expect(turnOf(ra2[0]).user?.id).toBe('ua1')
    // B 侧同理
    const rb2 = deriveFor('b')
    expect(rb2).toBe(rb)
  })

  it('cleanup(sid) 后分区重建：该 sid 重新全量派生（对象新），另一 sid 分区不受影响', () => {
    const { deriveFor, state } = setup()
    const ra1 = deriveFor('a')
    const rb1 = deriveFor('b')
    state().cleanup('a') // 模拟 triggerSessionCleanups('a') 走到的分区删除
    const ra2 = deriveFor('a')
    expect(ra2).not.toBe(ra1) // 分区重建 → 全量重扫（引用新）
    expect(ra2).toEqual(ra1) // 内容不变（纯派生缓存可无损重建）
    const rb2 = deriveFor('b')
    expect(rb2).toBe(rb1) // B 分区未受 cleanup('a') 影响
  })
})
