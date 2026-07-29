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
 * - 并发保护：module-level updating 标志，performUpdate 进行中时拒绝重入（避免重复 spawn 脚本）
 * - win spawn-installer 延迟 1.5s 再 spawn，给 handler 的 app.quit 留时间避免文件锁冲突
 *
 * 依赖方向：orchestrator → download-asset + platform-updater + proxy-config + constants + types + @xyz-agent/shared
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { LatestReleaseInfo, ReleaseAsset, UpdateStage } from '@xyz-agent/shared'
import { downloadAsset } from './download-asset.js'
import { createPlatformUpdater } from './platform-updater.js'
import { UPDATE_DIR, UPDATE_RESULT_FILE } from './constants.js'
import { readProxyConfig } from './proxy-config.js'
import { UpdateError, UpdateUnsupportedError } from './types.js'
import type { UpdateScriptRef } from './types.js'

/** Windows NSIS 安装器 spawn 延迟：给 handler 的 app.quit 留时间避免文件锁冲突 */
const WIN_INSTALLER_SPAWN_DELAY_MS = 1500

/** 进度完成百分比 */
const PROGRESS_COMPLETE = 100

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
 * 并发保护：performUpdate 进行中时拒绝重入。
 *
 * 重复调用会竞争写 update-result.json + spawn 多个 detached 脚本（文件锁冲突 /
 * 多脚本同时替换导致破损）。用 module-level 单例标志做互斥。
 * 注意：进程内互斥即可（handler 单线程调用），跨进程由 update-result.json SSOT 兜底。
 */
let updating = false

/**
 * 执行完整升级流程。
 *
 * 纯逻辑实现（不依赖 electron app），orchestrator 单例委托到此函数。
 */
export async function performUpdate(
  release: LatestReleaseInfo,
  opts: { onProgress: UpdateProgressCallback },
): Promise<{ triggerRestart: boolean }> {
  // 0. 并发保护：重入直接拒绝（避免重复 spawn 脚本 / 写文件竞争）
  if (updating) {
    throw new UpdateError('update already in progress', 'downloading')
  }
  updating = true
  try {
    // 1. 选 asset
    const asset = pickAsset(release)
    if (!asset) {
      throw new UpdateError(`no asset for platform ${process.platform}`, 'downloading')
    }

    // 2. 写 update-result.json status='replacing'（self-healer 启动时检测中断）
    //    replacing 标记是 self-healer 检测中断的关键信号，写入失败必须中止升级
    //    （否则崩溃后 self-healer 无法识别需要回滚）。这里不 catch，让异常上抛。
    try {
      mkdirSync(UPDATE_DIR, { recursive: true })
      writeUpdateResult('replacing', release.version)
    } catch (writeErr) {
      // 权限错误分类
      if (writeErr instanceof Error && (writeErr.message.includes('EACCES') || writeErr.message.includes('permission'))) {
        throw new UpdateError(
          'permission denied when writing update status',
          'replacing',
          'UPDATE_PERMISSION_DENIED',
        )
      }
      // 磁盘空间不足
      if (writeErr instanceof Error && (writeErr.message.includes('ENOSPC') || writeErr.message.includes('disk space'))) {
        throw new UpdateError(
          'insufficient disk space for update status file',
          'downloading',
          'UPDATE_DISK_SPACE',
        )
      }
      throw writeErr
    }

    // 3. 下载 + 校验（downloadAsset 内部已校验 sha256/size）
    //    [C1] 读取 proxy-config.json（统一由 ./proxy-config.ts SSOT 负责），
    //    把代理配置传给 downloadAsset，让下载链路真正接入代理
    //    （downloadAsset 内部据此构造 undici ProxyAgent dispatcher）。
    //    proxyConfig 读取失败（文件损坏等）不阻断升级：降级为默认 mode='system'（直连/环境变量）。
    opts.onProgress('downloading', 0)
    const proxyConfig = readProxyConfig()
    const { filePath } = await downloadAsset(
      asset,
      (percent) => opts.onProgress('downloading', percent),
      proxyConfig,
    )
    opts.onProgress('verifying', PROGRESS_COMPLETE)

    // 4. 平台分发（生成脚本 + 触发替换）
    opts.onProgress('replacing', 0)
    const updater = createPlatformUpdater()
    let ref: UpdateScriptRef
    try {
      ref = updater.prepareUpdate(filePath, release)
    } catch (prepErr) {
      // 权限错误分类
      if (prepErr instanceof Error && (prepErr.message.includes('EACCES') || prepErr.message.includes('permission'))) {
        throw new UpdateError(
          'permission denied during update preparation',
          'replacing',
          'UPDATE_PERMISSION_DENIED',
        )
      }
      throw prepErr
    }
    opts.onProgress('replacing', PROGRESS_COMPLETE)

    // 5. 据 ref.kind 决定返回值
    return handleScriptRef(ref)
  } finally {
    updating = false
  }
}

/**
 * 根据平台升级器返回的 UpdateScriptRef 决定后续动作。
 *
 * - detached-script：mac/linux 已在 prepareUpdate 内 spawn detached，直接返回 triggerRestart
 * - spawn-installer：win，orchestrator 负责 spawn NSIS installer
 * - unsupported：抛 UpdateUnsupportedError
 */
function handleScriptRef(ref: UpdateScriptRef): { triggerRestart: boolean } {
  switch (ref.kind) {
    case 'detached-script':
      // mac/linux 已 spawn detached，返回 triggerRestart=true（handler 调 app.quit）
      return { triggerRestart: true }
    case 'spawn-installer':
      // win：先等 handler 的 setTimeout(app.quit, 500) 触发并完成退出，
      // 再 spawn NSIS installer，避免文件锁冲突（NSIS 检测 app 运行会弹窗）。
      // [NOTE] best-effort：handler quit 定时器 500ms + 本处延迟确保 app 已退出。
      // 更彻底的方案是 wrapper 脚本轮询 PID 退出，暂不引入。
      setTimeout(() => {
        try {
          spawn(ref.installerPath, ref.args, { detached: true, stdio: 'ignore' }).unref()
        // eslint-disable-next-line taste/no-silent-catch -- best-effort：spawn 失败时 app 已 quit，无调用方可传播
        } catch (e) {
          console.error('[orchestrator] spawn NSIS failed:', e)
        }
      }, WIN_INSTALLER_SPAWN_DELAY_MS)
      return { triggerRestart: true }
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
 *
 * 注意：写入失败直接抛错（不吞错）。调用方决定容错策略：
 *   - 初始 replacing 标记：必须成功（self-healer 检测中断的关键信号），失败应中断升级
 *   - 成功/失败终态标记：调用方可在 catch 内 best-effort 记录（不影响安全）
 */
function writeUpdateResult(status: string, version: string, error?: string): void {
  const data = { status, version, at: new Date().toISOString(), error }
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(UPDATE_RESULT_FILE, JSON.stringify(data, null, 2))
}

/** 升级编排器单例（注入 IpcHandlerDeps） */
export const updateOrchestrator: IUpdateOrchestrator = { performUpdate }
