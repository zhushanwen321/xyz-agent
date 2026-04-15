import { ref } from 'vue'
import { createSession, listSessions, deleteSession as deleteSessionApi, renameSession as renameSessionApi, isTauri } from '../lib/tauri'
import { clearSessionTabs } from './useTabManager'
import type { SessionInfo } from '../types'

const sessions = ref<SessionInfo[]>([])
const currentSessionId = ref<string | null>(null)
const error = ref<string | null>(null)

export function useSession() {
  async function loadSessions() {
    if (!isTauri()) return
    error.value = null
    try {
      sessions.value = await listSessions()
    } catch (err) {
      error.value = String(err)
    }
  }

  function selectSession(id: string) {
    currentSessionId.value = id
  }

  async function createNewSession(): Promise<string | null> {
    if (!isTauri()) return null
    error.value = null
    try {
      const result = await createSession()
      await loadSessions()
      currentSessionId.value = result.session_id
      return result.session_id
    } catch (err) {
      error.value = String(err)
      return null
    }
  }

  async function deleteSession(id: string) {
    if (!isTauri()) return
    error.value = null
    try {
      await deleteSessionApi(id)
      clearSessionTabs(id)
      if (currentSessionId.value === id) {
        currentSessionId.value = null
      }
      await loadSessions()
    } catch (err) {
      error.value = String(err)
    }
  }

  async function renameSession(id: string, newTitle: string) {
    if (!isTauri()) return
    error.value = null
    try {
      await renameSessionApi(id, newTitle)
      await loadSessions()
    } catch (err) {
      error.value = String(err)
    }
  }

  return { sessions, currentSessionId, error, loadSessions, selectSession, createNewSession, deleteSession, renameSession }
}
