import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { trash } from './trash.js'
import { loadLabels } from './session-label-store.js'

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
  /** Display name (from independent label store), or null */
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
 * Labels are read from the independent label store, not from pi's .jsonl.
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

  const labels = loadLabels()
  const results: ScannedSession[] = []

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl'))

  for (const file of files) {
    const filePath = join(SESSIONS_DIR, file)
    try {
      const stat = statSync(filePath)
      const header = parseSessionHeader(filePath)
      if (!header) continue

      results.push({
        id: header.id,
        filePath,
        cwd: header.cwd,
        timestamp: header.timestamp,
        name: labels[header.id] ?? null,
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

/** Parse the first line of a session file for header metadata. */
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
