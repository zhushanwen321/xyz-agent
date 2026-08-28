/**
 * SessionData 内存缓存 + 持久化编排
 *
 * 封装 sessionData 的 per-session KV 缓存、dirty 跟踪、定时 flush、磁盘恢复、
 * clear 等生命周期。底层用 WriteBackCache（与 PluginStorage 同一抽象，P0-1 C6）。
 *
 * 消费者（PluginService、session-data-api、plugin-rpc-setup）通过本类的公共方法
 * 操作 sessionData，不再直接持有散落的 Map。
 *
 * size 口径统一为 Buffer.byteLength（修复原 JSON.stringify().length 的 UTF-16 偏差）。
 */

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readdirSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { WriteBackCache } from '../../utils/json-store.js'
import { errorWithCode } from '../../utils/errors.js'
import { PluginRpcErrorCodes } from './plugin-types.js'

// eslint-disable-next-line no-magic-numbers
const MB = 1024 * 1024
// eslint-disable-next-line no-magic-numbers
const DEFAULT_MAX_SESSION_DATA_BYTES = 10 * MB
const FLUSH_DEBOUNCE_MS = 500
/** H1: session-data 持久化子目录名（configDir 下）。提常量消除 4 处魔法串重复。 */
const SESSION_DATA_DIRNAME = 'session-data'
/** [SEC-A5] 防御拒绝 message 中 sessionId 的回显截断长度（防超长输入撑爆日志） */
const SESSION_ID_PREVIEW_CHARS = 64

export class SessionDataStore {
  /** write-back 缓存：分区键 = sessionId，内键 = key，值 = unknown */
  private readonly cache: WriteBackCache<string, string, unknown>
  /** 配置根目录（session-data 持久化用），由组合根注入，不再直连 infra。 */
  private readonly configDir: string

  /**
   * @param configDir xyz-agent 配置根（~/.xyz-agent/），session-data 持久化目录的父。
   * @param maxSizeBytes 单 session 最大字节数，默认 10MB。
   * @param storageFullCode 容量超限时抛出错误的 code（由调用方注入，避免叶子层硬编码 RPC 码）。
   */
  constructor(
    configDir: string,
    maxSizeBytes: number = DEFAULT_MAX_SESSION_DATA_BYTES,
    storageFullCode: number = PluginRpcErrorCodes.STORAGE_FULL,
  ) {
    this.configDir = configDir
    this.cache = new WriteBackCache<string, string, unknown>(
      {
        loadPartition: (sessionId) => this.loadPartitionSync(sessionId),
        persistPartition: (sessionId, data) => this.persistPartition(sessionId, data),
      },
      { flushMs: FLUSH_DEBOUNCE_MS },
      // 容量检查：单 session 总量超限抛错（错误码由调用方经 storageFullCode 注入，避免叶子层硬编码 RPC 码）
      (_sessionId, _key, _value, partitionSize) => {
        if (partitionSize > maxSizeBytes) {
          throw errorWithCode(`Session data storage full (${partitionSize} > ${maxSizeBytes} bytes)`, storageFullCode)
        }
      },
    )
  }

  // ── KV 操作（供 session-data-api RPC 调用） ──────────────────

  get(sessionId: string, key: string): unknown | undefined {
    return this.cache.get(sessionId, key)
  }

  set(sessionId: string, key: string, value: unknown): void {
    this.cache.set(sessionId, key, value)
  }

  delete(sessionId: string, key: string): void {
    this.cache.delete(sessionId, key)
  }

  keys(sessionId: string): string[] {
    return this.cache.keys(sessionId)
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 将所有 dirty 数据批量 flush */
  flushAll(): void {
    this.cache.flushAll()
  }

  /** flush 指定 session 的 dirty 数据 */
  flushSession(sessionId: string): void {
    this.cache.flush(sessionId)
  }

  /** 从磁盘恢复所有 sessionData（initialize 时调用） */
  restoreFromDisk(): void {
    try {
      const sessionDataDir = join(this.configDir, SESSION_DATA_DIRNAME)
      if (!existsSync(sessionDataDir)) return
      const files = readdirSync(sessionDataDir)
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '')
          // 触发 WriteBackCache lazy load（loadPartition 会读盘）
          const data = this.cache.keys(sessionId)
          if (data.length === 0) continue
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- sessionData restore: directory may not exist initially
    } catch {
      // Directory doesn't exist yet, that's fine
    }
  }

  /** 清理指定 session 的内存缓存 + 磁盘文件 */
  clearSession(sessionId: string): void {
    // 先做路径防御校验再动状态：拒绝时缓存分区保持原样（fail fast，不留半更新状态）
    const filePath = this.resolveSessionFilePath(sessionId)
    this.cache.onExternalChange(sessionId)
    // 同步删除磁盘文件：避免删除后 lazy load 把文件内容又读回内存。
    try {
      rmSync(filePath, { force: true })
    // eslint-disable-next-line taste/no-silent-catch -- clearSession: file may not exist
    } catch {
      // best-effort
    }
  }

  /** shutdown 清理（落盘保障 = per-write debounce 500ms + 退出前 flushAll）。 */
  dispose(): void {
    this.cache.dispose()
  }

  // ── Private（WriteBackCache backing 回调） ──────────────────

  /**
   * [SEC-A5 深度防御] 解析 sessionId 对应的持久化文件绝对路径，并确保结果
   * 仍落在 session-data 目录内。入口层（session-data-api 的 asSafeKey 白名单）
   * 已拒绝非法标识符，这里用 path.resolve/relative 兜底拦「上游漏网」的
   * `..` 遍历与跨盘绝对路径，保证任何调用路径都无法把读/写/删引到数据
   * 目录之外。合法输入（白名单内的 sessionId）行为与 resolve 前完全一致。
   */
  private resolveSessionFilePath(sessionId: string): string {
    const dir = resolve(this.configDir, SESSION_DATA_DIRNAME)
    const filePath = resolve(dir, `${sessionId}.json`)
    const rel = relative(dir, filePath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw errorWithCode(
        `Invalid sessionId ${JSON.stringify(sessionId.slice(0, SESSION_ID_PREVIEW_CHARS))}: resolved path escapes `
        + `the session-data directory (${dir}). sessionId must match /^[A-Za-z0-9._-]{1,128}$/ `
        + `(no path separators or '..'). This defense-in-depth rejection means the RPC entry `
        + `layer validation was bypassed — report it as a bug if reached via plugin RPC.`,
        'INVALID_SESSION_ID',
      )
    }
    return filePath
  }

  private loadPartitionSync(sessionId: string): Map<string, unknown> {
    // [SEC-A5] 校验必须在 try 外：防御性拒绝要向上冒，不能被下方 ENOENT
    // 容错 catch 吞掉（否则恶意 sessionId 会静默退化为「空分区可写入」）
    const filePath = this.resolveSessionFilePath(sessionId)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return new Map(Object.entries(parsed))
    } catch {
      return new Map()
    }
  }

  private persistPartition(sessionId: string, data: Map<string, unknown>): void {
    // sync atomicWrite（与 PluginStorage 一致）。容量检查在 onSet 已拦截，
    // 此处不再重复校验。flush 前会 clearTimeout，同一分区无并发写，固定 .tmp 名安全。
    // [SEC-A5] 写盘前过同款 resolve 防御；若被上游漏网触发，WriteBackCache.flush
    // 会捕获并保留 dirty 重试（不 crash），但文件绝不会被写到目录外。
    const filePath = this.resolveSessionFilePath(sessionId)
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const content = JSON.stringify(Object.fromEntries(data))
    atomicWrite(filePath, content)
  }
}
