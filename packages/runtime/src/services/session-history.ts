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
  // 保留 message entry（常规消息）+ compaction entry（压缩记录顶层 entry，无 message 字段）。
  // compaction 转成 compactionSummary role 的伪消息，与 RPC 路径（pi get_messages 返回的 compactionSummary）
  // 在 convertPiHistory 汇合，统一还原成 system 消息（AGENTS.md 规则 7.5：可重开恢复）。
  const piMessages = parseJsonl(content)
    .filter((e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null &&
      ((e as { type?: string }).type === 'message' && 'message' in e ||
       (e as { type?: string }).type === 'compaction'))
    .map((e) => {
      if (e.type === 'compaction') {
        return {
          role: 'compactionSummary',
          summary: e.summary,
          tokensBefore: e.tokensBefore,
          timestamp: e.timestamp ? new Date(e.timestamp as string).getTime() : Date.now(),
        }
      }
      return e.message
    })

  return sessionStore.convertHistory(piMessages)
}
