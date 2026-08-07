/**
 * Presence store —— 在线设备列表（P5 lease/presence）。
 *
 * 职责：持有 runtime 推送的 PresenceConnection[] 全量列表（谁在线、活跃 session、是否在操作）。
 *
 * 数据流（全量替换语义，spec D9）：
 *   runtime presence.update 广播 / auth.ok presence 字段（ws-client 合成 presence.update）
 *     → useConnection routeInbound global 通道 → presenceStore.setConnections(list)
 *   sidebar 在线设备列表读 presenceStore.connections 渲染
 *
 * 设计：全量替换（非增量 diff）——单用户自托管规模≤10，全量 payload<2KB，简单可靠。
 * 重连/补发场景：presence.update 是全局消息不入 P2 桶会丢，客户端经 auth.ok presence（首连）
 * 或 presence.list RPC（resume 主动拉）补。
 *
 * 依赖方向：无（stores 间禁止互相 import；订阅由 useConnection 做，写入 store）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PresenceConnection } from '@xyz-agent/shared'

export const usePresenceStore = defineStore('presence', () => {
  /** 在线设备列表（全量替换）。空数组 = 无其他设备在线。 */
  const connections = ref<PresenceConnection[]>([])

  /** 全量替换 connections（presence.update / auth.ok presence 调）。 */
  function setConnections(list: PresenceConnection[]): void {
    connections.value = list
  }

  return { connections, setConnections }
})
