import { ref } from 'vue'
import { createSession, listSessions, deleteSession as deleteSessionApi, isTauri } from '../lib/tauri'
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

  async function createNewSession() {
    if (!isTauri()) return
    try {
      const result = await createSession()
      console.log('[useSession] session created:', result.session_id)
      await loadSessions()
      currentSessionId.value = result.session_id
    } catch (err) {
      console.error('[useSession] createNewSession failed:', err)
    }
  }

  async function deleteSession(id: string) {
    if (!isTauri()) return
    try {
      await deleteSessionApi(id)
      if (currentSessionId.value === id) {
        currentSessionId.value = null
      }
      await loadSessions()
    } catch (err) {
      console.error('[useSession] deleteSession failed:', err)
    }
  }

  return { sessions, currentSessionId, loadSessions, selectSession, createNewSession, deleteSession }
}
