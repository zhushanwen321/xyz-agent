import { ref } from 'vue'
import { createSession, listSessions } from '../lib/tauri'
import type { SessionInfo } from '../types'

const sessions = ref<SessionInfo[]>([])
const currentSessionId = ref<string | null>(null)

export function useSession() {
  async function loadSessions() {
    sessions.value = await listSessions('/')
  }

  async function selectSession(id: string) {
    currentSessionId.value = id
  }

  async function createNewSession() {
    const result = await createSession('/')
    await loadSessions()
    currentSessionId.value = result.session_id
  }

  return { sessions, currentSessionId, loadSessions, selectSession, createNewSession }
}
