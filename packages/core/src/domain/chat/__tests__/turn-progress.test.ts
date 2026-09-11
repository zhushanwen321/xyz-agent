/**
 * turn 进展观测面单测（session-dead-structural-fixes §3.3 D6 C1 方案一 / §3.1 成功路径 C）。
 *
 * 信号源走真实事件流入口：applyMessageEvent（message_start / text_delta / tool_call_*）
 * + store.setOccupancy（session.occupancy 帧 renderer 侧消费入口，useChat
 * handleSessionOccupancy 同一落点）。锁定四个验收语义：
 * - 结构事件边界驱动计时（u4 验收②）：turn-start 起算、tool 边界起止
 * - delta 只累计字数不重置计时（u4 验收②）：elapsed 仅按墙钟走
 * - ask_user pending 豁免（D6 豁免态 + u4 验收②）：超阈值不出警示、分型 awaitingUser
 * - turn 结束（occupancy → idle）展示消失 + 记忆复位（设计：展示自动消失，reload
 *   天然无残留——纯本地派生无持久化）
 * - 切 session 分区记忆以 turn 锚守门（F-U1）：后台 turn 已更替 → 切入重落基线不虚高；
 *   同 turn 切回 → 字符累计与计时基线保留
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/turn-progress.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref, effectScope } from 'vue'
import type { Ref } from 'vue'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import { useTurnProgress, TURN_PROGRESS_WARN_THRESHOLD_MS } from '../turn-progress'

const SID = 's-turn'

function makeEnv(initialSid: string | null = SID) {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  const sid: Ref<string | null> = ref(initialSid)
  const awaiting = { value: false }
  const sut = scope.run(() =>
    useTurnProgress(sid, store, { getAwaitingUser: () => awaiting.value }),
  )!
  return { scope, store, sid, awaiting, sut }
}

/** turn-start 真实事件序：occupancy 帧（generating，message_start 挂点驱动）+ message_start。 */
function startTurnEvents(store: ChatStoreInstance, sid = SID, messageId = 'a1'): void {
  store.setOccupancy(sid, { turn: 'generating', compacting: false, bash: false })
  store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId } })
}

function toolCallStartEvent(store: ChatStoreInstance, sid = SID): void {
  store.applyMessageEvent(sid, {
    type: 'message.tool_call_start',
    payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'write', arguments: {} } },
  })
}

function toolCallEndEvent(store: ChatStoreInstance, sid = SID): void {
  store.applyMessageEvent(sid, {
    type: 'message.tool_call_end',
    payload: {
      sessionId: sid,
      entry: {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: new Date().toISOString(),
        message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'done' }], timestamp: Date.now() },
      },
    },
  })
}

/** 推进墙钟并跑一个 tick（interval 周期 1s），返回最新快照。 */
async function advanceAndTick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await nextTick()
}

describe('turn-progress 结构事件边界驱动（u4 验收②）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turn-start（occupancy generating + message_start）起计时，墙钟推进即 elapsed 增长', async () => {
    const { scope, store, sut } = makeEnv()
    vi.advanceTimersByTime(100_000) // 事件到达前墙钟基线
    startTurnEvents(store)
    await nextTick()
    expect(sut.snapshot.value?.active).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(5_000)
    // 计时基线 = message_start 写入的 assistant timestamp（事件点），非 watch 触发点
    expect(sut.snapshot.value?.generatedChars).toBe(0)
    scope.stop()
  })

  it('delta 只累计字数不重置计时：elapsed 仅按墙钟走，不受 delta 帧影响', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(60_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(60_000)
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'hello' } })
    await nextTick()
    // delta 到达即累计字数（watch 事件驱动），计时基线不动
    expect(sut.snapshot.value?.generatedChars).toBe(5)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(60_000)
    vi.advanceTimersByTime(5_000)
    // 若 delta 重置了计时，此处会是 5_000 而非 65_000
    expect(sut.snapshot.value?.turnElapsedMs).toBe(65_000)
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: ' world' } })
    await nextTick()
    expect(sut.snapshot.value?.generatedChars).toBe(11)
    scope.stop()
  })

  it('tool 边界：tool_call_start 出现当前工具与时长，tool_call_end 收口消失', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    expect(sut.snapshot.value?.toolName).toBeNull()
    vi.advanceTimersByTime(10_000)
    toolCallStartEvent(store)
    await nextTick()
    vi.advanceTimersByTime(2_000)
    expect(sut.snapshot.value?.toolName).toBe('write')
    expect(sut.snapshot.value?.toolElapsedMs).toBe(2_000)
    // 工具执行期间的 delta 不重置工具计时基线
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'x' } })
    await nextTick()
    expect(sut.snapshot.value?.toolElapsedMs).toBe(2_000)
    toolCallEndEvent(store)
    await nextTick()
    expect(sut.snapshot.value?.toolName).toBeNull()
    expect(sut.snapshot.value?.toolElapsedMs).toBeNull()
    scope.stop()
  })

  it('turn 结束（occupancy → idle）：展示消失；新 turn 重新计时（记忆复位）', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(30_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(30_000)
    store.setOccupancy(SID, { turn: 'idle', compacting: false, bash: false })
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    // 新 turn：基线重置（若残留旧 turnStartedAt，elapsed 会是 30_000+）
    vi.advanceTimersByTime(10_000)
    startTurnEvents(store, SID, 'a2')
    await nextTick()
    vi.advanceTimersByTime(1_000)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(1_000)
    expect(sut.snapshot.value?.generatedChars).toBe(0)
    scope.stop()
  })

  it('cold-start：挂载时 turn 已活跃（split 双 panel / 切回场景），基线取 assistant timestamp 而非挂载时刻', async () => {
    const scope = effectScope(true)
    const store = scope.run(() => createChatStore())!
    vi.advanceTimersByTime(50_000)
    startTurnEvents(store) // 无观测者在场的 turn
    vi.advanceTimersByTime(8_000)
    const sid = ref<string | null>(SID)
    const sut = scope.run(() => useTurnProgress(sid, store))!
    await nextTick()
    // 挂载即有快照（immediate watch），计时从 message_start 事件点起算（50s），不是挂载点（58s）
    expect(sut.snapshot.value?.active).toBe(true)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(8_000)
    // 正在流式的消息已产出部分计入已生成字符
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'abc' } })
    await nextTick()
    expect(sut.snapshot.value?.generatedChars).toBe(3)
    scope.stop()
  })

  it('切 session：展示随目标切换，切回活跃 session 计时延续（per-session 分区记忆）', async () => {
    const { scope, store, sut, sid } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(20_000)
    // 切到 idle session：展示消失
    sid.value = 's-other'
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    // 切回：turn 仍在跑，计时基线保留（不是从零开始）
    vi.advanceTimersByTime(5_000)
    sid.value = SID
    await nextTick()
    expect(sut.snapshot.value?.active).toBe(true)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(25_000)
    scope.stop()
  })

  it('双活跃切换：目标 turn 已在后台更替（user 开新 turn），切入重落基线不虚高（F-U1①）', async () => {
    const { scope, store, sut, sid } = makeEnv()
    // B（s-other）先有被观测的 turn1（分区留下 b1 记忆）
    sid.value = 's-other'
    startTurnEvents(store, 's-other', 'b1')
    await nextTick()
    // 切入活跃 A：双活跃（B 转后台继续）
    sid.value = SID
    startTurnEvents(store, SID, 'a1')
    await nextTick()
    vi.advanceTimersByTime(30_000)
    // 后台：B turn1 收口 + user 消息开启 turn2（观测者在 A——B 的帧不触发边沿，分区记忆滞留 b1）
    store.setOccupancy('s-other', { turn: 'idle', compacting: false, bash: false })
    store.appendUser('s-other', [{ type: 'text', text: 'q2' }])
    vi.advanceTimersByTime(10_000)
    startTurnEvents(store, 's-other', 'b2') // b2.timestamp = t=40s（turn2 真实起点）
    vi.advanceTimersByTime(2_000) // t=42s，turn2 已跑 2s
    // 切入 B：锚失配（b1 ≠ 当前末组首条 b2）→ 重落基线；elapsed ≈ 2s 而非从 b1 记忆（t=0）虚高
    sid.value = 's-other'
    await nextTick()
    expect(sut.snapshot.value?.active).toBe(true)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(2_000)
    expect(sut.snapshot.value?.generatedChars).toBe(0)
    scope.stop()
  })

  it('turn 内多条 assistant 消息（text→toolCall→text）：切走再切回，字符累计与计时保留（F-U1②）', async () => {
    const { scope, store, sut, sid } = makeEnv()
    startTurnEvents(store, SID, 'a1')
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'hello' } })
    await nextTick()
    expect(sut.snapshot.value?.generatedChars).toBe(5)
    vi.advanceTimersByTime(10_000)
    // 切到 idle session（prev 为非活跃源——锚方案前此路径无条件 startTurn，累计被重置丢失）
    sid.value = 's-other'
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    vi.advanceTimersByTime(5_000)
    // 切回：同 turn（锚未变）→ 前段累计与计时基线保留
    sid.value = SID
    await nextTick()
    expect(sut.snapshot.value?.generatedChars).toBe(5)
    expect(sut.snapshot.value?.turnElapsedMs).toBe(15_000)
    // turn 内第二条 assistant（后续段）整条计入，前段不丢
    store.applyMessageEvent(SID, { type: 'message.message_start', payload: { sessionId: SID, messageId: 'a2' } })
    store.applyMessageEvent(SID, { type: 'message.text_delta', payload: { sessionId: SID, delta: 'world!' } })
    await nextTick()
    expect(sut.snapshot.value?.generatedChars).toBe(11)
    // 计时基线不因 turn 内新 assistant 消息重置（仍从 a1 事件点起算）
    expect(sut.snapshot.value?.turnElapsedMs).toBe(15_000)
    scope.stop()
  })
})

describe('turn-progress 阈值警示与豁免（D6/D7，u4 验收②③）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('阈值 10 分钟（P-3 实测后定值）：仅用于警示色切换，未超不警示', async () => {
    const { scope, store, sut } = makeEnv()
    expect(TURN_PROGRESS_WARN_THRESHOLD_MS).toBe(600_000)
    startTurnEvents(store)
    await nextTick()
    advanceAndTick(TURN_PROGRESS_WARN_THRESHOLD_MS - 1_000)
    expect(sut.snapshot.value?.warn).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    scope.stop()
  })

  it('ask_user pending 豁免：超阈值也不出警示，分型 awaitingUser=true（D6 豁免态）', async () => {
    const { scope, store, sut, awaiting } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 5_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    awaiting.value = true
    vi.advanceTimersByTime(1_000)
    // 等待用户输入期间：警示不参与，事实计时照常（turnElapsedMs 继续走）
    expect(sut.snapshot.value?.awaitingUser).toBe(true)
    expect(sut.snapshot.value?.warn).toBe(false)
    expect(sut.snapshot.value?.turnElapsedMs).toBeGreaterThanOrEqual(TURN_PROGRESS_WARN_THRESHOLD_MS)
    // 豁免解除后警示恢复（豁免是态不是一次性的）
    awaiting.value = false
    vi.advanceTimersByTime(1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    scope.stop()
  })

  it('「继续等待」snooze：本 turn 内抑制警示，turn 结束后新 turn 复位', async () => {
    const { scope, store, sut } = makeEnv()
    startTurnEvents(store)
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    sut.snoozeWarn()
    expect(sut.snapshot.value?.warn).toBe(false)
    expect(sut.snapshot.value?.active).toBe(true)
    // turn 结束 → 新 turn：snooze 不跨 turn
    store.setOccupancy(SID, { turn: 'idle', compacting: false, bash: false })
    await nextTick()
    startTurnEvents(store, SID, 'a3')
    await nextTick()
    vi.advanceTimersByTime(TURN_PROGRESS_WARN_THRESHOLD_MS + 1_000)
    expect(sut.snapshot.value?.warn).toBe(true)
    scope.stop()
  })

  it('无 sid（landing 态）/ 断连收口：无快照不 tick', async () => {
    const { scope, store, sut, sid } = makeEnv(null)
    await nextTick()
    expect(sut.snapshot.value).toBeNull()
    sid.value = SID
    startTurnEvents(store)
    await nextTick()
    expect(sut.snapshot.value?.active).toBe(true)
    scope.stop()
  })
})
