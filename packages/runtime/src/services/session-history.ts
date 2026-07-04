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
  const piMessages = parseJsonl(content)
    .filter((e): e is { type: string; message: unknown } =>
      typeof e === 'object' && e !== null && (e as { type?: string }).type === 'message' && 'message' in e)
    .map(e => e.message)

  return sessionStore.convertHistory(piMessages)
}
