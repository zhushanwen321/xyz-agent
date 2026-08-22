/**
 * session-manager extension 的类型定义。
 *
 * 6 个 action 的请求 params 和结果类型，供 handler 和 extension 共用。
 * marker 检测后按 action 分发到对应 handler 分支。
 */
import type { SESSION_MANAGER_ACTIONS } from './marker.js'

/** session-manager 支持的 6 个 action（从 SESSION_MANAGER_ACTIONS 集合派生，值与类型同源） */
export type SessionManagerAction = (typeof SESSION_MANAGER_ACTIONS)[number]

/** session-manager 请求的统一形状（extension → runtime via select 通道） */
export interface SessionManagerRequest {
  action: SessionManagerAction
  params: SessionManagerParams[SessionManagerAction]
}

/** 各 action 的请求参数映射 */
export interface SessionManagerParams {
  create: SessionManagerCreateParams
  send: SessionManagerSendParams
  history: SessionManagerHistoryParams
  status: SessionManagerStatusParams
  list: SessionManagerListParams
  abort: SessionManagerAbortParams
}

/** create action 参数 */
export interface SessionManagerCreateParams {
  /** session 工作目录 */
  cwd?: string
  /** session 标签 */
  label?: string
  /** 初始 prompt（可选；提供时 create 后立即注入——设计文档 §5.2 原子性决策） */
  prompt?: string
  /** 模型覆盖（可选，透传 SessionService.create 的 modelOverride） */
  model?: string
  /** thinking 级别覆盖（可选，透传 thinkingOverride） */
  thinkingLevel?: string
}

/** send action 参数 */
export interface SessionManagerSendParams {
  sessionId: string
  prompt: string
}

/** history action 参数 */
export interface SessionManagerHistoryParams {
  sessionId: string
  /** 截断尾部 turn 数（0 = 不截断） */
  tailTurns?: number
}

/** status action 参数 */
export interface SessionManagerStatusParams {
  sessionId: string
}

/** list action 参数 */
export interface SessionManagerListParams {
  /** 按 spawnSource 过滤 */
  spawnSource?: 'user' | 'agent'
  /** 按 parentAgentSessionId 过滤 */
  parentAgentSessionId?: string
}

/** abort action 参数 */
export interface SessionManagerAbortParams {
  sessionId: string
}

/** create 结果 */
export interface SessionManagerCreateResult {
  sessionId: string
  status: 'created'
  modelId?: string
}

/** send 结果 */
export interface SessionManagerSendResult {
  blocked: boolean
  rejected?: boolean
}

/** history 结果 */
export interface SessionManagerHistoryResult {
  messages: unknown[]
  truncated: boolean
}

/** status 结果 */
export interface SessionManagerStatusResult {
  status: string
  modelId?: string
}

/** list 结果 */
export interface SessionManagerListResult {
  sessions: SessionManagerSessionSummary[]
}

/** list 返回的 session 摘要（精简版） */
export interface SessionManagerSessionSummary {
  id: string
  label: string
  cwd: string
  status: string
  spawnSource?: 'user' | 'agent'
  parentAgentSessionId?: string
}

/** abort 结果 */
export interface SessionManagerAbortResult {
  success: boolean
}

/** 错误响应形状 */
export interface SessionManagerErrorResult {
  error: string
  /** create 已成功时附 sessionId + hint */
  sessionId?: string
  hint?: string
}
