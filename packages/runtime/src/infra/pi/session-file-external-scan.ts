/**
 * 外部目录 pi session 扫描（import-session D3 / U1）。
 *
 * 从 session-file-utils.ts 抽出的原因：后者有效行数撞 max-lines 预算（500），外部扫描域
 * （scanExternalSessions 及其独立 TTL 缓存 / 异步枚举辅助）整体迁出独立成档。与太极根
 * 扫描的共用原语（scanSessionMeta / isScannableSessionFile / SCAN_DIR_TTL_MS）仍由
 * session-file-utils 提供，本模块单向依赖；session-file-utils 不 re-export 本模块
 * （避免循环依赖），消费方直接 import 本文件。
 */
import { readdir as readdirAsync, stat as statAsync } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SCAN_DIR_TTL_MS,
  isScannableSessionFile,
  scanSessionMeta,
  type ScanSessionsOptions,
  type ScannedSessionMeta,
} from './session-file-utils.js'

// ── 外部目录扫描（import-session D3 / U1）────────────────────

/** 外部根扫描 TTL 缓存有效期：对齐太极根 SCAN_DIR_TTL_MS 惯例（1s），独立常量以容各自演化。 */
const SCAN_EXTERNAL_TTL_MS = SCAN_DIR_TTL_MS

/** 分批让出事件循环的批大小（D3/MF-3：每批 100 个文件后 setImmediate 让出）。 */
const SCAN_EXTERNAL_BATCH_SIZE = 100

/** 外部根扫描缓存条目。rootDir 作等值校验字段：外部根可变，切根即整体失效。 */
interface ScanExternalCacheEntry {
  rootDir: string
  items: ScannedSessionMeta[]
  expiresAt: number
}
let scanExternalCache: ScanExternalCacheEntry | null = null
/** 上次 scanExternalSessions 观测的 Date.now()（时钟回拨检测，与 scanPiSessions 同防护）。 */
let scanExternalLastNow = 0

/**
 * 扫描外部目录下的 pi session 文件（导入候选扫描原语，import-session D3 / U1）。
 *
 * 与太极根扫描（scanPiSessions → scanPiSessionsFromDisk）同构的收录语义：顶层 +
 * 一层子目录、isScannableSessionFile 过滤（含 `.tmp-migrate-` / `.tmp-import-` 残留
 * 家族）、scanSessionMeta 逐文件元数据提取——sessionMetaCache 键为
 * filePath+(mtimeMs,size)，跨根天然复用，同文件二次扫描零 IO。
 *
 * 执行模型（D3/MF-3）：目录遍历用 fs/promises 异步 API；逐文件 meta 提取沿用 sync 的
 * scanSessionMeta（单文件 header 首读 + 尾读通常 <1ms）但分批执行——每批
 * SCAN_EXTERNAL_BATCH_SIZE 个文件后 await setImmediate 让出事件循环，万级目录首扫被
 * 切成数十个短批，批间 WS 消息与流式广播照常处理。
 *
 * 缓存：独立于太极根 scanDirCache 的单条目 TTL 缓存（1s）——scanDirCache 无参取
 * getSessionsDir() 且为单条目缓存，不能承载可变 rootDir，故独立存放。
 * opts.force 绕过缓存强制重扫（导入成功后刷新外部根视图即传 force，D3）。
 *
 * @param rootDir 外部根目录（不存在/不可读 → items 为空数组，不抛错，与太极根同容错）
 * @param opts.force true 绕过 TTL 缓存强制重扫
 * @returns items 按 lastModified 降序（与 scanPiSessions 一致）+ 回显 rootDir
 */
export async function scanExternalSessions(
  rootDir: string,
  opts?: ScanSessionsOptions,
): Promise<{ items: ScannedSessionMeta[]; rootDir: string }> {
  const now = Date.now()
  const clockWentBackwards = now < scanExternalLastNow
  scanExternalLastNow = now
  if (
    !opts?.force &&
    !clockWentBackwards &&
    scanExternalCache &&
    scanExternalCache.rootDir === rootDir &&
    now < scanExternalCache.expiresAt
  ) {
    // 浅拷贝数组：消费者可安全 sort/splice，不污染缓存本体（与 scanPiSessions 同契约）
    return { items: [...scanExternalCache.items], rootDir }
  }

  // 阶段 1（异步）：枚举候选文件路径。目录遍历结果不缓存——readdir/stat 开销小，
  // 缓存只收 meta 提取结果，重扫时 sessionMetaCache 兜底零 IO。
  const files = await listExternalSessionFiles(rootDir)

  // 阶段 2（分批 sync）：逐文件 scanSessionMeta，每批后让出事件循环。
  const items: ScannedSessionMeta[] = []
  for (let i = 0; i < files.length; i++) {
    if (i > 0 && i % SCAN_EXTERNAL_BATCH_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    try {
      const meta = scanSessionMeta(files[i])
      if (meta) items.push(meta)
    // eslint-disable-next-line taste/no-silent-catch -- scanning: skip unreadable session entry
    } catch {
      // skip：单文件扫描失败不中断（与 scanPiSessionsFromDisk 同容错语义）
    }
  }

  items.sort((a, b) => b.lastModified - a.lastModified)
  // force 刷新同样写缓存：随后 1s 内的候选列表消费方零 IO 读到最新视图（与 scanPiSessions 同策略）。
  scanExternalCache = { rootDir, items, expiresAt: now + SCAN_EXTERNAL_TTL_MS }
  return { items: [...items], rootDir }
}

/**
 * 枚举外部根下的候选 session 文件路径：顶层文件 + 一层子目录内文件（与
 * scanPiSessionsFromDisk 同深度假设，更深层静默跳过——D3/S8，UI tooltip 声明）。
 * isScannableSessionFile 过滤在此应用：候选列表从机制上看不到任何非 final 名文件。
 * 根目录不存在/不可读 → 空数组（不抛错）；子目录 readdir 失败跳过不影响其余。
 */
async function listExternalSessionFiles(rootDir: string): Promise<string[]> {
  let topEntries: string[]
  try {
    topEntries = await readdirAsync(rootDir)
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of topEntries) {
    const entryPath = join(rootDir, entry)
    let entryStat
    try {
      entryStat = await statAsync(entryPath)
    } catch {
      continue
    }
    if (entryStat.isDirectory()) {
      let subEntries: string[]
      try {
        subEntries = await readdirAsync(entryPath)
      } catch {
        continue // skip unreadable dir
      }
      for (const name of subEntries) {
        if (isScannableSessionFile(name)) files.push(join(entryPath, name))
      }
    } else if (isScannableSessionFile(entry)) {
      files.push(entryPath)
    }
  }
  return files
}
