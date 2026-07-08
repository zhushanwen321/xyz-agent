/**
 * shim.ts — 骨架外部模块类型声明（tsc gate 独立运行用）
 * 骨架在隔离目录运行 tsc，外部模块不可解析。本 shim 声明最小类型让骨架 tsc 通过。
 * 落地时骨架逻辑迁入真实项目，import 解析由项目 tsconfig 接管，此文件不进入项目。
 */

// ── @xyz-agent/shared ──
declare module '@xyz-agent/shared' {
  export type ServerMessageType =
    | 'message.message_start' | 'message.text_delta' | 'message.thinking_start'
    | 'message.thinking_delta' | 'message.thinking_end' | 'message.tool_call_start'
    | 'message.tool_call_end' | 'message.tool_call_update'
    | 'message.complete' | 'message.error' | 'message.stream_error'
    | 'send.rejected' | 'session.commands' | 'session.status' | string

  export interface ServerMessage {
    type: ServerMessageType
    payload: Record<string, unknown>
  }
  export interface Message {
    id: string
    role: 'user' | 'assistant' | 'system'
    status: 'streaming' | 'complete' | 'error'
    content?: string
    toolCalls?: ToolCall[]
    contentBlocks?: unknown[]
  }
  export interface ToolCall {
    id: string
    status: 'running' | 'completed' | 'error' | 'end_not_received'
    output?: string
    endTime?: number
  }
  export type ChangeSetStatus = 'pending' | 'applied' | 'superseded'
  export interface FileChange { path: string; content: string }
  export type SteerFollowUpMode = 'steer' | 'followUp'
}

// ── pinia ──
declare module 'pinia' {
  export function defineStore<T>(name: string, setup: () => T): T
}

// ── vue ──
declare module 'vue' {
  export type Ref<T> = { value: T }
  export function ref<T>(value: T): Ref<T>
  export function computed<T>(getter: () => T): { readonly value: T }
}

// ── @/api (renderer api 层) ──
declare module '@/api' {
  interface ChatApi {
    send: (sid: string, text: string) => Promise<void>
    steer: (sid: string, text: string) => Promise<void>
    abort: (sid: string) => Promise<void>
    streamSubscribe: (sid: string, cb: (msg: { type: string; payload: Record<string, unknown> }) => void) => () => void
  }
  export const chat: ChatApi
}

// ── @/stores/chat ──
declare module '@/stores/chat' {
  interface ChatStore {
    [key: string]: (...args: unknown[]) => unknown
  }
  export const useChatStore: () => ChatStore
}

// ── @/stores/session ──
declare module '@/stores/session' {
  interface SessionStore {
    activeId: string | null
    [key: string]: unknown
  }
  export const useSessionStore: () => SessionStore
}

// ── @/composables/useToast ──
declare module '@/composables/useToast' {
  interface Toast {
    error: (msg: string) => void
    success: (msg: string) => void
  }
  export const useToast: () => Toast
}
