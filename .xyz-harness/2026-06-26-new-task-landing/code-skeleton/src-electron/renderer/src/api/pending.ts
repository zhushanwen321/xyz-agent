/**
 * pending 桩（api/domains/*.ts 引用 pending.create / pending.register）。
 * 请求-响应配对：create 发 id，register 关联 Promise，routeInbound 按 msg.id resolve。
 * 真实实现在 src-electron/renderer/src/api/pending.ts（未改动）。
 * [leaf] 骨架占位：签名对齐，resolve 逻辑属既有实现（非 NewTaskFlow 新增）。
 */
let counter = 0

export function create(): string {
  counter += 1
  return `pending-${counter}`
}

export function register<T>(_id: string): Promise<T> {
  // 骨架占位：真实实现返回与 id 绑定的 Promise，由 routeInbound resolve
  return new Promise<T>(() => {
    /* never resolves in skeleton */
  })
}
