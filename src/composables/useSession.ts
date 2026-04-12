import { ref } from 'vue'
import { createSession, listSessions, deleteSession as deleteSessionApi, renameSession as renameSessionApi, isTauri } from '../lib/tauri'
import { clearSessionTabs } from './useTabManager'
import type { SessionInfo } from '../types'

const sessions = ref<SessionInfo[]>([])
const currentSessionId = ref<string | null>(null)

export function useSession() {
  async function loadSessions() {
    if (!isTauri()) return
    try {
      sessions.value = await listSessions()
    } catch (err) {
      console.error('[useSession] loadSessions failed:', err)
    }
  }

  function selectSession(id: string) {
    currentSessionId.value = id
  }

  async function createNewSession(): Promise<string | null> {
    if (!isTauri()) return null
    try {
      const result = await createSession()
      console.log('[useSession] session created:', result.session_id)
      await loadSessions()
      currentSessionId.value = result.session_id
      return result.session_id
    } catch (err) {
      console.error('[useSession] createNewSession failed:', err)
      return null
    }
  }

  async function deleteSession(id: string) {
    if (!isTauri()) return
    try {
      await deleteSessionApi(id)
      clearSessionTabs(id)
      if (currentSessionId.value === id) {
        currentSessionId.value = null
      }
      await loadSessions()
    } catch (err) {
      console.error('[useSession] deleteSession failed:', err)
    }
  }

  async function renameSession(id: string, newTitle: string) {
    if (!isTauri()) return
    try {
      await renameSessionApi(id, newTitle)
      await loadSessions()
    } catch (err) {
      console.error('[useSession] renameSession failed:', err)
    }
  }

  return { sessions, currentSessionId, loadSessions, selectSession, createNewSession, deleteSession, renameSession }
}
