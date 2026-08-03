/**
 * spike 临时占位类型，PoC 验证链路用，非业务正确性。
 *
 * 字段仅含 PoC 断言所需最小子集（DM3）。core 包建立 + 业务类型归位后，
 * 这些占位类型由继任者结构替换为 @xyz-agent/shared 的正式类型。
 */

/** chatStore.messages 元素形状（DM3） */
export interface PlaceholderMessage {
  role: 'user' | 'assistant' | 'toolResult'
  id: string
  content: string
  toolResults?: unknown[]
  status?: string
}

/** sessionStore.sessions 值形状（DM3） */
export interface SessionInfo {
  id: string
  createdAt: number
  status: 'alive' | 'dead'
}

/** presenceStore.peers 值形状（DM3） */
export interface Peer {
  clientId: string
  active: boolean
}
