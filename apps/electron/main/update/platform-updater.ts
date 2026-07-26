/**
 * 三平台升级替换器。
 *
 * 对应 slice auto-update-and-install w3：根据 process.platform 选择对应 Updater，
 * 生成替换脚本/参数，触发替换动作（mac/linux spawn detached bash，win 返回 NSIS 参数）。
 *
 * [HISTORICAL] 不变量：
 * - mac：detached bash 脚本（含 sha256 二次校验 + rm-then-mv 回滚决策树），prepareUpdate 内已 spawn
 * - linux：AppImage 走 detached 脚本（与 mac 一致，避免双实例）；deb 包（APPIMAGE undefined）走 unsupported
 * - win：返回 NSIS 静默安装参数，由 orchestrator 负责 spawn（不在 prepareUpdate 内 spawn，
 *   保持 mac/linux/win 返回值语义一致：orchestrator 据 ref.kind 决定后续动作）
 * - dev 模式（!app.isPackaged）一律拒绝自更新（避免覆盖 dev 环境）
 * - .app bundle 路径推导：process.execPath（.../xyz-agent.app/Contents/MacOS/xyz-agent）
 *   向上 3 层 dirname 得到 .app 目录
 *
 * 依赖方向：platform-updater → electron(app) + node:child_process/fs + updater-script
 *           + constants + types + @xyz-agent/shared
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LatestReleaseInfo } from '@xyz-agent/shared'
import {
  LINUX_UPDATER_SCRIPT_PATH,
  LINUX_UPDATER_LOG_PATH,
  UPDATE_DIR,
  UPDATER_LOG_PATH,
  UPDATER_SCRIPT_PATH,
} from './constants.js'
import { buildLinuxUpdaterScript, buildUpdaterScript, buildWinInstallerArgs } from './updater-script.js'
import { UpdateError, UpdateUnsupportedError } from './types.js'
import type { UpdateScriptRef } from './types.js'

/** 平台升级器接口 */
export interface PlatformUpdater {
  /**
   * 准备替换动作。
   *
   * @param downloadedFilePath download-asset 返回的已下载文件路径（通过 sha256 校验）
   * @param release 当前 release 信息（取 sha256 / version / htmlUrl）
   * @returns 替换动作描述（mac/linux detached-script / win spawn-installer）
   */
  prepareUpdate(downloadedFilePath: string, release: LatestReleaseInfo): UpdateScriptRef
}

/**
 * mac 升级器。
 *
 * 流程：生成 detached bash 脚本 → 写盘 + chmod 755 → spawn detached（unref，不阻塞 app.quit）。
 */
export class MacUpdater implements PlatformUpdater {
  prepareUpdate(downloadedFilePath: string, release: LatestReleaseInfo): UpdateScriptRef {
    if (!app.isPackaged) throw new UpdateError('dev mode does not support self-update', 'replacing')
    // 推导 .app bundle 路径：execPath = .../xyz-agent.app/Contents/MacOS/xyz-agent
    // dirname×3 = .../xyz-agent.app
    const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
    // 布局守卫：dirname×3 假设标准 .app/Contents/MacOS/<binary> 布局。若 execPath 不符
    // （如开发期改了 cwd、或将来改成非 .app 打包），appBundle 不以 .app 结尾，后续
    // unzip/unlink 会破坏意外路径。提前 fail-fast 比静默写错更安全。
    if (!appBundle.endsWith('.app')) {
      throw new UpdateError(`unexpected app bundle path (not .app): ${appBundle}`, 'replacing')
    }
    // toLowerCase：GitHub digest 可能返回大写 hex，而 updater.sh 的 `shasum -a 256`
    // 输出小写。注入前统一小写，避免 [ "$ACTUAL" != "$SHA256" ] 字符串比较大写 vs 小写
    // 误判为不匹配（导致正确下载被错误回滚）。download-asset.ts 的下载期校验已小写化。
    const sha256 = release.assets.macArm64Zip?.sha256?.toLowerCase()
    if (!sha256) throw new UpdateError('mac asset missing sha256', 'verifying')
    const script = buildUpdaterScript({
      appBundle,
      zipPath: downloadedFilePath,
      sha256,
      logPath: UPDATER_LOG_PATH,
      resultPath: path.join(UPDATE_DIR, 'update-result.json'),
      appName: 'xyz-agent',
      targetVersion: release.version,
    })
    mkdirSync(UPDATE_DIR, { recursive: true })
    writeFileSync(UPDATER_SCRIPT_PATH, script, { mode: 0o755 })
    chmodSync(UPDATER_SCRIPT_PATH, 0o755)
    spawn('bash', [UPDATER_SCRIPT_PATH], { detached: true, stdio: 'ignore' }).unref()
    return { kind: 'detached-script', scriptPath: UPDATER_SCRIPT_PATH }
  }
}

/**
 * win NSIS 升级器。
 *
 * 不在 prepareUpdate 内 spawn（保持与 mac/linux 返回值语义一致）。
 * orchestrator 据 ref.kind='spawn-installer' 负责 spawn NSIS installer。
 */
export class WinUpdater implements PlatformUpdater {
  prepareUpdate(downloadedFilePath: string, _release: LatestReleaseInfo): UpdateScriptRef {
    if (!app.isPackaged) throw new UpdateError('dev mode does not support self-update', 'replacing')
    // win 安装目录 = execPath 的 dirname（electron-builder NSIS 默认布局）
    const installDir = path.dirname(process.execPath)
    return {
      kind: 'spawn-installer',
      installerPath: downloadedFilePath,
      args: buildWinInstallerArgs(installDir),
    }
  }
}

/**
 * linux AppImage 升级器。
 *
 * AppImage 走 detached 脚本（与 mac 一致，避免双实例）。
 * deb 包（APPIMAGE 环境变量 undefined）走 unsupported，前端跳 release 页降级。
 */
export class LinuxAppImageUpdater implements PlatformUpdater {
  prepareUpdate(downloadedFilePath: string, release: LatestReleaseInfo): UpdateScriptRef {
    const appImage = process.env.APPIMAGE
    if (!appImage) {
      throw new UpdateUnsupportedError('deb package does not support self-update', release.htmlUrl)
    }
    // toLowerCase + 缺失抛 UpdateError：与 mac 路径一致。linux updater 脚本里
    // sha256sum 输出小写，统一小写避免字符串比较大小写误判。
    const sha256 = release.assets.linuxX64AppImage?.sha256?.toLowerCase()
    if (!sha256) throw new UpdateError('linux asset missing sha256', 'verifying')
    const script = buildLinuxUpdaterScript({
      appImagePath: appImage,
      newFilePath: downloadedFilePath,
      sha256,
      logPath: LINUX_UPDATER_LOG_PATH,
      resultPath: path.join(UPDATE_DIR, 'update-result.json'),
      targetVersion: release.version,
    })
    mkdirSync(UPDATE_DIR, { recursive: true })
    writeFileSync(LINUX_UPDATER_SCRIPT_PATH, script, { mode: 0o755 })
    chmodSync(LINUX_UPDATER_SCRIPT_PATH, 0o755)
    spawn('bash', [LINUX_UPDATER_SCRIPT_PATH], { detached: true, stdio: 'ignore' }).unref()
    return { kind: 'detached-script', scriptPath: LINUX_UPDATER_SCRIPT_PATH }
  }
}

/**
 * 按当前平台创建升级器。
 *
 * @throws UpdateUnsupportedError 未知平台
 */
export function createPlatformUpdater(): PlatformUpdater {
  switch (process.platform) {
    case 'darwin': return new MacUpdater()
    case 'win32': return new WinUpdater()
    case 'linux': return new LinuxAppImageUpdater()
    default: throw new UpdateError(`unsupported platform: ${process.platform}`, 'replacing')
  }
}
