import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentEvent, SessionInfo, TranscriptEntry } from '../types'

export async function createSession(cwd: string): Promise<{ session_id: string; path: string }> {
  return invoke('new_session', { cwd })
}

export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  return invoke('list_sessions', { cwd })
}

export async function getHistory(sessionId: string): Promise<TranscriptEntry[]> {
  return invoke('get_history', { sessionId })
}

export async function sendMessage(sessionId: string, content: string): Promise<void> {
  return invoke('send_message', { sessionId, content })
}

export function onAgentEvent(handler: (event: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>('agent-event', (event) => {
    handler(event.payload)
  })
}
