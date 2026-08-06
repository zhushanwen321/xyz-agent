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
 * 依赖方向：update-self-healer → constants + node:fs/path
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { UPDATE_RESULT_FILE } from './constants.js'

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
