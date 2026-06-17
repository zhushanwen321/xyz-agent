import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionSummary[]>([])
  const currentSessionId = ref<string | null>(null)

  const groupedSessions = computed<SessionGroup[]>(() => {
    const groups = new Map<string, SessionSummary[]>()
    for (const s of sessions.value) {
      const g = groups.get(s.cwd) || []
      g.push(s)
      groups.set(s.cwd, g)
    }
    return Array.from(groups.entries())
      .map(([cwd, sessions]) => ({ cwd, sessions }))
  })

  const currentSession = computed(() =>
    sessions.value.find(s => s.id === currentSessionId.value) || null
  )

  function setSessions(list: SessionSummary[]) { sessions.value = list }
  function addSession(s: SessionSummary) {
    if (sessions.value.some(x => x.id === s.id)) return
    sessions.value = [s, ...sessions.value]
  }
  function removeSession(id: string) { sessions.value = sessions.value.filter(s => s.id !== id) }
  function switchSession(id: string) { currentSessionId.value = id }

  /** Rename a session by id. No-op if session not found. */
  function renameSession(id: string, label: string) {
    const idx = sessions.value.findIndex(s => s.id === id)
    if (idx >= 0) {
      sessions.value[idx] = { ...sessions.value[idx], label }
    }
  }

  const PAD_LENGTH = 2

  /** Generate a unique label like "new-session-01" for a given cwd */
  function generateSessionLabel(cwd: string): string {
    const existing = sessions.value
      .filter(s => s.cwd === cwd)
      .map(s => s.label)
    let n = 1
    while (existing.includes(`new-session-${String(n).padStart(PAD_LENGTH, '0')}`)) {
      n++
    }
    return `new-session-${String(n).padStart(PAD_LENGTH, '0')}`
  }

  return {
    sessions, currentSessionId, groupedSessions, currentSession,
    setSessions, addSession, removeSession, switchSession, renameSession,
    generateSessionLabel,
  }
})
