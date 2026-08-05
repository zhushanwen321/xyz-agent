/**
 * Pending 请求映射 —— 命令 id（crypto.randomUUID）→ Promise。
 *
 * 依赖方向：无下游（被 api/domains 调用）。
 *
 * 注：将 ServerMessage(id) 路由到 pending.resolve 的 dispatcher 由 features 层
 * （useChat/useSidebar）在订阅 transport.on 时串联，本层只提供注册表。
 * resolveEnvelope 例外：它是 core route-inbound 委托的 pending 分流出口（R2/ES1），
 * 由 useConnection 装配的 TransportPorts.pending.resolveEnvelope 调用。
 */
import type { ServerMessage } from '@xyz-agent/shared'

/** 注册中的 pending 请求 */
export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** per-request 超时（ms）。需 ≥ runtime rpc-client CMD_TIMEOUT_MS（60s）+ 余量，防误超时。 */
const DEFAULT_TIMEOUT_MS = 65_000

const pendingMap = new Map<string, PendingRequest>()

/** 生成新命令 id（crypto.randomUUID） */
export function create(): string {
  return crypto.randomUUID()
}

/**
 * 注册 pending 请求，返回与之关联的 Promise。
 *
 * @param id 命令 id（create() 生成）
 * @param timeoutMs 超时毫秒数，默认 30s。超时后自动 reject（error.code='timeout'）+ 清理。
 *                 传 0 禁用超时（向后兼容极少数长操作场景，如 compact 300s）。
 */
export function register<T>(id: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const entry: PendingRequest = {
      resolve: (value: unknown) => {
        if (timer) clearTimeout(timer)
        resolve(value as T)
      },
      reject: (error: unknown) => {
        if (timer) clearTimeout(timer)
        reject(error)
      },
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (pendingMap.has(id)) {
          pendingMap.delete(id)
          const err = Object.assign(new Error(`request timeout after ${timeoutMs}ms`), { code: 'timeout' })
          reject(err)
        }
      }, timeoutMs)
    }
    pendingMap.set(id, entry)
  })
}

/** 按 id resolve pending 请求（id 不存在时 no-op，防重复/过期响应） */
export function resolve<T>(id: string, value: T): void {
  const req = pendingMap.get(id)
  if (!req) return
  pendingMap.delete(id)
  req.resolve(value)
}

/**
 * 是否存在该 id 的 pending 请求。
 *
 * 用于入站路由区分「RPC reply（id 命中 pending）」与「带 id 的 server-push 广播」——
 * runtime 的 broadcast 消息（config.skills/agents/...）也携带 nextPushId 作为 id，
 * 若仅凭 msg.id 存在就判定为 reply，会把广播误吞进 pending 分流（pendingMap 无此 id → 静默丢弃），
 * 导致靠广播推送的 store（skills/agents 等，无 RPC 兜底）永空。
 */
export function has(id: string): boolean {
  return pendingMap.has(id)
}

/** 按 id reject pending 请求（id 不存在时 no-op） */
export function reject(id: string, error: unknown): void {
  const req = pendingMap.get(id)
  if (!req) return
  pendingMap.delete(id)
  req.reject(error)
}

/**
 * 按 envelope 语义 settle pending 请求（收尾 6：envelope 展开下沉 pending 层）。
 *
 * 接受原始 ServerMessage：id 命中 pending 时——
 * - type==='error'：展开 error envelope（code 提取 + details.detail 展开到 Error）后 reject；
 * - 其他 type：resolve msg.payload 原样。
 * id 缺失或未命中 pending（如带 nextPushId 的广播）→ no-op，绝不吞广播。
 *
 * 逻辑从 core/coordination/route-inbound.ts 的 pending 分流分支搬移（行为零变化），
 * 该分支后续将替换为一行 `ports.pending.resolveEnvelope(msg); return`。
 */
export function resolveEnvelope(msg: ServerMessage): void {
  if (!msg.id || !pendingMap.has(msg.id)) return
  if (msg.type === 'error') {
    // type==='error' 已窄化 payload 为 error envelope（含 code + message + 可选 details）。
    // 透传 code 到 reject 的 Error（D-021：NodeState.reason 需要 error code 区分失败类型，
    // 如 out_of_cwd / permission_denied / timeout）。此前只透传 message 丢了 code。
    // details.detail 展开：string（如 WORKTREE_EXISTS 的 cwd）→ Error.cwd；object（如
    // SETUP_FAILED 的 { exitCode, stderr }）→ Object.assign 展开到 Error 上。
    const payload = msg.payload as {
      code?: string
      message?: string
      details?: Record<string, unknown>
    }
    const message = typeof payload.message === 'string' ? payload.message : 'request failed'
    const code = typeof payload.code === 'string' ? payload.code : 'unknown'
    const enriched: Record<string, unknown> = { code }
    const d = payload.details?.detail
    if (typeof d === 'string') {
      // 字符串 detail（如 WORKTREE_EXISTS 的 cwd）直接作 cwd 字段
      enriched.cwd = d
    } else if (d && typeof d === 'object') {
      // 对象 detail（如 { exitCode, stderr }）展开到 Error 上
      Object.assign(enriched, d)
    }
    reject(msg.id, Object.assign(new Error(message), enriched))
  } else {
    resolve(msg.id, msg.payload)
  }
}

/** 批量 reject 所有 pending 请求（WS 断连 / runtime 崩溃时调）。 */
export function rejectAll(error: unknown): void {
  for (const [, req] of pendingMap) {
    req.reject(error)
  }
  pendingMap.clear()
}
