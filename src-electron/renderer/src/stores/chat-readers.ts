/**
 * chat store 的 payload 读取 + FileChange 合并辅助函数（从 chat.ts 提取，控制主文件行数）。
 *
 * 所有函数是纯函数（payload 是 Record<string, unknown>，安全窄化到具体类型）。
 * event-adapter 生产端的 payload 形状见 runtime/src/infra/pi/event-adapter.ts 各 handler。
 */
import type {
  BashExecution,
  BranchSummary,
  ChangeSetStatus,
  CompactionSummary,
  FileChange,
} from '@xyz-agent/shared'

/** 安全读取 payload 字符串字段（payload 是 Record<string, unknown>） */
export function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}

/** 读 payload 上的对象字段（tool_call_start.input 等），非对象时回退空对象。 */
export function readRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = payload[key]
  return v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {}
}

/** 读 payload 上的数字字段 */
export function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 读 payload 上的布尔字段 */
export function readBool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true
}

/** 读 payload 上的字符串数组字段（queue_update.steering/followUp） */
export function readStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
  const v = payload[key]
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined
}

/**
 * 读 tool_call_update.detail。event-adapter 生产端 detail 可能是 string 或 object
 * （见 handleToolExecutionUpdate：partialResult 对象/字符串分支）。窄化到 ToolCall.detail 类型。
 */
export function readDetail(payload: Record<string, unknown>, key: string): string | Record<string, unknown> | undefined {
  const v = payload[key]
  if (v === null || v === undefined) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return undefined
}

/**
 * 读 message.complete.usage（event-adapter 生产端形状）。
 * payload.usage = { inputTokens, outputTokens, totalTokens }（见 event-adapter handleAgentEnd）。
 * shared.Usage 只需 { inputTokens, outputTokens }；totalTokens 舍弃（无字段承载）。
 */
export function readUsage(payload: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const u = readRecord(payload, 'usage')
  if (Object.keys(u).length === 0) return undefined
  const inputTokens = readNumber(u, 'inputTokens')
  const outputTokens = readNumber(u, 'outputTokens')
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

/** 读 message.bashExecution payload（event-adapter handleMessageStart bashExecution 分支） */
export function readBashExecution(payload: Record<string, unknown>): BashExecution {
  const exec: BashExecution = {}
  const command = readString(payload, 'command')
  if (command) exec.command = command
  const output = readString(payload, 'output')
  if (output) exec.output = output
  const exitCode = readNumber(payload, 'exitCode')
  if (exitCode !== undefined) exec.exitCode = exitCode
  if (readBool(payload, 'cancelled')) exec.cancelled = true
  if (readBool(payload, 'truncated')) exec.truncated = true
  const fullOutputPath = readString(payload, 'fullOutputPath')
  if (fullOutputPath) exec.fullOutputPath = fullOutputPath
  const timestamp = readNumber(payload, 'timestamp')
  if (timestamp !== undefined) exec.timestamp = timestamp
  if (readBool(payload, 'excludeFromContext')) exec.excludeFromContext = true
  return exec
}

/** 读 message.compactionSummary payload */
export function readCompactionSummary(payload: Record<string, unknown>): CompactionSummary {
  const summary: CompactionSummary = {}
  const s = readString(payload, 'summary')
  if (s) summary.summary = s
  const tokensBefore = readNumber(payload, 'tokensBefore')
  if (tokensBefore !== undefined) summary.tokensBefore = tokensBefore
  const timestamp = readNumber(payload, 'timestamp')
  if (timestamp !== undefined) summary.timestamp = timestamp
  return summary
}

/** 读 message.branchSummary payload */
export function readBranchSummary(payload: Record<string, unknown>): BranchSummary {
  const summary: BranchSummary = {}
  const s = readString(payload, 'summary')
  if (s) summary.summary = s
  const fromId = readString(payload, 'fromId')
  if (fromId) summary.fromId = fromId
  const timestamp = readNumber(payload, 'timestamp')
  if (timestamp !== undefined) summary.timestamp = timestamp
  return summary
}

/** 读 message.file_changes.fileChanges（FileChange[]，W10） */
export function readFileChanges(payload: Record<string, unknown>): FileChange[] {
  const v = payload.fileChanges
  if (!Array.isArray(v)) return []
  return v.filter(
    (c): c is FileChange =>
      c !== null && typeof c === 'object' && typeof (c as FileChange).filePath === 'string',
  )
}

/** 读 message.file_changes.changeSetStatus（ChangeSetStatus，W10） */
export function readChangeSetStatus(payload: Record<string, unknown>): ChangeSetStatus {
  const v = payload.changeSetStatus
  const valid: ChangeSetStatus[] = ['accumulating', 'ready', 'partially-reviewed', 'resolved', 'superseded']
  return typeof v === 'string' && valid.includes(v as ChangeSetStatus) ? v as ChangeSetStatus : 'accumulating'
}

/**
 * 合并 FileChange[]（accumulating 增量合并）。同 filePath 取最新项（后者覆盖前者），
 * 保留 addLines/delLines（若新项未带则沿用旧项）。ready 帧传 [] 作 baseline 即全集替换。
 */
export function mergeFileChanges(incoming: FileChange[], baseline: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const c of baseline) byPath.set(c.filePath, c)
  for (const c of incoming) {
    const prev = byPath.get(c.filePath)
    byPath.set(c.filePath, {
      filePath: c.filePath,
      status: c.status,
      ...(c.addLines !== undefined ? { addLines: c.addLines } : prev?.addLines !== undefined ? { addLines: prev.addLines } : {}),
      ...(c.delLines !== undefined ? { delLines: c.delLines } : prev?.delLines !== undefined ? { delLines: prev.delLines } : {}),
    })
  }
  return Array.from(byPath.values())
}
