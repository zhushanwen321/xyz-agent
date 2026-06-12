/**
 * Config Bridge — 桥接层（thin barrel）
 *
 * 保留 session 扫描和 agent 管理的直接实现，并 re-export 其他模块的功能。
 *
 * 拆分后的模块结构：
 * - pi-paths.ts — 路径解析（env-var-aware）
 * - pi-provider-store.ts — models.json/settings.json CRUD + 缓存 + 迁移
 * - session-file-utils.ts — session 文件解析/创建/重命名
 * - 本文件 — session 扫描 + agent 管理 + re-export
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './scanner-base.js'
import { parseSessionHeader, extractSessionName } from './session-file-utils.js'
import { getSessionsDir as getSessionsDirRaw, getAgentsDir } from './pi-paths.js'

// ── 模块加载时执行一次性迁移 ──────────────────────────────────
import { migrateToPiSubdir } from './pi-provider-store.js'
migrateToPiSubdir()

// ── Re-export: pi-paths ────────────────────────────────────────
export { getConfigDir, getPiAgentDir, getModelsPath, getSettingsPath } from './pi-paths.js'

// ── Re-export: pi-provider-store ───────────────────────────────
export {
  readModels, writeModels, getProviderNames, getProviderConfig,
  upsertProvider, removeProvider, getAllModels, getApiKeyForProvider,
  readSettings, writeSettings, findValidDefaultModel, getDefaultModel,
  setDefaultModel, getEnabledModels, setEnabledModels,
  getDefaultThinkingLevel, setDefaultThinkingLevel,
  getSkillPaths, setSkillPaths, addSkillPath, removeSkillPath,
  refreshAll, refreshModels, refreshSettings,
} from './pi-provider-store.js'

// Re-export types
export type { PiModelDefinition, PiProviderConfig, PiModelsConfig, PiSettings } from './pi-provider-store.js'

// ── Re-export: session-file-utils ──────────────────────────────
export { ensureSessionFile, persistSessionName, patchSessionCwd } from './session-file-utils.js'

// ── Session 扫描 ──────────────────────────────────────────────

export function getSessionsDir(): string {
  const dir = getSessionsDirRaw()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * 扫描 pi 的 sessions 目录（按 cwd 分组的子目录结构）。
 * 返回扁平化的 session 列表。
 */
export function scanPiSessions(): Array<{
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  lastModified: number
  size: number
}> {
  if (!existsSync(getSessionsDirRaw())) return []

  const results: Array<{
    id: string
    filePath: string
    cwd: string
    timestamp: string
    name: string | null
    lastModified: number
    size: number
  }> = []

  const sessionsDir = getSessionsDirRaw()
  const entries = readdirSync(sessionsDir)

  for (const entry of entries) {
    const entryPath = join(sessionsDir, entry)
    let stat
    try {
      stat = statSync(entryPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      try {
        const files = readdirSync(entryPath).filter(f => f.endsWith('.jsonl'))
        for (const file of files) {
          const filePath = join(entryPath, file)
          const header = parseSessionHeader(filePath)
          if (!header) continue
          try {
            const fstat = statSync(filePath)
            const sessionName = extractSessionName(filePath)
            results.push({
              id: header.id,
              filePath,
              cwd: header.cwd,
              timestamp: header.timestamp,
              name: sessionName,
              lastModified: fstat.mtimeMs,
              size: fstat.size,
            })
          // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entries
          } catch {
            // skip
          }
        }
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session subdirectory
      } catch {
        // skip unreadable dir
      }
    } else if (entry.endsWith('.jsonl')) {
      const header = parseSessionHeader(entryPath)
      if (!header) continue
      try {
        const sessionName = extractSessionName(entryPath)
        results.push({
          id: header.id,
          filePath: entryPath,
          cwd: header.cwd,
          timestamp: header.timestamp,
          name: sessionName,
          lastModified: stat.mtimeMs,
          size: stat.size,
        })
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entry
      } catch {
        // skip
      }
    }
  }

  results.sort((a, b) => b.lastModified - a.lastModified)
  return results
}

// ── Agent 管理 ────────────────────────────────────────────────

export { getAgentsDir } from './pi-paths.js'
export function listAgentFiles(): Array<{ name: string; path: string; content: string }> {
  if (!existsSync(getAgentsDir())) return []
  const results: Array<{ name: string; path: string; content: string }> = []
  const files = readdirSync(getAgentsDir()).filter(f => f.endsWith('.md'))
  for (const file of files) {
    const filePath = join(getAgentsDir(), file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      results.push({ name: file.replace(/\.md$/, ''), path: filePath, content })
    // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable agent files
    } catch {
      // skip unreadable files
    }
  }
  return results
}

export function writeAgentFile(name: string, content: string): void {
  const agentsDir = getAgentsDir()
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true })
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  atomicWrite(filePath, content)
}

export function deleteAgentFile(name: string): boolean {
  const agentsDir = getAgentsDir()
  const fileName = name.endsWith('.md') ? name : `${name}.md`
  const filePath = join(agentsDir, fileName)
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
