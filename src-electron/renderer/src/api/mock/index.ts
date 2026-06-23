/**
 * Mock 门面 —— 与 @/api 同接口签名，VITE_MOCK=true 时由 api/index 注入。
 *
 * 行为（D7 工程默认）：
 * - 不走 transport/ws-client，直接返回内存 fixture + setTimeout 模拟流式
 * - 不模拟失败（v1 永远成功），除 switchSession 的 id 不存在（契约要求抛）
 * - 全内存（reload 重置）
 * - 流式事件名严格按 protocol.ts ServerMessageType（message_start/text_delta/complete）
 *
 * 依赖方向：无（不 import transport/events/pending，独立内存实现）。
 */
import type { Message, ServerMessage, SessionSummary, ProviderInfo, SkillInfo, AgentInfo } from '@xyz-agent/shared'
import { createSession, fixtureMessages, fixtureSessions } from './data'
import {
  fixtureProviders,
  fixtureSkills,
  fixtureAgents,
  fixtureExtensions,
  fixtureSystem,
  type FixtureExtension,
  type FixtureSystemSettings,
} from './settings-data'

/** 流式时序（ms）—— 仅用于视觉演示节奏，不影响契约 */
const TIMING = {
  ack: 40, // 命令 ack
  startGap: 60, // message_start 前
  chunk: 70, // 每个 text_delta 间隔
  done: 40, // complete 前
  switchCmd: 30,
}

/** mock 固定回复前缀（不模拟失败，D7） */
const CANNED_REPLY = '好的，我来处理这个请求。（mock 模拟回复）'

const streamHandlers = new Map<string, Set<(msg: ServerMessage) => void>>()
/** 已 abort 的 session：send 循环检查后提前返回 */
/** 已 abort 的 session：send 循环检查后提前返回 */
const cancelled = new Set<string>()
/** 运行中的 setTimeout 句柄，resolve 后自动移除，避免 Set 无限增长 */
const timers = new Set<ReturnType<typeof setTimeout>>()

/** 清理所有未触发的 timer（测试 teardown / 模块卸载时调用） */
export function __clearTimers(): void {
  for (const t of timers) clearTimeout(t)
  timers.clear()
}

let idSeq = 0

function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

function emit(sessionId: string, msg: ServerMessage): void {
  streamHandlers.get(sessionId)?.forEach((h) => h(msg))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      timers.delete(t)
      resolve()
    }, ms)
    timers.add(t)
  })
}

/** 按字符/词切分，证明逐块推送 */
function splitChunks(text: string): string[] {
  return text.match(/[\u4e00-\u9fa5]|[A-Za-z]+|\s+|[^\sA-Za-z\u4e00-\u9fa5]/g) ?? [text]
}

export const session = {
  async list(): Promise<SessionSummary[]> {
    await sleep(TIMING.ack)
    // 深拷贝：调用方突变不影响 fixture
    return fixtureSessions.map((s) => ({ ...s }))
  },

  async create(title?: string): Promise<SessionSummary> {
    await sleep(TIMING.ack)
    const s = createSession(title)
    fixtureSessions.push(s)
    return { ...s }
  },

  async switchSession(id: string): Promise<void> {
    await sleep(TIMING.switchCmd)
    if (!fixtureSessions.some((s) => s.id === id)) {
      throw new Error(`mock: session ${id} 不存在`)
    }
  },

  async rename(sessionId: string, label: string): Promise<void> {
    await sleep(TIMING.ack)
    const target = fixtureSessions.find((s) => s.id === sessionId)
    if (!target) throw new Error(`mock: session ${sessionId} 不存在`)
    target.label = label
  },

  async remove(sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
    const idx = fixtureSessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) throw new Error(`mock: session ${sessionId} 不存在`)
    fixtureSessions.splice(idx, 1)
    delete fixtureMessages[sessionId]
  },
}

export const chat = {
  /** 拉 session 历史（深拷贝 fixture，避免外部突变污染） */
  async getHistory(sessionId: string): Promise<Message[]> {
    await sleep(TIMING.ack)
    return (fixtureMessages[sessionId] ?? []).map((m) => ({ ...m }))
  },

  async send(sessionId: string, text: string): Promise<void> {
    cancelled.delete(sessionId)
    const messageId = nextId('m')
    const reply = `已处理："${text}"。\n${CANNED_REPLY}`

    await sleep(TIMING.ack)
    emit(sessionId, {
      type: 'message.message_start',
      id: messageId,
      payload: { sessionId, messageId },
    })

    for (const chunk of splitChunks(reply)) {
      if (cancelled.has(sessionId)) return
      await sleep(TIMING.chunk)
      emit(sessionId, {
        type: 'message.text_delta',
        id: messageId,
        payload: { sessionId, messageId, delta: chunk },
      })
    }

    if (cancelled.has(sessionId)) return
    await sleep(TIMING.done)
    emit(sessionId, {
      type: 'message.complete',
      id: messageId,
      payload: { sessionId, messageId, stopReason: 'complete' },
    })
  },

  async abort(sessionId: string): Promise<void> {
    // 标记取消，send 循环下一轮检测后退出
    cancelled.add(sessionId)
    emit(sessionId, {
      type: 'message.complete',
      payload: { sessionId, stopReason: 'aborted' },
    })
    await sleep(TIMING.ack)
  },

  /** steer：mock 下仅 ack，不模拟队列（pending 气泡渲染 DEFERRED） */
  async steer(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    void sessionId
    void text
  },

  /** followUp：mock 下仅 ack */
  async followUp(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    void sessionId
    void text
  },

  streamSubscribe(
    sessionId: string,
    handler: (msg: ServerMessage) => void,
  ): () => void {
    let set = streamHandlers.get(sessionId)
    if (!set) {
      set = new Set()
      streamHandlers.set(sessionId, set)
    }
    set.add(handler)
    return () => {
      streamHandlers.get(sessionId)?.delete(handler)
    }
  },
}

/* ── Settings mock ── */

export const settings = {
  async getProviders(): Promise<ProviderInfo[]> {
    await sleep(TIMING.ack)
    return fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }))
  },

  async getSkills(): Promise<SkillInfo[]> {
    await sleep(TIMING.ack)
    return fixtureSkills.map((s) => ({ ...s }))
  },

  async getAgents(): Promise<AgentInfo[]> {
    await sleep(TIMING.ack)
    return fixtureAgents.map((a) => ({ ...a }))
  },

  async getExtensions(): Promise<FixtureExtension[]> {
    await sleep(TIMING.ack)
    return fixtureExtensions.map((e) => ({ ...e }))
  },

  async getSystem(): Promise<FixtureSystemSettings> {
    await sleep(TIMING.ack)
    return { ...fixtureSystem }
  },

  async updateSystem(patch: Partial<FixtureSystemSettings>): Promise<void> {
    await sleep(TIMING.ack)
    Object.assign(fixtureSystem, patch)
  },
}
