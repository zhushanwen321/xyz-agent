/**
 * 升级流程编排器（纯逻辑，不调 app.quit）。
 *
 * 对应 slice auto-update-and-install w3：串联下载 → 校验 → 平台分发 → 触发替换。
 * orchestrator 是纯逻辑层（不依赖 electron app 生命周期），便于单元测试；
 * app.quit() 由 update-handlers 在收到 triggerRestart=true 后调用。
 *
 * 职责链：
 *   1. pickAsset：按 platform 选 asset（deb 用户选 AppImage 但 APPIMAGE undefined → unsupported）
 *   2. 写 update-result.json status='replacing'（self-healer 启动时检测中断）
 *   3. downloadAsset：下载 + sha256 校验（onProgress 推 downloading 进度）
 *   4. createPlatformUpdater().prepareUpdate：生成脚本 + 触发替换
 *   5. 据 ref.kind 决定返回值（detached-script → triggerRestart / spawn-installer → spawn + triggerRestart）
 *
 * [HISTORICAL] 不变量：
 * - orchestrator 不调 app.quit()（保持纯逻辑可测，quit 由 handler 调）
 * - onProgress 单回调：handler 负责转成 update:progress IPC 事件推 renderer
 * - 失败时 throw UpdateError/UpdateUnsupportedError，handler catch 后推 update:error 事件
 * - linux deb 用户（APPIMAGE undefined）：pickAsset 仍返回 AppImage asset，但 prepareUpdate 抛
 *   UpdateUnsupportedError（携带 fallbackUrl），orchestrator 透传给 handler
 *
 * 依赖方向：orchestrator → download-asset + platform-updater + constants + types + @xyz-agent/shared
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { LatestReleaseInfo, ReleaseAsset, UpdateStage } from '@xyz-agent/shared'
import { downloadAsset } from './download-asset.js'
import { createPlatformUpdater } from './platform-updater.js'
import { UPDATE_DIR, UPDATE_RESULT_FILE } from './constants.js'
import { UpdateError, UpdateUnsupportedError } from './types.js'
import type { UpdateScriptRef } from './types.js'

/** 升级进度回调签名 */
export type UpdateProgressCallback = (stage: UpdateStage, percent: number) => void

/** 升级编排器 Facade 接口（DI 契约，供 handler 注入） */
export interface IUpdateOrchestrator {
  /**
   * 执行完整升级流程。
   *
   * @param release release-checker 返回的最新版本信息
   * @param opts.onProgress 进度回调（stage + percent 0-100）
   * @returns triggerRestart=true 表示需要重启（handler 调 app.quit）
   * @throws UpdateError/UpdateUnsupportedError 升级失败
   */
  performUpdate(
    release: LatestReleaseInfo,
    opts: { onProgress: UpdateProgressCallback },
  ): Promise<{ triggerRestart: boolean }>
}

/**
 * 执行完整升级流程。
 *
 * 纯逻辑实现（不依赖 electron app），orchestrator 单例委托到此函数。
 */
export async function performUpdate(
  release: LatestReleaseInfo,
  opts: { onProgress: UpdateProgressCallback },
): Promise<{ triggerRestart: boolean }> {
  // 1. 选 asset
  const asset = pickAsset(release)
  if (!asset) {
    throw new UpdateError(`no asset for platform ${process.platform}`, 'downloading')
  }

  // 2. 写 update-result.json status='replacing'（self-healer 启动时检测中断）
  mkdirSync(UPDATE_DIR, { recursive: true })
  writeUpdateResult('replacing', release.version)

  // 3. 下载 + 校验（downloadAsset 内部已校验 sha256/size）
  opts.onProgress('downloading', 0)
  const { filePath } = await downloadAsset(asset, (percent) => opts.onProgress('downloading', percent))
  opts.onProgress('verifying', 100)

  // 4. 平台分发（生成脚本 + 触发替换）
  opts.onProgress('replacing', 0)
  const updater = createPlatformUpdater()
  const ref = updater.prepareUpdate(filePath, release)
  opts.onProgress('replacing', 100)

  // 5. 据 ref.kind 决定返回值
  return handleScriptRef(ref)
}

/**
 * 根据平台升级器返回的 UpdateScriptRef 决定后续动作。
 *
 * - detached-script：mac/linux 已在 prepareUpdate 内 spawn detached，直接返回 triggerRestart
 * - spawn-installer：win，orchestrator 负责 spawn NSIS installer
 * - sync-replace：保留位（当前未用）
 * - unsupported：抛 UpdateUnsupportedError
 */
function handleScriptRef(ref: UpdateScriptRef): { triggerRestart: boolean } {
  switch (ref.kind) {
    case 'detached-script':
      // mac/linux 已 spawn detached，返回 triggerRestart=true（handler 调 app.quit）
      return { triggerRestart: true }
    case 'spawn-installer':
      // win：spawn NSIS installer（/S 静默，detached 不阻塞）
      spawn(ref.installerPath, ref.args, { detached: true, stdio: 'ignore' }).unref()
      return { triggerRestart: true }
    case 'sync-replace':
      // 不应到达（linux AppImage 已在 prepareUpdate 内 spawn detached）
      throw new UpdateError('unexpected sync-replace', 'replacing')
    case 'unsupported':
      throw new UpdateUnsupportedError(ref.reason, ref.fallbackUrl)
  }
}

/**
 * 按当前平台选 release asset。
 *
 * 注意：linux deb 用户也选 AppImage asset（pickAsset 不知道用户用哪种包）。
 * LinuxAppImageUpdater.prepareUpdate 会检测 APPIMAGE 环境变量，deb 用户（APPIMAGE undefined）
 * 抛 UpdateUnsupportedError → handler 推 update:error 事件 → 前端跳 release 页。
 */
function pickAsset(release: LatestReleaseInfo): ReleaseAsset | undefined {
  switch (process.platform) {
    case 'darwin': return release.assets.macArm64Zip
    case 'win32': return release.assets.winX64Exe
    case 'linux': return release.assets.linuxX64AppImage
    default: return undefined
  }
}

/**
 * 写 update-result.json（跨进程 SSOT）。
 *
 * @param status replacing|done|failed|rolled-back
 * @param version 目标版本
 * @param error 可选错误信息（failed 时）
 */
function writeUpdateResult(status: string, version: string, error?: string): void {
  const data = { status, version, at: new Date().toISOString(), error }
  try {
    writeFileSync(UPDATE_RESULT_FILE, JSON.stringify(data, null, 2))
  } catch (e) {
    console.error('[update] write result failed:', e)
  }
}

/** 升级编排器单例（注入 IpcHandlerDeps） */
export const updateOrchestrator: IUpdateOrchestrator = { performUpdate }
