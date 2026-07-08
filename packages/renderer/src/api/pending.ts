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

const pendingMap = new Map<string, PendingRequest>()

/** 生成新命令 id（crypto.randomUUID） */
export function create(): string {
  return crypto.randomUUID()
}

/** 注册 pending 请求，返回与之关联的 Promise */
export function register<T>(id: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pendingMap.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    })
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
