import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentEvent, ConfigResponse, LoadHistoryResult, SessionInfo, TranscriptEntry, UpdateConfigRequest } from '../types'

export type { LoadHistoryResult }

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export async function createSession(): Promise<{ session_id: string; title: string }> {
  return invoke<{ session_id: string; title: string }>('new_session')
}

export async function listSessions(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>('list_sessions')
}

export async function getHistory(sessionId: string): Promise<LoadHistoryResult> {
  return invoke<LoadHistoryResult>('get_history', { sessionId })
}

export async function sendMessage(sessionId: string, content: string): Promise<void> {
  return invoke('send_message', { sessionId, content })
}

export async function deleteSession(sessionId: string): Promise<void> {
  return invoke('delete_session', { sessionId })
}

export async function renameSession(sessionId: string, newTitle: string): Promise<void> {
  return invoke('rename_session', { sessionId, newTitle })
}

export function onAgentEvent(handler: (event: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>('agent-event', (e) => {
    handler(e.payload)
  })
}

export async function getCurrentModel(): Promise<string> {
  return invoke<string>('get_current_model')
}

export async function listTools(): Promise<string[]> {
  return invoke<string[]>('list_tools')
}

export async function getConfig(): Promise<ConfigResponse> {
  return invoke<ConfigResponse>('get_config')
}

export async function updateConfig(payload: UpdateConfigRequest): Promise<void> {
  return invoke<void>('update_config', { payload })
}

export async function killTask(taskId: string): Promise<void> {
  return invoke<void>('kill_task', { taskId })
}

export async function cancelMessage(sessionId: string): Promise<void> {
  return invoke<void>('cancel_message', { sessionId })
}

export async function pauseTask(taskId: string): Promise<void> {
  return invoke<void>('pause_task', { taskId })
}

export async function resumeTask(taskId: string): Promise<void> {
  return invoke<void>('resume_task', { taskId })
}

export async function loadSidechainHistory(
  sessionId: string,
  sidechainId: string,
  sidechainType: string,
): Promise<TranscriptEntry[]> {
  return invoke<TranscriptEntry[]>('load_sidechain_history', { sessionId, sidechainId, sidechainType })
}
