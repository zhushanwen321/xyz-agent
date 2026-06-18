/**
 * Runtime 内部类型（非 pi 协议）。
 *
 * 🔒 **归属（R1，三层架构）**：本文件只放 runtime 自身的内部领域类型。
 * pi 外部系统的协议类型（Pi* 前缀）已迁至 `infra/pi/pi-protocol.ts`，
 * services/transport 不得 import 那里。本文件可被任意层 import。
 *
 * 历史变更：原 444 行混放 pi 协议类型 + 内部类型，R1 拆分后只保留内部类型。
 */

// ── Session Tree types（内部模型，面向前端）─────────────────────

/** A node in the session tree, parsed from pi's JSONL session file. */
export interface TreeNode {
  /** Entry ID (uuidv7). */
  id: string
  /** Parent entry ID, or null for root nodes. */
  parentId: string | null
  /** Entry type from JSONL: "message", "label", "model_change", etc. */
  type: string
  /** Message role for message entries: "user", "assistant", "toolResult". */
  role?: string
  /** First line of text content, truncated to max 100 chars. */
  text: string
  /** User-defined label (from label entries targeting this node). */
  label?: string
  /** ISO timestamp from entry. */
  timestamp: string
  /** Child nodes (built from parentId references). */
  children: TreeNode[]
}

/** Full tree data payload sent to the frontend. */
export interface TreeData {
  /** Session ID this tree belongs to. */
  sessionId: string
  /** Root nodes of the tree. */
  tree: TreeNode[]
  /** ID of the current leaf entry (the active branch tip). */
  leafId: string | null
  /** Number of branch points (nodes with >1 children). */
  branchCount: number
  /** Whether tree navigation is available (requires pi session support). */
  navigateCapable: boolean
}

/** Result of a tree navigate operation. */
export interface NavigateResult {
  /** Whether the navigation succeeded. */
  success: boolean
  /** The new leaf ID after navigation. */
  newLeafId?: string
  /** Text to populate the editor (for user-message navigation). */
  editorText?: string
  /** Error message if navigation failed. */
  error?: string
}

/** Result of a tree fork operation. */
export interface ForkResult {
  /** Whether the fork succeeded. */
  success: boolean
  /** ID of the new session created by the fork. */
  newSessionId?: string
  /** Path to the new session file (for dedup in session list). */
  sessionFile?: string
  /** Error message if fork failed. */
  error?: string
}
