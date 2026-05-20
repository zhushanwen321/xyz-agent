import { readdirSync, readFileSync, openSync, readSync, closeSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { trash } from './trash.js'

const SESSIONS_DIR = join(homedir(), '.xyz-agent', 'sessions')

export interface ScannedSession {
  /** Session UUID */
  id: string
  /** Session file path (absolute) */
  filePath: string
  /** Working directory (from session header) */
  cwd: string
  /** ISO timestamp string from session header */
  timestamp: string
  /** Display name (from session_info entry), or null */
  name: string | null
  /** File last modified time (ms) */
  lastModified: number
  /** File size in bytes */
  size: number
}

/**
 * Scan ~/.xyz-agent/sessions/ for all session files.
 * Sessions are stored as flat .jsonl files (no subdirectory grouping).
 * Each file's first line is parsed for header metadata.
 *
 * Results are cached for SCAN_TTL_MS to avoid repeated disk I/O.
 * Call invalidateScanCache() after create/delete/rename.
 */

const SCAN_TTL_MS = 5_000
let cachedScan: { timestamp: number; result: ScannedSession[] } | null = null

export function scanSessions(): ScannedSession[] {
  if (cachedScan && Date.now() - cachedScan.timestamp < SCAN_TTL_MS) {
    return cachedScan.result
  }
  const result = scanSessionsUncached()
  cachedScan = { timestamp: Date.now(), result }
  return result
}

export function invalidateScanCache(): void {
  cachedScan = null
}

function scanSessionsUncached(): ScannedSession[] {
  if (!existsSync(SESSIONS_DIR)) return []

  const results: ScannedSession[] = []

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))

  for (const file of files) {
    const filePath = join(SESSIONS_DIR, file)
    try {
      const stat = statSync(filePath)
      const header = parseSessionHeader(filePath)
      if (!header) continue

      const name = parseSessionName(filePath)

      results.push({
        id: header.id,
        filePath,
        cwd: header.cwd,
        timestamp: header.timestamp,
        name,
        lastModified: stat.mtimeMs,
        size: stat.size,
      })
    } catch {
      // expected: malformed session file, skip
      void 0
    }
  }

  // Sort by last modified, newest first
  results.sort((a, b) => b.lastModified - a.lastModified)
  return results
}

/**
 * Delete a session file. Uses trash if available, otherwise permanent delete.
 */
export async function deleteSessionFile(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return
  await trash(filePath)
}

/**
 * Group scanned sessions by cwd, similar to pi's session listing.
 */
export function groupSessions(sessions: ScannedSession[]): { cwd: string; sessions: ScannedSession[] }[] {
  const groups = new Map<string, ScannedSession[]>()
  for (const s of sessions) {
    const list = groups.get(s.cwd) ?? []
    list.push(s)
    groups.set(s.cwd, list)
  }
  return Array.from(groups.entries()).map(([cwd, sessions]) => ({ cwd, sessions }))
}

// ── Internal ───────────────────────────────────────────────────

interface SessionHeader {
  id: string
  cwd: string
  timestamp: string
}

/**
 * Parse the first line of a session file for header metadata.
 * Returns null if the file doesn't start with a valid session header.
 */
function parseSessionHeader(filePath: string): SessionHeader | null {
  try {
    const fd = readFileSync(filePath, 'utf-8')
    const firstLine = fd.split('\n')[0]
    if (!firstLine) return null
    const entry = JSON.parse(firstLine)
    if (entry.type !== 'session') return null
    return {
      id: entry.id,
      cwd: entry.cwd,
      timestamp: entry.timestamp,
    }
  } catch {
    return null
  }
}

/**
 * Scan the tail of the file for the last session_info entry.
 * Reads up to TAIL_SCAN_BYTES from the end for efficiency.
 */
const TAIL_SCAN_BYTES = 4096
function parseSessionName(filePath: string): string | null {
  try {
    const stat = statSync(filePath)
    const readLen = Math.min(stat.size, TAIL_SCAN_BYTES)
    if (readLen === 0) return null

    const buf = Buffer.alloc(readLen)
    const fd = openSync(filePath, 'r')
    try {
      readSync(fd, buf, 0, readLen, stat.size - readLen)
    } finally {
      closeSync(fd)
    }

    const tail = buf.toString('utf-8')
    // 从后往前找最后一个 session_info
    let pos = tail.length
    while (pos > 0) {
      const idx = tail.lastIndexOf('session_info', pos - 1)
      if (idx === -1) break
      const lineStart = tail.lastIndexOf('\n', idx)
      const lineEnd = tail.indexOf('\n', idx)
      const line = tail.slice(lineStart + 1, lineEnd === -1 ? tail.length : lineEnd).trim()
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'session_info' && entry.name) return entry.name
      } catch {
        // expected: malformed line, skip
        void 0
      }
      pos = idx
    }
    return null
  } catch {
    return null
  }
}
