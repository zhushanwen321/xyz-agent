/**
 * 启动自愈器（检测上次中断的升级并回滚）。
 *
 * 对应 slice auto-update-and-install w3：app 启动时（whenReady 内、bootstrapMainWindow 之前）
 * 读 update-result.json，若 status='replacing'（上次升级被中断：崩溃/断电/强杀），
 * 按备份存在与否区分两种情况：
 *   - .old 备份存在 → updater 脚本已把原版本 mv 到 .old（替换阶段被中断）→ 真正回滚
 *     （rm 半截态 + mv .old 回来）→ 写 status='rolled-back'，返回 true
 *   - .old 不存在 → 中断发生在下载/校验阶段（download-asset 在替换前就失败，原 app
 *     未被改动，无 .old 产物）→ 无需回滚 → 写 status='no-op'，返回 false
 *
 * 回滚策略（.old 存在时）：
 * - mac：原子化恢复——先把破损 .app rename 到 .broken，再 mv .old 回 .app，最后清理 .broken
 *   （避免 rm 后 rename 失败导致 app 路径为空）
 * - linux AppImage：同 mac 策略（.broken 中间态）
 * - 写 result status='rolled-back' 标记已处理（下次启动 no-op）
 *
 * [HISTORICAL] 不变量：
 * - 只在 status='replacing' 时进入回滚分支（done/failed/rolled-back 都是终态，no-op）
 * - 区分 .old 是否存在：避免误把"下载期失败"标成 rolled-back（语义误导，监控/用户
 *   会以为回滚了一个其实没动过的安装）
 * - 自愈失败绝不阻塞 app 启动（返回 false，仅 console.error 记录）
 * - mac 回滚依赖 updater.sh 写的 .old 备份（rm-then-mv 决策树产物）
 * - linux 回滚依赖 updater-linux.sh 的 mv .old 备份（v2 起 unlink → mv .old）
 * - result.json 解析失败时，若内容含 'replacing' 且 .old 存在，仍尝试回滚
 *   （写入中断的半截 JSON 不应让破损 app 蒙混过关）
 *
 * 依赖方向：update-self-healer → constants + types + compare-versions + electron + node:fs/path
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LaunchResult } from '@xyz-agent/shared'
import { compare } from 'compare-versions'
import { app } from 'electron'
import {
  LINUX_UPDATER_LOG_PATH,
  LINUX_UPDATER_SCRIPT_PATH,
  PENDING_UPDATE_FILE,
  PRELOADED_UPDATE_FILE,
  UPDATE_DIR,
  UPDATE_RESULT_FILE,
  UPDATER_LOG_PATH,
  UPDATER_SCRIPT_PATH,
} from './constants.js'
import type { UpdateResultStatus } from './types.js'

/** update-result.json 的合法结构（运行时校验） */
interface UpdateResultData {
  status?: unknown
  version?: unknown
}

/**
 * 检测并回滚上次中断的升级。
 *
 * 在 app.whenReady 内、bootstrapMainWindow 之前调用。
 *
 * @returns true=执行了回滚（.old 存在，已 rm 半截 + mv .old 回来），
 *          false=无需回滚（终态/无 result/.old 不存在/自愈失败，均不阻塞启动）
 */
export async function maybeRollbackInterruptedUpdate(): Promise<boolean> {
  if (!existsSync(UPDATE_RESULT_FILE)) return false

  // 读取与解析分开 try：解析失败时 catch 仍能访问 raw 内容，
  // 据此判断是否是「写入中断的半截 replacing JSON」并尝试回滚。
  let raw: string
  try {
    raw = readFileSync(UPDATE_RESULT_FILE, 'utf-8')
  } catch (e) {
    // 读文件本身失败（权限/IO 错误）：记录但不阻塞启动
    console.error('[update-self-healer] read result failed:', e)
    return false
  }

  let data: UpdateResultData
  try {
    data = JSON.parse(raw) as UpdateResultData
  } catch (e) {
    // JSON 解析失败：可能是写入中断导致半截 JSON。
    // 保守策略：若原始内容含 'replacing' 子串（说明 status 字段写了一半），
    // 且 .old 备份存在，仍尝试回滚（宁可误回滚也不留破损 app）。
    if (typeof raw === 'string' && raw.includes('replacing')) {
      const oldPath = getOldBackupPath()
      if (oldPath && existsSync(oldPath)) {
        console.warn(
          '[update-self-healer] corrupt result.json but .old exists, attempting rollback',
        )
        try {
          if (process.platform === 'darwin') rollbackMacBundle()
          else if (process.platform === 'linux') rollbackLinuxAppImage()
          // 标记已回滚（下次启动 no-op）；写失败也不影响（已回滚到位）
          try {
            writeFileSync(
              UPDATE_RESULT_FILE,
              JSON.stringify({
                status: 'rolled-back',
                at: new Date().toISOString(),
                reason: 'rolled back after corrupt result.json',
              }),
            )
          // eslint-disable-next-line taste/no-silent-catch -- best-effort：标记写入失败不影响已完成的回滚
          } catch (writeErr) {
            console.warn('[update-self-healer] write rolled-back marker failed:', writeErr)
          }
          console.log('[update-self-healer] rolled back after corrupt result.json')
          return true
        // eslint-disable-next-line taste/no-silent-catch -- best-effort：回滚失败不阻塞启动
        } catch (rollbackErr) {
          console.error(
            '[update-self-healer] rollback after corrupt json failed:',
            rollbackErr,
          )
        }
      }
    }
    console.error('[update-self-healer] failed to parse result:', e)
    return false
  }

  try {
    if (data.status !== 'replacing') return false // done/failed/rolled-back 都是终态

    const oldPath = getOldBackupPath()
    // .old 不存在：中断发生在下载/校验阶段，原 app 未被改动 → 无需回滚。
    // 写 no-op 避免下次启动重复检测；返回 false 表示"没有回滚动作"。
    if (!oldPath || !existsSync(oldPath)) {
      writeFileSync(
        UPDATE_RESULT_FILE,
        JSON.stringify({
          status: 'no-op',
          version: typeof data.version === 'string' ? data.version : undefined,
          at: new Date().toISOString(),
          reason: 'no .old backup: interrupted before replace phase',
        }),
      )
      console.log('[update-self-healer] interrupted update had no .old backup; no-op')
      return false
    }

    // .old 存在：替换阶段被中断，半截态残留 → 真正回滚
    if (process.platform === 'darwin') {
      rollbackMacBundle()
    } else if (process.platform === 'linux') {
      rollbackLinuxAppImage()
    }

    // 标记已回滚（下次启动 no-op）
    writeFileSync(
      UPDATE_RESULT_FILE,
      JSON.stringify({
        status: 'rolled-back',
        version: typeof data.version === 'string' ? data.version : undefined,
        at: new Date().toISOString(),
      }),
    )
    console.log('[update-self-healer] rolled back interrupted update')
    return true
  } catch (e) {
    // 自愈失败不阻塞启动：仅记录，靠下次启动重试或用户手动恢复
    console.error('[update-self-healer] failed:', e)
    return false
  }
}

/** cleanupCompletedUpdate 需处理的终态集合（replacing 由 maybeRollbackInterruptedUpdate 处理） */
const TERMINAL_CLEANUP_STATUSES: readonly UpdateResultStatus[] = [
  'done',
  'failed',
  'rolled-back',
  'no-op',
]

/**
 * 幂等删除：文件不存在(ENOENT)静默，其他错误 rethrow。
 *
 * 升级产物清理场景下，文件已被外部清理（用户手动删 / 上次清理已删）是常态而非异常，
 * 用本函数避免对每个产物逐一 existsSync 判空。仅吞 ENOENT（预期），其他 IO 错误需暴露
 * （交由 {@link cleanupCompletedUpdate} 的外层 try/catch 记录）。
 */
export function ignoreENOENT(target: string): void {
  try {
    unlinkSync(target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/**
 * 启动时清理已完成/失败的升级产物，并返回终态上下文供 renderer 通知用户。
 *
 * 修复根因：升级成功后 update-result.json status='done'，但 maybeRollbackInterruptedUpdate
 * 只处理 'replacing'，done/failed/rolled-back/no-op 终态直接 return false 不清理 → 170MB zip
 * 永久残留 + preloaded-update.json 残留导致下次启动误恢复「已下载」态。本函数在
 * maybeRollbackInterruptedUpdate 之后调用，清理这些终态产物。
 *
 * 清理矩阵（终态简化为「全部清含 result 自身」，仅 done 做版本校验）：
 * - done + app.getVersion() >= data.version（真 done，已升级到目标版本）→ 清全部含 result
 * - done + app.getVersion() < data.version（假 done，app 仍旧版）→ 不清（result 未生效/过期）
 * - failed / rolled-back / no-op → 清全部含 result
 * - replacing → 不归本函数（maybeRollbackInterruptedUpdate 处理）
 *
 * 路径注入防护：删除 preloaded 记录的下载 zip 前，校验其 path.resolve 结果在 UPDATE_DIR 之内，
 * 不在则 warn 跳过（防 preloaded 文件被篡改指向任意路径导致误删用户文件）。
 *
 * 永不抛错、永不阻塞启动：整体 try/catch + console.warn。在 main.ts 的 whenReady 内、
 * maybeRollbackInterruptedUpdate 之后调用。
 *
 * @returns 有意义的终态上下文（done/failed/rolled-back），供 renderer 通知用户；
 *          no-op 或无 result 返回 null（不通知）。
 */
export async function cleanupCompletedUpdate(): Promise<LaunchResult | null> {
  try {
    if (!existsSync(UPDATE_RESULT_FILE)) return null

    let data: UpdateResultData
    try {
      data = JSON.parse(readFileSync(UPDATE_RESULT_FILE, 'utf-8')) as UpdateResultData
    } catch {
      // 文件读失败（existsSync 与 read 间竞态/权限）/ JSON 解析失败（半截写入）：均视为无可清理，no-op
      return null
    }

    const status = typeof data.status === 'string' ? (data.status as UpdateResultStatus) : undefined
    if (!status || !TERMINAL_CLEANUP_STATUSES.includes(status)) {
      return null // replacing / 未知状态：不归本函数
    }

    // done 需版本校验：仅当 app 确已升级到目标版本才清理（version <= current）。
    // 非 semver 版本号无法判定真假 done → 保守不清（与 readPendingUpdate 的 catch+keep 对称）。
    if (status === 'done') {
      let realDone = false
      try {
        realDone = compare(
          app.getVersion(),
          typeof data.version === 'string' ? data.version : '',
          '>=',
        )
      } catch (e) {
        console.warn('[update-self-healer] done status version compare failed, skip cleanup:', e)
        return null
      }
      if (!realDone) return null // 假 done：app 仍旧版，result 可能未生效，不清
    }

    // ── 捕获终态上下文（在清理 result 自身之前）────────────────
    const version = typeof data.version === 'string' ? data.version : ''
    const launchResult: LaunchResult | null =
      (status === 'done' || status === 'failed' || status === 'rolled-back') && version
        ? { status, version }
        : null

    // ── 清理产物 ────────────────────────────────────────────────
    // 1. preloaded-update.json：先读其 filePath（指向下载 zip），再删 json + zip
    if (existsSync(PRELOADED_UPDATE_FILE)) {
      let preloadedFilePath: string | null = null
      try {
        const pre = JSON.parse(readFileSync(PRELOADED_UPDATE_FILE, 'utf-8')) as unknown
        if (
          pre &&
          typeof pre === 'object' &&
          typeof (pre as Record<string, unknown>).filePath === 'string'
        ) {
          preloadedFilePath = (pre as Record<string, unknown>).filePath as string
        }
      } catch (e) {
        // preloaded 损坏：无法取得可信 filePath，仅删 json 本身（zip 留待下次或手动清理）
        console.warn('[update-self-healer] preloaded parse failed, skip zip deletion:', e)
      }
      // 删下载 zip（路径注入防护：必须在 UPDATE_DIR 内）
      if (preloadedFilePath) {
        const resolved = path.resolve(preloadedFilePath)
        const updateDirPrefix = path.resolve(UPDATE_DIR) + path.sep
        if (resolved.startsWith(updateDirPrefix)) {
          ignoreENOENT(resolved)
        } else {
          console.warn(`[update-self-healer] skip download zip outside UPDATE_DIR: ${resolved}`)
        }
      }
      ignoreENOENT(PRELOADED_UPDATE_FILE)
    }

    // 2. 其余产物（固定路径，无注入风险）
    ignoreENOENT(PENDING_UPDATE_FILE)
    ignoreENOENT(UPDATER_SCRIPT_PATH)
    ignoreENOENT(LINUX_UPDATER_SCRIPT_PATH)
    ignoreENOENT(UPDATER_LOG_PATH)
    ignoreENOENT(LINUX_UPDATER_LOG_PATH)

    // 3. 下载中断残留（.downloading 临时文件）
    if (existsSync(UPDATE_DIR)) {
      for (const f of readdirSync(UPDATE_DIR)) {
        if (f.endsWith('.downloading')) {
          ignoreENOENT(path.join(UPDATE_DIR, f))
        }
      }
    }

    // 4. result 自身最后删（标记本次清理完成；下次启动无 result → no-op）
    ignoreENOENT(UPDATE_RESULT_FILE)

    return launchResult
  } catch (e) {
    // 永不阻塞启动：仅 warn
    console.warn('[update-self-healer] cleanupCompletedUpdate failed:', e)
    return null
  }
}

/**
 * 推导当前平台的 .old 备份路径（若平台/环境不支持自更新则返回 undefined）。
 *
 * - mac：execPath .../太极.app/Contents/MacOS/TaiJi → dirname×3 得 .app，
 *   备份在 `<appBundle>.old`
 * - linux：process.env.APPIMAGE → 备份在 `${APPIMAGE}.old`
 * - win/其他：返回 undefined（win 走 NSIS，无 .old 备份机制）
 */
function getOldBackupPath(): string | undefined {
  if (process.platform === 'darwin') {
    const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
    return `${appBundle}.old`
  }
  if (process.platform === 'linux') {
    const appImage = process.env.APPIMAGE
    return appImage ? `${appImage}.old` : undefined
  }
  return undefined
}

/**
 * mac .app bundle 回滚：.old 存在 → 原子化恢复。
 *
 * 原子化策略（避免 rm 后 rename 失败导致 app 路径为空）：
 *   1. 先把破损 .app rename 到 .broken（rename 失败才退回 rmSync）
 *   2. rename .old 回 .app（失败则把 .broken 还回去，至少有 app 可用）
 *   3. 成功后清理 .broken
 *
 * execPath 推导 .app 路径：.../太极.app/Contents/MacOS/TaiJi → dirname×3
 */
function rollbackMacBundle(): void {
  const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
  const oldBundle = `${appBundle}.old`
  const brokenBundle = `${appBundle}.broken`
  // 1. 把破损 .app 移到 .broken（不直接 rm：rename 失败时原 app 仍在原位）
  if (existsSync(appBundle)) {
    try {
      renameSync(appBundle, brokenBundle)
    } catch (renameErr) {
      // rename 失败（跨设备/权限）：rm 作为最后手段
      console.warn('[update-self-healer] rename to .broken failed, falling back to rm:', renameErr)
      rmSync(appBundle, { recursive: true, force: true })
    }
  }
  // 2. 恢复 .old 到原位
  try {
    renameSync(oldBundle, appBundle)
  } catch (e) {
    // rename .old 失败：尝试把 .broken 还回去（至少保留一个可用的 app）
    if (existsSync(brokenBundle)) {
      try {
        renameSync(brokenBundle, appBundle)
      // eslint-disable-next-line taste/no-silent-catch -- best-effort：.broken 无法恢复，记录即可
      } catch (restoreErr) {
        console.warn('[update-self-healer] restore .broken failed:', restoreErr)
      }
    }
    throw e
  }
  // 3. 成功后清理 .broken（清理失败不影响回滚结果）
  try {
    rmSync(brokenBundle, { recursive: true, force: true })
  // eslint-disable-next-line taste/no-silent-catch -- best-effort：清理失败不影响回滚结果
  } catch (cleanupErr) {
    console.warn('[update-self-healer] cleanup .broken failed:', cleanupErr)
  }
}

/**
 * linux AppImage 回滚：.old 存在 → 原子化恢复。
 *
 * 原子化策略与 mac 一致：先把破损 AppImage rename 到 .broken，再 rename .old 回原位，
 * 最后清理 .broken。AppImage 是单文件（非目录）。
 */
function rollbackLinuxAppImage(): void {
  const appImage = process.env.APPIMAGE
  if (!appImage) return
  const oldImage = `${appImage}.old`
  const brokenImage = `${appImage}.broken`
  // 1. 把破损 AppImage 移到 .broken
  if (existsSync(appImage)) {
    try {
      renameSync(appImage, brokenImage)
    } catch (renameErr) {
      // rename 失败：rm 作为最后手段
      console.warn('[update-self-healer] linux rename to .broken failed, falling back to rm:', renameErr)
      rmSync(appImage, { force: true })
    }
  }
  // 2. 恢复 .old 到原位
  try {
    renameSync(oldImage, appImage)
  } catch (e) {
    // rename .old 失败：把 .broken 还回去
    if (existsSync(brokenImage)) {
      try {
        renameSync(brokenImage, appImage)
      // eslint-disable-next-line taste/no-silent-catch -- best-effort：.broken 无法恢复，记录即可
      } catch (restoreErr) {
        console.warn('[update-self-healer] linux restore .broken failed:', restoreErr)
      }
    }
    throw e
  }
  // 3. 成功后清理 .broken
  try {
    rmSync(brokenImage, { force: true })
  // eslint-disable-next-line taste/no-silent-catch -- best-effort：清理失败不影响回滚结果
  } catch (cleanupErr) {
    console.warn('[update-self-healer] linux cleanup .broken failed:', cleanupErr)
  }
}
