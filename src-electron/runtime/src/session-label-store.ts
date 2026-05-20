import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STORE_PATH = join(homedir(), '.xyz-agent', 'session-labels.json')
const SESSIONS_DIR = join(homedir(), '.xyz-agent', 'sessions')

export interface LabelStore {
  [sessionId: string]: string
}

export function loadLabels(): LabelStore {
  try {
    if (!existsSync(STORE_PATH)) return {}
    return JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function saveStore(store: LabelStore): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + '\n')
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

/**
 * 一次性迁移：从 pi 的 .jsonl 文件中提取 session_info 的 name，
 * 写入独立 label store。仅当 store 为空时执行。
 */
export function migrateLabelsIfNeeded(): void {
  const store = loadLabels()
  // 非空说明已经迁移过，跳过
  if (Object.keys(store).length > 0) return

  if (!existsSync(SESSIONS_DIR)) return

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
}
