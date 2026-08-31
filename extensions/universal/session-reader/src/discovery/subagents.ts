import { readFile, readdir, open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { Entry } from '../core/parser.js'
import type { Family, SessionRef, SubagentRef } from '../core/family.js'
import { buildFamilyIndex, resolveFamily } from '../core/family.js'
import { listMainSessions, listSubagentSessions } from './roots.js'
import { resolveWorkflows } from './workflows.js'

/**
 * [M2 discovery] 从文件系统构建某 session 的完整家族（IO 适配层）。
 *
 * 组合 M1 family 纯逻辑（buildFamilyIndex/resolveFamily）+ 真实文件读取。零 pi 依赖
 *（node:fs + 相对 import M1 core + M2 roots），同 roots/find，可完全单测。
 *
 * 关键衔接点（探查确认，详见各步骤注释）：
 * - identity 在 subagent 文件 **尾行**（非首行；design §3.3 D-7 "尾部"，实测 019fe635
 *   的 identity 在 71/71 行）。故 header 读首行、identity 读尾行，两次定长读。
 * - identity id 修正：M1 用 identity entry.id（=data.id 的 sa-xxx 占位）作 SubagentRef.sessionId。
 *   M2 用 subagent 文件首行 header.id（真实 session id）替换之，使 SubagentRef.sessionId
 *   是真实 id，Q1 隔代关联仍用 data.rootSessionId（不变）。
 * - cleanedUp：subagent 文件被 30 天 TTL GC 后，identity（在文件尾）一并消失。唯一残留痕迹
 *   是 records/<sa-id>.json manifest（subagent 创建时写入，持久存在）。故 manifest 是孤儿/
 *   cleanedUp 的来源（design §3.3 D-7 "records/*.json manifest 作孤儿补充"）。
 * - workflows：M1 resolveFamily 恒返回 []。M2 在此单独读目标 session 的 workflow-state-link
 *   custom entry → link.data.path（wf-state 文件绝对路径）→ 读该文件最后一行（最新快照）取 calls。
 *
 * @throws sessionId 不在任意 main session header → Error（M3 tool-adapter 层转 F1 恢复指引）
 */
export async function buildFamilyFromFs(sessionId: string, agentDir: string): Promise<Family> {
  // ---- 0. record manifest 索引（U4：sessionFile → manifest，供 alive 扫描查富字段）----
  // manifest 主路径：alive 文件的 meta.path 命中索引 → 透 task/slug/model/status/sessionFile 全字段。
  // 索引未命中（场景 A：嵌套 subagent 的 manifest 不在当前 agentDir，11.5%）走 P-fallback 回退 identity。
  const manifests = await listRecordManifests(agentDir)
  const manifestBySessionFile = new Map<string, RecordManifest>()
  for (const m of manifests) manifestBySessionFile.set(m.sessionFile, m)

  // ---- 1. main sessions：首行 header → byId/childrenOf 素材 + fileStats + 路径反查 ----
  const mainMetas = await listMainSessions(agentDir)
  const headers: Entry[] = []
  const fileStats = new Map<string, { mtime: number; size: number }>()
  /** sessionId → 真实文件路径，供 workflows 找目标文件 + enrich 补 fileName */
  const sessionIdToPath = new Map<string, string>()
  /** path → 完整 SessionRef（含真实 cwd/fileName/mtime/size），供 enrich + workflow calls 反查 */
  const pathToRef = new Map<string, SessionRef>()

  for (const meta of mainMetas) {
    const h = parseHeaderLine(await readFirstLine(meta.path))
    if (!h) continue // 非 session/坏 header → 跳过（不入 byId）
    const entry: Entry = { type: 'session', id: h.id, parentId: null, cwd: h.cwd ?? '' }
    if (h.parentSession) entry.parentSession = h.parentSession
    headers.push(entry)
    fileStats.set(h.id, { mtime: meta.mtime, size: meta.size })
    sessionIdToPath.set(h.id, meta.path)
    const ref: SessionRef = {
      sessionId: h.id,
      fileName: meta.path,
      mtime: meta.mtime,
      sizeBytes: meta.size,
      cwd: h.cwd ?? '',
    }
    if (h.parentSession) ref.parentSession = h.parentSession
    pathToRef.set(meta.path, ref)
  }

  // ---- 2. subagent sessions：首行 header（真实 id）+ manifest 主/identity 回退 → 富字段 identity ----
  // U4 数据流：manifest 命中透全字段；未命中 P-fallback 读尾行 identity 取 task/slug/agent
  //（model/status 不可回退，留 undefined）；无 manifest 无 identity（运行中/异常）跳过。
  const subMetas = await listSubagentSessions(agentDir)
  const identities: Entry[] = []
  /** 已扫描到的 subagent 文件路径集合，供 manifest 孤儿判定（alive 则跳过 manifest） */
  const aliveSubPaths = new Set<string>()

  for (const meta of subMetas) {
    const h = parseHeaderLine(await readFirstLine(meta.path))
    if (!h) continue // 非 session/坏 header → 无真实 session id，无法 id 修正，跳过
    const realId = h.id
    // header 可解析即视为 alive（MF-3）：identity 在文件尾行、完成时才写入，运行中的 subagent
    // 无 identity。若此处跳过，步骤 3 会把活文件（含其 manifest）当孤儿收编 → cleanedUp=true，
    // family 把活着的 subagent 显示成 [已清理]，真实 sessionId 永远无法关联。
    aliveSubPaths.add(meta.path)

    // identity data 组装：manifest 主路径或 P-fallback identity 回退，二选一
    const manifest = manifestBySessionFile.get(meta.path)
    let data: Record<string, unknown>
    if (manifest) {
      // manifest 主（TC-u4-manifest-enrich）：透 task/slug/model/status/sessionFile 全字段
      data = {
        rootSessionId: manifest.rootSessionId,
        slug: manifest.slug ?? '', // slug 兼容旧 manifest（缺→空串兑底，m0 契约）
        task: manifest.task,
        agent: manifest.agentName, // 同语义异名：manifest.agentName ↔ identity.data.agent
        model: manifest.model,
        status: manifest.status,
        sessionFile: manifest.sessionFile,
      }
    } else {
      // P-fallback（ES-p-fallback-no-manifest）：读尾行 identity 回退取 task/slug/agent
      const ident = await readTailIdentity(meta.path, meta.size)
      if (!ident) continue // 无 identity（ES-p-fallback-no-identity，运行中/异常）→ 跳过
      data = {
        rootSessionId: ident.rootSessionId,
        slug: ident.slug,
        task: ident.task,
        agent: ident.agent,
        // model/status 不可回退（identity 无，探针 15/15），留 undefined
        sessionFile: meta.path,
      }
    }
    // id 修正：entry.id 用真实 header.id 替换 sa-xxx 占位
    identities.push({
      type: 'custom',
      id: realId,
      parentId: null,
      customType: 'subagent-identity',
      data,
    })
    fileStats.set(realId, { mtime: meta.mtime, size: meta.size })
    sessionIdToPath.set(realId, meta.path)
    pathToRef.set(meta.path, {
      sessionId: realId,
      fileName: meta.path,
      mtime: meta.mtime,
      sizeBytes: meta.size,
      cwd: h.cwd ?? '',
    })
  }

  // ---- 3. records manifest → 孤儿（cleanedUp，ES-orphan-manifest）----
  // manifest 在 subagent 创建时写入，.jsonl 被 GC 后仍残留。alive 的（sessionFile 已在步骤 2
  // 扫到）跳过；未扫到的 = 文件已 GC → 孤儿。用 manifest 完整富字段填 SubagentRef，
  // sessionFile 保留 manifest 的 GC 路径（不置空，供 LLM 知晓原位置），cleanedUp 由
  // buildFamilyIndex 的 !fileStats.has(ident.id) 判 true（ident.id=manifest.id 不在 fileStats）。
  for (const m of manifests) {
    if (aliveSubPaths.has(m.sessionFile)) continue
    identities.push({
      type: 'custom',
      id: m.id,
      parentId: null,
      customType: 'subagent-identity',
      data: {
        rootSessionId: m.rootSessionId,
        // 孤儿 slug 随文件 GC 丢失：优先 manifest.slug，回退 agentName（agent 类型名），再兜底空串
        slug: m.slug ?? m.agentName ?? '',
        task: m.task,
        agent: m.agentName, // 同语义异名映射
        model: m.model,
        status: m.status,
        sessionFile: m.sessionFile,
      },
    })
  }

  // ---- 4-5. build index + resolve（sessionId 不在 byId → resolveFamily 抛 Error）----
  if (!sessionIdToPath.has(sessionId)) {
    throw new Error(
      `session "${sessionId}" not found under ${agentDir}/sessions — ` +
        `no main session file whose first-line header id matches. ` +
        `Verify the sessionId or agentDir; for partial uuid, use findSessions first.`,
    )
  }
  const index = buildFamilyIndex(headers, identities, fileStats)
  const family = resolveFamily(sessionId, index)

  // ---- 6. 补 M1 占位字段（fileName / subagent cwd）+ workflows ----
  enrichRefs(family, pathToRef)
  family.workflows = await resolveWorkflows(sessionId, sessionIdToPath, pathToRef)

  return family
}

// ============================================================
// 文件读取 helpers（定长 buffer，避免全文读：subagent 文件均 269KB、总量 ~923MB）
// ============================================================

/** 首行读取 buffer 上限。session header（id/cwd/parentSession）实测 < 300 字节，8KB 足够。 */
const HEADER_READ_BYTES = 8192
/** 尾行 identity 读取 buffer 上限。identity 含完整 task 文本可达数 KB；实测 64KB 覆盖 3203/3430。 */
const TAIL_READ_BYTES = 65536

/** 读文件首行（header）。定长 8KB 一次 read；空文件/读失败返回 undefined。 */
async function readFirstLine(path: string): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0)
    if (bytesRead === 0) return undefined
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    return nl === -1 ? text : text.slice(0, nl)
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

interface SessionHeader {
  id: string
  cwd?: string
  parentSession?: string
}

/** 解析 header 首行为 SessionHeader。非 session 行/缺 id → null。 */
function parseHeaderLine(line: string | undefined): SessionHeader | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.type !== 'session' || typeof o.id !== 'string') return null
  const h: SessionHeader = { id: o.id }
  if (typeof o.cwd === 'string') h.cwd = o.cwd
  if (typeof o.parentSession === 'string') h.parentSession = o.parentSession
  return h
}

/**
 * 读 subagent 文件尾部（最后 64KB）找 subagent-identity entry，返回 rootSessionId + slug + task + agent。
 *
 * identity 在文件尾行（探查确认；design §3.3 D-7 "尾部"）。用 lastIndexOf 定位最后一个
 * subagent-identity 标记（多次重写时取最新），提取该行边界内的 JSON 解析。identity 行
 * 超 64KB（极罕见，实测 1/3430）会截断 → 解析失败 → 返回 undefined（该 subagent 不收）。
 *
 * U4 扩展返回 task/agent（P-fallback 富化用）：从 identity.data.task / data.agent 提取，
 * 存在则带。model/status 在 identity 不存在（探针 15/15 无），P-fallback 时由调用方留 undefined。
 *
 * M3b 扩展（IF3 三级数据源 ②）：返回 parentRecordId（identity.data.parentRecordId，新版本
 * session-runner 才写；当前本机旧数据无此字段→undefined）。size 改 optional——buildFamilyFromFs
 * 传 size（已有 meta.size 省一次 stat），buildExecutionTree 不传 size（内部 stat 获取）。
 */
export async function readTailIdentity(
  path: string,
  size?: number,
): Promise<
  | { rootSessionId: string; slug: string; task?: string; agent?: string; parentRecordId?: string }
  | undefined
> {
  // size 未传时内部 stat 获取（execution-tree.ts 复用时无 size）
  let resolvedSize = size
  if (resolvedSize === undefined) {
    try {
      resolvedSize = (await stat(path)).size
    } catch {
      return undefined // 文件不存在/读失败 → undefined
    }
  }
  if (resolvedSize === 0) return undefined
  let fh: FileHandle | undefined
  try {
    fh = await open(path, 'r')
    const len = Math.min(TAIL_READ_BYTES, resolvedSize)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, Math.max(0, resolvedSize - len))
    const text = buf.toString('utf8')
    const idx = text.lastIndexOf('subagent-identity')
    if (idx < 0) return undefined
    // 行首若在读窗口外（identity 行 > 64KB，整行塞不下）→ 无法可靠解析，跳过
    const lineStartSearch = text.lastIndexOf('\n', idx)
    if (lineStartSearch < 0 && resolvedSize > len) return undefined
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
    if (!data || typeof data.rootSessionId !== 'string') return undefined
    return {
      rootSessionId: data.rootSessionId,
      slug: typeof data.slug === 'string' ? data.slug : '',
      task: typeof data.task === 'string' ? data.task : undefined,
      agent: typeof data.agent === 'string' ? data.agent : undefined,
      parentRecordId:
        typeof data.parentRecordId === 'string' ? data.parentRecordId : undefined,
    }
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

// ============================================================
// records manifest（孤儿 / cleanedUp 来源）
// ============================================================

export interface RecordManifest {
  id: string
  rootSessionId: string
  agentName?: string
  /** subagent session.jsonl 绝对路径（创建时写入；文件 GC 后路径仍残留） */
  sessionFile: string
  /** subagent 任务文本（探针 20/20 全有；旧 manifest 缺→undefined） */
  task?: string
  /** slug 标签（探针 20/20 全有；旧 manifest 缺→undefined） */
  slug?: string
  /** 模型 id（探针 20/20 全有；旧 manifest 缺→undefined） */
  model?: string
  /** 终态 completed/failed/running（探针 20/20 全有；旧 manifest 缺→undefined） */
  status?: string
  /**
   * 直接父 subagent 的 record id（M3a 落盘镜像；depth=0 顶层 subagent 为 undefined）。
   *
   * session-reader 读侧镜像（IF2）：manifest 主路径透出，旧 manifest 缺此字段（undefined）。
   * isRecordManifest 校验不改（3 必填不变）。buildExecutionTree（core/execution-tree.ts）
   * 据此建精确父子链，三级数据源优先级 ①（DM4）。
   */
  parentRecordId?: string
}

function isRecordManifest(v: unknown): v is RecordManifest {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.rootSessionId === 'string' &&
    typeof o.sessionFile === 'string'
  )
}

/**
 * 扫描 subagents/<cwdSlug>/records/*.json —— subagent 注册清单。
 * 每个 manifest 在 subagent 创建时写入，持久存在即使 .jsonl 被 GC。坏 manifest（缺必填字段
 * /JSON 损坏）跳过，不中断扫描。
 */
/** 读单个 manifest 文件并校验；坏 manifest（JSON 损坏/缺必填字段）返回 undefined。 */
async function tryReadManifest(path: string): Promise<RecordManifest | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecordManifest(raw) ? raw : undefined
  } catch {
    return undefined // 坏 manifest 跳过，不中断整体扫描
  }
}

export async function listRecordManifests(agentDir: string): Promise<RecordManifest[]> {
  const root = join(agentDir, 'subagents')
  const out: RecordManifest[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在/无权限 → 静默返回
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile() && e.name.endsWith('.json') && basename(dir) === 'records') {
        const m = await tryReadManifest(full)
        if (m) out.push(m)
      }
    }
  }
  await walk(root)
  return out
}

// ============================================================
// 文件名 sessionId 提取（find.ts + discovery/workflows.ts 共用 helper）
// ============================================================
//
// workflow-state 发现链路（resolveWorkflows / extractCallSessionFiles /
// readRunSnapshot / sessionRefFromPath）已迁至 discovery/workflows.ts（w5 架构归位，
// SSOT §6.3 workflow 与 subagent 发现解耦）。本函数被 find.ts + workflows.ts 共用，
// 故留原位 export。

/** 从文件名（<timestamp>_<sessionId>.jsonl）提取 sessionId；非 uuid 特征返回空串。 */
export function extractSessionIdFromFilename(name: string): string {
  const noExt = name.replace(/\.jsonl.*$/, '')
  const idx = noExt.lastIndexOf('_')
  const candidate = idx >= 0 ? noExt.slice(idx + 1) : noExt
  return /^[0-9a-f-]{8,}$/i.test(candidate) ? candidate : ''
}

// ============================================================
// enrich：补 M1 占位字段（fileName / subagent cwd）
// ============================================================

/**
 * M1 buildFamilyIndex 设 SessionRef.fileName=''（header 推不出路径）、subagent cwd=''
 *（identity 无 cwd）。此处用已扫描的真实文件信息补全：alive 的 ref 补 fileName + cwd；
 * cleanedUp 孤儿（无文件）保持占位。
 */
function enrichRefs(family: Family, pathToRef: Map<string, SessionRef>): void {
  // sessionId → 完整 ref（含真实 fileName/cwd），由 pathToRef 反建
  const bySid = new Map<string, SessionRef>()
  for (const ref of pathToRef.values()) bySid.set(ref.sessionId, ref)

  const enrichSessionRef = (ref: SessionRef): SessionRef => {
    const full = bySid.get(ref.sessionId)
    if (!full) return ref
    return {
      ...ref,
      fileName: full.fileName || ref.fileName,
      cwd: full.cwd || ref.cwd,
    }
  }

  family.root = enrichSessionRef(family.root)
  family.parents = family.parents.map(enrichSessionRef)
  family.forks = family.forks.map(enrichSessionRef)
  family.subagents = family.subagents.map((s) => {
    const full = bySid.get(s.sessionId)
    if (!full) return s
    return {
      ...s,
      fileName: full.fileName || s.fileName,
      cwd: full.cwd || s.cwd,
    } as SubagentRef
  })
}
