/**
 * Subagent 提取器 —— 从主 session JSONL 提取 SubagentRecord[]。
 *
 * 数据来源：主 session JSONL 中的 `subagent` tool 调用。
 * pi-subagent-workflow 扩展注册了 `subagent` tool，主 agent 调用时会 spawn 子 agent。
 *
 * JSONL 中的 entry 模式：
 * 1. assistant message 含 toolCall{name:'subagent', arguments:{action:'start', startParam:{agent, task, wait}}}
 * 2. toolResult message 含 content[0].text = JSON 字符串，解析后含：
 *    - sync 模式：{action:'start', subagentId, sessionFile, syncResponse:{status:'done'|'failed', mode:'sync', agent, model, turns, totalTokens, elapsedSeconds, result, error}}
 *    - background 模式：{action:'start', subagentId, sessionFile:null, bgResponse:{status:'running', mode:'background', message:'detached...'}}
 *    - list 模式：{action:'list', subagentId:null, sessionFile:null, listResponse:{running, items:[{subagentId, agent, status, mode, sessionFile, model, totalTokens, duration}]}}
 * 3. custom_message customType:'subagent-bg-notify' 含 details:{id, status:'done'|'failed'|'cancelled', agent, model, result, error, startedAt, endedAt}
 *    （background 模式完成时注入，可用来更新状态）
 *
 * 提取策略：
 * - 遍历所有 message entry，收集 subagent toolCall（按 toolCallId 索引）和对应 toolResult
 * - sync 模式：直接从 syncResponse 构造记录
 * - background 模式：从 bgResponse（初始 running）+ 后续 listResponse（更新状态/sessionFile）+ bg-notify（终态）合并
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseJsonl } from '../../utils/jsonl.js'
import { getSubagentSessionDir } from '../../infra/pi/pi-paths.js'
import type { SubagentRecord, SubagentStatus, SubagentMode } from '@xyz-agent/shared'

/** subagent toolCall 的 arguments 结构（start action） */
interface SubagentStartArgs {
  action: 'start'
  startParam: {
    agent?: string
    task?: string
    wait?: boolean
  }
}

/** subagent toolResult 的解析结构 */
interface SubagentToolResultData {
  action: string
  subagentId: string | null
  sessionFile: string | null
  syncResponse?: {
    status: string
    mode: string
    agent?: string
    model?: string
    turns?: number
    totalTokens?: number
    elapsedSeconds?: number
    result?: string
    error?: string
    sessionFile?: string
  }
  bgResponse?: {
    status: string
    mode: string
    message?: string
  }
  listResponse?: {
    running: number
    items: Array<{
      subagentId: string
      agent?: string
      status?: string
      mode?: string
      sessionFile?: string
      model?: string
      totalTokens?: number
      duration?: number
    }>
  }
}

/** bg-notify details 结构（与 shared/message.ts BgNotifyRecord 一致） */
interface BgNotifyDetails {
  id: string
  status: 'done' | 'failed' | 'cancelled'
  agent?: string
  model?: string
  result?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

/** JSONL 中的 message entry 结构（简化） */
interface JsonlMessageEntry {
  type: string
  id?: string
  message?: {
    role?: string
    content?: unknown
    toolCallId?: string
    toolName?: string
  }
}

/** JSONL 中的 custom_message entry 结构 */
interface JsonlCustomEntry {
  type: string
  customType?: string
  details?: unknown
  timestamp?: string
}

/**
 * 从主 session JSONL 文件提取 SubagentRecord[]。
 *
 * 读取文件 → parseJsonl → 配对 toolCall/toolResult → 合并 bg-notify → 返回列表。
 * 文件不存在或无 subagent 调用时返回空数组。
 */
export function extractSubagentsFromSessionFile(filePath: string): SubagentRecord[] {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const entries = parseJsonl(content)

  // 提取主 session 的 cwd（首行 session entry），用于推导 subagent session 目录
  const sessionEntry = entries.find(
    (e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && (e as { type?: string }).type === 'session',
  )
  const mainCwd = typeof sessionEntry?.cwd === 'string' ? sessionEntry.cwd : null

  // 收集 subagent toolCall（按 toolCallId 索引）
  const toolCalls = new Map<string, { agent: string; task: string; wait: boolean }>()
  // 收集 subagent toolResult（按 toolCallId 索引）
  const toolResults = new Map<string, SubagentToolResultData>()
  // 收集 bg-notify（按 subagentId 索引）
  const bgNotifies = new Map<string, BgNotifyDetails>()
  // 收集 list response 中的 items（background 模式状态更新）
  const listItems = new Map<string, NonNullable<NonNullable<SubagentToolResultData['listResponse']>['items']>[number]>()

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as JsonlMessageEntry & JsonlCustomEntry

    // 处理 message entry
    if (e.type === 'message' && e.message) {
      const msg = e.message
      const role = msg.role
      const content = msg.content

      // assistant message：找 subagent toolCall
      if (role === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          const b = block as { type?: string; name?: string; id?: string; arguments?: unknown }
          if (b.type === 'toolCall' && b.name === 'subagent' && b.id && typeof b.arguments === 'object') {
            const args = b.arguments as SubagentStartArgs
            if (args.action === 'start') {
              toolCalls.set(b.id, {
                agent: args.startParam?.agent ?? 'unknown',
                task: args.startParam?.task ?? '',
                wait: args.startParam?.wait ?? false,
              })
            }
          }
        }
      }

      // toolResult message：找 subagent toolResult
      if (role === 'toolResult' && msg.toolName === 'subagent' && msg.toolCallId) {
        if (Array.isArray(content) && content.length > 0) {
          const firstBlock = content[0] as { type?: string; text?: string }
          if (firstBlock?.type === 'text' && typeof firstBlock.text === 'string') {
            try {
              const parsed = JSON.parse(firstBlock.text) as SubagentToolResultData
              toolResults.set(msg.toolCallId, parsed)
            // eslint-disable-next-line taste/no-silent-catch -- toolResult text 不是合法 JSON（如错误消息 "startParam is required"），跳过该条
            } catch {
              // skip malformed toolResult
            }
          }
        }
      }
    }

    // 处理 custom_message entry：找 subagent-bg-notify
    if (e.type === 'custom_message' && e.customType === 'subagent-bg-notify' && e.details) {
      const details = e.details as BgNotifyDetails
      if (details.id) {
        bgNotifies.set(details.id, {
          id: details.id,
          status: details.status,
          agent: details.agent,
          model: details.model,
          result: details.result,
          error: details.error,
          startedAt: details.startedAt,
          endedAt: details.endedAt,
        })
      }
    }
  }

  // 合并 toolResult 中的 listResponse items
  for (const tr of toolResults.values()) {
    if (tr.listResponse?.items) {
      for (const item of tr.listResponse.items) {
        if (item.subagentId) {
          listItems.set(item.subagentId, item)
        }
      }
    }
  }

  // 构造 SubagentRecord[]
  const records: SubagentRecord[] = []
  const seenIds = new Set<string>()

  for (const [toolCallId, tc] of toolCalls) {
    const tr = toolResults.get(toolCallId)
    if (!tr) continue

    // sync 模式
    if (tr.syncResponse) {
      const subagentId = tr.subagentId ?? 'unknown'
      if (seenIds.has(subagentId)) continue
      seenIds.add(subagentId)

      const sr = tr.syncResponse
      records.push({
        subagentId,
        sessionFile: tr.sessionFile ?? sr.sessionFile ?? null,
        agent: sr.agent ?? tc.agent,
        task: tc.task,
        mode: 'sync',
        status: normalizeStatus(sr.status),
        model: sr.model,
        turns: sr.turns,
        totalTokens: sr.totalTokens,
        elapsedSeconds: sr.elapsedSeconds,
        error: sr.error,
      })
      continue
    }

    // background 模式
    if (tr.bgResponse) {
      const subagentId = tr.subagentId ?? 'unknown'
      if (seenIds.has(subagentId)) continue
      seenIds.add(subagentId)

      // 从 listResponse items 或 bg-notify 更新状态
      const listItem = listItems.get(subagentId)
      const notify = bgNotifies.get(subagentId)

      const status: SubagentStatus = notify?.status ?? normalizeStatus(listItem?.status) ?? normalizeStatus(tr.bgResponse.status)
      const mode: SubagentMode = 'background'

      // sessionFile 回退查找：listResponse/bg-notify 都不带 sessionFile 时，
      // 扫描 subagent session 目录用 startedAt 时间戳匹配最近的 JSONL 文件。
      let resolvedSessionFile = listItem?.sessionFile ?? tr.sessionFile ?? null
      if (!resolvedSessionFile && mainCwd) {
        const startedAt = notify?.startedAt
        resolvedSessionFile = findSubagentSessionFile(mainCwd, startedAt)
      }

      records.push({
        subagentId,
        sessionFile: resolvedSessionFile,
        agent: listItem?.agent ?? tc.agent,
        task: tc.task,
        mode,
        status,
        model: notify?.model ?? listItem?.model,
        totalTokens: listItem?.totalTokens,
        elapsedSeconds: listItem?.duration,
        startedAt: notify?.startedAt,
        endedAt: notify?.endedAt,
        error: notify?.error,
      })
      continue
    }
  }

  return records
}

/**
 * 时间戳匹配窗口（ms）。subagent JSONL 文件名含 ISO 时间戳，
 * 与 bg-notify.startedAt 的差值在此窗口内视为匹配。
 */
const TIMESTAMP_WINDOW_MS = 60_000

/**
 * 在 subagent session 目录中查找最匹配的 JSONL 文件。
 *
 * 当 background subagent 的 sessionFile 丢失（bg-notify 不带、无 listResponse）时，
 * 用 startedAt 时间戳匹配文件名中 ISO 时间戳最近的 .jsonl 文件。
 *
 * @param mainCwd 主 session 的 cwd（用于推导 subagent session 目录）
 * @param startedAt bg-notify 的 startedAt 时间戳（ms）。缺失时返回最近的文件。
 */
function findSubagentSessionFile(mainCwd: string, startedAt: number | undefined): string | null {
  let dir: string
  try {
    dir = getSubagentSessionDir(mainCwd)
  } catch {
    return null
  }
  if (!existsSync(dir)) return null

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.finalized'))
  } catch {
    return null
  }
  if (files.length === 0) return null

  // 无 startedAt → 返回最近修改的文件
  if (startedAt === undefined) {
    let latest: { file: string; mtime: number } | null = null
    for (const f of files) {
      try {
        const mtime = statSync(join(dir, f)).mtimeMs
        if (!latest || mtime > latest.mtime) latest = { file: f, mtime }
      // eslint-disable-next-line taste/no-silent-catch -- stat 失败（文件被并发删除等），跳过该文件
      } catch { /* skip unreadable file */ }
    }
    return latest ? join(dir, latest.file) : null
  }

  // 有 startedAt → 匹配文件名 ISO 时间戳最近的文件
  const targetTime = startedAt
  let best: { file: string; diff: number } | null = null
  for (const f of files) {
    const fileTime = parseIsoFromFilename(f)
    if (fileTime === null) continue
    const diff = Math.abs(fileTime - targetTime)
    if (!best || diff < best.diff) best = { file: f, diff }
  }

  // 在窗口内才算匹配
  if (best && best.diff <= TIMESTAMP_WINDOW_MS) {
    return join(dir, best.file)
  }
  return null
}

/**
 * 从 subagent JSONL 文件名解析 ISO 时间戳为 ms。
 * 文件名格式：2026-07-12T17-09-01-293Z_<uuid>.jsonl
 */
function parseIsoFromFilename(filename: string): number | null {
  // 取 .jsonl 前的部分，按 _ 分割取第一段（ISO 时间戳部分）
  const tsPart = basename(filename, '.jsonl').split('_')[0]
  // 文件名的 ISO 时间戳用 - 替代了 :（文件系统安全），还原
  // 2026-07-12T17-09-01-293Z → 2026-07-12T17:09:01.293Z
  const match = tsPart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/)
  if (!match) return null
  const [, y, mo, d, h, mi, s, ms] = match
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : time
}

/** 将 pi-subagent-workflow 的状态字符串归一化为 SubagentStatus */
function normalizeStatus(status: string | undefined): SubagentStatus {
  if (!status) return 'running'
  switch (status) {
    case 'done':
    case 'completed':
    case 'success':
      return 'done'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'running':
    case 'pending':
    case 'active':
      return 'running'
    default:
      return 'running'
  }
}
