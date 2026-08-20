/**
 * mapSessionEntries — session entry → 伪消息映射的共享单点（converter M1）。
 *
 * 把 pi session JSONL entry 数组映射为三类产物，供 RPC/文件两条历史读取链路共用：
 * - messages：四类 entry（message 透传 / compaction / branch_summary / custom_message）转成的伪消息，
 *   role 集合与 RPC get_messages 返回对齐，供 convertPiHistory 单点消费（AGENTS.md 关键规则 9）。
 * - entryIds：与 messages 平行对齐的来源 entry id（替代旧 __entryId 注入，M1 不再塞消息体）。
 * - customDataEntries：纯数据 custom entry（type:'custom'，不进 LLM 上下文），按需读取。
 *
 * 设计依据：docs/architecture/conversation-history-unified-converter.md §3.3.1。
 * M1 只建 mapper + 类型 + SSOT，不接入 rebuildHistoryFromEntries / getHistoryFromFilePath（M2/M3 才接入）。
 *
 * 映射逻辑整体迁移自 session-history.ts mapEntriesToPiMessages（逻辑不重新发明），差异：
 * ① 不注入 __entryId（改平行 entryIds 数组）；
 * ② 完成通知 custom_message 的 display 覆写引用 shared COMPLETE_NOTIFY_CUSTOM_TYPES SSOT。
 */
import type { PiSessionEntry, PiSessionCustomEntry } from './pi-protocol.js'
import { COMPLETE_NOTIFY_CUSTOM_TYPES } from '@xyz-agent/shared'

/** mapSessionEntries 返回类型。 */
export interface MappedSessionEntries {
  /** 四类 entry 转成的伪消息数组（供 convertPiHistory 消费）。 */
  messages: unknown[]
  /** 与 messages 平行对齐的来源 entry id（entryIds[i] = messages[i] 来源 entry 的 id）。 */
  entryIds: string[]
  /** 纯数据 custom entry（type:'custom'，不进 messages / LLM 上下文）。 */
  customDataEntries: PiSessionCustomEntry[]
}

/** ISO timestamp → ms；非字符串（缺失/畸形）兜底 Date.now()（与 mapEntriesToPiMessages 一致）。 */
function toMs(timestamp: unknown): number {
  return typeof timestamp === 'string' ? new Date(timestamp).getTime() : Date.now()
}

/**
 * 把 pi session JSONL entry 数组映射为 { messages, entryIds, customDataEntries }。
 *
 * 映射规则（迁移自 mapEntriesToPiMessages）：
 * - message → 透传 message 体（不注入 __entryId，改用平行 entryIds）
 * - compaction → { role:'compactionSummary', summary, tokensBefore, timestamp }
 * - custom_message → { role:'custom', customType, content, details, display, timestamp }；
 *   完成通知 customType（COMPLETE_NOTIFY_CUSTOM_TYPES）display 覆写为 false
 *   （pi 可能持久化 display:true，xyz-agent 统一隐藏——agent 收到后 triggerTurn 唤醒处理，
 *   结果由后续 turn 体现，通知本身对用户是噪声）
 * - branch_summary → { role:'branchSummary', summary, fromId, timestamp }
 * - custom → 进 customDataEntries（不进 messages）
 * - 其余（label/session_info 等未建模类型）→ 跳过
 *
 * 畸形降级：custom_message 无 content → 默认空串，不抛错（session JSONL 可能被截断/损坏）。
 */
export function mapSessionEntries(entries: PiSessionEntry[]): MappedSessionEntries {
  const messages: unknown[] = []
  const entryIds: string[] = []
  const customDataEntries: PiSessionCustomEntry[] = []

  for (const entry of entries) {
    switch (entry.type) {
      case 'message': {
        // 透传 message 体（不注入 __entryId，改用平行 entryIds）
        messages.push(entry.message)
        entryIds.push(entry.id)
        break
      }
      case 'compaction': {
        messages.push({
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: toMs(entry.timestamp),
        })
        entryIds.push(entry.id)
        break
      }
      case 'custom_message': {
        // 完成通知类 customType：display 覆写为 false（pi 可能持久化 true，xyz-agent 统一隐藏）
        const isCompleteNotify = COMPLETE_NOTIFY_CUSTOM_TYPES.has(entry.customType)
        messages.push({
          role: 'custom',
          customType: entry.customType,
          // 畸形降级：content 非字符串时默认空串（session JSONL 截断/损坏不抛错）
          content: typeof entry.content === 'string' ? entry.content : '',
          details: entry.details,
          display: isCompleteNotify ? false : entry.display,
          timestamp: toMs(entry.timestamp),
        })
        entryIds.push(entry.id)
        break
      }
      case 'branch_summary': {
        messages.push({
          role: 'branchSummary',
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: toMs(entry.timestamp),
        })
        entryIds.push(entry.id)
        break
      }
      case 'custom': {
        // 纯数据 entry，不进 messages / LLM 上下文，由消费侧按需读取（如 client-msg-id 映射）
        customDataEntries.push(entry)
        break
      }
      default: {
        // label / session_info / 未建模类型 → 跳过
        break
      }
    }
  }

  return { messages, entryIds, customDataEntries }
}
