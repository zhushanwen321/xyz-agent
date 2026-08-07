/**
 * P5 lease/presence：异步上下文透传 clientId（ALS）。
 *
 * 用途：server.handleMessage 入口用 sessionContext.run({ clientId }, () => ...) 包裹，
 * 把当前请求的 clientId 注入异步上下文。深层 handler（如 P7 plugin RPC handler）
 * 经 sessionContext.getStore()?.clientId 取 clientId，无需显式参数透传到每层。
 *
 * 设计权衡：
 * - handler 层（message-dispatcher 等）用显式 ctx.getClientId()（确定性，ALS 有 getStore 返回
 *   undefined 的风险）；ALS 是补充，供无法拿到 ctx 的深层场景（plugin RPC）复用。
 * - AsyncLocalStorage 是 Node 官方推荐的异步上下文透传方案，Promise.then/setTimeout/async
 *   链路自动透传，无需手动管理生命周期。
 *
 * 禁令遵守：不使用任何 ESM 路径自省 API（AsyncLocalStorage 来自 node:async_hooks 原生模块，与路径无关）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 当前请求的 clientId 上下文 store 形状。
 * - clientId undefined：未在 sessionContext.run 内（如组合根启动期、定时器回调）。
 * - clientId='local'：本地 Electron 模式（P0 D5 单连接）。
 * - clientId=<uuid>：远程认证模式（P0 握手分配）。
 */
export interface SessionContextStore {
  clientId?: string
}

/**
 * 跨异步链路透传 clientId 的 ALS 实例。
 *
 * server.handleMessage 入口：sessionContext.run({ clientId }, () => handleMessage(...))。
 * P7 plugin RPC handler：sessionContext.getStore()?.clientId 取值。
 */
export const sessionContext = new AsyncLocalStorage<SessionContextStore>()
