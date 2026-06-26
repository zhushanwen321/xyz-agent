/**
 * message 类型桩（protocol.ts ServerMessageMapBase 引用 FileChange / ChangeSetStatus）。
 * 完整定义在 src-electron/shared/src/message.ts（未改动，本期不涉及）。
 */

export type ChangeSetStatus = 'accumulating' | 'ready' | 'partially-reviewed' | 'resolved' | 'superseded'

export interface FileChange {
  path: string
  status: string
}
