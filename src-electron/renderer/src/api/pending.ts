/**
 * Pending 请求映射 —— 命令 id（crypto.randomUUID）→ Promise。
 *
 * 依赖方向：无下游（被 api/domains 调用）。
 * 骨架阶段：签名完整，体 throw。
 */

/** 注册中的 pending 请求 */
export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** 生成新命令 id（crypto.randomUUID） */
export function create(): string {
  throw new Error('not implemented')
}

/** 注册 pending 请求，返回与之关联的 Promise */
export function register<T>(id: string): Promise<T> {
  throw new Error(`not implemented: register(${id})`)
}

/** 按 id resolve pending 请求 */
export function resolve<T>(id: string, value: T): void {
  throw new Error(`not implemented: resolve(${id}, ${typeof value})`)
}

/** 按 id reject pending 请求 */
export function reject(id: string, error: unknown): void {
  throw new Error(`not implemented: reject(${id}, ${String(error)})`)
}
