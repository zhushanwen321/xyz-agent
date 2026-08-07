// ── RPC 线协议类型（Wire Protocol）────────────────────────────────────
//
// 本文件仅包含 RPC 层的线协议类型与错误码，无跨域依赖——是 plugin-types
// 拆分中最独立的一个域。

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

export interface RpcSuccessResponse {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface RpcErrorResponse {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params: Record<string, unknown>
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification

// ── ClientId 透传（P7 长期方案 A）─────────────────────────────────
//
// Worker→主线程 RPC 请求 params 中携带显式 clientId 的键名。
// Worker（PluginRpcClient.request）在 plugin.tool.execute 执行期内自动注入当前
// 执行上下文 clientId 到此键；主线程 handler（session/agent 域）据此 per-client
// resolve active session，绕开 ALS 跨独立 I/O tick 断裂（P7 核心缺陷）。
//
// 双下划线前缀标记为「框架注入键」，plugin 代码不应手动传（会被 Worker 覆盖）。
export const CLIENT_ID_PARAM_KEY = '__clientId'

// ── Error Codes ──────────────────────────────────────────────────

export const PluginRpcErrorCodes = {
  RPC_TIMEOUT: -32000,
  PERMISSION_DENIED: -32001,
  PLUGIN_NOT_FOUND: -32010,
  PLUGIN_NOT_ACTIVE: -32011,
  STORAGE_FULL: -32040,
  PAYLOAD_TOO_LARGE: -32021,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
} as const

export type PluginRpcErrorCode = (typeof PluginRpcErrorCodes)[keyof typeof PluginRpcErrorCodes]
