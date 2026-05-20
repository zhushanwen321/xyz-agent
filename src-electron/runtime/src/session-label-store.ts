import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STORE_PATH = join(homedir(), '.xyz-agent', 'session-labels.json')
const MIGRATION_MARKER = join(homedir(), '.xyz-agent', '.labels-migrated')
const SESSIONS_DIR = join(homedir(), '.xyz-agent', 'sessions')

/** JSON 格式化缩进 */
const JSON_INDENT = 2

export interface LabelStore {
  [sessionId: string]: string
}

/** 内存缓存，避免每次操作都读磁盘 */
let cache: LabelStore | null = null

export function loadLabels(): LabelStore {
  if (cache) return cache
  try {
    if (!existsSync(STORE_PATH)) {
      cache = {}
      return cache
    }
    cache = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return cache!
  } catch {
    cache = {}
    return cache
  }
}

function saveStore(store: LabelStore): void {
  cache = store
  writeFileSync(STORE_PATH, JSON.stringify(store, null, JSON_INDENT) + '\n')
}

export function saveLabel(sessionId: string, label: string): void {
  const store = loadLabels()
  store[sessionId] = label
  saveStore(store)
}

export function removeLabel(sessionId: string): void {
  const store = loadLabels()
  if (!(sessionId in store)) return
  delete store[sessionId]
  saveStore(store)
}

export function getLabel(sessionId: string): string | undefined {
  return loadLabels()[sessionId]
}

/** 标记迁移已完成，后续启动不再扫描 */
function markMigrated(): void {
  writeFileSync(MIGRATION_MARKER, new Date().toISOString())
}

/**
 * 一次性迁移：从 pi 的 .jsonl 文件中提取 session_info 的 name，
 * 写入独立 label store。通过标记文件判断是否已迁移，避免每次启动全量扫描。
 */
export function migrateLabelsIfNeeded(): void {
  // 标记文件存在 → 已迁移，跳过
  if (existsSync(MIGRATION_MARKER)) return

  if (!existsSync(SESSIONS_DIR)) {
    markMigrated()
    return
  }

  const store = loadLabels()
  let migrated = false
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'))

  for (const file of files) {
    const filePath = join(SESSIONS_DIR, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')

      // 找 session header 拿 id
      let sessionId: string | undefined
      for (const line of lines) {
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'session' && entry.id) {
            sessionId = entry.id as string
            break
          }
        } catch { void 0 }
      }
      if (!sessionId) continue

      // 找最后一个 session_info 拿 name
      let label: string | undefined
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue
        try {
          const entry = JSON.parse(lines[i])
          if (entry.type === 'session_info' && entry.name) {
            label = entry.name as string
            break
          }
        } catch { void 0 }
      }
      if (label) {
        store[sessionId] = label
        migrated = true
      }
    } catch { void 0 }
  }

  if (migrated) saveStore(store)
  markMigrated()
}
