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
 * - 并发保护：module-level updating 标志，installUpdate 进行中时拒绝重入（避免重复 spawn 脚本）
 * - win 与 mac/linux 统一 detached-script 语义（设计 §3.4 批次 2）：wrapper 在
 *   prepareUpdate 内 spawn，orchestrator 不再延迟 spawn NSIS 安装器（原 1.5s
 *   延迟魔数常量与 win 安装器 ref 分支已整体删除）
 *
 * 依赖方向：orchestrator → download-asset + platform-updater + proxy-config + constants + types + @xyz-agent/shared
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import type { LatestReleaseInfo, UpdateStage } from '@xyz-agent/shared'
import { UPDATE_STALE_RELEASE } from '@xyz-agent/shared'
import { downloadAsset } from './download-asset.js'
import { createPlatformUpdater } from './platform-updater.js'
import { pickPlatformAsset } from './pick-platform-asset.js'
import { getUpdateDir, getUpdateResultFile } from './constants.js'
import { readProxyConfig } from './proxy-config.js'
import { UpdateError, UpdateUnsupportedError } from './types.js'
import type { UpdateScriptRef } from './types.js'
import type { IReleaseChecker } from '../interfaces.js'

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
   * 版本解析（批次 3 信任锚 RC1）：renderer 只传意图（version 字符串），release 数据
   * 由 main 权威解析。四分支 + 60s 节流详见 {@link resolveByVersion}。
   *
   * @param version renderer 请求的目标版本号（不可信输入，严格校验）
   * @param opts.currentVersion 当前 app 版本（checker 比较用）
   * @param opts.releaseChecker Release 权威源（缓存 / force check）
   * @throws UpdateError 格式非法 / STALE_RELEASE / check 网络失败 / 节流中
   */
  resolveByVersion(
    version: string,
    opts: { currentVersion: string; releaseChecker: IReleaseChecker },
  ): Promise<LatestReleaseInfo>

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
 * 并发保护：installUpdate 进行中时拒绝重入。
 *
 * 重复调用会竞争写 update-result.json + spawn 多个 detached 脚本（文件锁冲突 /
 * 多脚本同时替换导致破损）。用 module-level 单例标志做互斥。
 * 注意：进程内互斥即可（handler 单线程调用），跨进程由 update-result.json SSOT 兜底。
 */
let updating = false

/**
 * 并发保护：downloadUpdate 进行中时拒绝重入（含预下载）。
 *
 * 与 {@link updating} 分离：预下载（downloadUpdate）与安装（installUpdate）
 * 使用不同锁，允许「预下载进行中用户点击更新」等并发场景由调用方编排（见 update-handlers
 * 的快路径逻辑）。download-asset 自身的断点续传机制保证两者不会损坏同一临时文件。
 */
let downloading = false

/**
 * 当前安装形态是否支持自动更新（批次 6 review S：linux deb 与 Intel mac 同类门控的判定源）。
 *
 * linux 仅 AppImage 打包支持（APPIMAGE 环境变量由 AppImage 运行时注入）；deb/rpm 安装形态下
 * pickPlatformAsset 恒返回 AppImage asset——下载恒成功、install 恒抛 UpdateUnsupportedError →
 * handler 清 preloaded → 下次 check（预下载开启时）再后台下 ~170MB 循环空转。
 * 该判定同时供 downloadUpdate 门控（fail-fast 零字节）与 handler 层预下载跳过使用，
 * 两处同源防漂移。
 */
export function isAutoUpdateSupportedForCurrentInstall(): boolean {
  return !(process.platform === 'linux' && !process.env.APPIMAGE)
}

/**
 * 下载阶段：选 asset + 下载 + sha256 校验。
 *
 * 从原一键流程拆分，供预下载（后台静默下载）复用。下载完成后返回已校验的文件路径，
 * 不触发替换——调用方拿到 filePath 后可立即 installUpdate 或暂存（preloaded-update.json）。
 * 注意：不写 update-result.json 的 replacing 标记（那是 installUpdate 的职责），
 * 否则预下载后未安装就崩溃会触发 self-healer 误回滚。
 *
 * 不推 update:progress 事件：预下载是静默后台行为，进度回调由调用方决定如何处理
 * （update:download 透传给 handler 推 IPC；预下载不传回调静默）。
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
    // 0.5 架构门控（批次 5 m8）：Intel mac 直接拒绝，不下载任何字节。
    // 落点在 downloadUpdate 入口、pickPlatformAsset 之前——预下载与手动下载共用本入口，
    // 因此预下载同样被拦住，不会先下完 ~170MB 才在 install 阶段被拒。
    // 修复的是「静默装错架构产物」：pickPlatformAsset 对 darwin 一律返回 macArm64Dmg，
    // Intel mac 装上 arm64 包会得到一个打不开的 app。
    if (process.platform === 'darwin' && process.arch !== 'arm64') {
      throw new UpdateUnsupportedError(
        `auto update supports Apple Silicon only (current arch: ${process.arch})`,
        release.htmlUrl,
      )
    }
    // 0.6 打包形态门控（review round-1 S，与 m8 同类空转的第二形态）：linux deb/rpm
    // 安装不支持自动更新——失败前置到零字节下载之前（fallbackUrl 引导手动安装），
    // 预下载与手动下载共用本入口因此同样被拦。判定源 = isAutoUpdateSupportedForCurrentInstall。
    if (!isAutoUpdateSupportedForCurrentInstall()) {
      throw new UpdateUnsupportedError(
        `auto update supports AppImage installs only on linux (APPIMAGE env not set — deb/rpm package)`,
        release.htmlUrl,
      )
    }

    // 1. 选 asset。断供错误信息并入 release 页链接：存量 darwin 用户（本版本
    //    只发 dmg 后）报错时有一键手动下载出路（设计 §3.3.3-D「错误信息可操作」）
    const asset = pickPlatformAsset(release)
    if (!asset) {
      throw new UpdateError(
        `no asset for platform ${process.platform} (release page: ${release.htmlUrl})`,
        'downloading',
      )
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
 * 版本解析拒绝后的节流窗口：拒绝后 60s 内同 channel 后续请求直接拒绝、不触发
 * force check——恶意 renderer 高频 invoke 不能定向打光 GitHub API 限额（60 次/小时）。
 * 批次 4 的退避在 renderer 侧，拦不住恶意 invoke，节流必须在 main 侧。
 */
const RESOLVE_THROTTLE_MS = 60_000

/** 请求版本严格格式（3-4 段数字，与 release-checker 的 STRICT_VERSION_RE 同规则） */
const REQUESTED_VERSION_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

/**
 * 上次版本解析拒绝时刻（epoch ms，0 = 无拒绝）。
 * 只由 STALE_RELEASE 与格式非法拒绝触发；网络失败不节流（用户网络恢复后可立即重试）。
 */
let lastResolveRejectedAt = 0

/**
 * 版本解析器（批次 3 信任锚 RC1 核心）。
 *
 * update:download 契约版本号化后，renderer 只传意图（version 字符串），release 数据
 * 由 main 权威解析。四分支（设计 §3.5.1）：
 *   ① ReleaseChecker 缓存（非强制调用 = 1h 缓存语义）命中且版本一致 → 用缓存 release
 *   ② 缓存无 / 版本不一致 → 一次权威 force check：check 失败（网络断/超时，既不能
 *      确认也不能证伪）→ 抛网络类 UpdateError，绝不回退使用任何缓存外或 renderer 侧
 *      数据；check 成功但 latest.version ≠ 请求版本 → 抛 UPDATE_STALE_RELEASE
 *      （renderer 收到后自动重查，拿到更新的 latest）
 *   ③ 请求版本格式非法（非 string / 非 3-4 段数字）→ 直接拒绝
 *   ④ 拒绝后 60s 节流：同 channel 后续请求直接拒绝，不触发 force check
 *
 * 效果断言：无论 renderer 传什么，能被下载执行的永远是 GitHub 本仓库 latest release
 * 的官方 asset——RC1 的整类攻击面消失。
 *
 * [已知语义边界] checkForLatestRelease 的 null 同时覆盖「网络失败」与「latest ≤ 当前
 * 版本」等情形（该接口不在本单元领地）：两者在此一律按失败处理拒绝升级——保守方向
 * 安全（拒绝 ≠ 误装），代价是降级请求得到网络类错误文案。
 */
export async function resolveByVersion(
  version: string,
  opts: { currentVersion: string; releaseChecker: IReleaseChecker },
): Promise<LatestReleaseInfo> {
  // ④ main 侧廉价节流：拒绝后 60s 内直接拒绝（含合法重试——设计如此取舍，
  //    renderer 侧批次 4 退避会避开窗口）
  if (Date.now() - lastResolveRejectedAt < RESOLVE_THROTTLE_MS) {
    throw new UpdateError(
      'version resolve throttled: a previous resolve was rejected recently, retry later',
      'downloading',
    )
  }

  // ③ 版本格式非法 → 直接拒绝。typeof 守卫先行：IPC payload 不受 TS 类型约束，
  //    数字等非 string 值会被正则隐式串化绕过（123 → '123' 合法），必须显式拒绝
  if (typeof version !== 'string' || !REQUESTED_VERSION_RE.test(version)) {
    lastResolveRejectedAt = Date.now()
    throw new UpdateError(`invalid requested version format: ${String(version)}`, 'downloading')
  }

  // ① 缓存优先：非强制调用命中 1h 缓存且版本一致 → 直接用缓存 release（零网络）
  const cached = await opts.releaseChecker.checkForLatestRelease(opts.currentVersion)
  if (cached && cached.version === version) {
    return cached
  }

  // ② 权威 force check（缓存无 / 版本不一致）
  const latest = await opts.releaseChecker.checkForLatestRelease(opts.currentVersion, {
    force: true,
  })
  if (!latest) {
    // check 失败：既不能确认也不能证伪请求版本 → 抛网络类错误，绝不回退
    throw new UpdateError('latest release check failed (network)', 'downloading', 'UPDATE_NETWORK_FAILED')
  }
  if (latest.version !== version) {
    // check 成功但 latest ≠ 请求版本 → 请求版本已过期（renderer 应重新检查更新）
    lastResolveRejectedAt = Date.now()
    throw new UpdateError(
      `requested version ${version} is stale (latest is ${latest.version})`,
      'downloading',
      UPDATE_STALE_RELEASE,
    )
  }
  return latest
}

/**
 * 安装阶段：平台分发（生成替换脚本 + 触发替换）+ 据 ref.kind 决定返回值。
 *
 * 从原一键流程拆分，供预下载快路径复用：预下载产物存在时跳过 downloadUpdate
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
  // 复用 updating 锁：installUpdate 会 spawn 替换脚本，与其他安装调用互斥
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
      mkdirSync(getUpdateDir(), { recursive: true })
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
    default: {
      // 不可达分支（TS 已穷尽：UpdateScriptRef 只剩 detached-script / unsupported 两个
      // kind）。保留防御性 fail-fast 的理由：ref 来自 platform-updater 的返回值，未来
      // 若新增 kind 而此处漏改，静默透传会让升级停在一个没人报错的中间态——比抛错难查。
      const exhaustive: never = ref
      throw new UpdateError(`unexpected script ref kind: ${exhaustive}`, 'replacing')
    }
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
  const resultFile = getUpdateResultFile()
  // 原子写（批次 5 m12 / §3.7.2）：先写 .tmp 再 renameSync，读方（self-healer）不会
  // 读到半截 JSON——半截 replacing 会被 corrupt-json 分支误判触发回滚。
  const tmpPath = `${resultFile}.tmp`
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(tmpPath, JSON.stringify(data, null, 2))
  // 同目录 rename：同卷原子替换（目标已存在时覆盖）
  renameSync(tmpPath, resultFile)
}

/**
 * 升级编排器单例（注入 IpcHandlerDeps）。
 *
 * 实现 {@link IUpdateOrchestrator} 全部方法：downloadUpdate / resolveByVersion / installUpdate。
 * handler 经 deps.updateOrchestrator.* 调用——快路径与预下载也走 DI，使全部升级能力可经
 * mock 接口替换测试（见 S#11 arch-boundary：消除「DI 契约只含旧一键方法，新能力绕过 DI」的分裂）。
 */
export const updateOrchestrator: IUpdateOrchestrator = {
  downloadUpdate,
  resolveByVersion,
  installUpdate,
}
