/**
 * Session 文件历史读取工具
 *
 * 从 .jsonl session 文件解析消息历史。
 * 经 ISessionStore port 访问 scanSessions（发现）+ convertHistory（翻译），
 * 不直接 import infra。
 */

import { readFile } from 'node:fs/promises'
import type { ISessionStore } from './ports/session.js'
import { isEnoent } from '../utils/errors.js'
import { parseJsonl } from '../utils/jsonl.js'

/**
 * 从 .jsonl session 文件读取消息历史。
 * 文件不存在或为空时返回空数组。
 */
export async function getHistoryFromFile(sessionId: string, sessionStore: ISessionStore): Promise<import('@xyz-agent/shared').Message[]> {
  const target = sessionStore.scanSessions().find(s => s.id === sessionId)
  if (!target) return []

  let content: string
  try {
    content = await readFile(target.filePath, 'utf-8')
  } catch (e) {
    // Session 文件可能已被外部删除（pi 进程异常退出未 flush、用户手动清理等）
    if (isEnoent(e)) {
      console.warn(`[session-history] session file missing, returning empty history: ${target.filePath}`)
      return []
    }
    throw e
  }
  // G2: parseJsonl 统一「逐行 parse + 跳畸形行」骨架，消费方只做领域过滤。
  // 保留三类 entry：
  // - message：常规消息（取 e.message）
  // - compaction：压缩记录顶层 entry（无 message 字段），转 compactionSummary 伪消息
  // - custom_message：扩展经 pi.sendMessage 注入的 CustomMessage（如 subagent-bg-notify），
  //   转 role:'custom' 伪消息，与 RPC 路径（pi get_messages 返回的 role:'custom'）
  //   在 convertPiHistory 汇合，统一还原成 system 消息（AGENTS.md 规则 7.5：可重开恢复）。
  const piMessages = parseJsonl(content)
    .filter((e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && (
        ((e as { type?: string }).type === 'message' && 'message' in e) ||
        (e as { type?: string }).type === 'compaction' ||
        (e as { type?: string }).type === 'custom_message'
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
        // custom_message entry → role:'custom' 伪消息（convertPiHistory 的 role:'custom' 分支消费）
        const content = e.content
        // content 可能是 string 或 content array（pi CustomMessage.content 类型），
        // convertPiHistory 的 custom 分支只取 cm.content ?? ''，string 直传，array 会被 String() 兜底
        return {
          role: 'custom',
          customType: e.customType,
          content: typeof content === 'string' ? content : '',
          details: e.details,
          timestamp: e.timestamp ? new Date(e.timestamp as string).getTime() : Date.now(),
        }
      }
      // message entry：透传 message 体，附加 __entryId（pi JSONL entry id）供 fork 定位。
      // RPC 路径（pi get_messages）不返回 entryId，此通道仅文件路径读取时填充。
      const msg = (e.message && typeof e.message === 'object' ? e.message : {}) as Record<string, unknown>
      return { ...msg, __entryId: typeof e.id === 'string' ? e.id : undefined }
    })

  return sessionStore.convertHistory(piMessages)
}
