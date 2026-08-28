/**
 * 升级流程编排器（纯逻辑，不调 app.quit）。
 *
 * 对应 slice auto-update-and-install w3：串联下载 → 校验 → 平台分发 → 触发替换。
 * orchestrator 是纯逻辑层（不依赖 electron app 生命周期），便于单元测试；
 * app.quit() 由 update-handlers 在收到 triggerRestart=true 后调用。
 *
 * 职责链：
 *   1. pickAsset：按 platform 选 asset（deb 用户选 AppImage 但 APPIMAGE undefined → unsupported）
 *   2. downloadAsset：下载 + sha256 校验（onProgress 推 downloading 进度）
 *   3. 写 update-result.json status='replacing'（installUpdate 阶段，self-healer 启动时检测中断）
 *   4. createPlatformUpdater().prepareUpdate：生成脚本 + 触发替换
 *   5. 据 ref.kind 决定返回值（detached-script → triggerRestart / unsupported → 抛错）
 *
 * [HISTORICAL] 不变量：
 * - orchestrator 不调 app.quit()（保持纯逻辑可测，quit 由 handler 调）
 * - onProgress 单回调：handler 负责转成 update:progress IPC 事件推 renderer
 * - 失败时 throw UpdateError/UpdateUnsupportedError，handler catch 后推 update:error 事件
 * - linux deb 用户（APPIMAGE undefined）：pickAsset 仍返回 AppImage asset，但 prepareUpdate 抛
 *   UpdateUnsupportedError（携带 fallbackUrl），orchestrator 透传给 handler
 * - 并发保护：module-level updating 标志，performUpdate 进行中时拒绝重入（避免重复 spawn 脚本）
 * - win 与 mac/linux 统一 detached-script 语义（设计 §3.4 批次 2）：wrapper 在
 *   prepareUpdate 内 spawn，orchestrator 不再延迟 spawn NSIS 安装器（原 1.5s
 *   延迟魔数常量与 win 安装器 ref 分支已整体删除）
 *
 * 依赖方向：orchestrator → download-asset + platform-updater + proxy-config + constants + types + @xyz-agent/shared
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { LatestReleaseInfo, UpdateStage } from '@xyz-agent/shared'
import { downloadAsset } from './download-asset.js'
import { createPlatformUpdater } from './platform-updater.js'
import { pickPlatformAsset } from './pick-platform-asset.js'
import { UPDATE_DIR, UPDATE_RESULT_FILE } from './constants.js'
import { readProxyConfig } from './proxy-config.js'
import { UpdateError, UpdateUnsupportedError } from './types.js'
import type { UpdateScriptRef } from './types.js'

/** 进度完成百分比 */
const PROGRESS_COMPLETE = 100

/** 升级进度回调签名 */
export type UpdateProgressCallback = (stage: UpdateStage, percent: number) => void

/** 下载阶段返回的已校验产物路径 */
interface DownloadedFile {
  filePath: string
}

/** 升级编排器 Facade 接口（DI 契约，供 handler 注入）。
 *
 * handler（update-handlers.ts）的全部升级能力都经此接口调用，禁止绕过 DI
 * 直接 import downloadUpdate/installUpdate——这样快路径与预下载也能在测试中
 * 经 mock DI 接口替换，而非靠 mock 模块本身（见 S#11 arch-boundary）。
 */
export interface IUpdateOrchestrator {
  /**
   * 执行完整升级流程（下载 → 校验 → 替换 → 触发重启）。
   *
   * 内部组合 {@link IUpdateOrchestrator.downloadUpdate} + {@link IUpdateOrchestrator.installUpdate}。
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

  /**
   * 下载阶段：选 asset + 下载 + sha256 校验。
   *
   * 供预下载（后台静默下载）复用。下载完成后返回已校验的文件路径，不触发替换。
   *
   * @param release release-checker 返回的最新版本信息
   * @param onProgress 下载进度回调（0-100 百分比，仅 downloading 阶段）。可为 undefined（预下载静默）
   * @returns 已下载并校验的文件路径
   * @throws UpdateError 下载/校验失败（含 downloading 锁重入拒绝）
   */
  downloadUpdate(
    release: LatestReleaseInfo,
    onProgress?: (percent: number) => void,
  ): Promise<DownloadedFile>

  /**
   * 安装阶段：平台分发（生成替换脚本 + 触发替换）+ 据 ref.kind 决定返回值。
   *
   * 供预下载快路径复用：预下载产物存在时跳过 downloadUpdate 直接调本函数。
   *
   * @param release 当前 release 信息（取 sha256 / version / htmlUrl，注入替换脚本）
   * @param filePath downloadUpdate 返回的已校验文件路径
   * @param onProgress 进度回调（仅 replacing 阶段）。可为 undefined
   * @returns triggerRestart=true 表示需要重启（handler 调 app.quit）
   * @throws UpdateError/UpdateUnsupportedError 准备替换失败
   */
  installUpdate(
    release: LatestReleaseInfo,
    filePath: string,
    onProgress?: UpdateProgressCallback,
  ): Promise<{ triggerRestart: boolean }>
}

/**
 * 并发保护：performUpdate / installUpdate 进行中时拒绝重入。
 *
 * 重复调用会竞争写 update-result.json + spawn 多个 detached 脚本（文件锁冲突 /
 * 多脚本同时替换导致破损）。用 module-level 单例标志做互斥。
 * 注意：进程内互斥即可（handler 单线程调用），跨进程由 update-result.json SSOT 兜底。
 */
let updating = false

/**
 * 并发保护：downloadUpdate 进行中时拒绝重入（含预下载）。
 *
 * 与 {@link updating} 分离：预下载（downloadUpdate）与安装（installUpdate/performUpdate）
 * 使用不同锁，允许「预下载进行中用户点击更新」等并发场景由调用方编排（见 update-handlers
 * 的快路径逻辑）。download-asset 自身的断点续传机制保证两者不会损坏同一临时文件。
 */
let downloading = false

/**
 * 下载阶段：选 asset + 下载 + sha256 校验。
 *
 * 从原 performUpdate 拆分，供预下载（后台静默下载）复用。下载完成后返回已校验的文件路径，
 * 不触发替换——调用方拿到 filePath 后可立即 installUpdate 或暂存（preloaded-update.json）。
 * 注意：不写 update-result.json 的 replacing 标记（那是 installUpdate 的职责），
 * 否则预下载后未安装就崩溃会触发 self-healer 误回滚。
 *
 * 不推 update:progress 事件：预下载是静默后台行为，进度回调由调用方决定如何处理
 * （performUpdate 透传给 handler 推 IPC；预下载不传回调静默）。
 *
 * @param release release-checker 返回的最新版本信息
 * @param onProgress 下载进度回调（0-100 百分比，仅 downloading 阶段）。可为 undefined（预下载）
 * @returns 已下载并校验的文件路径
 * @throws UpdateError 下载/校验失败
 */
export async function downloadUpdate(
  release: LatestReleaseInfo,
  onProgress?: (percent: number) => void,
): Promise<{ filePath: string }> {
  // 0. 并发保护：重入直接拒绝（避免重复下载 / 写文件竞争）
  if (downloading) {
    throw new UpdateError('download already in progress', 'downloading')
  }
  downloading = true
  try {
    // 1. 选 asset
    const asset = pickPlatformAsset(release)
    if (!asset) {
      throw new UpdateError(`no asset for platform ${process.platform}`, 'downloading')
    }

    // 2. 下载 + 校验（downloadAsset 内部已校验 sha256/size）
    //    [C1] 读取 proxy-config.json（统一由 ./proxy-config.ts SSOT 负责），
    //    把代理配置传给 downloadAsset，让下载链路真正接入代理
    //    （downloadAsset 内部据此构造 undici ProxyAgent dispatcher）。
    //    proxyConfig 读取失败（文件损坏等）不阻断升级：降级为默认 mode='system'（直连/环境变量）。
    const proxyConfig = readProxyConfig()
    const { filePath } = await downloadAsset(asset, onProgress, proxyConfig)
    return { filePath }
  } finally {
    downloading = false
  }
}

/**
 * 安装阶段：平台分发（生成替换脚本 + 触发替换）+ 据 ref.kind 决定返回值。
 *
 * 从原 performUpdate 拆分，供预下载快路径复用：预下载产物存在时跳过 downloadUpdate
 * 直接调本函数。filePath 必须是已通过 sha256 校验的下载产物。
 *
 * @param release 当前 release 信息（取 sha256 / version / htmlUrl，注入替换脚本）
 * @param filePath downloadUpdate 返回的已校验文件路径
 * @param onProgress 进度回调（仅 replacing 阶段）。可为 undefined（预下载场景不适用）
 * @returns triggerRestart=true 表示需要重启（handler 调 app.quit）
 * @throws UpdateError/UpdateUnsupportedError 准备替换失败
 */
export async function installUpdate(
  release: LatestReleaseInfo,
  filePath: string,
  onProgress?: UpdateProgressCallback,
): Promise<{ triggerRestart: boolean }> {
  // 复用 updating 锁：installUpdate 会 spawn 替换脚本，与 performUpdate 的替换阶段互斥
  if (updating) {
    throw new UpdateError('update already in progress', 'replacing')
  }
  updating = true
  try {
    // 写 update-result.json status='replacing'（self-healer 启动时检测中断）。
    // replacing 标记是 self-healer 检测「正在替换、崩溃需回滚」的关键信号，
    // 必须在真正触发替换前写入。预下载阶段（downloadUpdate）只下载不替换，
    // 不应写 replacing——否则下载后用户未点安装就崩溃，self-healer 会误判
    // 需要回滚（实际只是下载中断）。此处放在 installUpdate（即将 spawn 替换脚本）才写。
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

    // 平台分发（生成脚本 + 触发替换）
    onProgress?.('replacing', 0)
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
    onProgress?.('replacing', PROGRESS_COMPLETE)

    // 据 ref.kind 决定返回值
    return handleScriptRef(ref)
  } finally {
    updating = false
  }
}

/**
 * 执行完整升级流程（下载 → 校验 → 替换 → 重启）。
 *
 * downloadUpdate + installUpdate 的组合，保持原有 onProgress 语义（downloading/verifying/replacing
 * 全阶段进度），供 update:perform handler 调用。预下载快路径（handler 内）直接调 installUpdate
 * 跳过下载阶段。
 *
 * 纯逻辑实现（不依赖 electron app），orchestrator 单例委托到此函数。
 */
export async function performUpdate(
  release: LatestReleaseInfo,
  opts: { onProgress: UpdateProgressCallback },
): Promise<{ triggerRestart: boolean }> {
  // 提前检查 updating 锁：避免下载完成后才发现安装阶段被占用（下载白做）
  if (updating) {
    throw new UpdateError('update already in progress', 'downloading')
  }
  // 下载阶段（downloadUpdate 内部有独立 downloading 锁）
  opts.onProgress('downloading', 0)
  const { filePath } = await downloadUpdate(release, (percent) =>
    opts.onProgress('downloading', percent),
  )
  opts.onProgress('verifying', PROGRESS_COMPLETE)

  // 安装阶段（installUpdate 内部持有 updating 锁）
  return await installUpdate(release, filePath, opts.onProgress)
}

/**
 * 根据平台升级器返回的 UpdateScriptRef 决定后续动作。
 *
 * - detached-script：三平台统一语义——替换脚本已在 prepareUpdate 内 spawn detached
 *   （win 为 cmd wrapper，见 win-updater-cmd.ts），orchestrator 只透传 triggerRestart
 * - unsupported：抛 UpdateUnsupportedError
 */
function handleScriptRef(ref: UpdateScriptRef): { triggerRestart: boolean } {
  switch (ref.kind) {
    case 'detached-script':
      // 三平台统一：脚本已 spawn detached，返回 triggerRestart=true（handler 调 app.quit）
      return { triggerRestart: true }
    case 'unsupported':
      throw new UpdateUnsupportedError(ref.reason, ref.fallbackUrl)
    default:
      // win 安装器延迟 spawn 分支已随批次 2 删除：win 改走 detached-script（wrapper 在
      // prepareUpdate 内 spawn，不再由 orchestrator 延迟 spawn NSIS）。防御性兑底：
      // types.ts 联合类型收窄由后续单元处理，未知 kind 一律 fail-fast。
      throw new UpdateError(`unexpected script ref kind: ${ref.kind}`, 'replacing')
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

/**
 * 升级编排器单例（注入 IpcHandlerDeps）。
 *
 * 实现 {@link IUpdateOrchestrator} 全部 3 个方法：performUpdate / downloadUpdate / installUpdate。
 * handler 经 deps.updateOrchestrator.* 调用——快路径与预下载也走 DI，使全部升级能力可经
 * mock 接口替换测试（见 S#11 arch-boundary：消除「DI 契约只含 performUpdate，新能力绕过 DI」的分裂）。
 */
export const updateOrchestrator: IUpdateOrchestrator = {
  performUpdate,
  downloadUpdate,
  installUpdate,
}
