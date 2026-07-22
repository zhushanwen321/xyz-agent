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
  forkEntryId?: string
}

/** fork 结果：新文件路径 + 新 session id（+ sourceFilePath 供 FR-20 fallback 判断）。 */
export interface ForkedFile {
  filePath: string
  sessionId: string
  /** 源 session 文件路径（fork 调用方传入的 sourceFilePath，供上层判断 parentSession fallback）。 */
  sourceFilePath: string
}

/**
 * 读源 session JSONL，按 forkEntryId 截断，写新 JSONL 文件。
 *
 * @param sourceFilePath   源 session JSONL 绝对路径
 * @param forkEntryId      fork 点的 pi entryId（截断用，message entry 的 id）
 * @param includeFrom      true: 保留到 forkEntry（含）；false: 保留到 forkEntry 前（不含）
 * @param targetDir        新 JSONL 写入目录（pi sessions 目录）
 * @param forkEntryIdField 可选，写入新 header 的 forkEntryId 字段（供后续 merge 定位 fork 点）。
 *                         与 forkEntryId 区别：后者用于截断回溯，前者是落盘标记（二者常相等，
 *                         但 includeFrom=false 等场景下语义不同；undefined 时不写该字段）。
 * @param fallbackParentId 可选，源 session 未落盘（sessionFilePath=undefined）时的 parentSession
 *                         fallback 键（FR-20）：用此值（源 sessionId）而非 sourceFilePath，
 *                         形成可追溯的父子链。parentSession 始终指向直接父级（源 session），
 *                         不透传源 header 的 parentSession（那是祖父）。
 * @returns 新文件路径 + 新 session id + sourceFilePath（供上层 fallback 判断）
 * @throws 源文件不存在 / forkEntryId 在树中找不到 / 源文件无 session header
 */
export async function createForkedSessionFile(
  sourceFilePath: string,
  forkEntryId: string,
  includeFrom: boolean,
  targetDir: string,
  forkEntryIdField?: string,
  fallbackParentId?: string,
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

  // parentSession 指向直接父级（源 session），不透传源的 parentSession（那是祖父）。
  // 多级 fork（A→B→C）：C 读 B 的文件，B.header.parentSession 是 A 的路径——但 C 的直接父级
  // 是 B，不能透传 A。故 parentSession 始终用源 session 的文件路径（sourceFilePath），
  // 它指向直接父级文件，与 forkEntryId（指向 B 内 entry）坐标系一致。
  // 源 session 可能尚未落盘（pi 延迟写入，上层 sessionFilePath=undefined），此时
  // sourceFilePath 是上层临时拷贝/不可靠路径，改用 fallbackParentId（源 sessionId）作血缘键，
  // 保证父子链可追溯（FR-20）。
  const resolvedParentSession = fallbackParentId ?? sourceFilePath

  // 新 session header（parentSession 指回源文件/源 sessionId，形成父子链）
  const newHeader: SessionHeaderEntry = {
    ...header,
    id: newSessionId,
    timestamp: now.toISOString(),
    parentSession: resolvedParentSession,
    ...(forkEntryIdField !== undefined ? { forkEntryId: forkEntryIdField } : {}),
  }
  // 保留源 header 的额外字段（如 label），但强制覆盖 id/timestamp/parentSession/forkEntryId
  lines.push(JSON.stringify(newHeader))

  // 按原始顺序写入保留的 entry（保持 entry 到达顺序，pi 重建树依赖顺序）
  for (const e of allEntries) {
    if (typeof e.id === 'string' && keepIds.has(e.id)) {
      lines.push(JSON.stringify(e))
    }
  }

  await writeFile(newFilePath, lines.join('\n') + '\n', 'utf-8')

  return { filePath: newFilePath, sessionId: newSessionId, sourceFilePath }
}
