/**
 * Session 文件历史读取工具
 *
 * 从 .jsonl session 文件解析消息历史。
 */

import { readFile } from 'node:fs/promises'
import { convertPiHistory } from '../message-converter.js'
import type { PiHistoryMessage } from '../types.js'
import { scanPiSessions } from '../pi-config-bridge.js'

interface ScannedSession {
  id: string
  filePath: string
}

function findScannedSession(sessionId: string): ScannedSession | undefined {
  return scanPiSessions().find(s => s.id === sessionId)
}

/**
 * 从 .jsonl session 文件读取消息历史。
 * 文件不存在或为空时返回空数组。
 */
export async function getHistoryFromFile(sessionId: string): Promise<import('@xyz-agent/shared').Message[]> {
  const target = findScannedSession(sessionId)
  if (!target) return []

  let content: string
  try {
    content = await readFile(target.filePath, 'utf-8')
  } catch (e) {
    // Session 文件可能已被外部删除（pi 进程异常退出未 flush、用户手动清理等）
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      console.warn(`[session-history] session file missing, returning empty history: ${target.filePath}`)
      return []
    }
    throw e
  }
  const lines = content.split('\n').filter(l => l.trim())
  const piMessages: PiHistoryMessage[] = []

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'message' && entry.message) {
        piMessages.push(entry.message as PiHistoryMessage)
      }
    } catch {
      void 0
    }
  }

  return convertPiHistory(piMessages)
}
