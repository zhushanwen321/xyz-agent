/**
 * spike 临时占位 store —— sessionStore（全局，DM3）。
 *
 * PoC 验证链路用，非业务逻辑（D6）。core 包建立后由继任者结构替换。
 * IF6 签名：{ sessions: Map<string,SessionInfo>, addSession, markExited }
 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { SessionInfo } from '../types'

export const useSessionStore = defineStore('core-spike/session', () => {
  const sessions = reactive(new Map<string, SessionInfo>())

  function addSession(info: SessionInfo): void {
    sessions.set(info.id, info)
  }

  function markExited(id: string): void {
    const s = sessions.get(id)
    if (s) s.status = 'dead'
  }

  return { sessions, addSession, markExited }
})
