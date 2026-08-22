/**
 * W3 等价锁定：tool-call-index 真实产出（wire 契约 + 提取链路）。
 *
 * 背景（审计 A-01 / docs/architecture/pi-assumption-remediation.md §3.3）：旧实现从
 * `event.message?.content?.[contentIndex]?.id` 提取 toolCallId，但 RPC wire 的 message_update
 * 恒无顶层 message（toJsonEvent 剥离，dist/modes/json-event.js:3-15）——提取恒 undefined，
 * tool-call-index 永不产出。旧单测 mock 自带 message 字段故「测试绿生产死」。
 *
 * 调查结论（W3 探针实测 + dist 源码，2026-08-20，pi 0.84.1）：
 * - wire `message_update` 顶层字段 = {type, assistantMessageEvent, usage?}（26 事件样本）
 * - `toolcall_start` wire = {type, contentIndex}——无 id（partial 被剥离，id 在
 *   partial.content[contentIndex].id 里拿不到；pi-ai types.d.ts:397-400）
 * - `toolcall_end` wire = {type, contentIndex, toolCall:{type:'toolCall',id,name,arguments}}
 *   （pi-ai types.d.ts:405-409 + 244-250；toolCall 非 partial 字段，wire 保留）
 * - 实测配对：toolcall_end.toolCall.id 与后续 tool_execution_start.toolCallId 同值
 *
 * 双轨（TEST-STRATEGY.md §4）：
 * - 凭证无关子集（CI 可跑，无条件执行）：mock 事件**照抄探针抓包样本**（真实 wire 形态，
 *   无顶层 message 字段）喂生产 translate() + EventInterpreter 全链路。
 * - 真实 pi 子集（describe.skipIf(!REAL_PI_READY)）：spawn 真实 pi 跑一轮含工具调用对话，
 *   锁定 wire 契约与 tool-call-index 真实产出。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnPiFixture, REAL_PI_READY, REAL_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'
import { translate } from '../../infra/pi/event-adapter.js'
import type { PiEvent } from '../../infra/pi/pi-protocol.js'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import type { ServerMessage } from '@xyz-agent/shared'

// ── 探针抓包样本（照抄，2026-08-20 /tmp 隔离探针，xiaomi mimo-v2.5-pro）──────────
// 样本即 wire 真契约：message_update 恒无顶层 message；toolcall_start 无 id；
// toolcall_end 携带完整 toolCall；id 与 tool_execution_start 同值。
const WIRE_TOOLCALL_START = {
  type: 'message_update',
  assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1 },
}
const WIRE_TOOLCALL_END = {
  type: 'message_update',
  assistantMessageEvent: {
    type: 'toolcall_end',
    contentIndex: 1,
    toolCall: {
      type: 'toolCall',
      id: 'call_54c7b7e7b4d944c98f05c3db',
      name: 'bash',
      arguments: { command: 'echo PROBE-W3-DONE .' },
    },
  },
}
const WIRE_TOOL_EXECUTION_START = {
  type: 'tool_execution_start',
  toolCallId: 'call_54c7b7e7b4d944c98f05c3db',
  toolName: 'bash',
  args: { command: 'echo PROBE-W3-DONE .' },
}

/** 翻译 + 编排全链路（生产帧链同构 chaos.test.ts：translate → interpreter.interpret） */
async function runThroughInterpreter(events: object[], sid: string): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = []
  const interpreter = new EventInterpreter(sid, { send: (msg) => frames.push(msg) })
  for (const ev of events) {
    interpreter.interpret(translate(ev as unknown as PiEvent, sid))
    // tool-call-start 的 hook 异步路径 flush（chaos.test.ts 同款 macrotask 间隔）
    await new Promise((r) => setTimeout(r, 0))
  }
  return frames
}

describe('W3 tool-call-index: translate 提取（真实 wire 形态 mock，凭证无关）', () => {
  it('toolcall_end（wire 形态）产出 tool-call-index（toolCallId + contentIndex）', () => {
    const events = translate(WIRE_TOOLCALL_END as unknown as PiEvent, 's')
    expect(events).toEqual([
      { kind: 'tool-call-index', toolCallId: 'call_54c7b7e7b4d944c98f05c3db', contentIndex: 1 },
    ])
  })

  it('toolcall_start（wire 形态：无 id、无顶层 message）不产出——noop', () => {
    // 旧 bug 回归锚：wire 上此事件拿不到 id（partial 被剥离）；若实现退回从
    // event.message 提取，本用例与上一用例的组合即复现「恒 undefined 生产死」。
    const events = translate(WIRE_TOOLCALL_START as unknown as PiEvent, 's')
    expect(events).toEqual([{ kind: 'noop' }])
  })

  it('全链路：tool-call-index 锚点附到 tool_call_start WS 帧 entry.contentIndex', async () => {
    const frames = await runThroughInterpreter(
      [WIRE_TOOLCALL_START, WIRE_TOOLCALL_END, WIRE_TOOL_EXECUTION_START],
      'w3-mock',
    )
    const startFrame = frames.find((f) => f.type === 'message.tool_call_start')
    expect(startFrame).toBeDefined()
    const entry = (startFrame as unknown as { payload: { entry?: { contentIndex?: number; toolCallId?: string } } }).payload.entry
    // 锚点语义：contentIndex 来自 toolcall_end（顺序锚点），toolCallId 与 tool_execution_start 配对
    expect(entry?.contentIndex).toBe(1)
    expect(entry?.toolCallId).toBe('call_54c7b7e7b4d944c98f05c3db')
  })
})

describe.skipIf(!REAL_PI_READY)(
  `W3 tool-call-index: 真实 pi wire 契约锁定（真实 pi 子进程${REAL_PI_SKIP_REASON ? `｜skip：${REAL_PI_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null
  const sid = 'w3-toolcall'

  // [HISTORICAL] 2026-08-20 PR #185：hook 显式超时——beforeAll 内跑真实 LLM 轮次（内部
  // waitForEvent 预算 120s），vitest 默认 hookTimeout 10s 在全量并发负载下先杀 hook
  // （隔离跑通过，纯环境饿死）。预算 = 冷启动 + 轮次等待 + 余量，对齐 attach-lifecycle 口径。
  // [HISTORICAL] 2026-08-22 sm-e2e cw verify 连续红：真实 LLM 偶尔纯文本回复不调工具
  //（toolcall_end 数为 0，下游 3 用例连锁假失败）——轮次间检测，无 toolcall 再推一轮，
  // 3 轮全无才交由用例断言失败（不弱化断言；语料守卫仍要求 toolcall 事件存在）。
  beforeAll(async () => {
    fixture = await spawnPiFixture()
    for (let attempt = 0; attempt < 3; attempt++) {
      await fixture.sendCommand('prompt', {
        message: 'Use the bash tool to run exactly: echo W3-TOOLCALL-ANCHOR . You must call the bash tool before replying; after the tool finishes, reply with the tool output text.',
      })
      await fixture.waitForEvent((e) => e.type === 'agent_end', 120_000)
      const hasToolcallEnd = fixture
        .collectEvents((e) => e.type === 'message_update')
        .some((e) => (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type === 'toolcall_end')
      if (hasToolcallEnd) break
    }
  }, 420_000)

  afterAll(async () => {
    await fixture?.dispose()
  })

  it('wire 契约：全部 message_update 事件无顶层 message 字段', () => {
    const fx = fixture!
    const updates = fx.collectEvents((e) => e.type === 'message_update')
    // 语料守卫：含工具调用的对话必有 message_update 流
    expect(updates.length).toBeGreaterThan(0)
    for (const u of updates) {
      expect('message' in u && u.message !== undefined).toBe(false)
    }
  })

  it('wire 契约：toolcall_end 携带 toolCall.id + contentIndex；toolcall_start 无 id 字段', () => {
    const fx = fixture!
    const subEvents = fx
      .collectEvents((e) => e.type === 'message_update')
      .map((e) => e.assistantMessageEvent as Record<string, unknown>)
    const ends = subEvents.filter((s) => s?.type === 'toolcall_end')
    const starts = subEvents.filter((s) => s?.type === 'toolcall_start')
    expect(ends.length).toBeGreaterThan(0)
    expect(starts.length).toBeGreaterThan(0)
    for (const s of ends) {
      expect(typeof (s.toolCall as { id?: unknown } | undefined)?.id).toBe('string')
      expect(typeof s.contentIndex).toBe('number')
    }
    for (const s of starts) {
      // id 只在 partial 里（wire 剥离）——若 pi 未来形态变化（start 携带 id），
      // 本断言失败即提醒重新评估提取点（可前移回 toolcall_start）。
      expect(s.toolCall).toBeUndefined()
      expect('id' in s).toBe(false)
    }
  })

  it('tool-call-index 真实产出：translate(真实 toolcall_end) 产出锚点事件，id 与 tool_execution_start 配对', () => {
    const fx = fixture!
    const events = fx.collectEvents()
    // translate 整流：所有 toolcall_end 事件都应产出 tool-call-index
    const toolcallEnds = events.filter(
      (e) => (e.assistantMessageEvent as { type?: string } | undefined)?.type === 'toolcall_end',
    )
    const anchorEvents = toolcallEnds.flatMap((e) => translate(e as unknown as PiEvent, sid))
    expect(anchorEvents.length).toBe(toolcallEnds.length)
    for (const a of anchorEvents) {
      expect(a.kind).toBe('tool-call-index')
    }
    // 配对语义：锚点 toolCallId ⊆ tool_execution_start 的 toolCallId 全集（顺序锚点可被
    // interpreter 缓存消费，前端按 contentIndex 有序插入）。
    const execIds = new Set(
      fx
        .collectEvents((e) => e.type === 'tool_execution_start')
        .map((e) => e.toolCallId as string),
    )
    expect(execIds.size).toBeGreaterThan(0)
    for (const a of anchorEvents) {
      if (a.kind === 'tool-call-index') {
        expect(execIds.has(a.toolCallId)).toBe(true)
      }
    }
  })

  it('时序锚点：首个 toolcall_end 事件到达于首个 tool_execution_start 之前', () => {
    const fx = fixture!
    const events = fx.collectEvents()
    const firstEndIdx = events.findIndex(
      (e) => (e.assistantMessageEvent as { type?: string } | undefined)?.type === 'toolcall_end',
    )
    const firstExecIdx = events.findIndex((e) => e.type === 'tool_execution_start')
    expect(firstEndIdx).toBeGreaterThanOrEqual(0)
    expect(firstExecIdx).toBeGreaterThanOrEqual(0)
    // toolcall_end（LLM 流中工具参数输出完成）恒早于 tool_execution_start（assistant
    // message 完成后执行工具）——顺序锚点语义的前提（§11 检查点 3）。
    expect(firstEndIdx).toBeLessThan(firstExecIdx)
  })
})
