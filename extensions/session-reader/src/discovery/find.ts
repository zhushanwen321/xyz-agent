import { createReadStream, type ReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename } from 'node:path'
import type { SessionRef } from '../core/family.js'
import { listMainSessions, listSubagentSessions, type SessionFileMeta } from './roots.js'
import { listRecordManifests, extractSessionIdFromFilename, type RecordManifest } from './subagents.js'

/**
 * M2 discovery 发现层：按 query 定位 session（design §3.3 D-3 + §3.4 find action）。
 *
 * 匹配三路（D-3）：
 * - uuid 片段子串：sessionId 含 query，或文件路径含 query
 * - "recent" 特殊值：按 mtime 倒序返回最近 N 个（不经片段匹配）
 * - 名称关键词：首消息预览含 query（fallback，仅在 uuid 片段零匹配且 query 非 uuid 特征时
 *   对候选深读首消息——D-5：不为定位付全文解析成本）
 *
 * 首行扫描策略（D-5）：先全量首行扫描拿 header（id/cwd/parentSession），不做全文解析；
 * 首消息预览仅在需要时（recent/uuid 匹配的最终结果 + 关键词 fallback）对候选单独深读。
 *
 * agentDir 注入：同 roots.ts，零 pi 依赖（仅 node:fs + 相对 import M1 core）。
 */

/** 候选来源标记（DM1 必填）：main = agentDir/sessions/、subagent = agentDir/subagents/。 */
export type SessionSource = 'main' | 'subagent'

export interface MatchedSession extends SessionRef {
  /** 候选来源（DM1 必填标记）：main 或 subagent，按文件所在目录标记 */
  source: SessionSource
  /** 首条 user message text 截 80 字符（从全文读，不只首行） */
  firstMessagePreview?: string
}

const DEFAULT_LIMIT = 20
const PREVIEW_MAX = 80
/** readFirstLine 单次读取 buffer 上限。session header（id/cwd/parentSession）远小于此。 */
const HEADER_READ_BYTES = 8192

/**
 * 读文件首行（header）。用定长 buffer 一次 read（避免 stream 开销），
 * 空文件/读失败返回 undefined。header 超 8KB 的极端情况会截断致 parse 失败——
 * session header（id+cwd）实测 < 300 字节，8KB 足够 27 倍余量。
 */
async function readFirstLine(path: string): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0)
    if (bytesRead === 0) return undefined
    const content = buf.subarray(0, bytesRead).toString('utf8')
    const nl = content.indexOf('\n')
    return nl === -1 ? content : content.slice(0, nl)
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 从单行 JSON 提取 message entry 的 user role 文本，非 user message 行返回 undefined。 */
function extractUserText(line: string): string | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  if (obj.type !== 'message') return undefined
  const msg = obj.message
  if (typeof msg !== 'object' || msg === null) return undefined
  const m = msg as Record<string, unknown>
  if (m.role !== 'user') return undefined
  return extractTextFromContent(m.content)
}

/**
 * 从 message content 提取可读文本。
 * 兼容 pi 两种形态：string content（直接用）与 array content（拼 type:text 项的 text）。
 */
function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'object' && item !== null) {
        const it = item as Record<string, unknown>
        if (it.type === 'text' && typeof it.text === 'string') {
          parts.push(it.text)
        }
      }
    }
    return parts.length > 0 ? parts.join(' ') : undefined
  }
  return undefined
}

/**
 * 读文件首条 user message 的文本。逐行扫描直到命中 role:user（不读全文，命中即停 stream）。
 * 用于名称关键词匹配 + firstMessagePreview 填充。
 */
async function readFirstUserMessageText(path: string): Promise<string | undefined> {
  let stream: ReadStream | undefined
  try {
    stream = createReadStream(path, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const text = extractUserText(line)
        if (text !== undefined) return text
      }
    } finally {
      rl.close()
    }
    return undefined // 无 user message（如纯 compaction session）
  } catch {
    return undefined
  } finally {
    stream?.destroy()
  }
}

interface SessionHeader {
  id: string
  cwd?: string
  parentSession?: string
}

/** 解析 header 首行为 SessionHeader。非 session 行/缺 id → null。 */
function parseHeader(line: string | undefined): SessionHeader | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (obj.type !== 'session' || typeof obj.id !== 'string') return null
  const header: SessionHeader = { id: obj.id }
  if (typeof obj.cwd === 'string') header.cwd = obj.cwd
  if (typeof obj.parentSession === 'string') header.parentSession = obj.parentSession
  return header
}

/**
 * query 是否具备 uuid 片段特征（仅十六进制字符与连字符）。
 * 用于 uuid 片段零匹配时决定是否走名称关键词 fallback：纯十六进制 query（如 e6c96、019fe635）
 * 几乎不会出现在自然语言首消息里，深读首消息徒劳，跳过；含非十六进制字符的 query（如 plugin、
 * 重构）才走 fallback。边界词（如 abc，恰好全十六进制）会被判 uuid 特征不走 fallback——
 * 可接受（abc 作为首消息关键词罕见，且 uuid 片段匹配已先尝试）。
 */
function looksLikeUuidFragment(query: string): boolean {
  return /^[0-9a-f-]+$/i.test(query)
}

interface Candidate {
  meta: SessionFileMeta
  ref: SessionRef
  /** 候选来源（透传到 MatchedSession.source，DM1） */
  source: SessionSource
}

interface Matched extends Candidate {
  /** 名称关键词匹配路径已读出的预览；recent/uuid 路径 undefined，后续按需补读 */
  preview?: string
}

// ============================================================
// U5：subagent task/slug/agentName 匹配（manifest 索引 + P-fallback identity 回退）
// ============================================================

/** P-fallback 尾行 identity 读取窗口（同 subagents.ts，task 文本可达数 KB）。 */
const TAIL_READ_BYTES = 65536

/**
 * 读 subagent 文件尾部（最后 64KB）找 subagent-identity entry，返回 task/slug/agent。
 *
 * find 的 P-fallback 路径（场景 A：subagent 无 manifest，本机 11.5%）：manifest 索引未命中时
 * 读尾行 identity 取 task/slug/agent 做 query 子串匹配。与 subagents.ts 的 readTailIdentity
 * 同源（64KB 窗口 + lastIndexOf 定位），但是 find 专用最小版（只取 task/slug/agent，不要
 * rootSessionId——find 候选已有 header.id）。不导出，不碰 subagents.ts（w3 冻结）。
 */
async function readTailIdentityForMatch(
  path: string,
  size: number,
): Promise<{ task?: string; slug?: string; agent?: string } | undefined> {
  if (size === 0) return undefined
  let fh: FileHandle | undefined
  try {
    fh = await open(path, 'r')
    const len = Math.min(TAIL_READ_BYTES, size)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, Math.max(0, size - len))
    const text = buf.toString('utf8')
    const idx = text.lastIndexOf('subagent-identity')
    if (idx < 0) return undefined
    const lineStartSearch = text.lastIndexOf('\n', idx)
    if (lineStartSearch < 0 && size > len) return undefined
    const start = lineStartSearch < 0 ? 0 : lineStartSearch + 1
    let end = text.indexOf('\n', idx)
    if (end < 0) end = text.length
    const line = text.slice(start, end)
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return undefined
    }
    const data = (raw as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined
    if (!data) return undefined
    return {
      task: typeof data.task === 'string' ? data.task : undefined,
      slug: typeof data.slug === 'string' ? data.slug : undefined,
      agent: typeof data.agent === 'string' ? data.agent : undefined,
    }
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * 建 sessionId→RecordManifest 索引（U5：subagent task/slug/agentName 匹配用）。
 *
 * listRecordManifests 一次性读全部 manifest（json 小，几百字节），用 extractSessionIdFromFilename
 * 从 manifest.sessionFile 文件名提取 sessionId 作 key（与候选 header.id 同源真实 id）。无 subagent
 * 候选时跳过（避免无谓 IO——TC-find-manifest-index 的 O(1) 查表前提）。
 */
async function buildManifestIndex(
  agentDir: string,
  hasSubagentCandidates: boolean,
): Promise<Map<string, RecordManifest>> {
  if (!hasSubagentCandidates) return new Map()
  const manifests = await listRecordManifests(agentDir)
  const index = new Map<string, RecordManifest>()
  for (const m of manifests) {
    const sid = extractSessionIdFromFilename(basename(m.sessionFile))
    if (sid) index.set(sid, m)
  }
  return index
}

/**
 * subagent 候选元数据匹配（U5）：manifest 命中走 task/slug/agentName 子串；索引未命中（P-fallback，
 * 场景 A）读尾行 identity 回退匹配 task/slug/agent。
 *
 * manifest 命中但不匹配时不再回退 identity——manifest 是权威主表，task/slug/agentName 即其提供，
 * identity 同源数据回退无新信息（探针 manifest 20/20 全有 task/slug）。manifest 缺某字段（旧 manifest）
 * 时该字段 undefined，includes 自然 false，不影响其他字段。
 */
async function matchSubagentMetadata(
  candidate: Candidate,
  query: string,
  manifestIndex: Map<string, RecordManifest>,
): Promise<boolean> {
  const manifest = manifestIndex.get(candidate.ref.sessionId)
  if (manifest) {
    return (
      (manifest.task?.includes(query) ?? false) ||
      (manifest.slug?.includes(query) ?? false) ||
      (manifest.agentName?.includes(query) ?? false)
    )
  }
  // P-fallback：manifest 索引未命中 → 读尾行 identity 回退
  const ident = await readTailIdentityForMatch(candidate.meta.path, candidate.meta.size)
  if (!ident) return false
  return (
    (ident.task?.includes(query) ?? false) ||
    (ident.slug?.includes(query) ?? false) ||
    (ident.agent?.includes(query) ?? false)
  )
}

/**
 * 按 query 找 session（接口冻结，design §3.4 find action）。
 *
 * 返回按 mtime 倒序，limit 截断（默认 20），truncated 标记是否截断。
 * cwd 过滤：opts.cwd 提供时只留 header.cwd === opts.cwd 的（在匹配前过滤，减少 fallback 深读量）。
 * 匹配为空 → `{ matches: [], truncated: false }`（F1 恢复指引在 M3 tool-adapter 层）。
 */
export async function findSessions(
  query: string,
  agentDir: string,
  opts?: { cwd?: string; limit?: number; source?: SessionSource },
): Promise<{ matches: MatchedSession[]; truncated: boolean }> {
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const cwdFilter = opts?.cwd
  const sourceFilter = opts?.source

  // 0. 按来源收集文件列表（source 过滤在文件列表层：source==='main' 只扫 sessions/、
  //    'subagent' 只扫 subagents/、undefined 两者合并——决策二性能意图：不扫被过滤目录）。
  //    两路目录扫描相互独立 → Promise.allSettled（AGENTS.md：独立请求用 allSettled），
  //    任一目录不存在（roots.ts 静默返回空数组）不影响另一路。
  const sources: SessionSource[] =
    sourceFilter === undefined ? ['main', 'subagent'] : [sourceFilter]
  const listResults = await Promise.allSettled(
    sources.map(async (src) => ({
      src,
      files: await (src === 'main' ? listMainSessions(agentDir) : listSubagentSessions(agentDir)),
    })),
  )

  // 1. 首行扫描建候选 SessionRef（cwd 过滤在此应用；按来源打 source 标记）
  const candidates: Candidate[] = []
  for (const r of listResults) {
    if (r.status !== 'fulfilled') continue
    const { src, files } = r.value
    for (const meta of files) {
      const headerLine = await readFirstLine(meta.path)
      const header = parseHeader(headerLine)
      if (!header) continue // 非 session 文件/坏 header → 跳过
      if (cwdFilter !== undefined && (header.cwd ?? '') !== cwdFilter) continue
      const ref: SessionRef = {
        sessionId: header.id,
        // 完整绝对路径（与 parentSession 同构，便于 family 按 includes(sid) 反查）
        fileName: meta.path,
        mtime: meta.mtime,
        sizeBytes: meta.size,
        cwd: header.cwd ?? '',
      }
      if (header.parentSession) ref.parentSession = header.parentSession
      candidates.push({ meta, ref, source: src })
    }
  }

  // 2. 匹配
  let matched: Matched[]
  if (query === 'recent') {
    // recent：不经片段匹配，全部候选按 mtime 倒序后截 limit
    matched = candidates.map((c) => ({ ...c }))
  } else {
    // 先 uuid 片段匹配（sessionId 或文件路径含 query）——cheap，已有 header
    const uuidHits = candidates.filter(
      (c) => c.ref.sessionId.includes(query) || c.meta.path.includes(query),
    )
    if (uuidHits.length > 0) {
      matched = uuidHits.map((c) => ({ ...c }))
    } else if (looksLikeUuidFragment(query)) {
      // query 像 uuid 片段但无匹配 → uuid 写错的可能性高，不对全部候选深读首消息
      matched = []
    } else {
      // 关键词层（U5 扩展）：subagent manifest 元数据 task/slug/agentName（+ P-fallback identity
      // 回退）与 main/subagent 首消息预览并列匹配，命中任一即入选（TC-find-match-priority）。
      // - subagent 候选：先查 manifest 索引（命中走元数据子串，未命中 P-fallback 读尾行 identity）；
      //   元数据命中即入选（preview 留空，第 5 步补读首消息），未命中仍可走首消息 fallback
      // - main / subagent 元数据未命中：首消息预览 query 子串匹配（m0 现状路径不变）
      const manifestIndex = await buildManifestIndex(
        agentDir,
        candidates.some((c) => c.source === 'subagent'),
      )
      const keywordHits: Matched[] = []
      for (const c of candidates) {
        if (c.source === 'subagent' && (await matchSubagentMetadata(c, query, manifestIndex))) {
          keywordHits.push({ ...c })
          continue
        }
        const text = await readFirstUserMessageText(c.meta.path)
        if (text && text.includes(query)) {
          keywordHits.push({ ...c, preview: text.slice(0, PREVIEW_MAX) })
        }
      }
      matched = keywordHits
    }
  }

  // 3. mtime 倒序
  matched.sort((a, b) => b.ref.mtime - a.ref.mtime)

  // 4. 截断
  const truncated = matched.length > limit
  const sliced = truncated ? matched.slice(0, limit) : matched

  // 5. 填 firstMessagePreview（recent/uuid 路径未读，这里对最终 limit 个补读——最多 limit 个 IO）
  const result: MatchedSession[] = []
  for (const m of sliced) {
    const out: MatchedSession = { ...m.ref, source: m.source }
    if (m.preview !== undefined) {
      out.firstMessagePreview = m.preview
    } else {
      const text = await readFirstUserMessageText(m.meta.path)
      if (text) out.firstMessagePreview = text.slice(0, PREVIEW_MAX)
    }
    result.push(out)
  }

  return { matches: result, truncated }
}
