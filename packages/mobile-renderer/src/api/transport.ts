/**
 * Transport 层 —— 封装 ws-client（R5），提供 send/on 统一管道。
 *
 * 依赖方向：lib/ws-client（transport 是业务层对 ws-client 的唯一适配点）。
 *
 * 注：连接生命周期由 useConnection 统一管理（远程模式 profile.url + auth 握手）。
 * 本模块仅暴露 send（出站 ClientMessage）+ on（入站 ServerMessage 订阅），
 * 不承担连接建立——历史 connect()/waitForConnected() 为 dead code（无调用方；
 * useConnection.init 直接调 ws-client.connect(profile.url)），已删除避免误导维护者。
 */
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import * as wsClient from '@/lib/ws-client'

/**
 * 发送 ClientMessage，返回 boolean 表示是否实际送出（W4 fast-fail 透传）。
 * 未就绪时返回 false，调用方可据此立即 reject pending（而非让 Promise 永挂到超时）。
 */
export function send(msg: ClientMessage): boolean {
  return wsClient.send(msg)
}

/** 订阅 ServerMessage（第 1 层：所有消息），返回取消函数 */
export function on(handler: (msg: ServerMessage) => void): () => void {
  return wsClient.onMessage(handler)
}
