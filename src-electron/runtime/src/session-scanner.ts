import { existsSync } from 'node:fs'
import { scanPiSessions, refreshAll } from './pi-config-bridge.js'
import { trash } from './trash.js'

export interface ScannedSession {
  /** Session UUID */
  id: string
  /** Session file path (absolute) */
  filePath: string
  /** Working directory (from session header) */
  cwd: string
  /** ISO timestamp string from session header */
  timestamp: string
  /** Display name (from session_info in .jsonl), or null */
  name: string | null
  /** File last modified time (ms) */
  lastModified: number
  /** File size in bytes */
  size: number
}

/**
 * Scan sessions directory for all session files.
 * Delegates to config-bridge.scanPiSessions() which handles
 * both flat and subdirectory layouts.
 */
export function scanSessions(): ScannedSession[] {
  return scanPiSessions() as ScannedSession[]
}

/**
 * Refresh caches and re-scan.
 */
export function refreshSessions(): ScannedSession[] {
  refreshAll()
  return scanSessions()
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
