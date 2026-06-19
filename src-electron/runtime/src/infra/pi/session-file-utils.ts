/**
 * Session 文件工具函数
 *
 * 提供 session .jsonl 文件的解析、创建、重命名等操作。
 * 从 pi-config-bridge.ts 提取以控制文件行数。
 */

import { existsSync, readFileSync, statSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { dirname } from 'node:path'

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
 */
export function extractSessionName(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    // 倒序查找最后一条 session_info
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type === 'session_info' && entry.name) {
          return entry.name as string
        }
        // eslint-disable-next-line taste/no-silent-catch -- parsing: skip malformed session line, continue parsing
      } catch {
        // skip malformed line
      }
    }
    return null
  } catch {
    return null
  }
}

// ── 文件操作 ─────────────────────────────────────────────────

/**
 * 确保 session 文件存在。如果 pi 延迟写入导致文件不存在，
 * 创建一个包含 session header 的最小 jsonl 文件。
 * 这样 scanPiSessions() 总能找到该 session，避免空对话 session 重启后消失。
 */
export function ensureSessionFile(filePath: string, id: string, cwd: string, label?: string): void {
  if (!filePath) return
  if (existsSync(filePath)) return

  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd,
  }) + '\n'
  const entries = [header]
  if (label) {
    entries.push(JSON.stringify({ type: 'session_info', name: label, timestamp: new Date().toISOString() }) + '\n')
  }
  try {
    const fd = openSync(filePath, 'wx')
    writeSync(fd, entries.join(''))
    closeSync(fd)
    console.log(`[config-bridge] ensured session file: ${filePath}`)
  } catch (e) {
    // 文件可能已被 pi 进程创建（竞态），忽略 EEXIST
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') {
      console.error(`[config-bridge] failed to ensure session file: ${filePath}`, e)
    }
  }
}

/**
 * 将 session 名称持久化到 .jsonl 文件。
 *
 * 追加一条 `session_info` entry（pi 的标准格式），使 extractSessionName
 * 和 pi 进程都能读到新名称。如果文件不存在则静默跳过。
 */
export function persistSessionName(filePath: string, name: string, id?: string, cwd?: string): void {
  if (!filePath) return
  if (!existsSync(filePath)) {
    // 文件不存在时，写完整 header + name 确保 scanPiSessions 能找到
    // （空 session 重命名场景：pi 延迟写入导致文件未创建）
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const timestamp = new Date().toISOString()
    const entries = []
    if (id && cwd) {
      entries.push(JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd }) + '\n')
    }
    entries.push(JSON.stringify({ type: 'session_info', name, timestamp }) + '\n')
    try {
      const fd = openSync(filePath, 'wx')
      writeSync(fd, entries.join(''))
      closeSync(fd)
      console.log(`[config-bridge] persistSessionName: created file with name: ${filePath}`)
    // eslint-disable-next-line taste/no-silent-catch -- file creation: failure to create file must not crash caller
    } catch (e) {
      console.error(`[config-bridge] persistSessionName: failed to create file: ${filePath}`, e)
    }
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
