/**
 * useCompactQueue 单测（compact-queued-messages W1，TC1-TC8 + S1/S2 加固 TC9-TC11
 * + u4a 确认机制 CD1-CD3 + u4b flush 投递确认驱动 F1-F5）。
 *
 * 覆盖契约（/tmp/cw-plan-w1.json contracts C1 + session-occupancy-send-closure u4b / D5）：
 * - enqueue 追加并返回含 id 条目（TC1）
 * - remove 按 id 精确取消，未知 id no-op（TC2）；已提交条目（mode 已写）no-op——记账
 *   不变量下沉（R3-U2，TC2b），未提交条目正常移除
 * - flush 空队列 no-op 返回 true（TC3）
 * - flush 调度：首个未提交条目 send（带 clientUuid=条目 id）+ 其余 steer，send 先于 steer（TC4）
 * - flush 提交成功 → **不出队**（E2「成功即清队」语义已退役）条目保持 mode 已写，
 *   确认帧（confirmDelivery）驱动出队；全确认后再次 flush 不再调 chatApi（TC5）
 * - flush 任一 RPC 失败 → 未投递条目留队 + 原始错误上抛（A1：调用方 toast「发送失败: {原因}」，
 *   ≠ S1 busy 拒绝的 resolve false 静默自愈）；已提交在途条目不重发（TC6/F1）
 * - per-session 隔离（TC7）/ session 销毁 cleanup 移除分区（TC8）
 * - flush 期间 send.rejected 广播 → 未投递：留队 + 清提交标记 + 占位回滚（TC9 无 uuid 归属 /
 *   F2 带 clientUuid 精确归属），返回 false；steer 未被调（停止后续提交）（F2）
 * - flush await 窗口内新入队消息不被误删（TC10，S2 精确记账）
 * - flush 进行中重复触发复用同一 in-flight promise（TC11，S2）
 * - confirmDelivery 按 id 出队 + 转态副作用（CD1/CD3，appendUser 正常气泡）
 * - flush 提交时写提交通道标记（CD2，core ① 匹配资格判据）
 * - flush 重入：已提交在途条目跳过，新条目并入 steer 通道（F3/F4，防双 run 双投递）
 * - 滞留场景：提交后无确认帧 → 条目保持 mode 已写不重发（F5，占位挂着等确认回收）
 *
 * [u4b 测试基建变化] flush 经 core submitQueuedEntry 编排（挂 inflight 占位 +
 * ensureStreamSubscription），故 beforeEach 补 setActivePinia（chat store 计数断言 +
 * appendUser 转态）+ resetChatModuleStateForTest（清理 flush 建立的会话级流订阅，防跨用例
 * 泄漏 handler）；'@/api' mock 补 streamSubscribe。
 *
 * send.rejected 注入：useCompactQueue 从 @/api/events 导入真实 events 模块（vi.mock('@/api')
 * 只替换 index，不波及子模块），测试用 dispatchSession 直接投递事件，模拟 runtime 广播。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/use-compact-queue.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'
import { dispatchSession } from '@/api/events'
import { useChatStore } from '@/stores/chat'
import { resetChatModuleStateForTest } from '@xyz-agent/core'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；chatApi.send/steer/streamSubscribe 是
// flush 编排（submitQueuedEntry）依赖的 RPC/订阅面
const apiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn(() => () => {}),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    send: apiMock.send,
    steer: apiMock.steer,
    streamSubscribe: apiMock.streamSubscribe,
  },
  session: {},
}))

let scope: EffectScope

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // flush 建立会话级流订阅（ensureStreamSubscription，core 模块级 Map）——逐用例清理防
  // rejected handler 跨用例泄漏（同 sid 's1' 下残留 handler 会消费后续用例的广播）
  resetChatModuleStateForTest()
  // 首次调用创建单例（active effect scope 内：onScopeDispose 注册实例 cleanup 到模块级
  // 注册表，TC8 的 triggerSessionCleanups 依赖它）。单例跨用例共享，scope 不 stop
  //（stop 会反注册 cleanup，TC8 的 trigger 将无 fn 可调）。
  scope = effectScope()
  scope.run(() => {
    useCompactQueue()
  })
  // 清空所有分区（单例跨用例共享，不 reset 会泄漏到下一用例）
  useCompactQueue()._clearAllForTest()
})

/** 构造 message_end(user) 帧的 PiMessageEntry（content parts 数组形态，pi 不 trim——
 *  与 extractUserContentText 的比对源同构）。 */
function makeUserEntry(text: string): Record<string, unknown> {
  return {
    type: 'message',
    id: `e-${crypto.randomUUID()}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
  }
}

describe('useCompactQueue 队列基础（TC1-TC2）', () => {
  it('TC1: enqueue 追加并返回含 id 条目', () => {
    const queue = useCompactQueue()
    const entry = queue.enqueue('s1', 'hello')

    expect(typeof entry.id).toBe('string')
    expect(entry.id.length).toBeGreaterThan(0)
    expect(entry.text).toBe('hello')
    expect(queue.count('s1')).toBe(1)
  })

  it('TC2: remove 按 id 精确取消，未知 id no-op', () => {
    const queue = useCompactQueue()
    const e1 = queue.enqueue('s1', 'a')
    queue.enqueue('s1', 'b')

    queue.remove('s1', e1.id)
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['b'])

    // 未知 id 不抛错，队列不变
    expect(() => queue.remove('s1', 'unknown-id')).not.toThrow()
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['b'])
  })

  it('TC2b: remove 对已提交条目（mode 已写）no-op，未提交条目正常移除（R3-U2 记账不变量下沉）', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const m1 = queue.enqueue('s1', 'm1')
    // flush 提交 → m1 mode='send'（已提交在途，send 占位挂着等确认帧）
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(queue.peek('s1')[0]!.mode).toBe('send')
    expect(chat.getInflight('s1')).toBe(1)

    // 在途窗口新入队未提交条目（F3 同款构造）
    const m2 = queue.enqueue('s1', 'm2')

    // 已提交条目 remove 无效果：留队、mode 不变——inflight 占位与 confirmDelivery
    // 确认通路不被破坏（否则占位悬空、确认帧变未知 id）
    queue.remove('s1', m1.id)
    expect(queue.peek('s1').map((m) => m.id)).toEqual([m1.id, m2.id])
    expect(queue.peek('s1')[0]!.mode).toBe('send')
    expect(chat.getInflight('s1')).toBe(1)

    // 未提交条目正常移除（撤销边界 D4）
    queue.remove('s1', m2.id)
    expect(queue.peek('s1').map((m) => m.id)).toEqual([m1.id])
  })
})

describe('useCompactQueue flush（TC3-TC6，u4b 投递确认驱动语义）', () => {
  it('TC3: flush 空队列 no-op 返回 true', async () => {
    const queue = useCompactQueue()

    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(apiMock.send).not.toHaveBeenCalled()
    expect(apiMock.steer).not.toHaveBeenCalled()
  })

  it('TC4: flush 调度——首个未提交条目 send（带 clientUuid=条目 id）+ 其余 steer，顺序正确', async () => {
    const queue = useCompactQueue()
    const m1 = queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    queue.enqueue('s1', 'm3')

    await expect(queue.flush('s1')).resolves.toBe(true)

    expect(apiMock.send).toHaveBeenCalledTimes(1)
    // [u4b / D5.1] clientUuid = 条目 id：runtime 拒绝广播原样回带，S1 per-entry 归属判据。
    // renderer send 适配层第三参 images（undefined 占位）+ 第四参 options
    expect(apiMock.send).toHaveBeenCalledWith('s1', 'm1', undefined, { clientUuid: m1.id })
    expect(apiMock.steer).toHaveBeenCalledTimes(2)
    expect(apiMock.steer).toHaveBeenCalledWith('s1', 'm2')
    expect(apiMock.steer).toHaveBeenCalledWith('s1', 'm3')
    // 调用顺序：send 先于所有 steer
    expect(apiMock.send.mock.invocationCallOrder[0]).toBeLessThan(apiMock.steer.mock.invocationCallOrder[0])
    expect(apiMock.steer.mock.invocationCallOrder[0]).toBeLessThan(apiMock.steer.mock.invocationCallOrder[1])
  })

  it('TC5: flush 提交成功 → 不出队（E2 退役），确认帧驱动出队 + 占位回收 + 转态；全确认后 flush 不再调 chatApi', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')

    await expect(queue.flush('s1')).resolves.toBe(true)
    // [u4b / D5.3] 提交 ≠ 投递：条目保持（mode 已写）等 message_end(user) 确认；
    // send 通道占位挂着（inflight=1），确认时经 core ① 回收
    expect(queue.count('s1')).toBe(1)
    expect(queue.peek('s1')[0]!.mode).toBe('send')
    expect(chat.getInflight('s1')).toBe(1)

    // 确认帧到达（端到端：message_end(user) → core ① 命中 → confirmDelivery 出队 +
    // 转态 + 仅 send 条目 decrementInflight 回收占位）
    chat.applyMessageEvent('s1', { type: 'message.message_end', payload: { sessionId: 's1', entry: makeUserEntry('m1') } })
    expect(queue.count('s1')).toBe(0)
    expect(chat.getInflight('s1')).toBe(0)
    // 转态：正常气泡入流（confirmDelivery 的 appendUser 副作用）
    expect(chat.getMessages('s1').map((m) => m.role)).toContain('user')

    // 空队列 flush：仍返回 true 且不再调 chatApi
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.steer).not.toHaveBeenCalled()
  })

  it('TC6: 第 2 条 steer RPC 失败 → 未投递条目留队 + 原始错误上抛（A1）；第 1 条已提交在途不重发', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    apiMock.steer.mockRejectedValueOnce(new Error('rpc fail'))

    // [A1] RPC reject 上抛（传输级真错误，调用方 toast「发送失败: {原因}」）≠ S1 busy 拒绝
    // （resolve false 静默自愈，TC9/F2）
    await expect(queue.flush('s1')).rejects.toThrow('rpc fail')
    // [u4b per-entry 记账] m1 已提交（mode 'send'，等确认帧，不重发）；m2 未投递回滚
    // （mode 清除 + 占位不挂——steer 通道本就不挂）；队列两条都保留（E2 整队清除已退役）
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['m1', 'm2'])
    expect(queue.peek('s1').map((m) => m.mode)).toEqual(['send', undefined])
    // m1 的 send 占位仍在（等确认回收）
    expect(chat.getInflight('s1')).toBe(1)
  })

  it('TC9: flush 期间收到 send.rejected（无 clientUuid，按 FIFO 归属当前条）→ 留队 + 清标记 + 占位回滚返回 false（S1）', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    // 模拟 runtime busy 预检：广播 send.rejected 后 reply resolve（不抛错，ack 型 void）
    apiMock.send.mockImplementationOnce(async () => {
      dispatchSession('s1', {
        type: 'send.rejected',
        payload: { sessionId: 's1', reason: 'busy', message: 'Agent 正在处理' },
      })
    })

    await expect(queue.flush('s1')).resolves.toBe(false)
    // 消息未实际投递：条目留队（mode 清除——重试重标重提交）+ send 占位回滚（重试重挂）
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['m1', 'm2'])
    expect(queue.peek('s1').map((m) => m.mode)).toEqual([undefined, undefined])
    expect(chat.getInflight('s1')).toBe(0)
    // 停止提交后续：steer 未被调
    expect(apiMock.steer).not.toHaveBeenCalled()
  })

  it('TC10: flush await 窗口内新入队消息不被误删（S2 per-entry 记账）', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    let resolveSend!: () => void
    apiMock.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve }),
    )

    const flushPromise = queue.flush('s1')
    // await 窗口内（send 未 resolve）新入队——per-entry 记账只动 snapshot 已有条目
    queue.enqueue('s1', 'late')
    resolveSend()
    await expect(flushPromise).resolves.toBe(true)

    // [u4b] 提交成功不再出队：m1 保持（mode send 在途）+ late 保留（未提交）
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['m1', 'late'])
    expect(queue.peek('s1').map((m) => m.mode)).toEqual(['send', undefined])
    expect(apiMock.send).toHaveBeenCalledTimes(1)
  })

  it('TC11: flush 进行中重复触发 → 复用同一 in-flight promise，不重复发送（S2）', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    let resolveSend!: () => void
    apiMock.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve }),
    )

    const p1 = queue.flush('s1')
    const p2 = queue.flush('s1')
    // 第二次 flush 复用 in-flight：send 只被调一次
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.steer).not.toHaveBeenCalled()

    resolveSend()
    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)
    // [u4b] 提交完成不出队（等确认帧）+ 无重复发送
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(queue.count('s1')).toBe(1)
  })
})

describe('useCompactQueue 隔离与生命周期（TC7-TC8）', () => {
  it('TC7: per-session 隔离——sid A 不影响 sid B', () => {
    const queue = useCompactQueue()
    queue.enqueue('sA', 'x')

    expect(queue.count('sB')).toBe(0)

    queue.enqueue('sB', 'y')
    expect(queue.count('sA')).toBe(1)
    expect(queue.count('sB')).toBe(1)
    expect(queue.hasPending('sB')).toBe(true)
    expect(queue.hasPending('sB-x')).toBe(false)
  })

  it('TC8: session 销毁 cleanup 移除队列分区（deleteSession → triggerSessionCleanups）', () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'x')
    expect(queue.count('s1')).toBe(1)

    // 模拟 useSidebar.deleteSession 编排：triggerSessionCleanups 遍历注册表调实例 cleanup
    triggerSessionCleanups('s1')

    // 分区被移除，下次访问重新 init（空队列）
    expect(queue.count('s1')).toBe(0)
  })
})

// ── [session-occupancy u4a / D5.3 ①] 投递确认出队（confirmDelivery）+ 提交通道标记
//    （mode）——core CompactQueueLike 接口扩展的 renderer 实现侧锁定。core 侧机制
//    （message_end(user) 三分支 ①）的行为测试在 packages/core effects-defer-confirmation.test.ts。──
describe('useCompactQueue 投递确认与提交通道标记（u4a / D5.3）', () => {
  it('CD1: confirmDelivery 按 id 精确出队 + 转态副作用（appendUser 正常气泡）；未知 id 返回 false 且队列不变', () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const e1 = queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')

    expect(queue.confirmDelivery('s1', e1.id)).toBe(true)
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['m2'])
    // [u4b 转态] core ① 命中后帧消费终止（不 appendUser），正常气泡唯一插入点在
    // confirmDelivery——appendUser 尾插与 pi 落盘 entry 同文本的用户消息（live ≡ reload）
    const messages = chat.getMessages('s1')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'm1' }])

    // 未知 id：no-op 不抛错，返回 false（core 据此判匹配作废落回现有处理链），无转态副作用
    expect(queue.confirmDelivery('s1', 'unknown-id')).toBe(false)
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['m2'])
    expect(chat.getMessages('s1')).toHaveLength(1)
  })

  it('CD2: flush 逐条提交写提交通道标记——队首 send 先写，steer 随逐条提交跟进（core ① 匹配资格判据）', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    // 入队未提交：mode undefined（不参与 core ① 的确认匹配，撤销入口开放）
    expect(queue.peek('s1').map((m) => m.mode)).toEqual([undefined, undefined])

    let resolveSend!: () => void
    apiMock.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve }),
    )
    const flushPromise = queue.flush('s1')
    // send 在途窗口：首条已标 'send'；逐条提交下第二条尚未轮到（mode 仍 undefined）
    expect(queue.peek('s1').map((m) => m.mode)).toEqual(['send', undefined])
    resolveSend()
    await expect(flushPromise).resolves.toBe(true)
    // 整队提交完成：'send' / 'steer' 与提交顺序一致
    expect(queue.peek('s1').map((m) => m.mode)).toEqual(['send', 'steer'])
  })

  it('CD3: flush 提交窗口内 confirmDelivery 出队成功（core message_end 确认帧驱动路径）', async () => {
    const queue = useCompactQueue()
    const e1 = queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')
    let resolveSend!: () => void
    apiMock.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve }),
    )
    const flushPromise = queue.flush('s1')
    // 投递确认帧先于 flush 完成到达（pi ack 后 message_end 即落盘）：条目按 id 出队 +
    // 转态（appendUser 副作用见 CD1）；flush 循环实时查 live，已出队条目不重复提交
    expect(queue.confirmDelivery('s1', e1.id)).toBe(true)
    resolveSend()
    await expect(flushPromise).resolves.toBe(true)
    // [u4b] 出队记账与 flush 记账互不双删：已确认的 m1 出队，m2 保持（mode steer 在途等确认）
    expect(queue.count('s1')).toBe(1)
    expect(queue.peek('s1')[0]!.text).toBe('m2')
  })
})

// ── [session-occupancy u4b / D5] flush 投递确认驱动 + per-entry 记账——E2 整队保留重发
//    语义退役的正面锁定（部分失败只重发未投递条目、确认驱动出队、占位三态闭环）。──
describe('useCompactQueue flush 逐条提交与确认驱动（u4b / D5）', () => {
  it('F1: 第 2 条 steer RPC 失败 → 第 1 条已提交不重发、第 2/3 保留；确认后重试只重发未投递条目', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const m1 = queue.enqueue('s1', 'm1')
    const m2 = queue.enqueue('s1', 'm2')
    const m3 = queue.enqueue('s1', 'm3')
    // 第 2 条（首个 steer）RPC 失败
    apiMock.steer.mockRejectedValueOnce(new Error('rpc fail'))

    // [A1] RPC reject 上抛（≠ S1 busy 拒绝的 resolve false）
    await expect(queue.flush('s1')).rejects.toThrow('rpc fail')
    // m1 已提交在途（mode send + 占位挂着）、m2 未投递回滚（mode 清除）、m3 未提交
    expect(queue.peek('s1').map((m) => m.mode)).toEqual(['send', undefined, undefined])
    expect(chat.getInflight('s1')).toBe(1)

    // m1 确认帧到达（端到端：core ① 命中 → confirmDelivery 出队 + 占位回收）
    chat.applyMessageEvent('s1', { type: 'message.message_end', payload: { sessionId: 's1', entry: makeUserEntry('m1') } })
    expect(queue.peek('s1').map((m) => m.text)).toEqual(['m2', 'm3'])
    expect(chat.getInflight('s1')).toBe(0)

    // 重试 flush：m1 已出队跳过（已投递不重发）；m2 成为队首——测试环境无 assistant
    // 回复流（isActive=false）→ 走 send 启动新 run（turn 活跃时由 isActive 判据并入
    // steer，见 doFlush 通道路由注释），m3 并入 steer
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(apiMock.send.mock.calls.map((c) => c[1])).toEqual(['m1', 'm2']) // m1 未重发
    expect(apiMock.steer.mock.calls.map((c) => c[1])).toEqual(['m2', 'm3']) // 首轮失败 m2 + 重试 m3
    // m2 已提交（mode send，占位在途）、m3 steer
    expect(queue.peek('s1').map((m) => [m.text, m.mode])).toEqual([['m2', 'send'], ['m3', 'steer']])
    expect(chat.getInflight('s1')).toBe(1)
    void m2
    void m3
  })

  it('F2: send.rejected 带 clientUuid 精确归属该条 → 未投递回滚占位 + 停止后续 + 重试重挂占位', async () => {
    const chat = useChatStore()
    const queue = useCompactQueue()
    const m1 = queue.enqueue('s1', 'm1')
    const m2 = queue.enqueue('s1', 'm2')
    // runtime 预检拒绝：广播带 clientUuid（u2 落地回带）后 reply resolve
    apiMock.send.mockImplementationOnce(async () => {
      dispatchSession('s1', {
        type: 'send.rejected',
        payload: { sessionId: 's1', reason: 'compacting', clientUuid: m1.id, message: '压缩中' },
      })
    })

    await expect(queue.flush('s1')).resolves.toBe(false)
    // 未投递：m1 留队首（mode 清除）+ 占位回滚；m2 未提交
    expect(queue.peek('s1').map((m) => [m.text, m.mode])).toEqual([['m1', undefined], ['m2', undefined]])
    expect(chat.getInflight('s1')).toBe(0)
    expect(apiMock.steer).not.toHaveBeenCalled()

    // 重试 flush：m1 重挂占位重新提交（占位三态闭环：挂→回滚→重挂），成功后占位在途
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(apiMock.send).toHaveBeenCalledTimes(2)
    expect(apiMock.send).toHaveBeenLastCalledWith('s1', 'm1', undefined, { clientUuid: m1.id })
    expect(chat.getInflight('s1')).toBe(1)
    expect(queue.peek('s1').map((m) => m.mode)).toEqual(['send', 'steer'])
    void m2
  })

  it('F3: flush 重入——已提交在途条目跳过不重发，新入队条目并入 steer 通道', async () => {
    const queue = useCompactQueue()
    const m1 = queue.enqueue('s1', 'm1')
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(queue.peek('s1')[0]!.mode).toBe('send')

    // 确认帧未到（在途）期间新条目入队 + flush 再次触发（第二次压缩结束）
    const m2 = queue.enqueue('s1', 'm2')
    await expect(queue.flush('s1')).resolves.toBe(true)
    // m1 已提交跳过（不重发）；m2 走 steer（turn 已被 m1 的 send 启动，防双 run 双投递）
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.steer).toHaveBeenCalledTimes(1)
    expect(apiMock.steer).toHaveBeenCalledWith('s1', 'm2')
    expect(queue.peek('s1').map((m) => [m.text, m.mode])).toEqual([['m1', 'send'], ['m2', 'steer']])
    void m1
    void m2
  })

  it('F4: 滞留场景——提交成功后无确认帧，条目保持 mode 已写不误清（气泡保持 pending 语义的数据面）', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    queue.enqueue('s1', 'm2')

    // 全部提交成功（pi steer 入内存队列，落盘在迭代边界 drain——可能因 abort/error 滞留）
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(queue.peek('s1').map((m) => [m.text, m.mode])).toEqual([['m1', 'send'], ['m2', 'steer']])

    // 滞留（无确认帧到达）期间多次空转 flush：条目保留、mode 不变、不重发
    await expect(queue.flush('s1')).resolves.toBe(true)
    await expect(queue.flush('s1')).resolves.toBe(true)
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.steer).toHaveBeenCalledTimes(1)
    expect(queue.peek('s1').map((m) => [m.text, m.mode])).toEqual([['m1', 'send'], ['m2', 'steer']])
  })
})
