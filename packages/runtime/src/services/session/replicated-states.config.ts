/**
 * 标量 session 状态的 ReplicatedState 配置条目（data-source-governance W7，P1.1 + P1.2 第一批）。
 *
 * 本文件 = 登记表条目的代码化（docs/architecture/data-source-registry.md）：每条配置 =
 * 快照 RPC + 合并策略（含字段空值语义）。失效触发源不进配置——由调用方（event-interpreter /
 * session-service.switchModel）在自己的事件 / RPC 响应路径上调实例 markDirty()（W6 原语约定）。
 * 实例按 session 注册在 session-service（本文件纯函数，无状态，W8 补 usage / queue / commands 三条）。
 *
 * 三条目（W7 验收锁定）：
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
 * @module replicated-states-config
 */
import {
  ownerSnapshotMerge,
  WireSnapshotSchemaError,
  type ReplicatedStateConfig,
} from './replicated-state.js'

/**
 * 失效防抖窗口（ms）。W7 三标量实例共用。
 * 行为级验收约束「切模型后模型名 1s 内更新」：防抖 + get_state（毫秒级 RPC）须 < 1s。
 * export 供测试 import（SR6 SSOT：测试跟随源码常量，不漂移）。
 */
export const SCALAR_STATE_DEBOUNCE_MS = 300

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
