/**
 * Session 文件历史读取工具
 *
 * 从 .jsonl session 文件解析消息历史。经 ISessionStore port 访问 scanSessions（发现）+
 * convertHistory（翻译，透传 entryIds）。entry → 伪消息映射复用 infra 共享单点
 * mapSessionEntries（converter M3），与 RPC 路径（rebuildHistoryFromEntries）共用单点，
 * by construction 保证两路径覆盖一致（AGENTS.md 关键规则 9：可重开恢复）。
 *
 * 字节预算（crash-resilience §3.3 D5 / 实施计划 u4b-history-budget）：
 * - ①档 getHistoryFromFilePath：statSync 预检超 READ_PRECHECK_MAX_BYTES（32MB）→
 *   逆序分块读返回最近预算窗口 + truncated 标记（不拒绝——通路的价值就是给内容）。
 *   消费方：getSubagentHistory / getAgentCallHistory（session-records.ts——subagent
 *   历史恰是巨型 JSONL 高发源）。[u6] getFullHistory（前端「加载更多」）消费方已随
 *   全量通路退役（D4 中期：session.history 游标翻页替代），getHistoryFromFile 包装同点删除。
 * - ②档 tailReadHistory 尾读 fallback：分块扩窗（从尾部按 1MB 块向前扩，凑够
 *   HISTORY_BUDGET.RECENT_TURNS 或读到文件头即停，总读取量上限 32MB）替代
 *   「凑不够 20 turns 就全量读」的现行路径——离线 fallback 不再是无界读。
 *
 * 游标翻页（crash-resilience §3.3 D4 中期，u6-paging-protocol）：collectRecentTurnEntriesFromTail
 * 扩展 cursorId 定位——逆序扫描遇 cursor entry 行时丢弃已收集的更新侧行，从更旧行继续
 * 凑 N turns，即「锚点之前的最近窗口」；与活跃路径（sliceMessagesBeforeCursor +
 * applyHistoryBudgetWindow）共用 turn 边界/首 turn 豁免/字节预算参数语义。
 */

import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import type { Message } from '@xyz-agent/shared'
import { HISTORY_BUDGET, READ_PRECHECK_MAX_BYTES } from '@xyz-agent/shared'
import type { ISessionStore } from './ports/session.js'
import { isEnoent } from '../utils/errors.js'
import { parseJsonl } from '../utils/jsonl.js'
import { mapSessionEntries } from '../infra/pi/session-entry-mapper.js'
import type { PiSessionEntry } from '../infra/pi/pi-protocol.js'
import { forEachReversedLineChunk } from './session/history-reverse-read.js'

/**
 * 过滤出 object entry 并收窄为 PiSessionEntry[]（供 mapSessionEntries 消费）。
 *
 * parseJsonl/readTailBytes 可能返回非 object JSON 值（裸数字/字符串/null/畸形行 parse 出的非对象值），
 * 而 mapSessionEntries 的 switch(entry.type) 要求 entry 是 object（非 object 访问 .type 会抛错）。
 * 此处前置过滤，mapper 只处理 object entry。
 *
 * bashExecution 以 type:'message' + message.role:'bashExecution' 存储（W2 已验证：pi
 * session-manager appendMessage 把 message 包成 SessionMessageEntry），走 mapper 的 message
 * 分支透传，convertPiHistory 的 bashExecution 分支正确还原，无需单独处理。
 */
function filterObjectEntries(entries: unknown[]): PiSessionEntry[] {
  // parseJsonl/readTailBytes 可能返回非 object（裸数字/字符串/null），mapSessionEntries 的
  // switch(entry.type) 要求 entry 是 object。前置过滤后 cast 为 PiSessionEntry[]（运行时降级，
  // mapper 按 entry.type 结构访问，非合规字段走 default 跳过）。不用类型谓词，保留 unknown[]
  // 到 PiSessionEntry[] 的 cast（TS 认为充分重叠；谓词会收窄成 Record<string,unknown>[] 导致
  // 与 PiSessionEntry 联合不重叠报 TS2352）。
  return entries.filter((e) => typeof e === 'object' && e !== null) as PiSessionEntry[]
}

/**
 * [u6] 离线历史窗口查询参数（session.history 协议参数的文件读路径投影）。
 * cursor/limitTurns/maxBytes 语义与活跃路径共用（D4：活跃/离线两路径同一参数语义）。
 */
export interface HistoryWindowQuery {
  /** turn 边界锚点 entryId：返回该锚点之前的最近窗口；缺省 = 最近窗口（u4b 现状）。 */
  cursor?: string
  /** 窗口 turns 数（缺省 HISTORY_BUDGET.RECENT_TURNS）。 */
  limitTurns?: number
  /** 字节预算（缺省不启用于既有尾读调用方；游标翻页路径由 reader 归一默认传入）。 */
  maxBytes?: number
}

/**
 * W1 H4：从 .jsonl session 文件**尾读**最近 maxTurns 个 turn 的历史。
 *
 * 尾读走预算窗口（分块扩窗，D5②），避免大 session 文件全量读取。返回 TailReadResult
 * （含 truncated 标志）。getHistory 的文件 fallback 走此函数（默认尾读）。
 *
 * [u6] query.cursor 存在时切游标窗口（锚点之前的最近 N turns，见
 * collectRecentTurnEntriesFromTail 的 cursorId 定位）；cursor 未命中（已清理/超扫描域）→
 * 空页 + truncated=false（翻页到头语义，不报错）。
 */
export async function getHistoryTailFromFile(
  sessionId: string,
  sessionStore: ISessionStore,
  maxTurns: number = HISTORY_BUDGET.RECENT_TURNS,
  query?: HistoryWindowQuery,
): Promise<TailReadResult> {
  // wave:perf-w26（D9-1 消费方分层，plan M-3）：路径解析 force 旁路目录 TTL 缓存——
  // pi 是外部进程写文件（首个 assistant 后落盘），刚落盘 session 在 TTL 窗口内也必须
  // 解析到文件路径；离线 session 的尾读 fallback 不受 TTL 窗口陈旧影响。
  const target = sessionStore.scanSessions({ force: true }).find(s => s.id === sessionId)
  if (!target) return { messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }
  return tailReadHistory(target.filePath, sessionStore, maxTurns, query)
}

/** ①档文件直读结果（crash-resilience §3.3 D5①：超预检阈值时 truncated=true）。 */
export interface HistoryFileReadResult {
  messages: Message[]
  truncated: boolean
}

/**
 * 从指定文件路径读取 .jsonl session 历史并转换为 Message[]。
 *
 * 底层函数——getHistoryFromFile（主 session）和 SessionService.getSubagentHistory
 * （subagent session）共用此转换链路。subagent JSONL 格式与主 session 一致
 * （pi SessionManager._persist 写入），parseJsonl + filter + convertHistory 零适配复用。
 *
 * D5①：statSync 预检超 READ_PRECHECK_MAX_BYTES（32MB）→ 逆序分块读最近预算窗口
 * （HISTORY_BUDGET.RECENT_TURNS 个完整 turn）+ truncated 标记，不拒绝——消费方
 * （「加载更多」/ subagent 历史面板）的价值就是给内容，拒绝等于功能缺失。
 */
export async function getHistoryFromFilePath(filePath: string, sessionStore: ISessionStore): Promise<HistoryFileReadResult> {
  // statSync 预检（D5①）。ENOENT 与下方 readFile catch 同语义（预检与打开之间的
  // TOCTOU 删除窗口由两处共同覆盖），非 ENOENT（如 EACCES）原样上抛（现状语义不变）。
  let fileSize: number
  try {
    fileSize = statSync(filePath).size
  } catch (e) {
    if (isEnoent(e)) {
      console.warn(`[session-history] session file missing, returning empty history: ${filePath}`)
      return { messages: [], truncated: false }
    }
    throw e
  }

  if (fileSize >= READ_PRECHECK_MAX_BYTES) {
    const loaded = collectRecentTurnEntriesFromTail(filePath, HISTORY_BUDGET.RECENT_TURNS)
    // 预检后文件被竞态删除（openSync 失败）→ 空结果不抛（对齐规则 #6 降级语义）
    if (!loaded) return { messages: [], truncated: false }
    return { messages: convertWindowEntries(loaded.entries, sessionStore), truncated: loaded.truncated }
  }

  // 现状全量读路径（< 32MB，行为不变）
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (e) {
    // Session 文件可能已被外部删除（pi 进程异常退出未 flush、用户手动清理等）
    if (isEnoent(e)) {
      console.warn(`[session-history] session file missing, returning empty history: ${filePath}`)
      return { messages: [], truncated: false }
    }
    throw e
  }
  // 经共享 mapper（mapSessionEntries）映射四类 entry → 伪消息 + 平行 entryIds（M3）。
  // filterObjectEntries 前置过滤非 object（parseJsonl 可能返回裸数字/字符串/null）。
  const { messages, entryIds } = mapSessionEntries(filterObjectEntries(parseJsonl(content)))

  // 经 port 透传 entryIds（MF5），使 user/assistant message 带 piEntryId（fork 定位截断点用）。
  return { messages: sessionStore.convertHistory(messages, entryIds), truncated: false }
}

/**
 * turn 边界判定：entry 是否为 user message（turn 起点）。
 * D11：turn = user message 到下一个 user message 之前。
 */
function isTurnBoundary(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Record<string, unknown>
  if (e.type !== 'message') return false
  const msg = e.message
  if (typeof msg !== 'object' || msg === null) return false
  return (msg as Record<string, unknown>).role === 'user'
}

/**
 * 单行文本的 turn 边界判定（逆序扫描用）：parse 后复用 entry 级 isTurnBoundary。
 * 畸形行 parseJsonl 返回空数组 → 非边界。
 */
function isTurnBoundaryLine(line: string): boolean {
  const parsed = parseJsonl(line)
  return parsed.length > 0 && isTurnBoundary(parsed[0])
}

/**
 * 历史窗口读取结果（通用形状：①②档文件读与活跃 getHistory 预算窗口共用）。
 * truncated=true 表示窗口外仍有历史（前端据此显隐「加载更多」）。
 * totalTurnsEstimate：turn 总数估计——读到文件头时是精确总量；分块扩窗提前停止时
 * 是诚实下界（= loadedTurns，窗口外 turn 数未知），配合 truncated=true 表达「至少 N 轮」。
 */
export interface HistoryWindowResult {
  messages: Message[]
  truncated: boolean
  loadedTurns: number
  totalTurnsEstimate: number
}

/** [HISTORICAL] N1 修复期旧名，= HistoryWindowResult 别名（保留既有 import 兼容）。 */
export type TailReadResult = HistoryWindowResult

/**
 * 逆序分块收集最近预算窗口的 entries（①档超限路径与②档尾读共用，D5）。
 *
 * 从文件尾按 1MB 块向前扩窗扫描（forEachReversedLineChunk），倒序累计 turn 边界，
 * 凑够 maxTurns 或读到文件头即停；总读取量上限 READ_PRECHECK_MAX_BYTES（32MB），
 * 到上限仍未凑够返回已凑部分 + truncated 标记。**消除「凑不够就全量读」的现行 fallback**。
 *
 * [u6] 游标定位（cursorId 传入时）：逆序扫描（新→旧）遇 cursor entry 行时，丢弃此前
 * 收集的行（那是 cursor 更新侧），其后收集的即「cursor 之前」区域——凑够 N turns 即停。
 * cursor 行本身不返回（锚所在 turn 已在 renderer 分区中）。cursor 未命中（读到头 /
 * 32MB 上限仍未遇）→ cursorMiss=true（调用方按翻页到头返回空页，不报错——D4 空游标边界）。
 *
 * [u6] 字节预算（maxBytes 传入时启用，游标翻页路径用；与活跃路径 applyHistoryBudgetWindow
 * 同语义——首个 turn 豁免（超限完整放行）、后续 turn 按累计字节判定，turn 原子性不切）。
 * 缺省（既有尾读调用方）= 仅 turn 数预算，u4b 现状不变。
 *
 * 窗口起点对齐（entry 原子性）：分块停止时最前一行可能落在某 turn 中间（前半未读）——
 * 非全文件扫描时把起点对齐到已读区域内第一个 turn 边界（残段丢弃，同 turn entry 不拆）；
 * 全文件扫描（fullyScanned）时窗口含全部行（对齐现行 windowStart=0 行为，头部孤儿段保留）。
 *
 * 返回 null = 文件 open 失败（ENOENT/EACCES 竞态，规则 #6 / B6 同语义不抛）。
 */
function collectRecentTurnEntriesFromTail(
  filePath: string,
  maxTurns: number,
  opts?: { maxBytes?: number; cursorId?: string },
): { entries: PiSessionEntry[]; truncated: boolean; loadedTurns: number; totalTurnsEstimate: number; cursorMiss: boolean } | null {
  const maxBytes = opts?.maxBytes
  const cursorId = opts?.cursorId
  const linesDesc: string[] = [] // 倒序（新→旧）累积完整行
  const turnFlagsDesc: boolean[] = [] // 与 linesDesc 平行的 turn 边界标记
  let turnCount = 0
  let accBytes = 0
  // cursor 未定位前置 false：更新侧行不收集（cursor miss 时不得把更新侧误当锚前区域）
  let cursorSeen = cursorId === undefined
  const summary = forEachReversedLineChunk(
    filePath,
    // maxTotalBytes 显式注入 shared SSOT（工具自身零 shared 依赖，纯 IO 形态）
    { maxTotalBytes: READ_PRECHECK_MAX_BYTES },
    ({ lines }) => {
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseJsonl(lines[i])
        if (!cursorSeen) {
          // cursor 命中判定与 turn 判定共用同一 parse。命中行本身不收集（锚所在 turn
          // 已在 renderer 分区），并丢弃此前收集的更新侧——从下一行（更旧）即锚前区域。
          const hitCursor = parsed.some(
            (e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>).id === cursorId,
          )
          if (hitCursor) {
            cursorSeen = true
            linesDesc.length = 0
            turnFlagsDesc.length = 0
            turnCount = 0
            accBytes = 0
          }
          continue
        }
        const isTurn = parsed.length > 0 && isTurnBoundary(parsed[0])
        // 字节预算（turn 边界处判定已收集 turns 的累计；首个 turn 恒放行 = 首 turn 豁免；
        // 当前超界 turn 完整放行 = entry 原子性）
        if (isTurn && turnCount > 0 && maxBytes !== undefined && accBytes > maxBytes) return false
        linesDesc.push(lines[i])
        turnFlagsDesc.push(isTurn)
        accBytes += Buffer.byteLength(lines[i], 'utf-8')
        if (isTurn) turnCount++
        // 凑够预算 turns：立即停止扩窗（当前块内剩余更早行不交付——窗口恰好在
        // 第 maxTurns 个 turn 边界上截断，entry 原子性由 stop-at-boundary 保证）
        if (turnCount >= maxTurns) return false
      }
    },
  )
  if (summary.openFailed) return null
  if (!cursorSeen) {
    // cursor 未命中：空页 + 翻页到头语义（D4 空游标边界——不报错）
    return { entries: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0, cursorMiss: true }
  }

  const lines = linesDesc.reverse() // 正序
  const turnFlags = turnFlagsDesc.reverse()
  let startIdx = 0
  if (!summary.fullyScanned) {
    // 窗口起点对齐 turn 边界（entry 原子性）：分块停止 / 上限截停时首行可能是残 turn
    const firstTurn = turnFlags.indexOf(true)
    startIdx = firstTurn === -1 ? lines.length : firstTurn
  }
  const windowLines = lines.slice(startIdx)
  // 逐行 parse（turn 判定阶段已跳过畸形行的边界计数），窗口行二次 parse 换取收集期
  // 不驻留 parsed 对象图——行文本驻留（≤32MB 上限）远小于 parse 后对象图
  const entries = filterObjectEntries(windowLines.flatMap((line) => parseJsonl(line)))
  const loadedTurns = turnFlags.slice(startIdx).filter(Boolean).length
  return {
    entries,
    // N1 判定（无 cursor）对齐现行语义：全文件扫描时按 turn 数精确判定；只读了部分时保守
    // true（窗口外 turn 数未知，宁可多显示「加载更早」也别漏）。
    // [u6] cursor 定位后（锚前区域）：fullyScanned = cursor 之前全部读完 → 更早历史不存在
    // → truncated=false 精确；提前停止 / 上限截停 → 保守 true（同 N1 取向）。
    truncated: cursorId !== undefined ? !summary.fullyScanned : (summary.fullyScanned ? turnCount > maxTurns : true),
    loadedTurns,
    totalTurnsEstimate: summary.fullyScanned ? turnCount : loadedTurns,
    cursorMiss: false,
  }
}

/** 窗口 entries → Message[]（共享 mapper + port 翻译，①②档共用单点）。 */
function convertWindowEntries(entries: PiSessionEntry[], sessionStore: ISessionStore): Message[] {
  const { messages, entryIds } = mapSessionEntries(entries)
  return sessionStore.convertHistory(messages, entryIds)
}

/**
 * W1 H4：尾读 JSONL 历史，按 turn 边界加载最近 maxTurns 个完整 turn（分块扩窗，D5②）。
 *
 * 对应 FR-3 + AC-5/6/12。从文件尾部按 1MB 块向前扩窗，倒序计数 turn（user message 为
 * 边界，D11），凑够 maxTurns 个完整 turn 或读到文件头即停（总读取量上限 32MB），
 * 经 convertHistory 转换。**「凑不够 maxTurns 就全量读」的现行 fallback 已删除**。
 *
 * N1 修复：返回 TailReadResult（含 truncated 标志），前端据此控制「加载更多」显隐，
 * 避免空 session 闪现按钮。
 *
 * [u6] query.cursor 存在时切游标窗口（锚点之前的最近 N turns + 字节预算）；cursor 未命中
 * → 空页 + truncated=false（翻页到头，不报错）。
 *
 * 规则 #6：文件不存在返回空结果不抛（pi 延迟写入）。
 * AC-12：末行损坏由逆序读的残行丢弃语义承接（INVAR-tail-3 同源）。
 */
export async function tailReadHistory(
  filePath: string,
  sessionStore: ISessionStore,
  maxTurns: number = HISTORY_BUDGET.RECENT_TURNS,
  query?: HistoryWindowQuery,
): Promise<TailReadResult> {
  const emptyPage = { messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }
  // 规则 #6：文件不存在返回空数组（statSync 失败涵盖 ENOENT；打开期竞态由 collect 的
  // openFailed 语义兜底，同样不抛）
  let fileSize: number
  try {
    fileSize = statSync(filePath).size
  } catch {
    return emptyPage
  }
  if (fileSize === 0) return emptyPage

  const loaded = collectRecentTurnEntriesFromTail(filePath, maxTurns, {
    maxBytes: query?.maxBytes,
    cursorId: query?.cursor,
  })
  if (!loaded || loaded.cursorMiss) return emptyPage

  // AC-5 turn 外扩（D14）：若窗口首条是孤立 toolResult（窗口外有对应 assistant），
  // convertHistory 内部 warn 丢弃（不额外拉取，外扩逻辑在 convertHistory 处理）。
  return {
    messages: convertWindowEntries(loaded.entries, sessionStore),
    truncated: loaded.truncated,
    loadedTurns: loaded.loadedTurns,
    totalTurnsEstimate: loaded.totalTurnsEstimate,
  }
}
