/**
 * [W14] pendingBuffer 计数 FIFO 核心回归（data-source-governance P2.2，D1 表末行 + D6）。
 *
 * 背景：pi 入队存 skill 展开后文本 ≠ 提交原文（pi agent-session _expandSkillCommand /
 * expandPromptTemplate 先于入队），投递定位的文本相等匹配在该场景必挂（消息永久丢失）。
 * 本 wave 改计数 FIFO：queue_update 差集（countDrained）算出被投递条数 N → drainN 按条数取。
 *
 * 三组核心回归用例（plan W14 步骤 3 / 验收 4）：
 * - 组1：相同文本多次提交（['A','A'] drain 1 条）取最早一条（countDrained 注释中的 TC）
 * - 组2：展开后文本 ≠ 提交原文时仍按条数取出（本 wave 核心回归——文本匹配必挂场景）
 * - 组3：深度对账——pendingBuffer 与 pendingMessageCount 偏差 1（模拟扩展注入例外）
 *   → 下一次 queue_update 到达后偏差收敛（D6 残余风险边界的行为规格）
 * - 组4：buffer > 深度（队列被外部清空）→ reconcilePending 裁剪僵尸暂存
 *
 * 端到端：真 createChatStore + applyMessageEvent（真 registry dispatch 链，非 ctx mock）。
 * 纯数据层（fake timers 不需要——queue_update 路径不挂 timer）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/pending-drain-fifo.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { effectScope, toRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { textToSegments, segmentsToText, type Segment, type ServerMessage } from '@xyz-agent/shared'

/** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。 */
function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** 引用断言 helper：pendingBuffer 是深响应式 ref，buffer 内取出的 segments 是 reactive
 *  Proxy——toRaw 解回 raw 引用后与 push 时传入的原始数组做 Object.is 比较（FIFO「取最早」
 *  的精确判据：同文本两条内容相等，只有引用可区分入队先后）。 */
function rawContent(content: unknown): Segment[] {
  return toRaw(content as Segment[])
}

describe('W14 pendingBuffer 计数 FIFO（queue_update 差集驱动，D6）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }
  const sid = 's-w14'

  /** 广播一帧 queue_update（payload 默认带 sessionId；steering/followUp 为 pi 队列全量数组） */
  function queueUpdate(payload: Record<string, unknown>): void {
    const msg = { type: 'message.queue_update', payload: { sessionId: sid, ...payload } } as ServerMessage
    sut.store.applyMessageEvent(sid, msg)
  }

  /** 读该 session 的 pendingBuffer 暂存条数（深度对账断言用） */
  function bufferLen(): number {
    return sut.store.pendingBuffer.value.get(sid)?.length ?? 0
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    sut = makeStore()
  })
  afterEach(() => sut.dispose())

  it('组1: 相同文本多次提交（["A","A"] drain 1 条）→ 取最早一条（FIFO）', () => {
    const segFirst: Segment[] = textToSegments('A')
    const segSecond: Segment[] = textToSegments('A')
    sut.store.pushPending(sid, segFirst, 'steer')
    sut.store.pushPending(sid, segSecond, 'steer')

    // pi 入队后广播全量数组（两条同文本）
    queueUpdate({ steering: ['A', 'A'], pendingMessageCount: 2 })
    // pi 投递 1 条：数组 ['A']——countDrained(['A','A'], ['A']) 差集条数 N=1
    queueUpdate({ steering: ['A'], pendingMessageCount: 1 })

    // 取最早一条：引用断言（drainN 返回入队最早的 segments 原引用，appendUser 原样进对话流）
    const msgs = sut.store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].status).toBe('complete')
    expect(rawContent(msgs[0].content)).toBe(segFirst)
    // 第二条仍在暂存（等下一次 drain）
    expect(bufferLen()).toBe(1)

    // 第二次 drain：数组清空 → N=1 → 取剩下那条
    queueUpdate({ steering: [], pendingMessageCount: 0 })
    const msgs2 = sut.store.getMessages(sid)
    expect(msgs2).toHaveLength(2)
    expect(rawContent(msgs2[1].content)).toBe(segSecond)
    expect(bufferLen()).toBe(0)
  })

  it('组2（核心回归）: skill 展开后文本 ≠ 提交原文 → 仍按条数取出（文本匹配必挂场景）', () => {
    // 提交原文（skill 命令形式）
    const original: Segment[] = textToSegments('/deploy --prod')
    sut.store.pushPending(sid, original, 'steer')

    // pi 入队存展开后文本（与原文完全不同）→ queue_update 全量数组是展开文本
    const expanded = 'skill deploy 展开：先检查环境，再执行 prod 部署流程……（全文与 /deploy --prod 无任何文本相等关系）'
    queueUpdate({ steering: [expanded], pendingMessageCount: 1 })

    // pi 投递（数组清空）：countDrained 差集 N=1 → drainN 按条数取，不看文本
    queueUpdate({ steering: [], pendingMessageCount: 0 })

    // 旧文本匹配在此场景 drainPending 匹配失败 → 消息永久丢失（父文档 #6 失联即丢）；
    // 计数 FIFO 必过：原文 segments 原样进对话流
    const msgs = sut.store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].status).toBe('complete')
    expect(rawContent(msgs[0].content)).toBe(original)
    expect(segmentsToText(rawContent(msgs[0].content))).toBe('/deploy --prod')
    expect(bufferLen()).toBe(0)
  })

  it('组3: 深度对账——扩展注入偏差 1 → 下一次 queue_update 到达后偏差收敛', () => {
    sut.store.pushPending(sid, textToSegments('renderer one'), 'steer')
    sut.store.pushPending(sid, textToSegments('renderer two'), 'steer')

    // 帧1：pi 队列 3 条 = renderer 2 条 + 扩展 deliverAs 注入 1 条（renderer 未提交，
    // pendingBuffer 无此条）→ 偏差存在：buffer(2) < 深度(3)。D6 已知例外：无法凭空补
    // segments，接受有界偏差（不裁剪、不误删 renderer 暂存）。
    queueUpdate({ steering: ['renderer one', 'renderer two', 'EXT injected'], pendingMessageCount: 3 })
    expect(bufferLen()).toBe(2)

    // 帧2（下一次 queue_update）：pi 清空队列全部投递 → countDrained 差集 N=3，
    // drainN(sid, 'steer', 3) 取尽即止（buffer 只有 2 条）
    queueUpdate({ steering: [], pendingMessageCount: 0 })

    // renderer 两条按入队顺序进对话流（不是 3 条——扩展条无前端暂存，由 pi 侧自己投递）
    const msgs = sut.store.getMessages(sid)
    expect(msgs).toHaveLength(2)
    expect(segmentsToText(msgs[0].content as Segment[])).toBe('renderer one')
    expect(segmentsToText(msgs[1].content as Segment[])).toBe('renderer two')
    // 偏差收敛：drain 后 pendingBuffer 长度 === 帧内深度（0 === 0）
    expect(bufferLen()).toBe(0)
  })

  it('组4: 深度对账——buffer > 深度（队列被外部清空）→ 裁剪僵尸暂存到深度', () => {
    sut.store.pushPending(sid, textToSegments('will stay'), 'steer')
    sut.store.pushPending(sid, textToSegments('zombie'), 'steer')

    // 帧1：首帧数组只 1 条（深度 1 < buffer 2，模拟 pi 队列内容被外部清掉一条——
    // 僵尸暂存永不被投递且污染后续 FIFO 计数）→ reconcilePending 裁剪到深度
    queueUpdate({ steering: ['will stay'], pendingMessageCount: 1 })
    const buf = sut.store.pendingBuffer.value.get(sid) ?? []
    expect(buf).toHaveLength(1)
    expect(buf[0].text).toBe('will stay')

    // 帧2：投递 → 取出唯一暂存，结构归零
    queueUpdate({ steering: [], pendingMessageCount: 0 })
    expect(sut.store.getMessages(sid)).toHaveLength(1)
    expect(bufferLen()).toBe(0)
  })

  it('组5: queue_update 全量数组照常写 queueStates（QueueBubble 显示行为不变）', () => {
    queueUpdate({ steering: ['queued text'], pendingMessageCount: 1 })
    expect(sut.store.getQueueState(sid)?.steering).toEqual(['queued text'])

    queueUpdate({ steering: [], pendingMessageCount: 0 })
    // 空数组 = 无内容 → queueStates 清除（QueueBubble 消失）
    expect(sut.store.getQueueState(sid)).toBeUndefined()
  })
})
