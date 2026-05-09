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
  function addSession(s: SessionSummary) { sessions.value = [s, ...sessions.value] }
  function removeSession(id: string) { sessions.value = sessions.value.filter(s => s.id !== id) }
  function switchSession(id: string) { currentSessionId.value = id }

  return {
    sessions, currentSessionId, groupedSessions, currentSession,
    setSessions, addSession, removeSession, switchSession,
  }
})
