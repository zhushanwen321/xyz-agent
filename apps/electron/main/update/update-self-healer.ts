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
 * - mac：rm 半截 .app → mv .old 回 .app（恢复上次稳定版本）
 * - linux AppImage：rm 半截 AppImage → mv .old 回 AppImage（单文件，与 mac 同语义）
 * - 写 result status='rolled-back' 标记已处理（下次启动 no-op）
 *
 * [HISTORICAL] 不变量：
 * - 只在 status='replacing' 时进入回滚分支（done/failed/rolled-back 都是终态，no-op）
 * - 区分 .old 是否存在：避免误把"下载期失败"标成 rolled-back（语义误导，监控/用户
 *   会以为回滚了一个其实没动过的安装）
 * - 自愈失败绝不阻塞 app 启动（返回 false，仅 console.error 记录）
 * - mac 回滚依赖 updater.sh 写的 .old 备份（rm-then-mv 决策树产物）
 * - linux 回滚依赖 updater-linux.sh 的 mv .old 备份（v2 起 unlink → mv .old）
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
  try {
    if (!existsSync(UPDATE_RESULT_FILE)) return false

    const raw = readFileSync(UPDATE_RESULT_FILE, 'utf-8')
    const data = JSON.parse(raw) as UpdateResultData
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

    // .old 存在：替换阶段被中断，半截态残留 → 真正回滚（rm 半截 + mv .old 回来）
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
 * - mac：execPath .../xyz-agent.app/Contents/MacOS/xyz-agent → dirname×3 得 .app，
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
 * mac .app bundle 回滚：.old 存在 → rm 半截 .app → mv .old 回 .app。
 *
 * execPath 推导 .app 路径：.../xyz-agent.app/Contents/MacOS/xyz-agent → dirname×3
 */
function rollbackMacBundle(): void {
  const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
  const oldBundle = `${appBundle}.old`
  if (existsSync(appBundle)) {
    rmSync(appBundle, { recursive: true, force: true })
  }
  renameSync(oldBundle, appBundle)
}

/**
 * linux AppImage 回滚：.old 存在 → rm 半截 AppImage → mv .old 回 AppImage。
 *
 * AppImage 是单文件（非目录），用 rmSync force（兼容文件/目录）。
 */
function rollbackLinuxAppImage(): void {
  const appImage = process.env.APPIMAGE
  if (!appImage) return
  const oldImage = `${appImage}.old`
  if (existsSync(appImage)) {
    rmSync(appImage, { force: true })
  }
  renameSync(oldImage, appImage)
}
