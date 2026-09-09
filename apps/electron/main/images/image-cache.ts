/**
 * toolResult 图片缓存生命周期（crash-resilience §3.3 D6-⑨ / u7-memory-governance，main 侧）。
 *
 * 目录形态：`<dataDir>/cache/images/<sessionId>/<sha256(data)>.<ext>`（路径推导 SSOT =
 * shared paths.ts getImageCacheDir / getImageCacheRoot，穿越校验同款）。
 *
 * **纯缓存语义**：可随时丢弃、可幂等重建——
 * - 幂等写：文件名 = 内容 sha256，hash 命中（existsSync）跳过写直接返回 cached；
 * - LRU 驱逐（renderer 内存分区）永不调用本模块的删除 API——驱逐只释放内存，重进
 *   hydrate 重新编排时 hash 命中或从 base64 重建，磁盘层无感知；
 * - 三条文件系统级清理通道（判据全部在文件系统层，不依赖跨进程内存态）：
 *   ① session 删除级联（deleteSessionImageCache，runtime session-lifecycle 删除链调用）；
 *   ② 启动孤儿扫描（scanOrphanImageCaches：目录 mtime 超 30 天且路径内 sessionId 在 pi
 *      sessions 目录无对应 session 文件 → 判死删目录；文件级判据天然覆盖 subagent 虚拟
 *      分区——subagent 历史同存于 sessions 目录）；
 *   ③ 全局软上限（enforceImageCacheGlobalCap：总 size 超 512MB 时**只清孤儿判死目录**，
 *      mtime 老→新——不做「未在场分区引用」判定，跨窗口在场集不可见问题构造性消失，
 *      活 session 文件永不命中清理）。
 *
 * **单 session size 帽（64MB）**：超帽停止为该 session 落盘新图（writeImagesNewestFirst
 * 按新→旧序处理、超帽即停，更旧图返回 quota-full 由 renderer 显示「图片缓存已满」占位，
 * 不阻断消息流）。
 *
 * 实现形态：全部 sync fs（对齐 renderer-log-handler 先例——低频通道的同步写代价可忽略，
 * 换来无并发编排复杂度）；目录/路径参数显式注入（dataDir/sessionsDir 可选参，缺省经
 * shared paths 动态推导，测试注入 tmpdir——仓规测试红线：禁触碰真实 ~/.xyz-agent）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { getDataDir, getImageCacheDir, getImageCacheRoot } from '@xyz-agent/shared/paths'
import type { ImageCacheWriteImage, ImageCacheWriteImageResult, ImageCacheWriteResult } from '@xyz-agent/shared'

/** 字节/时间换算常量（帽值语义单位为 MB、孤儿龄语义单位为天，字面量收敛在此）。 */
const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

/** 单 session 帽（MB）：设计 D6-⑨ v5 硬帽封顶；越限停落盘显式占位非静默。 */
const SESSION_CACHE_MAX_MB = 64
/** 全局软上限（MB）：超限只清孤儿判死目录，mtime 老→新。 */
const GLOBAL_SOFT_CAP_MB = 512
/** 孤儿目录龄阈值（天）：mtime 判定，活跃 session 目录 mtime 持续刷新。 */
const ORPHAN_AGE_DAYS = 30

/** 单 session 图片缓存 size 帽：64MB。 */
export const IMAGE_CACHE_SESSION_MAX_BYTES = SESSION_CACHE_MAX_MB * BYTES_PER_MB

/** 全局软上限：512MB。 */
export const IMAGE_CACHE_GLOBAL_SOFT_CAP_BYTES = GLOBAL_SOFT_CAP_MB * BYTES_PER_MB

/** 孤儿扫描目录龄阈值：30 天。 */
export const IMAGE_CACHE_ORPHAN_AGE_MS = ORPHAN_AGE_DAYS * MS_PER_DAY

/** mimeType → 文件扩展名映射（缺省 .png 对齐设计字面形态）。 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** 本模块全部 fs 动作的参数面（测试注入 tmpdir；生产缺省动态推导）。 */
export interface ImageCacheDirs {
  /** 数据根目录（缺省 getDataDir()） */
  dataDir?: string
  /** pi sessions 目录（孤儿判据反查用；缺省 `<dataDir>/pi/agent/sessions`——shared paths SSOT 推导） */
  sessionsDir?: string
}

/** 逐图写入单图（内部原语：返回 null 表示 invalid，'quota-full' 语义由调用方判帽）。 */
function writeSingleImage(
  sessionId: string,
  image: ImageCacheWriteImage,
  dirs: ImageCacheDirs,
): { status: 'written' | 'cached'; path: string; bytes: number } | { status: 'invalid' } {
  if (typeof image.data !== 'string' || image.data === '' || typeof image.mimeType !== 'string') {
    return { status: 'invalid' }
  }
  // getImageCacheDir 内含 sessionId 穿越校验（throw）——异常向上传播为 invoke rejection，
  // IPC 壳层兜底 catch（防畸形 sessionId 写到任意位置）。
  const sessionDir = getImageCacheDir(sessionId, dirs.dataDir)
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })
  const hash = createHash('sha256').update(image.data).digest('hex')
  const ext = MIME_EXTENSIONS[image.mimeType] ?? '.png'
  const filePath = join(sessionDir, hash + ext)
  if (existsSync(filePath)) {
    return { status: 'cached', path: filePath, bytes: statSync(filePath).size }
  }
  const bytes = Buffer.byteLength(image.data, 'base64')
  writeFileSync(filePath, Buffer.from(image.data, 'base64'))
  return { status: 'written', path: filePath, bytes }
}

/** 统计目录总字节数（文件数有限，sync 遍历；目录不存在 → 0）。 */
function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const name of readdirSync(dir)) {
    const st = statSync(join(dir, name))
    if (st.isFile()) total += st.size
  }
  return total
}

/** 单 session 目录 size（帽判定 + 软上限清后复核共用）。 */
export function sessionImageCacheBytes(sessionId: string, dirs: ImageCacheDirs = {}): number {
  return dirBytes(getImageCacheDir(sessionId, dirs.dataDir))
}

/**
 * 按给定数组序落盘一批图片（数组序 = 落盘序）：超帽即停，后续图返回 quota-full。
 *
 * **顺序契约（设计 D6-⑨ v8 显式声明）**：调用方（core 编排层 persistImagesNewestFirst）
 * 传新→旧序——帽满时最新图已落盘、更旧图占位（「最新内容优先可见」）。live 单图传单
 * 元素数组（剩余额度内即写）。
 */
export function writeImagesNewestFirst(
  sessionId: string,
  images: ImageCacheWriteImage[],
  dirs: ImageCacheDirs = {},
  maxBytes: number = IMAGE_CACHE_SESSION_MAX_BYTES,
): ImageCacheWriteResult {
  const results: ImageCacheWriteImageResult[] = []
  let used = sessionImageCacheBytes(sessionId, dirs)
  let quotaFull = false
  for (const image of images) {
    if (quotaFull) {
      results.push({ status: 'quota-full' })
      continue
    }
    // 帽预检：新图字节超剩余额度 → 停（本图与后续全部 quota-full——超帽即停语义）。
    const incoming = typeof image.data === 'string' ? Buffer.byteLength(image.data, 'base64') : 0
    if (used + incoming > maxBytes) {
      quotaFull = true
      results.push({ status: 'quota-full' })
      continue
    }
    const r = writeSingleImage(sessionId, image, dirs)
    if (r.status === 'invalid') {
      results.push({ status: 'invalid' })
      continue
    }
    used += r.bytes
    results.push({ status: r.status, path: r.path, bytes: r.bytes })
  }
  return { results, quotaFull }
}

/** session 删除级联：删该 session 的 cache 子目录（best-effort，不存在 = 幂等 no-op）。 */
export function deleteSessionImageCache(sessionId: string, dirs: ImageCacheDirs = {}): void {
  rmSync(getImageCacheDir(sessionId, dirs.dataDir), { recursive: true, force: true })
}

/**
 * 孤儿判据（文件系统级）：cache 目录名（sessionId）在 pi sessions 目录无对应 session
 * 文件 → 判死。判据只看文件存在性——subagent 虚拟分区历史同存于 sessions 目录，天然覆盖。
 */
function isOrphanSessionDir(sessionDirName: string, dirs: ImageCacheDirs): boolean {
  // 缺省 `<dataDir>/pi/agent/sessions`（shared paths getPiAgentDir 同构推导——main 侧
  // 不 import runtime 的 getSessionsDir，包边界；dataDir 注入时直接拼保持测试 tmpdir 隔离）
  const sessionsDir = dirs.sessionsDir ?? join(dirs.dataDir ?? getDataDir(), 'pi', 'agent', 'sessions')
  if (!existsSync(sessionsDir)) return false
  for (const f of readdirSync(sessionsDir)) {
    // session 文件名形态 `<sessionId>.jsonl`（sidecar 是 `<sessionId>.jsonl.<suffix>`），
    // 取首个 '.' 前的主名比对。
    if (f.startsWith(sessionDirName + '.')) return false
  }
  return true
}

/** 孤儿扫描结果（A9③ 实证记录用）。 */
export interface OrphanScanResult {
  scanned: number
  removed: string[]
}

/**
 * 启动孤儿扫描：目录 mtime 超 30 天且孤儿判死 → rm 目录。mtime 阈值在前（廉价 stat），
 * sessions 目录列举在后（每判死目录一次 readdir）——活 session 目录零 sessions 扫描成本。
 */
export function scanOrphanImageCaches(dirs: ImageCacheDirs = {}, now: number = Date.now()): OrphanScanResult {
  const root = getImageCacheRoot(dirs.dataDir)
  const result: OrphanScanResult = { scanned: 0, removed: [] }
  if (!existsSync(root)) return result
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    result.scanned++
    let mtime: number
    try {
      mtime = statSync(dir).mtimeMs
    } catch {
      continue
    }
    if (now - mtime < IMAGE_CACHE_ORPHAN_AGE_MS) continue
    if (!isOrphanSessionDir(name, dirs)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      result.removed.push(name)
    } catch { void 0 } // best-effort：单目录删除失败不中断扫描（下轮启动重试）
  }
  return result
}

/** 全局软上限清理结果。 */
export interface SoftCapResult {
  totalBytes: number
  overCap: boolean
  removed: string[]
}

/**
 * 全局软上限（512MB）：超限时**只清孤儿判死目录**，mtime 老→新，直到回落帽下。
 * 活 session 目录永不命中清理（孤儿判据豁免）——设计 v5 裁决：任何进程级「在场集」
 * 都有跨窗口不可见问题，收敛到 session 级判死后判据全在文件系统层。
 */
export function enforceImageCacheGlobalCap(
  dirs: ImageCacheDirs = {},
  softCapBytes: number = IMAGE_CACHE_GLOBAL_SOFT_CAP_BYTES,
): SoftCapResult {
  const root = getImageCacheRoot(dirs.dataDir)
  const result: SoftCapResult = { totalBytes: 0, overCap: false, removed: [] }
  if (!existsSync(root)) return result

  interface Entry { name: string; bytes: number; mtime: number }
  const entries: Entry[] = []
  let total = 0
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      const st = statSync(dir)
      if (!st.isDirectory()) continue
      const bytes = dirBytes(dir)
      entries.push({ name, bytes, mtime: st.mtimeMs })
      total += bytes
    } catch {
      continue
    }
  }
  result.totalBytes = total
  if (total <= softCapBytes) return result
  result.overCap = true

  let cur = total
  // 只对孤儿判死目录动手，mtime 老→新
  const orphans = entries
    .filter((e) => isOrphanSessionDir(e.name, dirs))
    .sort((a, b) => a.mtime - b.mtime)
  for (const e of orphans) {
    if (cur <= softCapBytes) break
    try {
      rmSync(join(root, e.name), { recursive: true, force: true })
      cur -= e.bytes
      result.removed.push(e.name)
    } catch { void 0 } // best-effort 同上
  }
  return result
}

/**
 * 启动清扫（孤儿扫描 + 软上限，一次调用）：main 侧注册 IPC handler 时 fire-and-forget
 * 执行（app ready 后时序 = 启动扫描语义；全部异常消化，清理故障不阻塞启动）。
 */
export function runImageCacheStartupSweep(dirs: ImageCacheDirs = {}): void {
  try {
    scanOrphanImageCaches(dirs)
    enforceImageCacheGlobalCap(dirs)
  } catch { void 0 } // 清理通道故障静默（下轮启动重试；写入路径不受影响）
}

/** 从 session 文件路径派生 sessionId（runtime 删除链接线用：`<sid>.jsonl` → `<sid>`）。 */
export function sessionIdFromSessionFilePath(filePath: string): string {
  return basename(filePath).replace(/\.jsonl.*$/, '')
}
