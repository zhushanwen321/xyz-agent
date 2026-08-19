/**
 * 标量 session 状态的 ReplicatedState 配置条目（data-source-governance W7 + W8，P1.1 / P1.2）。
 *
 * 本文件 = 登记表条目的代码化（docs/architecture/data-source-registry.md）：每条配置 =
 * 快照 RPC + 合并策略（含字段空值语义）。失效触发源不进配置——由调用方（event-interpreter /
 * session-service 的事件与 RPC 响应汇聚点）调实例 markDirty()（W6 原语约定）。
 * 实例按 session 注册在 session-service（本文件纯函数，无状态）。
 *
 * W7 三条目（label / thinkingLevel / modelId，fetch 同源 get_state）：
 * - label：fetch = get_state().sessionName；失效 = session_info_changed；空值语义 =
 *   sessionName 缺失 = 未命名 = 覆盖（'explicit-null'——label 与 sessionName 是同一数据链，
 *   无独立可守卫空值语义，D1b 归一，登记表不双登记）。
 * - thinkingLevel：fetch = get_state().thinkingLevel；失效 = thinking_level_changed +
 *   周期兜底 pollIntervalMs 30_000（pi 同档位切换不发射事件——session-service.switchModel 注释
 *   既有记录，纯事件失效覆盖不住）；空值语义 = 'required'（值域不含空、永不 guard）。
 * - modelId：fetch = get_state().model（pi Model.id 是裸 modelId、provider 在 Model.provider，
 *   投影组合为 runtime 语义的 'provider/model' 字符串——与 session.modelId /
 *   switchModel 口径一致，见 rpc-types.ts RpcSessionState.model / ai types.ts Model）；
 *   失效 = switchModel RPC 成功响应（RPC 响应驱动是「事件只做失效」的补充合法形态，D7）；
 *   空值语义 = 'required'（W15 磁盘扫描占位符 '' 不是权威空值，不登记空值语义）。
 *
 * W8 三条目（usage / queue 深度 / commands，六实例齐备）：
 * - usage：fetch = get_session_stats().contextUsage（投影对齐既有 fetchContext 口径：
 *   inputTokens = tokens、contextLimit = contextWindow、usagePercent = Math.round(percent ?? 0)）；
 *   失效 = context 相关事件 turn_end / agent_end / compaction（接线汇聚点 =
 *   session-service.applyContextUpdate——三事件路径均经 interpreter onContextUpdate 到达）；
 *   空值语义 = 无（tokens=null 是 pi compact 后无新 turn 的合法「无值」态，投影为空快照
 *   保持旧值，对齐 fetchContext 返回 null 的不更新语义，不做覆盖也不做 guard）。
 * - queue 深度：fetch = get_state().pendingMessageCount（深度权威 = pi，D6）；失效 =
 *   queue_update（翻译帧经 session-service 的 send 汇聚点只做失效信号）；空值语义 =
 *   'required'（值域含 0 不含空——0 = 空队列合法态，key 缺失 = 协议异常）。
 * - commands：fetch = get_commands（数组包装为 { commands } 快照，空数组 = 合法态整字段覆盖）；
 *   失效 = getCommands 的全部调用路径（session 激活的 fetchAndBroadcastCommands 发布路径 +
 *   renderer 主动 RPC 查询——查询即失效，对齐 session-service.getCommands 现有事件源全集）；
 *   空值语义 = 无（投影自构对象 key 恒在）。
 *
 * @module replicated-states-config
 */
import {
  ownerSnapshotMerge,
  WireSnapshotSchemaError,
  type ReplicatedStateConfig,
} from './replicated-state.js'
// type-only：PiCommandInfo 是 commands 快照的元素形态（rpc-client getCommands 返回项）
import type { PiCommandInfo } from '../ports/pi-engine.js'

/**
 * 失效防抖窗口（ms）。W7/W8 六实例共用。
 * 行为级验收约束「切模型后模型名 1s 内更新」：防抖 + get_state（毫秒级 RPC）须 < 1s。
 * export 供测试 import（SR6 SSOT：测试跟随源码常量，不漂移）。
 */
export const SCALAR_STATE_DEBOUNCE_MS = 300

/** usagePercent 上限（对齐 session-service.computeUsage 的 MAX_PERCENT 口径，clamp 防越界）。 */
const MAX_USAGE_PERCENT = 100

/**
 * thinkingLevel 周期兜底重拉间隔（ms，W7 验收锁定 30s）。
 * pi 同档位切换不发射 thinking_level_changed，纯事件失效覆盖不住——周期兜底补拉。
 * export 供测试 import（SR6）。
 */
export const THINKING_LEVEL_POLL_INTERVAL_MS = 30_000

/** 快照失败退避序列（canonical，W6 接口契约锁定值）。export 供测试 import（SR6）。 */
// eslint-disable-next-line no-magic-numbers -- canonical 退避序列 1s/5s/15s（W6 契约锁定，非可调魔数）
export const SCALAR_STATE_BACKOFF_SCHEDULE: readonly number[] = [1000, 5000, 15000]

/** get_state 三字段投影的共享形态（每实例快照是其中单字段子集）。 */
interface SessionScalarFields {
  sessionName?: string
  thinkingLevel?: string
  modelId?: string
  /** queue 深度（W8）：pi RpcSessionState.pendingMessageCount（steering + followUp 条数和）。 */
  pendingMessageCount?: number
}

/** label 实例快照形态（单字段投影；sessionName undefined = 未命名合法态）。 */
export interface LabelSnapshot {
  sessionName?: string
}

/** thinkingLevel 实例快照形态。 */
export interface ThinkingLevelSnapshot {
  thinkingLevel?: string
}

/** modelId 实例快照形态（'provider/model' 形态字符串）。 */
export interface ModelIdSnapshot {
  modelId?: string
}

/**
 * get_state wire 投影：提取三标量字段，非 string 值退化为「key 缺失」（与 JSON wire 序列化
 * 丢 undefined key 同构），交由 fieldsNullSemantics 归一判定语义——投影层不做语义决策。
 *
 * state 非对象 = 协议异常（rpc-client 归一后仍可能 undefined）→ 抛 WireSnapshotSchemaError，
 * 按快照失败处理（退避重试 + 保留旧值）。特别地，label 不把「整包 state 缺失」当
 * 「sessionName 未命名」覆盖旧名——只有 state 正常到达且 sessionName key 缺失才是未命名。
 */
function projectSessionScalars(state: unknown): SessionScalarFields {
  if (typeof state !== 'object' || state === null) {
    throw new WireSnapshotSchemaError(
      `get_state returned ${state === null ? 'null' : typeof state} instead of an object state`,
    )
  }
  const record = state as Record<string, unknown>
  const fields: SessionScalarFields = {}
  if (typeof record.sessionName === 'string') fields.sessionName = record.sessionName
  if (typeof record.thinkingLevel === 'string') fields.thinkingLevel = record.thinkingLevel
  // W8 queue 深度：pi RpcSessionState.pendingMessageCount 恒为 number（agent-session.ts
  // `get pendingMessageCount()`），非 number = 协议异常 → 丢 key 走 'required' 归一。
  if (typeof record.pendingMessageCount === 'number') fields.pendingMessageCount = record.pendingMessageCount
  const model = record.model
  if (typeof model === 'object' && model !== null) {
    const m = model as Record<string, unknown>
    // pi Model.id 是裸 modelId（如 'mimo-v2.5-pro'，provider 在 Model.provider）；runtime
    // session.modelId 语义是 'provider/model' 组合（switchModel / toSummary 口径）——此处组合。
    if (typeof m.provider === 'string' && m.provider !== '' && typeof m.id === 'string' && m.id !== '') {
      fields.modelId = `${m.provider}/${m.id}`
    }
  }
  return fields
}

/** get_state 窄访问器（session-service 注入：复用 rpc-client getState）。 */
export type FetchStateFn = () => Promise<Record<string, unknown> | undefined>

/** label 配置条目（登记表代码化）。 */
export function createLabelStateConfig(fetchState: FetchStateFn): ReplicatedStateConfig<LabelSnapshot> {
  return {
    fetchSnapshot: async () => {
      const fields = projectSessionScalars(await fetchState())
      // undefined 丢 key：走原语 wire 归一（'explicit-null' 物化显式 undefined → 合并覆盖）
      return fields.sessionName === undefined ? {} : { sessionName: fields.sessionName }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: { sessionName: 'explicit-null' },
  }
}

/** thinkingLevel 配置条目（登记表代码化，含 30s 周期兜底）。 */
export function createThinkingLevelStateConfig(
  fetchState: FetchStateFn,
): ReplicatedStateConfig<ThinkingLevelSnapshot> {
  return {
    fetchSnapshot: async () => {
      const fields = projectSessionScalars(await fetchState())
      // 丢 key 后 'required' 归一抛协议异常 → 快照失败退避（key 缺失 ≠ 字段不动）
      return fields.thinkingLevel === undefined ? {} : { thinkingLevel: fields.thinkingLevel }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    pollIntervalMs: THINKING_LEVEL_POLL_INTERVAL_MS,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: { thinkingLevel: 'required' },
  }
}

/** modelId 配置条目（登记表代码化）。 */
export function createModelIdStateConfig(fetchState: FetchStateFn): ReplicatedStateConfig<ModelIdSnapshot> {
  return {
    fetchSnapshot: async () => {
      const fields = projectSessionScalars(await fetchState())
      // 丢 key 后 'required' 归一抛协议异常 → 快照失败退避（model 缺失 = 协议异常，禁当字段不动）
      return fields.modelId === undefined ? {} : { modelId: fields.modelId }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: { modelId: 'required' },
  }
}

// ── W8 三条目：usage / queue 深度 / commands ────────────────────────────────

/**
 * usage 实例快照形态（get_session_stats().contextUsage 三字段投影，对齐 fetchContext 口径）。
 * 字段 optional 是 wire 归一前形态（同 W7 标量条目）：tokens=null（compact 后无新 turn）时
 * 投影为空快照 {}（无字段 = 合法「无值」态，merge 保持旧值）。
 */
export interface UsageSnapshot {
  inputTokens?: number
  contextLimit?: number
  usagePercent?: number
}

/** queue 深度实例快照形态（get_state().pendingMessageCount；optional = 丢 key 走 'required' 归一）。 */
export interface QueueDepthSnapshot {
  pendingMessageCount?: number
}

/** commands 实例快照形态（get_commands 数组的包装对象——merge 契约要求对象形态）。 */
export interface CommandsSnapshot {
  commands: PiCommandInfo[]
}

/** get_session_stats 窄访问器（session-service 注入：复用 rpc-client getSessionStats）。 */
export type FetchSessionStatsFn = () => Promise<Record<string, unknown> | undefined>

/** get_commands 窄访问器（session-service 注入：复用 rpc-client getCommands）。 */
export type FetchCommandsFn = () => Promise<unknown>

/**
 * usage 配置条目（登记表代码化，W8 验收锁定）。
 *
 * tokens=null（pi compact 后无新 turn）是合法「无值」态：投影为空快照 {}，ownerSnapshotMerge
 * 的 spread 语义保持旧值——与既有 fetchContext「返回 null 不更新」口径等价（退避重拉无意义，
 * 值要等下一次 turn 产生新 assistant usage 才有）。空值语义登记 = 无（验收锁定）。
 *
 * W10：switchModel 即时重算的重算口径归本条目（见 {@link recomputeUsageWithWindow}）——
 * owner（session-service）切模型时读自己的 contextWindow（resolver 按新 modelId 解析）+
 * usage 实例最新快照的 inputTokens，按新窗口重算 usagePercent/contextLimit 即时广播；
 * 防抖到点后快照收敛 pi 权威值（pi getContextUsage 用当前 model 的 contextWindow 算 percent，
 * setModel 后天然按新窗口），即时值与权威值同公式收敛一致。
 */
export function createUsageStateConfig(
  fetchSessionStats: FetchSessionStatsFn,
): ReplicatedStateConfig<UsageSnapshot> {
  return {
    fetchSnapshot: async () => {
      const stats = await fetchSessionStats()
      if (typeof stats !== 'object' || stats === null) {
        throw new WireSnapshotSchemaError(
          `get_session_stats returned ${stats === null ? 'null' : typeof stats} instead of an object stats`,
        )
      }
      const cu = (stats as Record<string, unknown>).contextUsage
      if (typeof cu !== 'object' || cu === null) {
        // pi RpcSessionStats.contextUsage 恒在（rpc-mode getSessionStats），缺失 = 协议异常
        throw new WireSnapshotSchemaError(
          `get_session_stats.contextUsage missing or non-object: ${cu === null ? 'null' : typeof cu}`,
        )
      }
      const record = cu as Record<string, unknown>
      const tokens = record.tokens
      if (typeof tokens !== 'number') return {} // tokens=null = compact 后合法无值态，保持旧值
      const contextWindow = record.contextWindow
      // 投影口径对齐既有 fetchContext：contextWindow=number、percent ?? 0 后取整
      const percent = typeof record.percent === 'number' ? record.percent : 0
      return {
        inputTokens: tokens,
        contextLimit: typeof contextWindow === 'number' ? contextWindow : 0,
        usagePercent: Math.min(Math.round(percent), MAX_USAGE_PERCENT),
      }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: {},
  }
}

/**
 * W10：usage 重算口径 SSOT（switchModel 即时广播 / applyContextUpdate 即时广播共用）。
 *
 * owner 内读「自己的 contextWindow + 最新快照」：inputTokens 唯一来源 = usage 实例快照
 * （或本事件的权威 payload），外部不得再传入独立 inputTokens 数据源（旧 setInputTokens
 * 缓存已删——「缓存写入先于 switchModel 读取」的时序约定随之消解为结构不可能：单一数据
 * 源下没有第二个写入者可与 switchModel 竞争顺序）。
 *
 * 公式与 pi getContextUsage 同构（tokens / contextWindow * 100，四舍五入 + clamp 100），
 * 与 fetchSnapshot 的 percent 投影口径一致——pi 报 percent 时两路数值相等，防抖到点后
 * 快照收敛权威值（结构自愈，不依赖事件与 RPC 响应的到达顺序）。
 */
export function recomputeUsageWithWindow(
  inputTokens: number,
  contextWindow: number,
): { usagePercent: number; contextLimit: number } {
  return {
    usagePercent: contextWindow > 0
      ? Math.min(Math.round((inputTokens / contextWindow) * MAX_USAGE_PERCENT), MAX_USAGE_PERCENT)
      : 0,
    contextLimit: contextWindow,
  }
}

/** queue 深度配置条目（登记表代码化，W8 验收锁定：深度权威 = pi get_state，D6）。 */
export function createQueueDepthStateConfig(fetchState: FetchStateFn): ReplicatedStateConfig<QueueDepthSnapshot> {
  return {
    fetchSnapshot: async () => {
      const fields = projectSessionScalars(await fetchState())
      // 丢 key 后 'required' 归一抛协议异常 → 快照失败退避（pendingMessageCount 缺失 ≠ 字段不动）
      return fields.pendingMessageCount === undefined ? {} : { pendingMessageCount: fields.pendingMessageCount }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: { pendingMessageCount: 'required' },
  }
}

/**
 * commands 配置条目（登记表代码化，W8 验收锁定）。
 *
 * pi get_commands 返回数组；merge 契约要求对象形态，包装为 { commands }。空数组是合法态
 * （扩展全部禁用 / 未注册命令），ownerSnapshotMerge 整字段覆盖（自有属性 spread）——命令集
 * 清空也覆盖旧值，禁止把「空」当「字段不动」。
 */
export function createCommandsStateConfig(fetchCommands: FetchCommandsFn): ReplicatedStateConfig<CommandsSnapshot> {
  return {
    fetchSnapshot: async () => {
      const result = await fetchCommands()
      if (!Array.isArray(result)) {
        throw new WireSnapshotSchemaError(
          `get_commands returned ${result === null ? 'null' : typeof result} instead of an array`,
        )
      }
      return { commands: result as PiCommandInfo[] }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: {},
  }
}
