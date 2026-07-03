/**
 * Tree 域 ports —— pi JSONL 树解析 + navigate 拦截器。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/session-tree-reader-adapter.ts + navigate-interceptor.ts 实现。
 * TreeService/session-service 经此 port 解析树 + 创建拦截器，不直接 import infra。
 */

/** pi JSONL session 文件的原始 entry（解析自每行 JSON）。 */
export interface TreeRawEntry {
  id: string
  parentId?: string | null
  type: string
  timestamp?: string
  message?: {
    role: string
    content?: string | unknown[]
  }
  targetId?: string
  label?: string
  text?: string
}

/** buildTreeFromFile 的返回结构。 */
export interface BuildTreeResult {
  byId: Map<string, import('../../types.js').TreeNode>
  rootNodes: import('../../types.js').TreeNode[]
  labelsById: Map<string, string>
  /** 最后一条 message entry 的 id，用作当前叶子节点（leaf）的近似定位。 */
  lastEntryId: string | null
  /** 原始 JSONL entry map（用于提取完整文本等场景）。 */
  rawEntries: Map<string, TreeRawEntry>
}

/**
 * pi JSONL 树解析 port —— 从 pi session 文件构建会话树。
 * session-tree-reader（infra/pi/）实现。TreeService 经此 port 解析树。
 */
export interface ITreeReader {
  /** 从 .jsonl session 文件构建树结构（TreeNode + 原始 entry map）。 */
  buildTreeFromFile(filePath: string): Promise<BuildTreeResult>
  /** 统计树的分支数（节点有 >1 子节点）。 */
  countBranches(rootNodes: import('../../types.js').TreeNode[]): number
  /** 从原始 entry 提取完整文本（TreeNode.text 是截断预览）。 */
  extractFullText(entry: TreeRawEntry): string | undefined
}

/**
 * navigate 拦截器接口 —— 装饰 WsSender，拦截 pi navigate 扩展的自定义消息。
 * NavigateInterceptor（infra/pi/）实现。service 经工厂创建，不直接 new 具体类。
 */
export interface INavigateInterceptor {
  /** 设置下一次 navigate 操作的 resolver。 */
  setResolver(fn: (data: unknown) => void): void
  /** 清除 resolver（不 resolve，用于超时）。 */
  clearResolver(): void
  /** pi message turn 结束时调用（若有 pending resolver，resolve 为 cancelled）。 */
  onMessageEnd(): void
  /** 装饰后的 sender —— 传给 EventAdapter 代替原始 WsSender。 */
  send: (msg: import('@xyz-agent/shared').ServerMessage) => void
}

/** navigate 拦截器工厂 port —— service 经此创建拦截器实例。 */
export interface INavigateInterceptorFactory {
  createNavigateInterceptor(downstream: (msg: import('@xyz-agent/shared').ServerMessage) => void): INavigateInterceptor
}
