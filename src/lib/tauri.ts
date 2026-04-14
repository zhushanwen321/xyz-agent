import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentEvent, ConfigResponse, CustomAgentInput, LoadHistoryResult, PromptInfo, PromptSaveInput, SessionInfo, ToolConfigSaveInput, ToolInfo, TranscriptEntry, UpdateConfigRequest } from '../types'

export type { LoadHistoryResult }

export function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__
}

export async function createSession(): Promise<{ session_id: string; title: string }> {
  console.log('[tauri] createSession')
  const result = await invoke('new_session')
  console.log('[tauri] createSession result:', result)
  return result as any
}

export async function listSessions(): Promise<SessionInfo[]> {
  console.log('[tauri] listSessions')
  const result = await invoke('list_sessions')
  console.log('[tauri] listSessions result:', result)
  return result as any
}

export async function getHistory(sessionId: string): Promise<LoadHistoryResult> {
  return invoke<LoadHistoryResult>('get_history', { sessionId })
}

export async function sendMessage(sessionId: string, content: string): Promise<void> {
  console.log('[tauri] sendMessage, session=', sessionId, 'content=', content.slice(0, 50))
  return invoke('send_message', { sessionId, content })
}

export async function deleteSession(sessionId: string): Promise<void> {
  console.log('[tauri] deleteSession:', sessionId)
  return invoke('delete_session', { sessionId })
}

export async function renameSession(sessionId: string, newTitle: string): Promise<void> {
  return invoke('rename_session', { sessionId, newTitle })
}

export function onAgentEvent(handler: (event: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>('agent-event', (e) => {
    console.log('[tauri] agent-event:', e.payload.type, e.payload.session_id)
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

// ── Prompt 管理 API ──────────────────────────────────────

export async function promptList(): Promise<PromptInfo[]> {
  return invoke<PromptInfo[]>('prompt_list')
}

export async function promptGet(key: string): Promise<string> {
  return invoke<string>('prompt_get', { key })
}

export async function promptPreview(key: string): Promise<string> {
  return invoke<string>('prompt_preview', { key })
}

export async function promptSave(payload: PromptSaveInput): Promise<void> {
  return invoke<void>('prompt_save', { payload })
}

export async function promptDelete(key: string): Promise<void> {
  return invoke<void>('prompt_delete', { key })
}

export async function customAgentSave(payload: CustomAgentInput): Promise<void> {
  return invoke<void>('custom_agent_save', { payload })
}

export async function customAgentDelete(name: string): Promise<void> {
  return invoke<void>('custom_agent_delete', { name })
}

// ── Tool 配置管理 API ──────────────────────────────────────

export async function toolConfigList(): Promise<ToolInfo[]> {
  return invoke<ToolInfo[]>('tool_config_list')
}

export async function toolConfigSave(payload: ToolConfigSaveInput): Promise<void> {
  return invoke<void>('tool_config_save', { payload })
}

export async function toolConfigDelete(name: string): Promise<void> {
  return invoke<void>('tool_config_delete', { name })
}
