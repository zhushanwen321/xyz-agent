/**
 * transport 桩（api/domains/*.ts 引用 transport.send）。
 * 真实实现在 src-electron/renderer/src/api/transport.ts（WS 发送，未改动）。
 * [leaf] 骨架占位：签名对齐，发送逻辑属既有实现（非 NewTaskFlow 新增）。
 */
import type { ClientMessage } from '@xyz-agent/shared'

export function send(_msg: ClientMessage): void {
  // 骨架占位：真实实现经 ws-client 发往 runtime（既有，本期不改）
}
