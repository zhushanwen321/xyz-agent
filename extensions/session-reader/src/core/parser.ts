import { readFile } from 'node:fs/promises'

/**
 * session JSONL 文件解析后的单行 entry（冻结接口，M2-M5 契约）。
 *
 * 字段对齐 pi session JSONL 各 type 的 payload：
 * - type / id / parentId：树结构字段。root（session header）在文件里无 parentId，
 *   归一化为 null（design §3.5 算法 2 的 root 判定依据）。
 * - message：仅 type=message（role/content/toolCalls）。
 * - customType / data：仅 type=custom。
 * - parentSession / cwd：仅 type=session；parentSession 是 fork 文件指向来源的路径指针。
 * - summary：仅 type=compaction。
 *
 * 注：冻结接口未列的 per-type 附加字段（如 model_change.provider、
 * compaction.firstKeptEntryId、session.version）不在此暴露——M2+ 若需消费，
 * 扩展 Entry 接口并同步 design.md §3.4，不在 parser 层私自保留。
 */
export interface Entry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  message?: { role: 'user' | 'assistant' | 'toolResult'; content: unknown; toolCalls?: unknown[] }
  customType?: string
  data?: unknown
  parentSession?: string
  cwd?: string
  summary?: unknown
}

export interface ParseResult {
  entries: Entry[]
  /** JSON 解析失败（含缺必填结构字段）的行数 */
  skippedLines: number
  totalBytes: number
  /** 最后一行疑似半行（活跃 session 写入中），区别于中间坏行 */
  lastLinePartial: boolean
}

function isMessageRole(v: unknown): v is 'user' | 'assistant' | 'toolResult' {
  return v === 'user' || v === 'assistant' || v === 'toolResult'
}

/**
 * 把单个已 JSON.parse 成功的原始对象归一化为 Entry。
 * 缺必填结构字段（type/id）返回 undefined，调用方计为坏行（skippedLines++）。
 */
function toEntry(raw: unknown): Entry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.type !== 'string' || typeof obj.id !== 'string') return undefined

  const entry: Entry = {
    type: obj.type,
    id: obj.id,
    parentId: typeof obj.parentId === 'string' ? obj.parentId : null,
  }
  if (typeof obj.timestamp === 'string') entry.timestamp = obj.timestamp

  // message：role 经值守卫收窄，缺/非法 role 时丢弃 message 字段（接口 role 必填）
  if (obj.message !== null && typeof obj.message === 'object') {
    const m = obj.message as Record<string, unknown>
    if (isMessageRole(m.role)) {
      const message: NonNullable<Entry['message']> = { role: m.role, content: m.content }
      if (Array.isArray(m.toolCalls)) message.toolCalls = m.toolCalls
      entry.message = message
    }
  }

  if (typeof obj.customType === 'string') entry.customType = obj.customType
  if (obj.data !== undefined) entry.data = obj.data
  if (typeof obj.parentSession === 'string') entry.parentSession = obj.parentSession
  if (typeof obj.cwd === 'string') entry.cwd = obj.cwd
  if (obj.summary !== undefined) entry.summary = obj.summary

  return entry
}

/**
 * 解析 session JSONL 文本为 entries。
 *
 * 逐行 JSON.parse，坏行（语法错误或缺必填结构字段）计入 skippedLines 并跳过，
 * 不中断整体解析——pi 坏 session 容错（design §2 失败模式）。
 *
 * 末尾换行产生的空行忽略（不计 skipped、不计 partial）。最后一行 parse 失败时
 * lastLinePartial=true（活跃 session 写到一半的半行），区别于中间坏行。
 */
export function parseSessionContent(content: string): ParseResult {
  const entries: Entry[] = []
  let skippedLines = 0
  let lastLinePartial = false

  const lines = content.split('\n')
  // 移除末尾因 trailing newline 产生的空行（非真实行）
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isLast = i === lines.length - 1

    // 中间空行容错：pi 正常 jsonl 无空行，防御文件损坏；不计 skipped
    if (line.trim() === '') continue

    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      skippedLines++
      if (isLast) lastLinePartial = true
      continue
    }

    const entry = toEntry(raw)
    if (entry === undefined) {
      skippedLines++
      if (isLast) lastLinePartial = true
      continue
    }
    entries.push(entry)
  }

  return {
    entries,
    skippedLines,
    totalBytes: Buffer.byteLength(content, 'utf8'),
    lastLinePartial,
  }
}

/** 读取 session 文件并解析。文件不存在按 Node fs 原生错误抛出（ENOENT）。 */
export async function parseSessionFile(filePath: string): Promise<ParseResult> {
  const content = await readFile(filePath, 'utf8')
  return parseSessionContent(content)
}
