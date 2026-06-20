import { mkdir, readFile, unlink } from 'node:fs/promises'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { toErrorMessage, isEnoent } from '../../utils/errors.js'
import { randomSuffix } from '../../utils/ids.js'
import { atomicWrite, atomicWriteAsync } from '../../utils/fs-utils.js'
import { WriteBackCache } from '../../utils/json-store.js'

// eslint-disable-next-line no-magic-numbers
const MB = 1024 * 1024 // 1,048,576 bytes
// eslint-disable-next-line no-magic-numbers
const MAX_TOTAL_SIZE = 10 * MB // 10MB
const MAX_VALUE_SIZE = 1 * MB // 1MB
const FLUSH_DEBOUNCE_MS = 500
const JSON_FORMAT_INDENT = 2
const HASH_SLICE_LENGTH = 12

/** KV 分区键：${pluginId}:${scope} */
type PartitionKey = string

export class PluginStorage {
  private cache: WriteBackCache<PartitionKey, string, unknown> | null = null
  private baseDir = ''
  private projectRoot = ''

  init(baseDir: string, projectRoot: string): void {
    this.baseDir = baseDir
    this.projectRoot = projectRoot
    const pluginsDir = join(baseDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })

    this.cache = new WriteBackCache<PartitionKey, string, unknown>(
      {
        loadPartition: (k) => this.loadPartition(k),
        persistPartition: (k, data) => this.persistPartition(k, data),
      },
      { flushMs: FLUSH_DEBOUNCE_MS },
      // 容量检查：单值 1MB（-32021）+ 分区总量 10MB（-32040）
      (_k, _ik, _v, partitionSize, valueSize) => {
        if (valueSize > MAX_VALUE_SIZE) {
          throw Object.assign(
            new Error(`Value exceeds 1MB limit (${valueSize} bytes)`),
            { code: -32021 },
          )
        }
        if (partitionSize > MAX_TOTAL_SIZE) {
          throw Object.assign(
            new Error('Storage exceeds 10MB limit'),
            { code: -32040 },
          )
        }
      },
    )
  }

  // ── Scoped API (global or workspace) ───────────────────────────

  get(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): unknown | undefined {
    return this.cache!.get(this.partitionKey(pluginId, scope), key)
  }

  set(pluginId: string, key: string, value: unknown, scope: 'global' | 'workspace' = 'global'): void {
    this.cache!.set(this.partitionKey(pluginId, scope), key, value)
  }

  delete(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): void {
    this.cache!.delete(this.partitionKey(pluginId, scope), key)
  }

  keys(pluginId: string, scope: 'global' | 'workspace' = 'global'): string[] {
    return this.cache!.keys(this.partitionKey(pluginId, scope))
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** flush 指定 pluginId 的所有 scope（global + workspace）。 */
  flush(pluginId: string): void {
    for (const scope of ['global', 'workspace'] as const) {
      this.cache!.flush(this.partitionKey(pluginId, scope))
    }
  }

  flushAll(): void {
    this.cache!.flushAll()
  }

  onExternalChange(pluginId: string): void {
    this.cache!.onExternalChange(this.partitionKey(pluginId, 'global'))
    this.cache!.onExternalChange(this.partitionKey(pluginId, 'workspace'))
  }

  /** 停掉所有待 flush 定时器（shutdown 用）。 */
  dispose(): void {
    this.cache?.dispose()
  }

  // ── Private ─────────────────────────────────────────────────────

  private partitionKey(pluginId: string, scope: 'global' | 'workspace'): PartitionKey {
    return `${pluginId}:${scope}`
  }

  private parsePartitionKey(k: PartitionKey): { pluginId: string; scope: 'global' | 'workspace' } {
    const parts = k.split(':')
    return { pluginId: parts[0], scope: (parts[1] ?? 'global') as 'global' | 'workspace' }
  }

  private loadPartition(k: PartitionKey): Map<string, unknown> {
    const { pluginId, scope } = this.parsePartitionKey(k)
    const filePath = this.getFilePath(pluginId, scope)
    const data = new Map<string, unknown>()
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [key, v] of Object.entries(parsed)) {
        data.set(key, v)
      }
    } catch (e: unknown) {
      // 文件不存在（首次访问）或 JSON 解析失败 → 空 Map 是正确回退
      if (!isEnoent(e)) {
        console.warn(`[plugin-storage] failed to load ${filePath}:`, toErrorMessage(e))
      }
    }
    return data
  }

  private persistPartition(k: PartitionKey, data: Map<string, unknown>): void {
    const { pluginId, scope } = this.parsePartitionKey(k)
    const filePath = this.getFilePath(pluginId, scope)
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const obj: Record<string, unknown> = {}
    for (const [key, v] of data) obj[key] = v
    const content = JSON.stringify(obj, null, JSON_FORMAT_INDENT)
    atomicWrite(filePath, content)
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

// eslint-disable-next-line no-magic-numbers
const SESSION_DATA_SIZE_LIMIT = 10 * MB // 10MB

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
  // 并发 flush 可能交叉，用唯一 tmp 后缀避免互相覆盖 tmp（atomicWriteAsync uniqueSuffix）
  await atomicWriteAsync(filePath, content, `${Date.now()}_${randomSuffix()}`)
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
      console.warn(`[plugin-storage] loadSessionData failed for ${sessionId}:`, toErrorMessage(e))
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
      console.warn(`[plugin-storage] deleteSessionData failed for ${sessionId}:`, toErrorMessage(e))
    }
  }
}
