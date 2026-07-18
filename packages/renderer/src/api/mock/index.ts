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
  Message, ModelInfo, ServerMessage, SessionSummary, SessionGroup, ProviderInfo,
  SkillInfo, AgentInfo, PluginInfo, SetProviderData,
  SkillDirConfig, FileNode, RecommendedExtension, SubagentRecord, WorkflowRunRecord,
  SystemPromptConfig,
} from '@xyz-agent/shared'
import { recommendedExtensions } from '@xyz-agent/shared'
import { createSession, fixtureMessages, fixtureSessions, e2eTestSession } from './data'
import { fixtureProviders, fixtureSkills, fixtureAgents, fixtureExtensions, toCandidate } from './settings-data'
import { MOCK_MODELS, mockModelToInfo, MENTION_CANDIDATES, FILE_CANDIDATES } from './composer-data'
import { SEARCH_MOCK, SEARCH_RECENTS, SEARCH_SUGGESTED_COUNT, type SearchItem } from './search-data'
import type { Section } from '@/lib/search-types'
import { runSendStream, type Timing } from './run-send-stream'
import { makeMockSubscription, type GlobalHandler } from './subscription'
import * as events from '../events'
// settings 的纯前端偏好（getSystem/updateSystem）与 transport 无关，复用 real 实现消除手工同构；
// mock 域隔离原则针对 transport/events/pending，localStorage 偏好不在此列。
import { getSystem as realGetSystem, updateSystem as realUpdateSystem } from '../domains/settings'

// mock/git.ts 的 git domain + fixtureGitStatus 透出（Wave 1a real git domain 落地后由 api/index 接线）
export { git, fixtureGitStatus } from './git'
// mock/file.ts 的 file domain 透出（W3 file-tree real domain 落地后由 api/index 接线）
export { file } from './file'

// workflow/subagent fixture（E2E 验证 Flows/Agents tab，从 workflow-data.ts 拆出控文件行数）
import { fixtureWorkflows, fixtureSubagents } from './workflow-data'

/** "npm:" 前缀长度（install source 解析用，对齐 runtime NPM_PREFIX_LENGTH） */
const NPM_PREFIX = 'npm:'

/**
 * Mock 模拟 runtime session 通道推送（dispatchSession）。
 * 组件用 events.on(sessionId) 订阅 session.commands / context.update / extension:widget 等；
 * mock 不走 transport，故在此桥接——直接 dispatchSession 模拟 server-push，
 * 让组件订阅在 mock 模式下也能触发（mock/real 同构）。
 */
function pushSession(sessionId: string, msg: ServerMessage): void {
  events.dispatchSession(sessionId, msg)
}

/**
 * E2E 注入：VITE_E2E === 'true' 时把 e2eTestSession（cwd 指向 e2e/fixtures/sample-project）
 * 并入 fixtureSessions 快照，让 W8 文件树 E2E 拿到带确定 cwd 的 session。
 * renderer 是浏览器环境读不到 process.env，故用 Vite 构建期注入的 import.meta.env.VITE_E2E。
 */
const isE2E = import.meta.env.VITE_E2E === 'true'

/** 按 cwd 聚合 fixtureSessions 为 SessionGroup[]（config.sessions reply 与 server-push 共用） */
function buildGroups(): SessionGroup[] {
  // E2E 模式注入 fixture session（不修改 fixtureSessions 源数组，保持 idempotent）
  const base = fixtureSessions.map((s) => ({ ...s }))
  const snapshots = isE2E && e2eTestSession.cwd ? [e2eTestSession, ...base] : base
  const byCwd = new Map<string, SessionSummary[]>()
  for (const s of snapshots) {
    const bucket = byCwd.get(s.cwd)
    if (bucket) bucket.push(s)
    else byCwd.set(s.cwd, [s])
  }
  return Array.from(byCwd, ([cwd, sessions]) => ({ cwd, sessions }))
}

/**
 * 模拟 runtime broadcastSessionList（create/delete/rename 后推全量分组到 global 通道）。
 * useSidebar 经 events.onGlobalType('config.sessions') 订阅（refCount 防重复），mock 直 dispatchGlobal。
 */
function pushSessionList(): void {
  events.dispatchGlobal({ type: 'config.sessions', id: nextId('sl'), payload: { groups: buildGroups() } })
}

/** Mock 静态 slash 命令（模拟 pi getCommands 返回的扩展命令） */
const MOCK_COMMANDS = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', description: '代码审查', source: 'extension' },
  { name: '/fix', description: '修复问题', source: 'skill' },
  { name: '/compact', description: '压缩上下文', source: 'builtin' },
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
const TIMING: Timing = {
  ack: 40, // 命令 ack
  startGap: 60, // message_start 前
  chunk: 70, // 每个 text/thinking delta 间隔
  done: 40, // complete 前
  switchCmd: 30,
  thinkingGap: 50, // thinking 块各阶段间隔
  toolGap: 90, // tool_call 各阶段间隔（进度感）
  fileChangesGap: 120, // accumulating → ready 间隔
  retryGap: 800, // auto_retry_start → end 间隔（让指示位可见）
  steerDrain: 1500, // steer/followUp 入队 → 模拟 drain（pi 投递）间隔，让 pending 气泡可见
}

const streamHandlers = new Map<string, Set<(msg: ServerMessage) => void>>()
/** 已 abort 的 session：send 循环检查后提前返回 */
const cancelled = new Set<string>()
/** 运行中的 setTimeout 句柄，resolve 后自动移除，避免 Set 无限增长 */
const timers = new Set<ReturnType<typeof setTimeout>>()
/**
 * mock 队列状态镜像（steer/followUp pending）。
 * steer/followUp 入队时 push + emit 全量 queue_update（QueueBubble 渲染 + pending 气泡），
 * 延迟后 splice 模拟 drain（pi 投递）+ emit 全量（移除该项）→ 前端 pending 气泡转 complete。
 */
const mockQueues = new Map<string, { steering: string[]; followUp: string[] }>()

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

/** emit 全量 queue_update（steering + followUp 镜像），驱动 QueueBubble + pending 气泡 */
function emitQueueUpdate(sessionId: string): void {
  const q = mockQueues.get(sessionId)
  const steering = q?.steering.length ? q.steering : undefined
  const followUp = q?.followUp.length ? q.followUp : undefined
  // 两者皆空时仍 emit（空 payload），让 store 侧 queue_update handler delete queueState
  emit(sessionId, {
    type: 'message.queue_update',
    payload: { sessionId, steering, followUp },
  })
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

export const session = {
  /**
   * 按 cwd 分组返回（对齐后端 SessionGroup[]，D7）。
   * runtime 的 config.sessions reply 是 `{ groups: SessionGroup[] }`，同构返分组结构。
   * 同 cwd 的 session 归入一组，组内保持插入顺序（按 lastActiveAt 降序更贴近真实，
   * 但 mock fixture 已手排，此处保持稳定顺序避免打乱既有的 5 态演示）。
   */
  async list(): Promise<SessionGroup[]> {
    await sleep(TIMING.ack)
    // buildGroups 已深拷贝，调用方突变不影响 fixture
    return buildGroups()
  },

  async create(cwd?: string, label?: string): Promise<SessionSummary> {
    await sleep(TIMING.ack)
    const s = createSession(cwd, label)
    fixtureSessions.push(s)
    // 模拟 runtime create 后 broadcastSessionList（server-push 全量分组）
    pushSessionList()
    return { ...s }
  },

  /**
   * Mock fork：模拟 runtime 截断 + 新进程，返回新 session。
   * mock 模式无真实 JSONL 截断，仅创建空 session（历史由前端 selectSession 拉）。
   * 与 real domain 同接口，签名一致（opts 必选，对齐 session.ts fork）。
   */
  async fork(srcSessionId: string, opts: { piEntryId?: string; messageTimestamp?: number; messageRole?: string; includeFrom?: boolean; label?: string }): Promise<SessionSummary> {
    await sleep(TIMING.ack)
    const src = fixtureSessions.find((s) => s.id === srcSessionId)
    const cwd = src?.cwd
    const s = createSession(cwd, opts?.label)
    fixtureSessions.push(s)
    pushSessionList()
    return { ...s }
  },

  async switchSession(id: string): Promise<void> {
    await sleep(TIMING.switchCmd)
    // E2E 注入的 session 不在 fixtureSessions 数组中，单独放行
    const exists = isE2E && id === e2eTestSession.id ? true : fixtureSessions.some((s) => s.id === id)
    if (!exists) {
      throw new Error(`mock: session ${id} 不存在`)
    }
    // 模拟 runtime session 激活后的 server-push（session.commands + context.update）
    pushSessionState(id)
  },

  /** 拉取 session 扩展命令（与 real domain 同接口，mock 返回 MOCK_COMMANDS） */
  async getCommands(id: string): Promise<{ sessionId: string; commands: typeof MOCK_COMMANDS }> {
    await sleep(TIMING.ack)
    return { sessionId: id, commands: MOCK_COMMANDS.map((c) => ({ ...c })) }
  },

  /** 拉取上下文用量（mock 返回固定示例值，与 real domain 同接口） */
  async getContext(id: string): Promise<{ sessionId: string; inputTokens: number; contextLimit: number; usagePercent: number }> {
    await sleep(TIMING.ack)
    return { sessionId: id, inputTokens: 12000, contextLimit: 200000, usagePercent: 6 }
  },

  async rename(sessionId: string, label: string): Promise<void> {
    await sleep(TIMING.ack)
    const target = fixtureSessions.find((s) => s.id === sessionId)
    if (!target) throw new Error(`mock: session ${sessionId} 不存在`)
    target.label = label
    // 模拟 runtime rename 后 broadcastSessionList
    pushSessionList()
  },

  async remove(sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
    const idx = fixtureSessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) throw new Error(`mock: session ${sessionId} 不存在`)
    fixtureSessions.splice(idx, 1)
    delete fixtureMessages[sessionId]
    // 模拟 runtime delete 后 broadcastSessionList
    pushSessionList()
  },

  /** 设置思考等级（mock：持久到 fixture session.thinkingLevel，runtime 确认属后续联调） */
  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    await sleep(TIMING.ack)
    const target = fixtureSessions.find((s) => s.id === sessionId)
    if (target) target.thinkingLevel = level
  },

  /**
   * Mock subagent 列表。
   * s3（E2E 默认激活 session）返回 fixture，其他 session 返回空——
   * 让 E2E 能验证「切 session 后列表刷新」（切到无数据 session 看空态，切回 s3 看列表）。
   */
  async getSubagents(sessionId: string): Promise<SubagentRecord[]> {
    await sleep(TIMING.ack)
    return sessionId === 's3' ? fixtureSubagents.map((s) => ({ ...s })) : []
  },

  /** Mock subagent 对话流历史（返回空数组，agent call 对话流由 getAgentCallHistory 覆盖） */
  async getSubagentHistory(_sessionId: string, _subagentId: string): Promise<Message[]> {
    await sleep(TIMING.ack)
    return []
  },

  /**
   * Mock workflow 列表。
   * s3 返回 fixture，其他 session 返回空——同 getSubagents 的区分逻辑。
   */
  async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
    await sleep(TIMING.ack)
    return sessionId === 's3' ? fixtureWorkflows.map((w) => ({ ...w })) : []
  },

  /** Mock agent call 对话流历史（返回空数组，selectAgentCall 不 throw 即可） */
  async getAgentCallHistory(_sessionId: string, _agentCallSessionId: string): Promise<Message[]> {
    await sleep(TIMING.ack)
    return []
  },

  /** Mock workflow 操作（pause/resume/abort，E2E 不断言此路径，stub resolve 即可） */
  async workflowAction(_sessionId: string, _action: string, _runId: string): Promise<void> {
    await sleep(TIMING.ack)
  },

  /** Mock subagent cancel（对称 workflowAction，stub resolve 即可） */
  async subagentAction(_sessionId: string, _action: string, _subagentId: string): Promise<void> {
    await sleep(TIMING.ack)
  },
}

export const chat = {
  /** 拉 session 历史（深拷贝 fixture，避免外部突变污染） */
  async getHistory(sessionId: string): Promise<{ messages: Message[]; historyTruncated: boolean }> {
    await sleep(TIMING.ack)
    return { messages: (fixtureMessages[sessionId] ?? []).map((m) => ({ ...m })), historyTruncated: false }
  },

  /** W4 H4：全量历史（mock 与 getHistory 同行为，mock 无尾读截断） */
  async getFullHistory(sessionId: string): Promise<Message[]> {
    await sleep(TIMING.ack)
    return (fixtureMessages[sessionId] ?? []).map((m) => ({ ...m }))
  },

  async send(sessionId: string, text: string): Promise<void> {
    cancelled.delete(sessionId)
    // ack 语义：仅模拟 pi 接收命令，立即 resolve；流式序列 fire-and-forget（不 await）。
    // isStreaming 由 message_start/complete 事件驱动（useChat.ts），不受此处 resolve 时机影响，
    // 故 Composer :disabled=isSending 不会全程 true，流式中可 steer/retry。
    await sleep(TIMING.ack)
    void runSendStream(sessionId, text, {
      nextId,
      emit,
      sleep,
      pushSession,
      isCancelled: (s) => cancelled.has(s),
      TIMING,
    })
  },

  /**
   * compact（#6）：模拟 session.compact 生命周期（compacting → compacted）。
   * 不推 compactionSummary——那是 pi 自主压缩才推的 system 行，与用户主动 /compact 语义不同
   * （§4.4：compactionSummary 走 message.compactionSummary，由 pi 驱动，mock 捆绑会造成语义混淆）。
   */
  async compact(sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
    emit(sessionId, { type: 'session.compacting', payload: { sessionId, status: 'compacting' } })
    await sleep(TIMING.fileChangesGap)
    emit(sessionId, { type: 'session.compacted', payload: { sessionId, status: 'compacted' } })
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

  /**
   * steer：ack 后推 queue_update（steering 入队），延迟后模拟 drain（pi 投递：splice 移除 + emit）。
   * 入队 → QueueBubble 渲染 + pending 气泡；drain → 前端 pending→complete。
   * drain 时机简化为固定延迟（真实 pi 在「当前回合工具调用结束后、下次 LLM 调用前」）。
   */
  async steer(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    const q = mockQueues.get(sessionId) ?? { steering: [], followUp: [] }
    q.steering.push(text)
    mockQueues.set(sessionId, q)
    emitQueueUpdate(sessionId)
    // 延迟模拟 drain（投递后移除该项）
    const t = setTimeout(() => {
      const cur = mockQueues.get(sessionId)
      if (!cur || cancelled.has(sessionId)) return
      const idx = cur.steering.indexOf(text)
      if (idx !== -1) cur.steering.splice(idx, 1)
      emitQueueUpdate(sessionId)
    }, TIMING.steerDrain)
    timers.add(t)
  },

  /** followUp：ack 后推 queue_update（followUp 入队），延迟后模拟 drain。语义同 steer。 */
  async followUp(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    const q = mockQueues.get(sessionId) ?? { steering: [], followUp: [] }
    q.followUp.push(text)
    mockQueues.set(sessionId, q)
    emitQueueUpdate(sessionId)
    const t = setTimeout(() => {
      const cur = mockQueues.get(sessionId)
      if (!cur || cancelled.has(sessionId)) return
      const idx = cur.followUp.indexOf(text)
      if (idx !== -1) cur.followUp.splice(idx, 1)
      emitQueueUpdate(sessionId)
    }, TIMING.steerDrain)
    timers.add(t)
  },

  streamSubscribe(sessionId: string, handler: (msg: ServerMessage) => void): () => void {
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

/* ── Config mock（请求 + 订阅 + 动作）── */

// 订阅型 sub（注册即触发初始值）；请求型直接返 fixture 深拷贝
const providersSub = makeMockSubscription(() =>
  fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) })),
)
const skillsSub = makeMockSubscription(() => fixtureSkills.map((s) => ({ ...s })))
const agentsSub = makeMockSubscription(() => fixtureAgents.map((a) => ({ ...a })))
const defaultsSub = makeMockSubscription(() => 'Anthropic/claude-sonnet-4.5')

// ADR-0020 §1 discovery.json 加载路径配置（目录级管道，UI 层 A 勾选/拖动用）
// fixtureSkillDirs/fixtureAgentDirs 是「预设候选 + enabled 状态」的 UI 视图，对齐 server.ts buildDirConfigs
const PRESET_SKILL_DIRS = ['~/.pi/agent/skills', '~/.claude/skills', '~/.agents/skills', '.agents/skills']
const PRESET_AGENT_DIRS = ['~/.pi/agent/agents', '~/.claude/agents', '~/.agents/agents', '.agents/agents']
let mockSkillDirPaths = ['~/.pi/agent/skills', '~/.claude/skills', '~/.agents/skills'] // 启用的 skillDirs（有序 = 优先级）
let mockAgentDirPaths = ['~/.agents/agents'] // 启用的 agentDirs
function buildMockDirConfigs(preset: string[], enabledPaths: string[]): SkillDirConfig[] {
  // ADR-0020 §1.1：discovery 数组顺序即优先级（靠前覆盖靠后）。
  // 顺序：启用的按 discovery 顺序（用户拖拽排序）→ 未启用的预设候选按固定顺序追加。
  const enabledSet = new Set(enabledPaths)
  const configs = enabledPaths.map((path) => ({ path, enabled: true }))
  for (const path of preset) {
    if (!enabledSet.has(path)) configs.push({ path, enabled: false })
  }
  return configs
}
const skillDirsSub = makeMockSubscription(() => buildMockDirConfigs(PRESET_SKILL_DIRS, mockSkillDirPaths).map((d) => ({ ...d })))
const agentDirsSub = makeMockSubscription(() => buildMockDirConfigs(PRESET_AGENT_DIRS, mockAgentDirPaths).map((d) => ({ ...d })))

/** 默认系统提示词配置（与 W7 system-prompt-page.test defaultConfig 同构）。 */
function defaultSystemPromptConfig(): SystemPromptConfig {
  return {
    version: 1,
    replace: { enabled: false, prompt: '' },
    append: { enabled: false, prompt: '' },
  }
}
// 系统提示词配置订阅（模拟 config.systemPrompt 广播；初始推默认配置，corrupted=false）。
const systemPromptSub = makeMockSubscription(() => ({ config: defaultSystemPromptConfig(), corrupted: false }))

export const config = {
  // 请求型：直接返 fixture 深拷贝（不依赖 sub）
  async listProviders() {
    await sleep(TIMING.ack)
    return fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }))
  },
  async discoverModels(req: { baseUrl: string; apiKey?: string; providerType?: string; providerId?: string }) {
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
  onSkillDirs: (h: (dirs: SkillDirConfig[]) => void) => skillDirsSub.subscribe(h),
  onAgentDirs: (h: (dirs: SkillDirConfig[]) => void) => agentDirsSub.subscribe(h),
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
  /**
   * 设默认模型（W3 协议 config.setDefaultModel 的 mock 对齐）。
   * 改 defaultsSub 内部值并广播 "provider/modelId" 复合串，与 runtime 广播 config.defaults 同构。
   * 状态经 onDefaults 订阅推回 settingsStore.defaultModel，前端无需本地乐观更新。
   */
  async setDefaultModel(provider: string, modelId: string) {
    await sleep(TIMING.ack)
    defaultsSub.broadcast(`${provider}/${modelId}`)
  },
  async scanSkills(_sources: string[]) {
    await sleep(TIMING.ack)
    // 扫描后广播当前 skills 快照（runtime scan 后会刷新 config.skills）
    skillsSub.broadcast(fixtureSkills.map((s) => ({ ...s })))
  },
  /** ADR-0020 §1 目录级管道写入：更新 mock skillDirs + 广播 skill 列表 + 目录配置 */
  async setSkillDirs(dirs: string[]) {
    await sleep(TIMING.ack)
    mockSkillDirPaths = dirs
    skillDirsSub.broadcast(buildMockDirConfigs(PRESET_SKILL_DIRS, dirs).map((d) => ({ ...d })))
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
  /** ADR-0020 §1 目录级管道写入：更新 mock agentDirs + 广播 agent 列表 + 目录配置 */
  async setAgentDirs(dirs: string[]) {
    await sleep(TIMING.ack)
    mockAgentDirPaths = dirs
    agentDirsSub.broadcast(buildMockDirConfigs(PRESET_AGENT_DIRS, dirs).map((d) => ({ ...d })))
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
  // ── 系统提示词配置（W6 FR-4/FR-5，与 real domains/config 同构）──
  // mock 持内存默认配置；setSystemPrompt 广播 config.systemPrompt，与 runtime 行为一致。
  async getSystemPrompt() {
    await sleep(TIMING.ack)
    return { config: defaultSystemPromptConfig(), corrupted: false }
  },
  async setSystemPrompt(cfg: SystemPromptConfig) {
    await sleep(TIMING.ack)
    const next = { config: cfg, corrupted: false }
    systemPromptSub.broadcast(next)
    return next
  },
  onSystemPrompt: (h: (config: SystemPromptConfig, corrupted: boolean) => void) =>
    systemPromptSub.subscribe((p) => h(p.config, p.corrupted)),
}

/** 向 providers 订阅者广播最新 fixture 快照（模拟 runtime 动作后广播） */
function broadcastProviders(): void {
  const snapshot = fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }))
  providersSub.broadcast(snapshot)
}

/* ── Model mock ── */
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

export const extension = {
  onExtensions: (h: GlobalHandler<unknown>) => extensionsSub.subscribe(h),
  /** 主动重拉（对齐 runtime extension.list → 广播 config.extensions 刷新） */
  async scan() {
    await sleep(TIMING.ack)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async toggle(name: string, enabled: boolean) {
    await sleep(TIMING.ack)
    const target = fixtureExtensions.find((e) => e.name === name)
    if (target) target.enabled = enabled
    // 广播快照（模拟 runtime extension.toggle 后 onExtensions 推回）
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  /**
   * npm 直装（mock：剥 npm: 前缀后以真实包名加入 fixture 并广播刷新）。
   * 对齐 runtime installExtension 语义：source 形如 "npm:@scope/pkg"，runtime 用
   * pkgName（剥前缀）install，scanExtensions 读出的 name 是 package.json 的真实包名。
   * mock 直接用剥前缀后的 source 作为 name，让推荐区的 installed 匹配能命中。
   */
  async install(source: string) {
    await sleep(TIMING.ack)
    const name = source.startsWith('npm:') ? source.slice(NPM_PREFIX.length) : source
    if (!fixtureExtensions.some((e) => e.name === name)) {
      fixtureExtensions.push({ name, version: '0.0.0', description: `mock-installed: ${name}`, enabled: true, tools: [] })
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
  /** 拉取推荐扩展（含已安装状态）。mock 用 fixtureExtensions 判断 installed。 */
  async fetchRecommended(): Promise<Array<RecommendedExtension & { installed: boolean }>> {
    await sleep(TIMING.ack)
    const installedNames = new Set(fixtureExtensions.map((e) => e.name))
    return recommendedExtensions.map((r) => ({ ...r, installed: installedNames.has(r.name) }))
  },
  /** 升级扩展（mock：仅等待 ack，不实际升级） */
  async upgrade(_name: string) {
    await sleep(TIMING.ack)
  },
  /** 设置自动升级开关（mock：仅等待 ack） */
  async setAutoUpgrade(_name: string, _enabled: boolean) {
    await sleep(TIMING.ack)
  },
}

/* ── Plugin mock（订阅骨架，无 fixture；第3项真实集成补数据）── */

const pluginsSub = makeMockSubscription((): PluginInfo[] => [])

export const plugin = {
  onPlugins: (h: (plugins: PluginInfo[]) => void) => pluginsSub.subscribe(h),
}

/* ── Composer mock（@ 引用 / # 文件候选；# 已接 real domain，mock 模式仍用 fixture 演示）── */
/* 门面三元同构：getFileCandidates 返回 FileNode[]（与 real composer domain 一致），
   FILE_CANDIDATES（UI 形状）→ FileNode 映射在此处，消费侧 lib/file-candidates.ts 统一做 FileNode→候选映射。 */

export const composer = {
  async getMentionCandidates() {
    await sleep(TIMING.ack)
    return MENTION_CANDIDATES.map((m) => ({ ...m }))
  },
  async getFileCandidates(): Promise<FileNode[]> {
    await sleep(TIMING.ack)
    // FILE_CANDIDATES（UI 形状 {name,kind,path}）→ FileNode（{path,name,type}），与 real 同构
    return FILE_CANDIDATES.map((f) => ({
      path: f.path ?? f.name,
      name: f.name.replace(/\/$/, ''),
      type: (f.kind === '目录' ? 'dir' : 'file') as FileNode['type'],
    }))
  },
}

/* ── Search mock（全局搜索浮层 ⌘K；后端 LSP/命令注册表就绪后接 real domain）── */

export const search = {
  /**
   * 按查询过滤四类数据，空查询返回 recent + suggested。
   * W1 i18n-frontend-p2：返回 Section[] 带 kind 字段（recent/suggested/command/file/symbol/session），
   * 供 SearchModal kind-based 判定用（不再依赖中文字面量 s.label === '最近' 比较）。
   * label 仍为本地化文案（mock 内联 zh-CN 默认值，real 轨 useSearch 统一走 i18n.t）。
   */
  async query(q: string): Promise<Section[]> {
    await sleep(TIMING.ack)
    const trimmed = q.trim().toLowerCase()
    if (!trimmed) {
      return [
        { kind: 'recent', label: '最近', items: SEARCH_RECENTS.map((i) => ({ ...i })) },
        { kind: 'suggested', label: '建议命令', items: SEARCH_MOCK.command.slice(0, SEARCH_SUGGESTED_COUNT).map((i) => ({ ...i })) },
      ]
    }
    const TYPES: SearchItem['type'][] = ['command', 'file', 'symbol', 'session']
    const LABEL: Record<SearchItem['type'], string> = { command: '命令', file: '文件', symbol: '符号', session: '会话' }
    return TYPES
      .map((t) => ({
        kind: t,
        label: LABEL[t],
        items: SEARCH_MOCK[t]
          .filter((it) => it.title.toLowerCase().includes(trimmed) || it.sub.toLowerCase().includes(trimmed))
          .map((it) => ({ ...it })),
      }))
      .filter((s) => s.items.length > 0)
  },
}

/* ── Settings mock（对齐新契约：转发 config/extension 订阅 + 复用 real 的 localStorage 偏好）── */
/* 必须在 config/extension 块之后（转发引用它们） */

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
  // 纯前端偏好（localStorage）：复用 real 实现，两侧契约由类型保证一致，不再手工复制。
  getSystem: realGetSystem,
  updateSystem: realUpdateSystem,
}

// Mock workspace domain（W3：最近工作区记录，mock 返回 3 条 records 供 E2E 验证）

/**
 * 固定 3 条样例（lastUsedAt 递减，最新在前），供 T4.1/T4.3 E2E 验证 popover 渲染与搜索过滤。
 * label = cwd basename（与 runtime workspace-message-handler 的 label 派生一致）。
 *
 * 抽为模块级内部函数而非 workspace.listRecent 方法内联：record 需复用同一份数据，
 * 早期实现 record 调 this.listRecent() 依赖 this 绑定——但 workspace 对象方法被解构赋值
 * 或脱离对象调用（如 `const { record } = workspace; record(cwd)`）时 this=undefined → 抛错。
 * 提到模块级避免该 this 绑定陷阱（S12 修复）。
 */
function listRecentRecords(): import('@xyz-agent/shared').RecentWorkspaceRecord[] {
  const now = Date.now()
  const DAY = 86_400_000
  const oldestOffset = DAY + DAY // 2 天前（相加避免魔数 lint）
  return [
    { cwd: '/Users/demo/project-a', lastUsedAt: now, label: 'project-a' },
    { cwd: '/Users/demo/project-b', lastUsedAt: now - DAY, label: 'project-b' },
    { cwd: '/Users/demo/another-foo', lastUsedAt: now - oldestOffset, label: 'another-foo' },
  ]
}

export const workspace = {
  async listRecent(): Promise<import('@xyz-agent/shared').RecentWorkspaceRecord[]> {
    return listRecentRecords()
  },
  // record 不再依赖 this.listRecent（this 绑定陷阱，见 listRecentRecords 注释），直接调模块级函数
  async record(_cwd: string): Promise<import('@xyz-agent/shared').RecentWorkspaceRecord[]> {
    // Mock record：模拟写入后返回最新列表（与 listRecent 一致，简化实现）
    return listRecentRecords()
  },
}
