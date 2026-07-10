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
// 注：ExtensionUIRequestPayload / ExtensionUIResponsePayload / ExtensionErrorPayload /
// ToolCallUpdatePayload 已删除（reserved 占位契约，无生产消费方）。对应消息
// extension.ui_request / extension.ui_response / extension.error / message.tool_call_update
// 的 payload 形状在 protocol.ts 的 ClientMessageMap / ServerMessageMap 内联定义。

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
  /** 是否启用自动升级（仅 user-installed 扩展有效）。前端读写此字段控制 auto-upgrade 开关。 */
  autoUpgrade?: boolean
}

// ── Extension install flow payload interfaces ──────────────────

export interface ExtensionDiscoveredPayload {
  tempDir: string
  candidates: ExtensionInfo[]
}

// 注：ExtensionInstallErrorPayload 已删除（D10/P0-B）——install 失败现在走统一 error envelope，
// hint 进 details.hint。见 protocol.ts「错误契约」文档注释。

// ── Recommended extensions（SSOT: recommended-extensions.json）─────────

/**
 * 推荐扩展条目。数据源 recommended-extensions.json（runtime 读取，前端经 WS 拉取）。
 * 不含 version —— 版本动态从 npm registry 拉，JSON 只存稳定的 name + 描述。
 */
export interface RecommendedExtension {
  name: string
  description: string
}
