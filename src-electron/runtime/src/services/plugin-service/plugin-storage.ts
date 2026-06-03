import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const BYTES_PER_KB = 1024
const MB = BYTES_PER_KB * BYTES_PER_KB
const TEN = 10
const MAX_TOTAL_SIZE = TEN * MB // 10MB
const MAX_VALUE_SIZE = 1 * MB // 1MB
const FLUSH_DEBOUNCE_MS = 500
const JSON_FORMAT_INDENT = 2
const HASH_SLICE_LENGTH = 12
const RADIX_BASE36 = 36
const SLICE_START = 2

interface CacheEntry {
  data: Map<string, unknown>
  dirty: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
  totalSize: number
}

export class PluginStorage {
  private caches = new Map<string, CacheEntry>()
  private baseDir = ''
  private projectRoot = ''

  async init(baseDir: string, projectRoot: string): Promise<void> {
    this.baseDir = baseDir
    this.projectRoot = projectRoot
    const pluginsDir = join(baseDir, 'plugins')
    await mkdir(pluginsDir, { recursive: true })
  }

  // ── Scoped API (global or workspace) ───────────────────────────

  async get(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): Promise<unknown | undefined> {
    const cache = await this.getCache(pluginId, scope)
    return cache.data.get(key)
  }

  async set(pluginId: string, key: string, value: unknown, scope: 'global' | 'workspace' = 'global'): Promise<void> {
    const valueSize = Buffer.byteLength(JSON.stringify(value), 'utf-8')
    if (valueSize > MAX_VALUE_SIZE) {
      throw Object.assign(
        new Error(`Value exceeds 1MB limit (${valueSize} bytes)`),
        { code: -32021 },
      )
    }

    const cache = await this.getCache(pluginId, scope)
    const oldValue = cache.data.get(key)
    const oldSize =
      oldValue !== undefined
        ? Buffer.byteLength(JSON.stringify(oldValue), 'utf-8')
        : 0
    const newTotal = cache.totalSize - oldSize + valueSize

    if (newTotal > MAX_TOTAL_SIZE) {
      throw Object.assign(
        new Error('Storage exceeds 10MB limit'),
        { code: -32040 },
      )
    }

    cache.data.set(key, value)
    cache.totalSize = newTotal
    cache.dirty = true
    this.scheduleFlush(pluginId, scope)
  }

  async delete(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): Promise<void> {
    const cache = await this.getCache(pluginId, scope)
    const oldValue = cache.data.get(key)
    if (oldValue !== undefined) {
      cache.totalSize -= Buffer.byteLength(JSON.stringify(oldValue), 'utf-8')
      cache.data.delete(key)
      cache.dirty = true
      this.scheduleFlush(pluginId, scope)
    }
  }

  async keys(pluginId: string, scope: 'global' | 'workspace' = 'global'): Promise<string[]> {
    const cache = await this.getCache(pluginId, scope)
    return Array.from(cache.data.keys())
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async flush(pluginId: string): Promise<void> {
    // flush 所有 scope（global + workspace）
    for (const scope of ['global', 'workspace'] as const) {
      const cacheKey = `${pluginId}:${scope}`
      const cache = this.caches.get(cacheKey)
      if (!cache || !cache.dirty) continue
      if (cache.flushTimer) {
        clearTimeout(cache.flushTimer)
        cache.flushTimer = null
      }
      await this.writeToDisk(pluginId, scope, cache)
      cache.dirty = false
    }
  }

  async flushAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const [cacheKey, cache] of Array.from(this.caches)) {
      if (cache.dirty) {
        const parts = cacheKey.split(':')
        const pluginId = parts[0]
        const scope = (parts[1] ?? 'global') as 'global' | 'workspace'
        if (cache.flushTimer) {
          clearTimeout(cache.flushTimer)
          cache.flushTimer = null
        }
        promises.push(
          this.writeToDisk(pluginId, scope, cache).then(() => {
            cache.dirty = false
          }),
        )
      }
    }
    await Promise.allSettled(promises)
  }

  onExternalChange(pluginId: string): void {
    this.caches.delete(`${pluginId}:global`)
    this.caches.delete(`${pluginId}:workspace`)
  }

  // ── Private ─────────────────────────────────────────────────────

  private async getCache(
    pluginId: string,
    _scope: 'global' | 'workspace',
  ): Promise<CacheEntry> {
    const cacheKey = `${pluginId}:${_scope}`
    const existing = this.caches.get(cacheKey)
    if (existing) return existing

    const filePath = this.getFilePath(pluginId, _scope)
    const data = new Map<string, unknown>()
    let totalSize = 0
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        data.set(k, v)
        totalSize += Buffer.byteLength(JSON.stringify(v), 'utf-8')
      }
    } catch (e: unknown) {
      // 文件不存在（首次访问）或 JSON 解析失败 → 空 Map 是正确回退
      const isEnoent = e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT'
      if (!isEnoent) {
        console.warn(`[plugin-storage] failed to load ${filePath}:`, e instanceof Error ? e.message : String(e))
      }
    }

    const cache: CacheEntry = { data, dirty: false, flushTimer: null, totalSize }
    this.caches.set(cacheKey, cache)
    return cache
  }

  private scheduleFlush(
    pluginId: string,
    scope: 'global' | 'workspace',
  ): void {
    const cacheKey = `${pluginId}:${scope}`
    const cache = this.caches.get(cacheKey)
    if (!cache) return
    if (cache.flushTimer) clearTimeout(cache.flushTimer)
    cache.flushTimer = setTimeout(() => {
      cache.flushTimer = null
      this.flush(pluginId).catch((e: unknown) => {
        console.error(`[plugin-storage] flush failed for ${pluginId}:`, e)
      })
    }, FLUSH_DEBOUNCE_MS)
  }

  private async writeToDisk(
    pluginId: string,
    scope: 'global' | 'workspace',
    cache: CacheEntry,
  ): Promise<void> {
    const filePath = this.getFilePath(pluginId, scope)
    const dir = join(filePath, '..')
    await mkdir(dir, { recursive: true })
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Array.from(cache.data)) obj[k] = v
    const content = JSON.stringify(obj, null, JSON_FORMAT_INDENT)
    // 原子写入: temp + rename
    const tmpPath = filePath + '.tmp'
    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, filePath)
  }

  private getFilePath(
    pluginId: string,
    scope: 'global' | 'workspace',
  ): string {
    if (scope === 'global') {
      return join(this.baseDir, 'plugins', pluginId, 'globalState.json')
    }
    const cwdHash = createHash('sha256')
      .update(this.projectRoot)
      .digest('hex')
      .slice(0, HASH_SLICE_LENGTH)
    return join(
      this.baseDir,
      'plugins',
      pluginId,
      `workspace-${cwdHash}.json`,
    )
  }
}

// ── SessionData 文件持久化（独立函数）────────────────────────────────

const SESSION_DATA_SIZE_LIMIT = TEN * MB // 10MB

/**
 * 将 sessionData 持久化到磁盘（原子写入）。
 * @param baseDir - 存储基础目录
 * @param sessionId - session ID
 * @param data - 内存缓存 Map
 */
export async function persistSessionData(
  baseDir: string,
  sessionId: string,
  data: Map<string, unknown>,
): Promise<void> {
  const obj: Record<string, unknown> = Object.fromEntries(data)
  const content = JSON.stringify(obj)

  // 容量检查
  if (Buffer.byteLength(content, 'utf-8') > SESSION_DATA_SIZE_LIMIT) {
    throw new Error(`Session data exceeds 10MB limit for session ${sessionId}`)
  }

  const dir = join(baseDir, 'session-data')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${sessionId}.json`)
  const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(RADIX_BASE36).slice(SLICE_START)}`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

/**
 * 从磁盘加载 sessionData。
 * 文件不存在时返回空 Map。
 */
export async function loadSessionData(
  baseDir: string,
  sessionId: string,
): Promise<Map<string, unknown>> {
  const filePath = join(baseDir, 'session-data', `${sessionId}.json`)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return new Map(Object.entries(parsed))
  } catch (e: unknown) {
    const isEnoent = e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT'
    if (!isEnoent) {
      console.warn(`[plugin-storage] loadSessionData failed for ${sessionId}:`, e instanceof Error ? e.message : String(e))
    }
    return new Map()
  }
}

/**
 * 删除 sessionData 文件。ENOENT 静默忽略。
 */
export async function deleteSessionData(
  baseDir: string,
  sessionId: string,
): Promise<void> {
  const filePath = join(baseDir, 'session-data', `${sessionId}.json`)
  try {
    await unlink(filePath)
  } catch (e: unknown) {
    const isEnoent = e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT'
    if (!isEnoent) {
      console.warn(`[plugin-storage] deleteSessionData failed for ${sessionId}:`, e instanceof Error ? e.message : String(e))
    }
  }
}
