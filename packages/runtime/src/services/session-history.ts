/**
 * Session 文件历史读取工具
 *
 * 从 .jsonl session 文件解析消息历史。
 * 经 ISessionStore port 访问 scanSessions（发现）+ convertHistory（翻译），
 * 不直接 import infra。
 */

import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import type { ISessionStore } from './ports/session.js'
import { isEnoent } from '../utils/errors.js'

/** 尾读窗口默认保留的 turn 数上限（getHistoryTailFromFile / tailReadHistory 共用）。 */
const DEFAULT_MAX_TURNS = 20
import { parseJsonl, readTailBytes } from '../utils/jsonl.js'

/**
 * 把 JSONL entry 过滤+映射为 pi message 数组（供 convertHistory 消费）。
 * 放行四类 entry：message / compaction / custom_message / branch_summary。
 * branch_summary 是 pi BranchSummaryEntry（session-manager.ts:80），转 role:'branchSummary' 伪消息，
 * 与 RPC 路径（pi get_messages 返回 role:'branchSummary'）在 convertPiHistory 汇合（规则 7.5）。
 */
function mapEntriesToPiMessages(entries: unknown[]): unknown[] {
  return entries
    .filter((e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && (
        ((e as { type?: string }).type === 'message' && 'message' in e) ||
        (e as { type?: string }).type === 'compaction' ||
        (e as { type?: string }).type === 'custom_message' ||
        (e as { type?: string }).type === 'branch_summary'
      ))
    .map((e) => {
      if (e.type === 'compaction') {
        return {
          role: 'compactionSummary',
          summary: e.summary,
          tokensBefore: e.tokensBefore,
          timestamp: e.timestamp ? new Date(e.timestamp as string).getTime() : Date.now(),
        }
      }
      if (e.type === 'custom_message') {
        const content = e.content
        return {
          role: 'custom',
          customType: e.customType,
          content: typeof content === 'string' ? content : '',
          details: e.details,
          timestamp: e.timestamp ? new Date(e.timestamp as string).getTime() : Date.now(),
        }
      }
      if (e.type === 'branch_summary') {
        return {
          role: 'branchSummary',
          summary: e.summary,
          fromId: e.fromId,
          timestamp: e.timestamp ? new Date(e.timestamp as string).getTime() : Date.now(),
        }
      }
      // message entry：透传 message 体，附加 __entryId（pi JSONL entry id）供 fork 定位。
      const msg = (e.message && typeof e.message === 'object' ? e.message : {}) as Record<string, unknown>
      return { ...msg, __entryId: typeof e.id === 'string' ? e.id : undefined }
    })
}

/**
 * 从 .jsonl session 文件读取消息历史。
 * 文件不存在或为空时返回空数组。
 */
export async function getHistoryFromFile(sessionId: string, sessionStore: ISessionStore): Promise<import('@xyz-agent/shared').Message[]> {
  const target = sessionStore.scanSessions().find(s => s.id === sessionId)
  if (!target) return []
  return getHistoryFromFilePath(target.filePath, sessionStore)
}

/**
 * W1 H4：从 .jsonl session 文件**尾读**最近 maxTurns 个 turn 的历史。
 *
 * 与 getHistoryFromFile 的区别：用 tailReadHistory（256KB 尾读窗口 + turn 边界截断），
 * 避免大 session 文件全量读取。返回 TailReadResult（含 truncated 标志）。
 *
 * getHistory 的文件 fallback 走此函数（默认尾读），getFullHistory（加载更多）走
 * getHistoryFromFile（全量读）——两者语义互补。
 */
export async function getHistoryTailFromFile(sessionId: string, sessionStore: ISessionStore, maxTurns = DEFAULT_MAX_TURNS): Promise<TailReadResult> {
  const target = sessionStore.scanSessions().find(s => s.id === sessionId)
  if (!target) return { messages: [], truncated: false }
  return tailReadHistory(target.filePath, sessionStore, maxTurns)
}

/**
 * 从指定文件路径读取 .jsonl session 历史并转换为 Message[]。
 *
 * 底层函数——getHistoryFromFile（主 session）和 SessionService.getSubagentHistory
 * （subagent session）共用此转换链路。subagent JSONL 格式与主 session 一致
 * （pi SessionManager._persist 写入），parseJsonl + filter + convertHistory 零适配复用。
 */
export async function getHistoryFromFilePath(filePath: string, sessionStore: ISessionStore): Promise<import('@xyz-agent/shared').Message[]> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (e) {
    // Session 文件可能已被外部删除（pi 进程异常退出未 flush、用户手动清理等）
    if (isEnoent(e)) {
      console.warn(`[session-history] session file missing, returning empty history: ${filePath}`)
      return []
    }
    throw e
  }
  // G2: parseJsonl 统一「逐行 parse + 跳畸形行」骨架，消费方只做领域过滤。
  // mapEntriesToPiMessages 放行四类 entry：message / compaction / custom_message / branch_summary
  // （AGENTS.md 规则 7.5：可重开恢复——重开 session 时分支摘要/压缩记录/扩展通知都需还原）。
  const piMessages = mapEntriesToPiMessages(parseJsonl(content))

  return sessionStore.convertHistory(piMessages)
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
 * 尾读结果（含截断标志，N1 修复）。
 * truncated=true 表示文件里有比返回的更多的 turn（前端据此显隐「加载更多」）。
 */
export interface TailReadResult {
  messages: import('@xyz-agent/shared').Message[]
  truncated: boolean
}

/**
 * W1 H4：尾读 JSONL 历史，按 turn 边界截断加载最近 maxTurns 个完整 turn。
 *
 * 对应 FR-3 + AC-5/6/12。从文件尾部读字节窗口，倒序计数 turn（user message 为边界，
 * D11），收集最近 maxTurns 个完整 turn 对应的 message entry，经 convertHistory 转换。
 *
 * N1 修复：返回 TailReadResult（含 truncated 标志），前端据此控制「加载更多」显隐，
 * 避免空 session 闪现按钮。
 *
 * 规则 #6：文件不存在返回 { messages: [], truncated: false } 不抛（pi 延迟写入）。
 * AC-12：末行损坏复用 readTailBytes 的残行丢弃（INVAR-tail-3）。
 */
export async function tailReadHistory(
  filePath: string,
  sessionStore: ISessionStore,
  maxTurns = DEFAULT_MAX_TURNS,
): Promise<TailReadResult> {
  // 规则 #6：文件不存在返回空数组
  let fileSize: number
  try {
    fileSize = statSync(filePath).size
  } catch {
    return { messages: [], truncated: false }
  }
  if (fileSize === 0) return { messages: [], truncated: false }

  // 尾读窗口：按 maxTurns 动态估算（平均 1 turn ≈ 12KB，留余量到 32KB/turn 防长
  // tool_result/assistant 回复单 turn 达 50KB+ 触发不必要的 fallback 全量读）。
  // eslint-disable-next-line no-magic-numbers -- dynamic tail window based on maxTurns
  const TAIL_WINDOW = Math.max(256 * 1024, maxTurns * 32 * 1024)

  // W-Runtime2：是否全量读了整个文件（fileSize<=TAIL_WINDOW 或 fallback 全量读）。
  // 决定 truncated 判定方式：全量读时 userMsgIndices 是文件全部 turn，可按数量精确判定；
  // 只读了尾窗口时窗口外 turn 数未知，truncated 保守认定 true（宁可多显示「加载更多」也别漏）。
  let didFullRead = false

  // 收集尾部 entries（先尝试尾读窗口，不够再全量）
  let entries: unknown[]
  if (fileSize <= TAIL_WINDOW) {
    // 文件小于窗口，全量读（offset=0 无残行丢弃）
    const tailEntries = readTailBytes(filePath, TAIL_WINDOW)
    // B6: readTailBytes 返回 null（文件 openSync 失败，如 EACCES）→ 直接返回空，
    // 不进 fallback（fallback readFile 会重复抛 EACCES 未捕获）。
    if (tailEntries === null) return { messages: [], truncated: false }
    entries = tailEntries
    didFullRead = true
  } else {
    // 尾读窗口
    const tailEntries = readTailBytes(filePath, TAIL_WINDOW)
    // B6: readTailBytes 返回 null（文件 openSync 失败，如 EACCES）→ 直接返回空，
    // 不进 fallback（fallback readFile 会重复抛 EACCES 未捕获）。
    if (tailEntries === null) return { messages: [], truncated: false }
    entries = tailEntries
    // 检查尾读窗口内是否有足够 turn；不够则 fallback 全量读
    const turnCount = entries.filter(isTurnBoundary).length
    if (turnCount < maxTurns) {
      try {
        const content = await readFile(filePath, 'utf-8')
        entries = parseJsonl(content)
        didFullRead = true
      } catch (e) {
        if (isEnoent(e)) return { messages: [], truncated: false }
        throw e
      }
    }
  }

  // 确定窗口起点：从尾部数 maxTurns 个 user message，最早的那个 user message 的索引即为起点。
  // D11：turn = user message 到下一个 user message 之前。窗口含 maxTurns 个完整 turn。
  const userMsgIndices: number[] = []
  for (let i = 0; i < entries.length; i++) {
    if (isTurnBoundary(entries[i])) userMsgIndices.push(i)
  }

  // 窗口起点索引：倒数第 maxTurns 个 user message 的位置
  let windowStart = 0
  if (userMsgIndices.length > maxTurns) {
    // 取倒数第 maxTurns 个 user message（0-based：length - maxTurns）
    windowStart = userMsgIndices[userMsgIndices.length - maxTurns]
  }

  // 收集窗口内所有 message/compaction/custom_message/branch_summary entry（正序）
  const messageEntries: unknown[] = []
  for (let i = windowStart; i < entries.length; i++) {
    const entry = entries[i]
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const isMsg = e.type === 'message'
    const isCompaction = e.type === 'compaction'
    const isCustom = e.type === 'custom_message'
    const isBranch = e.type === 'branch_summary'
    if (isMsg || isCompaction || isCustom || isBranch) {
      messageEntries.push(entry)
    }
  }

  // AC-5 turn 外扩（D14）：若 messageEntries 首条是孤立 toolResult（窗口外有对应 assistant），
  // 尝试从原始 entries 向前找 1 轮配对。仍无法配对则 convertHistory 会 warn 丢弃。
  // 这里不额外拉取——外扩逻辑在 convertHistory 内部处理（toolResult 找不到 assistant 时 warn skip）。

  // 转换：复用 mapEntriesToPiMessages（与 getHistoryFromFilePath 同一份 filter+map 逻辑）
  const piMessages = mapEntriesToPiMessages(messageEntries)

  // N1: truncated 判定。全量读时按 turn 数判定；只读了尾窗口时保守认定 true
  // （尾窗口外的 turn 数未知，宁可多显示「加载更多」也别漏）。
  const truncated = didFullRead ? (userMsgIndices.length > maxTurns) : true
  return { messages: sessionStore.convertHistory(piMessages), truncated }
}
