/**
 * Session 文件工具函数
 *
 * 提供 session .jsonl 文件的解析、创建、重命名、扫描等操作。
 * 从 pi-config-bridge.ts 提取以控制文件行数（pi-config-bridge 已删除）。
 */

import { existsSync, readFileSync, writeFileSync, statSync, openSync, writeSync, closeSync, readdirSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { parseJsonl, readTailEntries } from '../../utils/jsonl.js'
import { join } from 'node:path'
import { getSessionsDir } from './pi-paths.js'

// ── 类型定义 ─────────────────────────────────────────────────

export interface SessionHeader {
  id: string
  cwd: string
  timestamp: string
}

// ── 解析工具 ─────────────────────────────────────────────────

export function parseSessionHeader(filePath: string): SessionHeader | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const firstLine = content.split('\n')[0]
    if (!firstLine) return null
    const entry = JSON.parse(firstLine)
    if (entry.type !== 'session') return null
    return { id: entry.id, cwd: entry.cwd, timestamp: entry.timestamp }
  } catch {
    return null
  }
}

/**
 * 从 .jsonl 文件提取最后一个 session_info 的 name 字段。
 * pi 的 session 会 append 多条 session_info，取最后一条作为当前名称。
 *
 * W2 尾读优化：先尾读（readTailEntries）找尾部最后一条 session_info。
 * pi persistSessionName 是 append，晚期 rename 的 session_info 在尾部可命中。
 * 未命中（INVAR-tail-2 SR1）→ fallback 全量读——早期命名 + 长对话追加会把最后一条
 * session_info 推到文件头部，尾窗找不到，必须 fallback 保证正确性（不丢名字）。
 */
export function extractSessionName(filePath: string): string | null {
  return findLastEntryField(filePath,
    (e) => e.type === 'session_info' && typeof e.name === 'string',
    (e) => e.name as string,
  )
}

// ── session 终态 entry（W4，ADR 0036）─────────────────────────

/**
 * session 结束时的终态类型（W4，ADR 0036 + W1 sidecar 方案）。
 * runtime 在 3 个终态点写 session_end 到 sidecar `.meta.json`（不写 JSONL），scanner
 * 据此派生终态，让前端侧栏无需预加载历史即可显示 done/error/stopped。
 */
export type SessionOutcome = 'done' | 'error' | 'stopped'

/**
 * 将 session 终态持久化到 sidecar `.meta.json`（W4，ADR 0036 + W1 sidecar 方案）。
 *
 * 与 JSONL 同目录写 `.meta.json`（存 session_end 元数据），不污染 JSONL——pi 的
 * _persist 永远只写 message/session_info，runtime 的终态独立存 sidecar，避免「pi
 * 忽略未知 type」的隐式约定。
 *
 * [规则 #6] 文件不存在时**绝不创建 sidecar**（与 pi 0.80.3 _persist 的 openSync("wx") 竞态）。
 * 进程崩溃（SIGKILL/OOM）可能来不及执行，这类 session 读不到终态 → scanner 回退 idle。
 *
 * @param filePath session JSONL 绝对路径（sidecar = filePath + '.meta.json'）
 * @param outcome 终态：done（正常完成）/ error（LLM 出错）/ stopped（用户 abort/进程崩溃）
 * @param reason 可选人类可读原因（error 的 errorMessage / stopped 的 abort reason）
 */
export function persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    // 文件不存在（pi 延迟写入窗口 / 首 turn 前崩溃）：绝不创建文件，直接跳过。
    return
  }
  const meta = { type: 'session_end', outcome, reason, timestamp: new Date().toISOString() }
  try {
    writeFileSync(filePath + '.meta.json', JSON.stringify(meta))
  // eslint-disable-next-line taste/no-silent-catch -- file write: failure must not crash caller
  } catch (e) {
    console.error(`[session-file-utils] persistSessionEnd failed: ${filePath}`, e)
  }
}

/**
 * 从 .jsonl 文件提取最后一条 session_end 的 outcome（W4，ADR 0036）。
 *
 * W2 尾读优化：先尾读找尾部最后一条 session_end。persistSessionEnd 是 session 结束时
 * 最后写入的 entry → session_end 始终在文件最尾部 → 尾读几乎必中。
 * 未命中（理论可能：session_end 后又有别的 runtime 写入）→ fallback 全量读兜底。
 *
 * @returns 终态 outcome；文件无 session_end entry（历史 session / 未结束）返回 null
 */
export function extractSessionOutcome(filePath: string): SessionOutcome | null {
  // 优先读 sidecar（W1 sidecar 元数据方案）
  const sidecarPath = filePath + '.meta.json'
  try {
    const raw = readFileSync(sidecarPath, 'utf-8')
    const meta = JSON.parse(raw)
    if (meta && typeof meta.outcome === 'string') {
      return meta.outcome as SessionOutcome
    }
  // eslint-disable-next-line taste/no-silent-catch -- ENOENT/no-parse → fallback to JSONL
  } catch { void 0 /* no sidecar or invalid → fallback */ }

  // fallback: 从 JSONL 读（历史 session / 无 sidecar 时的兼容路径）
  return findLastEntryField(filePath,
    (e) => e.type === 'session_end' && typeof e.outcome === 'string',
    (e) => e.outcome as SessionOutcome,
  )
}

/**
 * 尾读 + fallback 全量读，倒序找最后一条匹配 entry 的字段值（W2 共用骨架）。
 *
 * 1. readTailEntries 尾读尾部块（offset=max(0,size-32KB)）
 * 2. 倒序找匹配 predicate 的 entry，命中返回 extract(entry)
 * 3. 尾读未命中（INVAR-tail-2 SR1）→ fallback 全量 readFileSync + parseJsonl 倒序找
 * 4. 全量也无 → 返回 null
 *
 * 错误对等（INVAR-tail-7）：ENOENT/EACCES/JSON parse 错误与原实现一致返回 null，不引入新 throw。
 */
function findLastEntryField<R>(
  filePath: string,
  predicate: (e: Record<string, unknown>) => boolean,
  extract: (e: Record<string, unknown>) => R,
): R | null {
  // 尾读阶段
  const tailEntries = readTailEntries(filePath)
  if (tailEntries !== null) {
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      const entry = tailEntries[i]
      if (typeof entry === 'object' && entry !== null && predicate(entry as Record<string, unknown>)) {
        return extract(entry as Record<string, unknown>)
      }
    }
  }
  // fallback 全量读（INVAR-tail-2: 尾读未命中，目标可能在文件头部）
  try {
    const content = readFileSync(filePath, 'utf-8')
    const entries = parseJsonl(content)
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (typeof entry === 'object' && entry !== null && predicate(entry as Record<string, unknown>)) {
        return extract(entry as Record<string, unknown>)
      }
    }
  // eslint-disable-next-line taste/no-silent-catch -- 文件读取/解析失败返回 null，与原实现对等
  } catch {
    return null
  }
  return null
}

// ── 文件操作 ─────────────────────────────────────────────────

// [HISTORICAL] ensureSessionFile 已删除（2026-07-04）。
// 原实现用 openSync(wx) 提前创建 session 文件（含 session+session_info 两行），
// 理由是「pi 延迟写入期间 scanPiSessions 找不到该 session」。但这与 pi 0.80.3
// SessionManager._persist 的 openSync("wx") 冲突 → EEXIST → pi 抛 error → session 卡死。
// 现在依赖 SessionScanner.listAll 合并内存 active session（this.sessions Map），
// 即使磁盘无文件也显示；重启后内存清空，未 flush 的空 session 丢失是合理行为。

/**
 * 将 session 名称持久化到 .jsonl 文件。
 *
 * 追加一条 `session_info` entry（pi 的标准格式），使 extractSessionName
 * 和 pi 进程都能读到新名称。
 *
 * [HISTORICAL] 文件不存在时**绝不创建文件**（规则 #6）。原实现用 openSync(wx)
 * 提前建文件，与 pi 0.80.3 SessionManager._persist 的 openSync("wx") 冲突 →
 * EEXIST → pi 抛 error → session 永久卡死（见上方 ensureSessionFile 删除记录）。
 * 文件不存在时只 console.warn + return，由调用方（tryPersistLabel 在 turn_end /
 * agent_end 兜底）等 pi 首次 flush 完成后再写。active session 即使磁盘无文件也
 * 经 SessionScanner.listAll 合并内存 Map 显示，不依赖文件提前创建。
 */
export function persistSessionName(filePath: string, name: string, id?: string, cwd?: string): void {
  void id
  void cwd
  if (!filePath) return
  if (!existsSync(filePath)) {
    // 文件不存在（pi 延迟写入窗口）：绝不创建文件，等 tryPersistLabel 在
    // turn_end/agent_end 兜底写盘。此处只 warn 不抛，避免阻断 rename 调用方。
    console.warn(`[session-file-utils] persistSessionName: file does not exist, skipping (pi delayed write window): ${filePath}`)
    return
  }
  const entry = JSON.stringify({ type: 'session_info', name, timestamp: new Date().toISOString() }) + '\n'
  try {
    const fd = openSync(filePath, 'a')
    writeSync(fd, entry)
    closeSync(fd)
  // eslint-disable-next-line taste/no-silent-catch -- file append: failure to write must not crash caller
  } catch (e) {
    console.error(`[config-bridge] persistSessionName: failed to write: ${filePath}`, e)
  }
}

/**
 * Patch session 文件首行的 cwd 字段。用于 session 的原始 cwd 已不存在时，
 * 将 cwd 更新为 fallback 值，使 pi 的 switch_session 不会因 cwd 不存在而失败。
 * 只修改首行（session header），不影响后续 entry。
 *
 * ⚠️ PRECONDITION: 必须在 pi session 启动（createSession）之前调用。
 * pi 的 _persist() 会在 assistant 消息到达后异步写入 session 文件，
 * 如果 pi 已启动，patchSessionCwd 与 _persist() 之间存在写写竞态。
 * 当前调用链 restoreSession → patchSessionCwd → createSession 保证了时序安全。
 *
 * @throws 此函数不抛异常（catch-all），但调用方必须保证在 pi 进程启动前调用。
 *         如果 pi 已启动，其 _persist() flush 可能与本次写操作并发，导致数据静默丢失。
 */
export function patchSessionCwd(filePath: string, newCwd: string): boolean {
  try {
    // 防御性检查：如果文件最近被修改过，可能存在并发写入者（如 pi 的 _persist()）
    try {
      const stat = statSync(filePath)
      const ageMs = Date.now() - stat.mtimeMs
      // eslint-disable-next-line no-magic-numbers -- 1s threshold: file modified within last second = concurrent write risk
      if (ageMs < 1000) {
        console.warn(`[session-file-utils] patchSessionCwd: file modified ${ageMs}ms ago, possible concurrent writer — data loss risk`)
      }
    // eslint-disable-next-line taste/no-silent-catch -- stat failure is non-fatal for cwd patching
    } catch { /* stat failed is not fatal */ }

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    if (!lines[0]) return false
    const header = JSON.parse(lines[0])
    if (header.type !== 'session') return false
    header.cwd = newCwd
    lines[0] = JSON.stringify(header)
    // 原子写入：tmpfile + rename，防止与 pi 的 _persist() 并发写导致数据丢失。
    // 使用唯一 tmp 后缀防止并发 restoreSession 对同一文件的 TOCTOU 风险。
    atomicWrite(filePath, lines.join('\n'), `patch-${Date.now()}`)
    console.log(`[session-file-utils] patched session cwd: ${filePath} -> ${newCwd}`)
    return true
  } catch (e) {
    console.error(`[session-file-utils] failed to patch session cwd: ${filePath}`, e)
    return false
  }
}

// ── Session 扫描 ─────────────────────────────────────────────

/** scanPiSessions 返回的单条 session 元信息（持久化会话扫描结果）。 */
export interface ScannedSessionMeta {
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  /** W3 三读合一：outcome 随 meta 一起提取，scannedToSummary 直接取不再独立读文件（消除第 3 次全量读）。 */
  outcome: SessionOutcome | null
  lastModified: number
  size: number
}

/**
 * W3 文件级 mtime+size 缓存（INVAR-cache-1 模块级跨两阶段共享）。
 *
 * scanPiSessions（header+name+outcome 三读合一）与 scannedToSummary（取 outcome）共享此缓存。
 * 缓存键含 (path, mtimeMs, size)（INVAR-cache-2 SR4）——同 ms 内并发 append mtimeMs 不变但
 * size 变 → miss，消除竞态。无上限（INVAR-cache-6，每条~几百字节，10k session≈数 MB）。
 * 不跨进程（runtime 重启清空，首次 scan 冷读）。
 *
 * [KNOWN-LIMIT 无界增长] 缓存以 filePath 为键，删除 session 不会主动清条目（deleteSession
 * 走 trash 不回调此模块）。长时间运行的 runtime + 频繁创建/删除 session 时条目累积，
 * 但单条 ~几百字节、且 filePath 含 sessionId 不会重复，实测量级可控（数千条 ≈ 1MB）。
 * 若未来 session 生命周期变长/创建频繁导致内存压力，可在此加 LRU 上限或定期 sweep
 * （按 lastModified 淘汰 stale 条目）。当前 runtime 进程为 session 级常驻，生命周期内
 * session 总数有限，暂不引入淘汰逻辑。
 */
interface CachedSessionMeta {
  mtimeMs: number
  size: number
  meta: ScannedSessionMeta
}
const sessionMetaCache = new Map<string, CachedSessionMeta>()

/** 仅供测试重置缓存用（生产不调）。 */
export function _resetSessionMetaCacheForTest(): void {
  sessionMetaCache.clear()
}

/**
 * 单个 session 文件的元数据提取（三读合一 + 缓存）。
 *
 * 1. statSync 拿 mtimeMs + size，查缓存 (path, mtimeMs, size)
 * 2. 命中（INVAR-cache-3）→ 返回缓存 meta（零文件读取）
 * 3. miss → parseSessionHeader + extractSessionName + extractSessionOutcome 一次提取全部 → 写缓存
 *
 * 三读合一（FR-three-read-merge）：原 scanPiSessions 调 parseSessionHeader（全量读首行）
 * + extractSessionName（尾读），scannedToSummary 再调 extractSessionOutcome（第 3 次全量读）。
 * 现统一在此一次提取，scannedToSummary 从 meta.outcome 取（INVAR-merge-2）。
 *
 * 文件删除/不可读（INVAR-cache-4）→ 清该 key 返回 null。
 */
function scanSessionMeta(filePath: string): ScannedSessionMeta | null {
  let fstat
  try {
    fstat = statSync(filePath)
  } catch {
    // 文件不存在/不可读：清 stale 缓存条目（INVAR-cache-4），返回 null
    sessionMetaCache.delete(filePath)
    return null
  }

  const cached = sessionMetaCache.get(filePath)
  // INVAR-cache-2: 键含 (mtimeMs, size)，任一变 → miss
  if (cached && cached.mtimeMs === fstat.mtimeMs && cached.size === fstat.size) {
    return cached.meta // INVAR-cache-3: 命中，逐字节一致
  }

  // miss：三读合一提取全部元数据
  const header = parseSessionHeader(filePath)
  if (!header) {
    // 非 session 文件（首行不是 session header）：不缓存（下次仍尝试，开销小）
    return null
  }
  const name = extractSessionName(filePath)
  const outcome = extractSessionOutcome(filePath)
  const meta: ScannedSessionMeta = {
    id: header.id,
    filePath,
    cwd: header.cwd,
    timestamp: header.timestamp,
    name,
    outcome,
    lastModified: fstat.mtimeMs,
    size: fstat.size,
  }
  sessionMetaCache.set(filePath, { mtimeMs: fstat.mtimeMs, size: fstat.size, meta })
  return meta
}

/**
 * 扫描 pi 的 sessions 目录（按 cwd 分组的子目录结构）。
 * 返回扁平化的 session 列表。
 *
 * W3：scanSessionMeta 三读合一 + 缓存。每文件 miss 时 1 次提取 header+name+outcome，
 * hit 时零读取（仅 statSync）。
 */
export function scanPiSessions(): ScannedSessionMeta[] {
  if (!existsSync(getSessionsDir())) return []

  const results: ScannedSessionMeta[] = []

  const sessionsDir = getSessionsDir()
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch (e) {
    // L8: sessions 目录存在但不可读（权限/IO 故障）时，readdirSync 抛 EACCES 等异常。
    // 原实现未保护会冒泡为进程级未捕获异常，此处降级为返回空数组（scan 容忍失败）。
    console.error(`[session-file-utils] scanPiSessions: failed to read sessions dir: ${sessionsDir}`, e)
    return []
  }

  for (const entry of entries) {
    const entryPath = join(sessionsDir, entry)
    let stat
    try {
      stat = statSync(entryPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      try {
        const files = readdirSync(entryPath).filter(f => f.endsWith('.jsonl'))
        for (const file of files) {
          const filePath = join(entryPath, file)
          try {
            const meta = scanSessionMeta(filePath)
            if (meta) results.push(meta)
          // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entries
          } catch {
            // skip
          }
        }
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session subdirectory
      } catch {
        // skip unreadable dir
      }
    } else if (entry.endsWith('.jsonl')) {
      try {
        const meta = scanSessionMeta(entryPath)
        if (meta) results.push(meta)
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entry
      } catch {
        // skip
      }
    }
  }

  results.sort((a, b) => b.lastModified - a.lastModified)
  return results
}
