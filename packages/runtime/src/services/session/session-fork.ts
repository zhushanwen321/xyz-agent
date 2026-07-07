/**
 * Session fork 工具（路径 A：runtime 读 JSONL 截断 + 新进程 switch_session）。
 *
 * pi 原生 fork RPC 有语义限制（只支持 user message + position="before"，clone 只能 leaf），
 * 且 fork 在当前进程内 rebind 会破坏源 session 活跃状态。
 * 本工具在 runtime 层实现截断：读源 session JSONL → 按 entryId 树回溯 → 写新 JSONL，
 * 不调 pi fork RPC，不动源 session 的 pi 进程。
 *
 * entry 树结构（pi 0.80.3 JSONL v3）：
 *   - session（header，root，无 parentId）：{ type:"session", version, id, timestamp, cwd }
 *   - message：{ type:"message", id, parentId, timestamp, message:{role, content:[]} }
 *   - custom_message：{ type:"custom_message", id, parentId, timestamp, customType, content, ... }
 *   - model_change / thinking_level_change：{ type, id, parentId, timestamp, ... }
 *   - compaction：{ type:"compaction", id, parentId, timestamp, summary, ... }
 *   - session_info（可选，不参与树）：{ type:"session_info", name }
 *
 * 截断语义：
 *   - includeFrom=true：保留 root → forkEntry 的路径（含 forkEntry 自身）
 *   - includeFrom=false：保留 root → forkEntry 的路径（不含 forkEntry）
 *   兄弟分支（不在路径上的 entry）全部丢弃。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'

/** pi JSONL entry 的最小结构（只关心树拓扑）。 */
interface PiEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  [key: string]: unknown
}

/** session header entry（树的 root）。parentSession 在 fork 出的 session 上指向源文件。 */
interface SessionHeaderEntry extends PiEntry {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

/** fork 结果：新文件路径 + 新 session id。 */
export interface ForkedFile {
  filePath: string
  sessionId: string
}

/**
 * 读源 session JSONL，按 forkEntryId 截断，写新 JSONL 文件。
 *
 * @param sourceFilePath 源 session JSONL 绝对路径
 * @param forkEntryId    fork 点的 pi entryId（message entry 的 id）
 * @param includeFrom    true: 保留到 forkEntry（含）；false: 保留到 forkEntry 前（不含）
 * @param targetDir      新 JSONL 写入目录（pi sessions 目录）
 * @returns 新文件路径 + 新 session id
 * @throws 源文件不存在 / forkEntryId 在树中找不到 / 源文件无 session header
 */
export async function createForkedSessionFile(
  sourceFilePath: string,
  forkEntryId: string,
  includeFrom: boolean,
  targetDir: string,
): Promise<ForkedFile> {
  // 1. 读源文件
  let raw: string
  try {
    raw = await readFile(sourceFilePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) {
      throw new Error(`fork: source session file not found: ${sourceFilePath}`)
    }
    throw e
  }

  const allEntries = parseJsonl(raw) as PiEntry[]

  // 2. 找 session header（root），提取 cwd
  const header = allEntries.find((e): e is SessionHeaderEntry =>
    e.type === 'session' && typeof e.id === 'string' && typeof e.cwd === 'string',
  )
  if (!header) {
    throw new Error(`fork: source session has no valid session header: ${sourceFilePath}`)
  }

  // 3. 建 id → entry 索引（只索引有 id 的 entry）
  const entryById = new Map<string, PiEntry>()
  for (const e of allEntries) {
    if (typeof e.id === 'string') entryById.set(e.id, e)
  }

  // 4. 从 forkEntryId 沿 parentId 回溯到 root，收集路径上的 entryId 集合
  const keepIds = new Set<string>()
  let currentId: string | undefined = forkEntryId
  let visited = 0
  // 安全阀：正常树深度 ≤ allEntries.length，+SAFETY_MARGIN 防循环引用死循环
  const SAFETY_MARGIN = 10
  const maxDepth = allEntries.length + SAFETY_MARGIN
  while (currentId && visited < maxDepth) {
    const entry = entryById.get(currentId)
    if (!entry) break // parentId 指向不存在的 entry（跨文件 parent 或数据损坏）
    if (entry.type === 'session') {
      // 到达 root header，不加入 keepIds（header 会单独重建）
      break
    }
    keepIds.add(currentId)
    currentId = entry.parentId ?? undefined
    visited++
  }

  if (keepIds.size === 0) {
    throw new Error(`fork: forkEntryId "${forkEntryId}" not found in session tree: ${sourceFilePath}`)
  }

  // includeFrom=false：剔除 forkEntry 自身
  if (!includeFrom) {
    keepIds.delete(forkEntryId)
  }

  // 5. 生成新 session id + 文件名（pi 格式：<ISO_timestamp>_<uuid>.jsonl）
  const newSessionId = randomUUID()
  const now = new Date()
  // pi 用 ISO 时间把 : 和 . 替换为 -，如 2026-07-07T03-23-49-092Z
  const isoTs = now.toISOString().replace(/[:.]/g, '-')
  const fileName = `${isoTs}_${newSessionId}.jsonl`
  const newFilePath = join(targetDir, fileName)

  // 6. 构建新文件内容
  const lines: string[] = []

  // 新 session header（parentSession 指回源文件，形成父子链）
  const newHeader: SessionHeaderEntry = {
    ...header,
    id: newSessionId,
    timestamp: now.toISOString(),
    parentSession: sourceFilePath,
  }
  // 保留源 header 的额外字段（如 label），但强制覆盖 id/timestamp/parentSession
  lines.push(JSON.stringify(newHeader))

  // 按原始顺序写入保留的 entry（保持 entry 到达顺序，pi 重建树依赖顺序）
  for (const e of allEntries) {
    if (typeof e.id === 'string' && keepIds.has(e.id)) {
      lines.push(JSON.stringify(e))
    }
  }

  await writeFile(newFilePath, lines.join('\n') + '\n', 'utf-8')

  return { filePath: newFilePath, sessionId: newSessionId }
}
