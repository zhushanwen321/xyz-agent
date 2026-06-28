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
import { atomicWrite } from '../../utils/fs-utils.js'
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

/** Agent 文件扫描结果（单目录版，保持向后兼容）。 */
interface AgentFileEntry {
  name: string
  path: string
  content: string
  sourceType?: string
}

/**
 * 扫描 agent .md 文件。
 * - 不带参：扫默认强制目录 getAgentsDir()（向后兼容，旧调用方）。
 * - 带 dirs：扫多目录（ADR-0020 §1.1 层 3），同名按数组顺序去重（靠前覆盖靠后）。
 *   dirs 数组顺序 = 优先级（与 discovery.json.agentDirs 顺序一致）。
 */
export function listAgentFiles(dirs?: string[]): AgentFileEntry[] {
  const scanDirs = dirs ?? [getAgentsDir()]
  const seen = new Map<string, AgentFileEntry>() // name → entry，先到先得（靠前胜出）

  for (const rawDir of scanDirs) {
    if (!rawDir) continue
    if (!existsSync(rawDir)) continue
    let files: string[]
    try {
      files = readdirSync(rawDir).filter(f => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const file of files) {
      const filePath = join(rawDir, file)
      const name = file.replace(/\.md$/, '')
      if (seen.has(name)) continue // 同名去重，靠前目录胜出
      try {
        const content = readFileSync(filePath, 'utf-8')
        seen.set(name, { name, path: filePath, content })
      // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable agent files
      } catch {
        // skip unreadable files
      }
    }
  }

  return [...seen.values()]
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
