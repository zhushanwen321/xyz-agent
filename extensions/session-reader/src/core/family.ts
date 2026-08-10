import type { Entry } from './parser.js'

/**
 * 家族索引与解析（design §3.3 D-7 + §3.5 D-5 缓存）。
 *
 * M1 范围：纯逻辑层。buildFamilyIndex 接收已读入的 entry 数组（不做文件 IO），
 * 文件扫描/首行读取归 M2 discovery 层（roots.ts/find.ts/subagents.ts）。
 *
 * M1 占位约定（M2 discovery 层补全真实值，逻辑不变）：
 * - SessionRef.fileName：session header 推不出文件路径 → 占位空串
 * - SessionRef.mtime/sizeBytes：从 fileStats 取（M1 key=sessionId），取不到为 0
 * - SubagentRef.sessionId：identity entry 不含 subagent session 的 id → 占位用 entry.id
 * - SubagentRef.cwd：identity entry（custom 类型）无 cwd → 占位空串
 * - fileStats 的 key：M1 用 sessionId（M2 改用真实文件路径），isStale/cleanedUp 逻辑 M1/M2 通用
 *
 * 隔代关联规则（design §3.3 D-7 Q1）见 resolveFamily 注释。
 */

export interface SessionRef {
  sessionId: string
  fileName: string
  mtime: number
  sizeBytes: number
  cwd: string
  /** fork 文件指向来源的路径（来自 header 的 parentSession，原始文件路径字符串） */
  parentSession?: string
  name?: string
}

export interface SubagentRef extends SessionRef {
  rootSessionId: string
  slug: string
  /** identity 在但文件已被 30 天 TTL GC（design §3.3 D-7 边界 / 失败路径 F3） */
  cleanedUp?: boolean
}

export interface WorkflowRef {
  runId: string
  stateFile: string
  calls: SessionRef[]
}

export interface Family {
  root: SessionRef
  /** fork 父链（root 往上，最近在前） */
  parents: SessionRef[]
  /** fork 直接子代 */
  forks: SessionRef[]
  /** 含隔代（design §3.3 D-7 Q1：对 fork 链每个节点查 subagentsByRoot 合并） */
  subagents: SubagentRef[]
  /** M1 恒返回 []，workflow 腿需读 workflow-state 文件（IO）归 M2 */
  workflows: WorkflowRef[]
}

export interface FamilyIndex {
  byId: Map<string, SessionRef>
  /**
   * 父 sessionId（经 parentSession 文件路径反查得到）→ 直接 fork 子代。
   * 注意 key 是 sessionId 不是文件路径：parentSession 是文件路径，buildFamilyIndex
   * 反查映射回父 sessionId 后建此表，供 resolveFamily 用 root.sessionId 直接查。
   */
  childrenOf: Map<string, SessionRef[]>
  /** rootSessionId → 该 root 直接发起的 subagent（隔代合并在 resolveFamily 跨链节点做） */
  subagentsByRoot: Map<string, SubagentRef[]>
  /** 建索引时的文件元信息快照，供 isStale 缓存失效判断（design D-5） */
  fileStats: Map<string, { mtime: number; size: number }>
}

// ---- 类型守卫：从 unknown 的 entry.data 提取 subagent identity 字段 ----

interface SubagentIdentityData {
  rootSessionId: string
  slug: string
}

function isSubagentIdentityData(v: unknown): v is SubagentIdentityData {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return typeof obj.rootSessionId === 'string' && typeof obj.slug === 'string'
}

/**
 * 把 parentSession（文件路径）反查回父 sessionId。
 *
 * parentSession 是 fork 文件首行 header 指向来源的**文件路径**（非 session id），
 * 文件名格式 `<timestamp>_<sessionId>.jsonl`，故路径字符串含父 sessionId。
 * 遍历已知 sessionId 做子串匹配反查。
 *
 * 兼容 parentSession 直接就是 sessionId 的简化场景（测试 fixture 常用）。
 * 假设 sessionId 互不为子串（pi 用 UUID，满足）；M2 可优化为 fileName→sessionId
 * 索引反查（O(1)），当前遍历 O(N)，家族索引文件数通常几十到几百，可接受。
 */
function resolveParentSessionId(
  parentSession: string | undefined,
  byId: Map<string, SessionRef>,
): string | null {
  if (!parentSession) return null
  if (byId.has(parentSession)) return parentSession // 直接是 sessionId（简化场景）
  for (const sid of byId.keys()) {
    if (parentSession.includes(sid)) return sid
  }
  return null
}

/**
 * 从已读入的 session headers + subagent identity entries 建家族索引（纯逻辑，无 IO）。
 *
 * - headers（type=session）→ byId + childrenOf（parentSession 文件路径反查父 sessionId）
 * - subagentIdentities（type=custom, customType=subagent-identity）→ subagentsByRoot
 * - fileStats 原样存入 index，供 isStale 缓存失效判断
 *
 * 坏数据容错：identity 缺 rootSessionId/slug 跳过；parentSession 反查不到父（父文件
 * 未被扫描到）该 entry 不进 childrenOf——均不报错，符合 pi 坏 session 容错（design §2）。
 */
export function buildFamilyIndex(
  headers: Entry[],
  subagentIdentities: Entry[],
  fileStats: Map<string, { mtime: number; size: number }>,
): FamilyIndex {
  const byId = new Map<string, SessionRef>()

  // 1. headers → byId
  for (const h of headers) {
    const stat = fileStats.get(h.id)
    const ref: SessionRef = {
      sessionId: h.id,
      fileName: '', // M1 占位：M2 discovery 补真实文件路径
      mtime: stat?.mtime ?? 0,
      sizeBytes: stat?.size ?? 0,
      cwd: h.cwd ?? '',
    }
    if (h.parentSession) ref.parentSession = h.parentSession
    byId.set(h.id, ref)
  }

  // 2. childrenOf：parentSession（文件路径）→ 反查父 sessionId → key 用父 sessionId
  const childrenOf = new Map<string, SessionRef[]>()
  for (const h of headers) {
    if (!h.parentSession) continue
    const parentSid = resolveParentSessionId(h.parentSession, byId)
    if (parentSid === null) continue // 反查不到父 → 无法建反查关系，跳过
    const childRef = byId.get(h.id)
    if (!childRef) continue
    const list = childrenOf.get(parentSid) ?? []
    list.push(childRef)
    childrenOf.set(parentSid, list)
  }

  // 3. subagentIdentities → subagentsByRoot
  const subagentsByRoot = new Map<string, SubagentRef[]>()
  for (const ident of subagentIdentities) {
    if (!isSubagentIdentityData(ident.data)) continue // 坏数据（缺 rootSessionId/slug）跳过
    const stat = fileStats.get(ident.id)
    const ref: SubagentRef = {
      // M1 占位：identity entry 不含 subagent session 的 id，用 entry.id 顶替；
      // M2 discovery 读 subagent 文件首行 header.id 得到真实 subagent sessionId
      sessionId: ident.id,
      rootSessionId: ident.data.rootSessionId,
      slug: ident.data.slug,
      fileName: '', // M1 占位
      mtime: stat?.mtime ?? 0,
      sizeBytes: stat?.size ?? 0,
      cwd: '', // identity entry 无 cwd；M2 从 subagent 文件 header 补
      // M1: fileStats key=sessionId；M2 改用 subagent 真实文件路径（SubagentRef.fileName）查 fileStats
      cleanedUp: !fileStats.has(ident.id),
    }
    const list = subagentsByRoot.get(ident.data.rootSessionId) ?? []
    list.push(ref)
    subagentsByRoot.set(ident.data.rootSessionId, list)
  }

  return { byId, childrenOf, subagentsByRoot, fileStats }
}

/**
 * 缓存失效判断（design D-5）：任一文件 mtime/size 变化、消失或新增 → true。
 *
 * 比较 index.fileStats（建索引时的快照）与 currentStats（当前文件系统快照）。
 * 双向遍历覆盖三种失效：旧文件消失 / 内容变化 / 新文件新增。
 * 双向必要：仅遍历旧文件会漏"新增文件"（删除+新增数量相同时 size 比较也漏）。
 */
export function isStale(
  index: FamilyIndex,
  currentStats: Map<string, { mtime: number; size: number }>,
): boolean {
  // 旧文件消失或内容变化
  for (const [key, old] of index.fileStats) {
    const cur = currentStats.get(key)
    if (!cur) return true // 文件消失
    if (cur.mtime !== old.mtime || cur.size !== old.size) return true // 内容变化
  }
  // 新增文件（currentStats 有 index 没有的 key）
  for (const key of currentStats.keys()) {
    if (!index.fileStats.has(key)) return true
  }
  return false
}

/**
 * 解析某 session 的家族。
 *
 * 隔代关联规则（design §3.3 D-7 Q1，核心）：subagent 的 rootSessionId 指向其**直接
 * 发起 session**，可能是 fork 链中间节点而非家族根。故不能只查 root 的 subagentsByRoot——
 * 会漏隔代 subagent（从家族根出发会漏掉挂在 fork 子代下的 subagent）。
 *
 * 实现：建好 fork 链后，对链上**每个**节点 id（root + 所有 parents + 直接 forks）
 * 查 subagentsByRoot，按 sessionId 去重合并。
 *
 * 范围限定：M1 的 chainIds 只含直接 forks（childrenOf[root]），不递归孙代——
 * 多层 fork 后代上的 subagent 递归关联不在 M1 范围（Q1 真实场景为单层 fork）。
 *
 * @throws session 不在 index.byId 时抛 Error
 */
export function resolveFamily(sessionId: string, index: FamilyIndex): Family {
  const root = index.byId.get(sessionId)
  if (!root) {
    throw new Error(
      `session not found in family index: "${sessionId}". ` +
        `Ensure buildFamilyIndex received this session's header entry (type=session, id="${sessionId}").`,
    )
  }

  // 2. fork 父链 parents（root 沿 parentSession 往上，最近在前）
  const parents: SessionRef[] = []
  {
    const seen = new Set<string>([root.sessionId]) // 环防御（坏数据 A→B→A）
    let cur: SessionRef = root
    while (cur.parentSession) {
      const parentSid = resolveParentSessionId(cur.parentSession, index.byId)
      if (parentSid === null) break // 反查不到父 → 链断
      const parentRef = index.byId.get(parentSid)
      if (!parentRef) break // 父不在 byId（未扫描到）→ 链断
      if (seen.has(parentSid)) break // 环防御
      seen.add(parentSid)
      parents.push(parentRef)
      cur = parentRef
    }
  }

  // 3. fork 直接子代
  const forks: SessionRef[] = index.childrenOf.get(root.sessionId) ?? []

  // 4. 隔代 subagent：对 fork 链每个节点 id 查 subagentsByRoot，按 sessionId 去重合并
  const chainIds = new Set<string>([root.sessionId])
  for (const p of parents) chainIds.add(p.sessionId)
  for (const f of forks) chainIds.add(f.sessionId)

  const subagents: SubagentRef[] = []
  const seenSubagent = new Set<string>()
  for (const sid of chainIds) {
    const subs = index.subagentsByRoot.get(sid)
    if (!subs) continue
    for (const s of subs) {
      if (seenSubagent.has(s.sessionId)) continue
      seenSubagent.add(s.sessionId)
      subagents.push(s)
    }
  }

  // 5. workflows：M1 恒 []，workflow 腿需读 workflow-state 文件（IO）归 M2
  const workflows: WorkflowRef[] = []

  return { root, parents, forks, subagents, workflows }
}
