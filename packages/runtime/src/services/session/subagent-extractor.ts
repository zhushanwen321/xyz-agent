/**
 * Subagent 提取器 —— 从 session entry 列表派生 SubagentRecord[]。
 *
 * [W18] 本文件重构为 entry 扫描器：`scanSubagentEntries(entries)` 是 subagent 列表唯一派生
 * 函数，实时（entry_appended 失效 → get_entries 增量/全量拉取）与冷启动（磁盘 JSONL 全量
 * 解析 → getSubagents RPC）两条通路都调它（D4「实时与重开走同一份扫描代码」，模式 2 双
 * 管线消亡）。
 *
 * 数据来源优先级：
 * 1. **自描述 `subagent-record` entry（W16 v1，权威）**：pi-subagent-workflow 在 record 状态
 *    迁移点（register/archive/reportRecordTransition）经 pi.appendEntry 落完整快照（customType
 *    常量 = shared SUBAGENT_RECORD_CUSTOM_TYPE）。读取方无需逆向解析 toolCall/toolResult。
 * 2. **legacy 解析（降级兜底）**：无自描述 entry 命中（W16 改造前创建的旧 session）时走
 *    旧双管线的磁盘解析逻辑——从 toolCall/toolResult/bg-notify 配对重建。降级表现 = 旧
 *    session 数据滞后但可用（登记表 #8 标注）。
 *
 * legacy JSONL 中的 entry 模式（pi-subagent-workflow，仅 background 模式）：
 * 1. assistant message 含 toolCall{name:'subagent', arguments:{action:'start', startParam:{task, slug, agent?, model?, thinkingLevel?, fork?, worktree?, ...}}}
 * 2. toolResult message 含 content[0].text = JSON 字符串，解析后含：
 *    - background 模式：{action:'start', subagentId, sessionFile:null, bgResponse:{status:'running', message:'detached...'}}
 *    - list 模式：{action:'list', subagentId:null, sessionFile:null, listResponse:{running, items:[{subagentId, agent, status, sessionFile, model, totalTokens, duration}]}}
 * 3. custom_message customType:'subagent-bg-notify' 含 details:{id, status:'running'|'closed'（legacy 兼容 done/failed/cancelled）, agent, model, result, error, startedAt, endedAt, closedReason?, round?}
 *    （background 完成终态 / 对话模式轮次完成时注入，可用来更新状态）
 *
 * 2026-07-13 对齐 pi-subagent-workflow feat-ask-user-gui 分支：
 * - startParam 新增 slug（短标签），extractor 提取到 SubagentRecord.slug
 * - 移除 sync 模式分支（新版只有 background）
 * - 旧 session JSONL（startParam 无 slug）slug 兜底空串
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseJsonl } from '../../utils/jsonl.js'
import { getSubagentSessionDir } from '../../infra/pi/pi-paths.js'
import { parseBgNotifyDetails, SUBAGENT_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import { normalizeSubagentStatus } from './subagent-status.js'
import type { SubagentRecord, SubagentStatus, BgNotifyRecord } from '@xyz-agent/shared'

/** subagent toolCall 的 arguments 结构（start action） */
interface SubagentStartArgs {
  action: 'start'
  startParam: {
    agent?: string
    slug?: string
    task?: string
    model?: string
    thinkingLevel?: string
    fork?: boolean
    worktree?: boolean
    maxTurns?: number
    graceTurns?: number
    skillPath?: string
    appendSystemPrompt?: string[]
    cwd?: string
  }
}

/** subagent toolResult 的解析结构 */
interface SubagentToolResultData {
  action: string
  subagentId: string | null
  sessionFile: string | null
  bgResponse?: {
    status: string
    message?: string
  }
  listResponse?: {
    running: number
    items: Array<{
      subagentId: string
      agent?: string
      status?: string
      sessionFile?: string
      model?: string
      totalTokens?: number
      duration?: number
      /** L2 关闭原因（仅 status='closed' 的 item 有值，pi-subagent-workflow v4 A-6） */
      closedReason?: string
    }>
  }
}

/** bg-notify 单条记录复用 shared/message.ts 的 BgNotifyRecord（不再本地重复定义） */

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

/** JSONL 中的 custom / custom_message entry 结构 */
interface JsonlCustomEntry {
  type: string
  customType?: string
  data?: unknown
  details?: unknown
  timestamp?: string
}

/**
 * [W18] entry 扫描器：从 entry 列表派生 SubagentRecord[]。
 *
 * 实时（session-service 增量拉取）与冷启动（getSubagents 磁盘全量）唯一共用派生函数：
 * 1. 先扫自描述 `subagent-record` entry（W16 v1 完整快照，同 id 后到覆盖——extension 在
 *    状态迁移点 append，后者更新）；命中（≥1 条有效）直接返回自描述派生列表。
 * 2. 无命中（W16 前创建的旧 session）→ legacy 解析兜底（toolCall/toolResult/bg-notify
 *    配对重建，数据滞后但可用）。
 *
 * entries 来源两种形态同构（pi SessionEntry 内存对象与 JSONL 行反序列化），type 判定
 * 'custom'（pi appendCustomEntry；workflow-extractor 实测注释同源）。
 */
export function scanSubagentEntries(entries: unknown[]): SubagentRecord[] {
  const selfDescribed = collectSelfDescribedSubagentRecords(entries)
  if (selfDescribed !== null) return selfDescribed
  return extractSubagentsFromEntriesLegacy(entries)
}

/**
 * 收集自描述 subagent-record entry（W16 v1）。
 *
 * data schema = extensions/subagent-workflow/src/execution/record-entry.ts 的
 * SubagentRecordEntryData（v1；跨包依赖方向不允许 import extensions/ 源码，此处按
 * 防御式逐字段守卫消费——runtime 只取 shared SubagentRecord 投影需要的字段，
 * eventLog/displayItems 等扩展内部字段不进 runtime 契约）。
 *
 * @returns null = 无有效命中（走 legacy 兜底）；SubagentRecord[] = 命中（同 id 后到覆盖）。
 * 版本不认识的 entry 跳过并 warn（可观测，对齐 workflow-extractor R4 版本漂移语义）；
 * 全部无效视同无命中。
 */
function collectSelfDescribedSubagentRecords(entries: unknown[]): SubagentRecord[] | null {
  const records = new Map<string, SubagentRecord>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as JsonlCustomEntry
    if (e.type !== 'custom' || e.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) continue
    const data = e.data
    if (typeof data !== 'object' || data === null) continue
    const d = data as Record<string, unknown>
    if (d.v !== 1) {
      console.warn(
        `[subagent-extractor] subagent-record entry schema version '${String(d.v)}' unsupported (expected 1) — ` +
          `extension/runtime version skew, skip this entry. Fix: align schema with ` +
          `extensions/subagent-workflow/src/execution/record-entry.ts (W16 v1).`,
      )
      continue
    }
    if (typeof d.id !== 'string' || typeof d.status !== 'string') continue
    const status = normalizeSubagentStatus(d.status)
    const startedAt = typeof d.startedAt === 'number' ? d.startedAt : undefined
    const endedAt = typeof d.endedAt === 'number' ? d.endedAt : undefined
    records.set(d.id, {
      subagentId: d.id,
      sessionFile: typeof d.sessionFile === 'string' ? d.sessionFile : null,
      agent: typeof d.agent === 'string' ? d.agent : 'general-purpose',
      slug: typeof d.slug === 'string' ? d.slug : '',
      task: typeof d.task === 'string' ? d.task : '',
      status,
      // closedReason 仅 closed 终态投影（与 legacy 路径同构，防 running + closedReason 脏组合）
      closedReason: status === 'closed' && typeof d.closedReason === 'string' ? d.closedReason : undefined,
      turns: typeof d.turns === 'number' ? d.turns : undefined,
      totalTokens: typeof d.totalTokens === 'number' ? d.totalTokens : undefined,
      model: typeof d.model === 'string' ? d.model : undefined,
      thinkingLevel: typeof d.thinkingLevel === 'string' ? d.thinkingLevel : undefined,
      startedAt,
      endedAt,
      // elapsedSeconds 派生：entry 无 duration 字段（extension 快照不含），从 startedAt/
      // endedAt 差值派生（与 legacy 的 listResponse.duration 同语义，秒）
      elapsedSeconds: startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
        // eslint-disable-next-line no-magic-numbers -- 1000 = ms→s 换算常数，无语义歧义
        ? Math.round((endedAt - startedAt) / 1000)
        : undefined,
      error: typeof d.error === 'string' ? d.error : undefined,
      // 轮终结果文本（running-resumable 轮终信号）：entry v1 的轮终迁移写点
      // （reportRecordTransition ← finalize-round 的 doFinalizeRoundToIdle /
      // onRoundSettled）恒写非空——renderer hasRunning 据此排除轮终 running（review #8）。
      result: typeof d.result === 'string' ? d.result : undefined,
    })
  }
  return records.size > 0 ? Array.from(records.values()) : null
}

/**
 * 从主 session JSONL 文件提取 SubagentRecord[]（冷启动 / getSubagents RPC 路径）。
 *
 * 读取文件 → parseJsonl → scanSubagentEntries（与实时增量拉取同一份派生代码）。
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
  return scanSubagentEntries(entries)
}

/**
 * [legacy] 旧双管线的磁盘解析逻辑（W18 前的 extractSubagentsFromSessionFile 主体）。
 *
 * 降级兜底：仅当 session 无自描述 subagent-record entry（W16 改造前创建）时被
 * scanSubagentEntries 调用。W16 前创建的存量 session 由此路径继续可见（不静默丢失）。
 */
function extractSubagentsFromEntriesLegacy(entries: unknown[]): SubagentRecord[] {

  // 提取主 session 的 cwd（首行 session entry），用于推导 subagent session 目录
  const sessionEntry = entries.find(
    (e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && (e as { type?: string }).type === 'session',
  )
  const mainCwd = typeof sessionEntry?.cwd === 'string' ? sessionEntry.cwd : null

  // 收集 subagent toolCall（按 toolCallId 索引）
  const toolCalls = new Map<string, { agent: string; slug: string; task: string }>()
  // 收集 subagent toolResult（按 toolCallId 索引）
  const toolResults = new Map<string, SubagentToolResultData>()
  // 收集 bg-notify（按 subagentId 索引）。复用 shared 的 BgNotifyRecord 类型，
  // 解析逻辑统一走 parseBgNotifyDetails（正确处理 single + batch 两种形态）。
  const bgNotifies = new Map<string, BgNotifyRecord>()
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
                // 对齐 pi-subagent-workflow DEFAULT_AGENT_NAME。LLM 没传 agent 时 pi 实际启动的就是 general-purpose，
                // 不是"未知"。真实值会在 record 合并时被 notify.agent 覆盖（见下方 agent 优先级链）。
                agent: args.startParam?.agent ?? 'general-purpose',
                slug: args.startParam?.slug ?? '',
                task: args.startParam?.task ?? '',
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
    // 用 parseBgNotifyDetails 统一解析 single + batch 两种形态（pi notifier 滑动窗口 60s 合并），
    // 避免 batch 形态 {batch:true, items:[...]} 时 details.id 为 undefined 整批被丢弃。
    if (e.type === 'custom_message' && e.customType === 'subagent-bg-notify') {
      const parsed = parseBgNotifyDetails(e.details)
      if (!parsed) continue
      const records: BgNotifyRecord[] = 'batch' in parsed ? parsed.items : [parsed]
      for (const record of records) {
        // 同 id 后到的覆盖先到的（理论上同一 subagent 只 notify 一次）
        bgNotifies.set(record.id, record)
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

    // background 模式（pi-subagent-workflow 只有 background）
    if (tr.bgResponse) {
      const subagentId = tr.subagentId ?? 'unknown'
      if (seenIds.has(subagentId)) continue
      seenIds.add(subagentId)

      // 从 listResponse items 或 bg-notify 更新状态
      const listItem = listItems.get(subagentId)
      const notify = bgNotifies.get(subagentId)

      // status 归一：v4 起 notify.status 是两态枚举（running/closed，详见 subagent-extractor.ts 头部
      // 契约注释），legacy 值 done/failed/cancelled 仅为历史 session 数据保留；走
      // normalizeSubagentStatus 统一兼容上游变体（completed/error/crashed 等）。notify 缺失时回落
      // listItem.status（[review 修复] 删除原 `?? normalizeSubagentStatus(tr.bgResponse.status)` 右支——
      // normalizeSubagentStatus 恒返回非空（falsy 输入回 'running'），?? 右支永不可达）。
      const status: SubagentStatus = notify
        ? normalizeSubagentStatus(notify.status)
        : normalizeSubagentStatus(listItem?.status)

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
        // agent 优先级：bg-notify（pi 执行期真实值）> listResponse item > toolCall startParam（LLM 传的，兜底 general-purpose）
        agent: notify?.agent ?? listItem?.agent ?? tc.agent,
        slug: tc.slug,
        task: tc.task,
        status,
        model: notify?.model ?? listItem?.model,
        totalTokens: listItem?.totalTokens,
        elapsedSeconds: listItem?.duration,
        startedAt: notify?.startedAt,
        endedAt: notify?.endedAt,
        error: notify?.error,
        // L2 关闭原因（v4 B-1）：bg-notify 与 list item 都可能携带，notify 优先（终态时点更晚）。
        // 仅 status === 'closed' 时投影，与实时路径（event-interpreter handleSubagentBgNotify）
        // 同构——最后一条 notify 为 running（轮次完成通知）时不从 listItem 兜底 closedReason，
        // 消除 running + closedReason 脏组合。
        closedReason: status === 'closed' ? (notify?.closedReason ?? listItem?.closedReason) : undefined,
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

// 状态归一化已下沉至 ./subagent-status.ts 的 normalizeSubagentStatus（runtime 实时路径与磁盘路径共用，
// 避免两份手写实现漂移）。历史 bug：event-interpreter 的三元缺 completed/crashed 归一。
