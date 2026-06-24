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
import type {
  Message, ModelInfo, ServerMessage, SessionSummary, SessionGroup,
  ProviderInfo, SkillInfo, AgentInfo, PluginInfo, SetProviderData,
} from '@xyz-agent/shared'
import { createSession, fixtureMessages, fixtureSessions } from './data'
import {
  fixtureProviders,
  fixtureSkills,
  fixtureAgents,
  fixtureExtensions,
} from './settings-data'
import { MOCK_MODELS, type MockModel } from './composer-data'
import * as events from '../events'

// mock/git.ts 的 git domain + fixtureGitStatus 透出（Wave 1a real git domain 落地后由 api/index 接线）
export { git, fixtureGitStatus } from './git'

/**
 * Mock 模拟 runtime session 通道推送（dispatchSession）。
 * 组件用 events.on(sessionId) 订阅 session.commands / context.update；
 * mock 不走 transport，故在此桥接——直接 dispatchSession 模拟 server-push，
 * 让组件订阅在 mock 模式下也能触发（mock/real 同构）。
 */
function pushSession(sessionId: string, msg: ServerMessage): void {
  events.dispatchSession(sessionId, msg)
}

/** Mock 静态 slash 命令（模拟 pi getCommands 返回的扩展命令） */
const MOCK_COMMANDS = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', description: '代码审查', source: 'extension' },
  { name: '/fix', description: '修复问题', source: 'skill' },
]

/**
 * 模拟 runtime 的 session 级 server-push（session.commands + context.update）。
 * 在 switchSession（等价 runtime session 激活）后推，模拟 runtime fetchAndBroadcastCommands +
 * onContextUpdate。延迟模拟异步推送节奏。
 */
function pushSessionState(sessionId: string): void {
  const cmdTimer = setTimeout(() => {
    pushSession(sessionId, {
      type: 'session.commands',
      id: `mock_cmd_${sessionId}`,
      payload: { sessionId, commands: MOCK_COMMANDS },
    })
  }, TIMING.switchCmd)
  timers.add(cmdTimer)
  const ctxTimer = setTimeout(() => {
    pushSession(sessionId, {
      type: 'context.update',
      id: `mock_ctx_${sessionId}`,
      payload: { sessionId, usagePercent: 6.9, inputTokens: 69000, contextLimit: 1000000 },
    })
  }, TIMING.switchCmd)
  timers.add(ctxTimer)
}

/** 流式时序（ms）—— 仅用于视觉演示节奏，不影响契约 */
const TIMING = {
  ack: 40, // 命令 ack
  startGap: 60, // message_start 前
  chunk: 70, // 每个 text/thinking delta 间隔
  done: 40, // complete 前
  switchCmd: 30,
  thinkingGap: 50, // thinking 块各阶段间隔
  toolGap: 90, // tool_call 各阶段间隔（进度感）
  fileChangesGap: 120, // accumulating → ready 间隔
  retryGap: 800, // auto_retry_start → end 间隔（让指示位可见）
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
  /**
   * 按 cwd 分组返回（对齐后端 SessionGroup[]，D7）。
   * runtime 的 session.list reply 是 `{ groups: SessionGroup[] }`，同构返分组结构。
   * 同 cwd 的 session 归入一组，组内保持插入顺序（按 lastActiveAt 降序更贴近真实，
   * 但 mock fixture 已手排，此处保持稳定顺序避免打乱既有的 5 态演示）。
   */
  async list(): Promise<SessionGroup[]> {
    await sleep(TIMING.ack)
    // 深拷贝：调用方突变不影响 fixture
    const snapshots = fixtureSessions.map((s) => ({ ...s }))
    const byCwd = new Map<string, SessionSummary[]>()
    for (const s of snapshots) {
      const bucket = byCwd.get(s.cwd)
      if (bucket) bucket.push(s)
      else byCwd.set(s.cwd, [s])
    }
    return Array.from(byCwd, ([cwd, sessions]) => ({ cwd, sessions }))
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
    // 模拟 runtime session 激活后的 server-push（session.commands + context.update）
    pushSessionState(id)
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

  /** 设置思考等级（mock：持久到 fixture session.thinkingLevel，runtime 确认属后续联调） */
  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    await sleep(TIMING.ack)
    const target = fixtureSessions.find((s) => s.id === sessionId)
    if (target) target.thinkingLevel = level
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

    // FR-1：auto_retry 演示（关键词触发，让 RetryIndicator 渲染可验证）。
    // 默认不触发（不污染每条消息）；用户输入含 'retry' 时模拟一次瞬态失败→重试→恢复。
    if (/retry/i.test(text)) {
      if (cancelled.has(sessionId)) return
      emit(sessionId, {
        type: 'message.auto_retry_start',
        payload: {
          sessionId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: TIMING.retryGap,
          errorMessage: 'upstream 503 (mock)',
        },
      })
      await sleep(TIMING.retryGap)
      if (cancelled.has(sessionId)) return
      emit(sessionId, { type: 'message.auto_retry_end', payload: { sessionId } })
    }

    // thinking 块（thinking_start → delta×N → end）
    if (cancelled.has(sessionId)) return
    await sleep(TIMING.startGap)
    const thinkingId = nextId('th')
    emit(sessionId, {
      type: 'message.thinking_start',
      payload: { sessionId, thinkingId },
    })
    for (const chunk of splitChunks('让我分析一下这个请求……')) {
      if (cancelled.has(sessionId)) return
      await sleep(TIMING.chunk)
      emit(sessionId, { type: 'message.thinking_delta', payload: { sessionId, delta: chunk } })
    }
    if (cancelled.has(sessionId)) return
    emit(sessionId, { type: 'message.thinking_end', payload: { sessionId } })

    // tool_call 块（start → update → end），证明 tool 卡渲染 + 进度更新
    if (cancelled.has(sessionId)) return
    await sleep(TIMING.toolGap)
    const toolCallId = nextId('tc')
    emit(sessionId, {
      type: 'message.tool_call_start',
      payload: { sessionId, toolCallId, toolName: 'read', input: { path: '/mock/file.ts' } },
    })
    await sleep(TIMING.toolGap)
    if (cancelled.has(sessionId)) return
    emit(sessionId, {
      type: 'message.tool_call_update',
      payload: { sessionId, toolCallId, detail: '读取 42 行' },
    })
    await sleep(TIMING.toolGap)
    if (cancelled.has(sessionId)) return
    emit(sessionId, {
      type: 'message.tool_call_end',
      payload: { sessionId, toolCallId, output: '…文件内容（mock）…', status: 'completed' },
    })

    // 文本流式
    for (const chunk of splitChunks(reply)) {
      if (cancelled.has(sessionId)) return
      await sleep(TIMING.chunk)
      emit(sessionId, {
        type: 'message.text_delta',
        id: messageId,
        payload: { sessionId, messageId, delta: chunk },
      })
    }

    // file_changes（accumulating → ready），证明 ChangeSetCard/FileView 渲染 + 跨帧合并
    if (cancelled.has(sessionId)) return
    await sleep(TIMING.fileChangesGap)
    emit(sessionId, {
      type: 'message.file_changes',
      payload: {
        sessionId,
        messageId,
        fileChanges: [
          { filePath: 'src/mock-feature.ts', status: 'modified', addLines: 10, delLines: 2 },
        ],
        changeSetStatus: 'accumulating',
        isFullSet: false,
      },
    })
    await sleep(TIMING.fileChangesGap)
    if (cancelled.has(sessionId)) return
    emit(sessionId, {
      type: 'message.file_changes',
      payload: {
        sessionId,
        messageId,
        fileChanges: [
          { filePath: 'src/mock-feature.ts', status: 'modified', addLines: 10, delLines: 2 },
          { filePath: 'src/new-file.ts', status: 'added', addLines: 24 },
        ],
        changeSetStatus: 'ready',
        isFullSet: true,
      },
    })

    // complete（含 usage，证明 W05-A usage 回填）
    if (cancelled.has(sessionId)) return
    await sleep(TIMING.done)
    emit(sessionId, {
      type: 'message.complete',
      id: messageId,
      payload: {
        sessionId,
        messageId,
        stopReason: 'complete',
        usage: { inputTokens: 1280, outputTokens: 642, totalTokens: 1922 },
      },
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

  /** steer：mock 下 ack 后推 queue_update（steering 排队），让 QueueBubble 渲染可验证（#13/W06-B）。
   *  下次 message_start 到达时 store 侧清 queue（G-023，chat-chunk-processor 消费侧职责）。 */
  async steer(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    emit(sessionId, {
      type: 'message.queue_update',
      payload: { sessionId, steering: [text] },
    })
  },

  /** followUp：mock 下 ack 后推 queue_update（followUp 排队），让 QueueBubble 渲染可验证。 */
  async followUp(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    emit(sessionId, {
      type: 'message.queue_update',
      payload: { sessionId, followUp: [text] },
    })
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

/* ── 订阅工厂：订阅型 mock（onProviders/onSkills/...）共用 ── */

type GlobalHandler<T> = (data: T) => void

/**
 * mock 订阅工厂：注册后微任务触发一次初始值（模拟 sendInitialState 连接即推）。
 * 请求型接口（listProviders / scan* / discoverModels）不依赖它，直接返 fixture。
 * broadcast() 模拟 runtime 动作后经订阅通道推回状态变更（real 模式由 sendInitialState/
 * 广播驱动，mock 必须同构，否则组件订阅在 mock 模式下看不到动作结果）。
 */
function makeMockSubscription<T>(initial: () => T) {
  const handlers = new Set<GlobalHandler<T>>()
  return {
    subscribe(handler: GlobalHandler<T>): () => void {
      handlers.add(handler)
      // 微任务触发初始帧（模拟连接后推送；避免同步触发时组件未挂载完）
      queueMicrotask(() => handler(initial()))
      return () => {
        handlers.delete(handler)
      }
    },
    /** 向所有订阅者推送新值（模拟 runtime 广播状态变更） */
    broadcast(value: T): void {
      handlers.forEach((h) => h(value))
    },
    /** 取当前初始值快照（供 mock 动作读最新态） */
    snapshot(): T {
      return initial()
    },
  }
}

/* ── Config mock（请求 + 订阅 + 动作）── */

// 订阅型 sub（注册即触发初始值）；请求型直接返 fixture 深拷贝
const providersSub = makeMockSubscription(() =>
  fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) })),
)
const skillsSub = makeMockSubscription(() => fixtureSkills.map((s) => ({ ...s })))
const agentsSub = makeMockSubscription(() => fixtureAgents.map((a) => ({ ...a })))
const defaultsSub = makeMockSubscription(() => 'Anthropic/claude-sonnet-4.5')

export const config = {
  // 请求型：直接返 fixture 深拷贝（不依赖 sub）
  async listProviders() {
    await sleep(TIMING.ack)
    return fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }))
  },
  async discoverModels(req: {
    baseUrl: string
    apiKey?: string
    providerType?: string
    providerId?: string
  }) {
    await sleep(TIMING.ack)
    void req
    // mock：返回空模型集 + success（真实发现由 runtime discoverModelsFromApi 驱动）
    return { success: true, models: [], error: undefined }
  },
  // 订阅型（handler 类型与 real domains 对齐：facade 三元要求两侧同构）
  onProviders: (h: (providers: ProviderInfo[]) => void) => providersSub.subscribe(h),
  onSkills: (h: (skills: SkillInfo[]) => void) => skillsSub.subscribe(h),
  onAgents: (h: (agents: AgentInfo[]) => void) => agentsSub.subscribe(h),
  onDefaults: (h: (defaultModel: string) => void) => defaultsSub.subscribe(h),
  // 动作型：mock 同构——更新 fixture 后经订阅广播推回（与 real sendInitialState/广播一致）
  async setProvider(providerId: string, data: SetProviderData) {
    await sleep(TIMING.ack)
    const target = fixtureProviders.find((p) => p.id === providerId)
    if (target) {
      // 合并透传字段（name/type/apiKey/baseUrl/models/enabled）
      if (data.name !== undefined) target.name = data.name
      if (data.type !== undefined) target.api = data.type
      if (data.baseUrl !== undefined) target.baseUrl = data.baseUrl
      if (data.enabled !== undefined) target.enabled = data.enabled
      if (data.apiKey !== undefined) target.apiKeySet = data.apiKey.length > 0
      if (data.models !== undefined) {
        target.models = data.models.map((m) => (typeof m === 'string' ? { id: m } : { ...m, id: m.id }))
      }
    }
    broadcastProviders()
  },
  async deleteProvider(providerId: string) {
    await sleep(TIMING.ack)
    const idx = fixtureProviders.findIndex((p) => p.id === providerId)
    if (idx >= 0) fixtureProviders.splice(idx, 1)
    broadcastProviders()
  },
  async scanSkills(_sources: string[]) {
    await sleep(TIMING.ack)
    // 扫描后广播当前 skills 快照（runtime scan 后会刷新 config.skills）
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
  },
  async setSkill(skill: SkillInfo) {
    await sleep(TIMING.ack)
    const idx = fixtureSkills.findIndex((s) => s.id === skill.id)
    if (idx >= 0) fixtureSkills[idx] = { ...skill }
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
  },
  async deleteSkill(skillId: string) {
    await sleep(TIMING.ack)
    const idx = fixtureSkills.findIndex((s) => s.id === skillId)
    if (idx >= 0) fixtureSkills.splice(idx, 1)
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
  },
  async scanAgents(_sources: string[]) {
    await sleep(TIMING.ack)
    agentsSub.broadcast(fixtureAgents.map((a) => ({ ...a })))
  },
  async setAgent(agent: AgentInfo) {
    await sleep(TIMING.ack)
    const idx = fixtureAgents.findIndex((a) => a.id === agent.id)
    if (idx >= 0) fixtureAgents[idx] = { ...agent }
    agentsSub.broadcast(fixtureAgents.map((a) => ({ ...a })))
  },
  async deleteAgent(agentId: string) {
    await sleep(TIMING.ack)
    const idx = fixtureAgents.findIndex((a) => a.id === agentId)
    if (idx >= 0) fixtureAgents.splice(idx, 1)
    agentsSub.broadcast(fixtureAgents.map((a) => ({ ...a })))
  },
}

/** 向 providers 订阅者广播最新 fixture 快照（模拟 runtime 动作后广播） */
function broadcastProviders(): void {
  const snapshot = fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }))
  providersSub.broadcast(snapshot)
}

/* ── Model mock ── */
// ModelInfo 统一用 shared 形状（runtime aggregateModels 生产的 providerId/providerName 版）。
// mock 的 MockModel.provider（展示名）同时作 providerId 与 providerName。
// providerColor/tag 是纯 UI 关注点（runtime 不下发），由组件侧本地映射，不进 ModelInfo。
function mockModelToInfo(m: MockModel): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    providerId: m.provider,
    providerName: m.provider,
    reasoning: false,
    enabled: true,
  }
}

const modelsSub = makeMockSubscription(() => MOCK_MODELS.map(mockModelToInfo))

export const model = {
  onModels: (h: (models: ModelInfo[]) => void) => modelsSub.subscribe(h),
  async switchModel(_sessionId: string, _provider: string, _modelId: string) {
    await sleep(TIMING.ack)
  },
}

/* ── Extension mock ── */
// fixture 的 FixtureExtension 带 tools（ExtensionPage 模板依赖），与 shared ExtensionInfo
// （dirName/path/source）结构不同。onExtensions 暂留宽类型，由 SettingsModal 用本地
// ExtensionItem 桥接；tools/dirName/source 字段统一属 W08（Extension CRUD）。

const extensionsSub = makeMockSubscription(() => fixtureExtensions.map((e) => ({ ...e })))

/** 候选 → ExtensionInfo 形状（mock 模式补全 dirName/path/source，对齐 shared 契约） */
function toCandidate(c: { name: string; version: string; description: string; enabled: boolean; tools: string[] }) {
  return {
    name: c.name,
    dirName: c.name,
    version: c.version,
    description: c.description,
    path: `/mock/tmp/${c.name}`,
    enabled: c.enabled,
    source: 'user-installed' as const,
    tools: c.tools,
  }
}

export const extension = {
  onExtensions: (h: GlobalHandler<unknown>) => extensionsSub.subscribe(h),
  async toggle(name: string, enabled: boolean) {
    await sleep(TIMING.ack)
    const target = fixtureExtensions.find((e) => e.name === name)
    if (target) target.enabled = enabled
    // 广播快照（模拟 runtime extension.toggle 后 onExtensions 推回）
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  /** npm 直装（mock：把来源当作新扩展加入并广播刷新） */
  async install(source: string) {
    await sleep(TIMING.ack)
    if (!fixtureExtensions.some((e) => e.name === source)) {
      fixtureExtensions.push({ name: source, version: '0.0.0', description: `mock-installed: ${source}`, enabled: true, tools: [] })
    }
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async uninstall(name: string) {
    await sleep(TIMING.ack)
    const idx = fixtureExtensions.findIndex((e) => e.name === name)
    if (idx >= 0) fixtureExtensions.splice(idx, 1)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  /** dir/git 多步第一步：返回发现的候选（mock 把现有 fixture 当候选） */
  async installDir(_path: string) {
    await sleep(TIMING.ack)
    return { tempDir: `/mock/tmp/${Date.now()}`, candidates: fixtureExtensions.map(toCandidate) }
  },
  async installGitRepository(_url: string) {
    await sleep(TIMING.ack)
    return { tempDir: `/mock/tmp/${Date.now()}`, candidates: fixtureExtensions.map(toCandidate) }
  },
  /** 多步第二步：选中即视为已装（mock 已在 fixture 中，仅广播刷新） */
  async finishInstall(_tempDir: string, _selected: string[]) {
    await sleep(TIMING.ack)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async cancelInstall(_tempDir: string) {
    await sleep(TIMING.ack)
  },
}

/* ── Plugin mock（订阅骨架，无 fixture；第3项真实集成补数据）── */

const pluginsSub = makeMockSubscription((): PluginInfo[] => [])

export const plugin = {
  onPlugins: (h: (plugins: PluginInfo[]) => void) => pluginsSub.subscribe(h),
}

/* ── Settings mock（对齐新契约：转发 config/extension 订阅 + localStorage 偏好）── */
/* 必须在 config/extension 块之后（转发引用它们） */

const SYSTEM_KEY = 'xyz-agent:system-settings'

export const settings = {
  // 订阅（转发到 mock sub）
  onProviders: config.onProviders,
  onSkills: config.onSkills,
  onAgents: config.onAgents,
  onExtensions: extension.onExtensions,
  onDefaults: config.onDefaults,
  // 请求
  listProviders: config.listProviders,
  // 动作
  setProvider: config.setProvider,
  // 纯前端偏好（localStorage，与 real 一致）
  async getSystem(): Promise<{
    locale: 'zh-CN' | 'en-US'
    theme: 'light' | 'dark' | 'system'
    themePreset: string
  }> {
    const raw = localStorage.getItem(SYSTEM_KEY)
    let parsed: Record<string, unknown> = {}
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // 数据损坏：显式回退到默认值（空对象 → 下行 spread 自动用默认兜底）
        parsed = {}
      }
    }
    return {
      locale: 'zh-CN',
      theme: 'dark',
      themePreset: 'cold-blue',
      ...parsed,
    }
  },
  async updateSystem(patch: Record<string, unknown>): Promise<void> {
    const raw = localStorage.getItem(SYSTEM_KEY)
    let cur: Record<string, unknown> = {}
    if (raw) {
      try {
        cur = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // 数据损坏：显式回退到默认值（空对象 → 下行 spread 自动用 patch 兜底）
        cur = {}
      }
    }
    localStorage.setItem(SYSTEM_KEY, JSON.stringify({ ...cur, ...patch }))
  },
}
