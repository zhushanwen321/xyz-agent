/**
 * spike 临时占位 store —— presenceStore（全局，DM3）。
 *
 * PoC 验证链路用，非业务逻辑（D6）。core 包建立后由继任者结构替换。
 * presence 是 §4.2 显式全局例外（协同态，非 per-session）。
 * IF6 签名：{ peers: Map<string,Peer>, upsertPeer }
 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { Peer } from '../types'

export const usePresenceStore = defineStore('core-spike/presence', () => {
  const peers = reactive(new Map<string, Peer>())

  function upsertPeer(id: string, p: Peer): void {
    peers.set(id, p)
  }

  return { peers, upsertPeer }
})
