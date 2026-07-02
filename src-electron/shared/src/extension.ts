// ── Extension 领域 DTO（runtime ↔ renderer 之间流转的扩展相关 payload）──
// 迁移自 protocol.ts 第 3 块：ExtensionInfo / UI 交互 / 安装流 / 状态推送。
// protocol.ts 仅保留 type→payload 映射（SSOT），领域形状归此处便于读者一查到底。

export interface ExtensionWidgetPayload {
  sessionId: string
  widgetKey: string
  lines: string[]
}

export interface ExtensionStatusPayload {
  sessionId: string
  statusKey: string
  text: string
}

export const EXTENSION_EVENTS = {
  WIDGET: 'extension:widget',
  STATUS: 'extension:status',
} as const

// ── Extension UI 交互 / 安装流 payload ────────────────────────────

/** Interactive extension UI methods that produce extension.ui_request WS events */
export type ExtensionUIMethod = 'confirm' | 'select' | 'input' | 'notify' | 'editor'

export interface ExtensionUIRequestPayload {
  sessionId: string
  requestId: string
  method: ExtensionUIMethod
  title?: string
  message?: string
  options?: string[]
  default?: string
  level?: 'info' | 'warn' | 'error'
  /** Origin of the request — determines which WS channel the response is sent to */
  source?: 'extension' | 'plugin'
}

export interface ExtensionUIResponsePayload {
  sessionId: string
  requestId: string
  result: boolean | string | null
}

export interface ExtensionErrorPayload {
  sessionId: string
  extensionName: string
  error: string
  errorEvent?: string
}

export interface ToolCallUpdatePayload {
  sessionId: string
  toolCallId: string
  progress?: number
  detail?: string | Record<string, unknown>
}

export interface ExtensionInfo {
  name: string
  /** Filesystem directory basename (may differ from npm package name for scoped packages) */
  dirName: string
  version: string
  description: string
  path: string
  enabled: boolean
  source: 'built-in' | 'user-installed'
  /** Extension 暴露的工具名列表（MCP tools / pi extension tools）。可选：runtime 扫描到时填，
   *  前端 ExtensionPage 据此渲染工具清单。可选而非必填——避免强制 runtime 生产侧同步改造。 */
  tools?: string[]
}

// ── Extension install flow payload interfaces ──────────────────

export interface ExtensionDiscoveredPayload {
  tempDir: string
  candidates: ExtensionInfo[]
}

// 注：ExtensionInstallErrorPayload 已删除（D10/P0-B）——install 失败现在走统一 error envelope，
// hint 进 details.hint。见 protocol.ts「错误契约」文档注释。
