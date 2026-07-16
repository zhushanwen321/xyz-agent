/**
 * Pending 请求映射 —— 命令 id（crypto.randomUUID）→ Promise。
 *
 * 依赖方向：无下游（被 api/domains 调用）。
 *
 * 注：将 ServerMessage(id) 路由到 pending.resolve 的 dispatcher 由 features 层
 * （useChat/useSidebar）在订阅 transport.on 时串联，本层只提供注册表。
 */

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

/** 按 id reject pending 请求（id 不存在时 no-op） */
export function reject(id: string, error: unknown): void {
  const req = pendingMap.get(id)
  if (!req) return
  pendingMap.delete(id)
  req.reject(error)
}

/** 批量 reject 所有 pending 请求（WS 断连 / runtime 崩溃时调）。 */
export function rejectAll(error: unknown): void {
  for (const [, req] of pendingMap) {
    req.reject(error)
  }
  pendingMap.clear()
}
