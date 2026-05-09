import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { trash } from './trash.js'

const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions')

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
 * Scan ~/.pi/agent/sessions/ for all session files.
 * Each session file's first line is parsed for header metadata.
 * Optionally scans for session_info entries to get display names.
 */
export function scanSessions(): ScannedSession[] {
  if (!existsSync(SESSIONS_DIR)) return []

  const results: ScannedSession[] = []

  // Top-level dirs are encoded cwd paths like --Users-xxx-Code-project--
  const cwdDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('--'))

  for (const cwdDir of cwdDirs) {
    const dirPath = join(SESSIONS_DIR, cwdDir.name)
    const files = readdirSync(dirPath)
      .filter(f => f.endsWith('.jsonl'))

    for (const file of files) {
      const filePath = join(dirPath, file)
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
        // Skip malformed files
      }
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
 * Scan the file for the last session_info entry to get the display name.
 * Only scans lines that contain "session_info" as a quick filter.
 */
function parseSessionName(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    let lastName: string | null = null
    for (const line of lines) {
      if (!line.includes('session_info')) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'session_info' && entry.name) {
          lastName = entry.name
        }
      } catch {
        // skip malformed lines
      }
    }
    return lastName
  } catch {
    return null
  }
}
