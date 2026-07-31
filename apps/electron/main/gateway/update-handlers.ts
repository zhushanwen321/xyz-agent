/**
 * 自动升级 IPC handler。
 *
 * 对应 slice auto-update-and-install：注册两类 channel：
 *   - 'update:check'：检测最新版（w2，委托 IReleaseChecker.checkForLatestRelease）
 *   - 'update:perform'：执行升级（w3，委托 IUpdateOrchestrator.performUpdate +
 *     推 update:progress / update:error 事件 + 收到 triggerRestart 后调 app.quit）
 *
 * [HISTORICAL] 不变量：
 * - 单 payload 对象规则：emit('update:perform', { release })，禁止多 arg
 * - update:perform 内 onProgress 转发为 'update:progress' 事件（win.isDestroyed 守卫）
 * - 错误转发为 'update:error' 事件（区分 UpdateError.stage / UpdateUnsupportedError.errorCode）
 * - orchestrator 是纯逻辑（不调 app.quit）；quit 由本 handler 在 triggerRestart=true 后调
 * - quit 用 setTimeout(500) 延迟：给前端一点时间显示「重启中」状态
 * - releaseChecker / updateOrchestrator 未注入时降级（check 返回 null / perform 抛错）
 *
 * 依赖方向：update-handlers → electron(app/ipcMain) + interfaces + update/types + update/proxy-config
 */
import { app, ipcMain } from 'electron'
import { ProxyAgent } from 'undici'
import type { LatestReleaseInfo, IProxyConfig, UpdateSettings } from '@xyz-agent/shared'
import type { IpcHandlerDeps } from '../interfaces.js'
import { UpdateError } from '../update/types.js'
import { readProxyConfig, writeProxyConfig, resolveProxyUrl } from '../update/proxy-config.js'
import { validateRelease } from '../update/validate-release.js'
import { writePendingUpdate, readPendingUpdate } from '../update/pending-update.js'
import { getUpdateSettings, setUpdateSettings } from '../update/update-settings.js'
import { downloadUpdate, installUpdate } from '../update/orchestrator.js'
import type { UpdateProgressCallback } from '../update/orchestrator.js'
import { writePreloadedUpdate, readPreloadedUpdate, clearPreloadedUpdate } from '../update/preloaded-update.js'

/** 触发重启前留给前端渲染「重启中」状态的延迟（毫秒）。 */
const RESTART_QUIT_DELAY_MS = 500

/**
 * 根据 proxyConfig 解析出用于 fetch 的 dispatcher（undici ProxyAgent）。
 *
 * 代理 URL 的解析（mode→url）统一委托给 {@link resolveProxyUrl}（proxy-config SSOT），
 * 消除本文件与 download-asset 的重复；ProxyAgent 的构造（含网络依赖）留在 gateway 层。
 *
 * 返回 undefined 表示不挂代理（直连）。
 */
function resolveDispatcher(config: IProxyConfig): ProxyAgent | undefined {
  const proxyUrl = resolveProxyUrl(config)
  if (!proxyUrl) {
    return undefined
  }
  try {
    return new ProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
}

/**
 * 测试代理连接。
 *
 * [C2] 必须真正走代理（构造 undici ProxyAgent dispatcher 传给 fetch），
 * 否则即便代理不可用也会因直连成功而误报——给用户虚假的成功反馈。
 * testProxy 用与真实下载相同的 resolveDispatcher 逻辑，确保测试结果反映代理可用性。
 */
async function testProxyConnection(config: IProxyConfig): Promise<{ success: boolean; message?: string }> {
  if (config.mode === 'disabled') {
    // [B2] 返回 success:false 让前端据此显示「代理已禁用，跳过测试」（消费 i18n key testDisabled），
    // 而非误导性地显示「代理连接成功」。disabled 本就无连接可测，不应报成功。
    return { success: false, message: 'Proxy disabled, skipping test' }
  }

  // manual 模式：先校验代理 URL 格式（避免构造 ProxyAgent 时抛不友好错误）
  if (config.mode === 'manual') {
    const proxyUrl = config.httpsProxy ?? config.httpProxy
    if (!proxyUrl) {
      return { success: false, message: 'No proxy URL configured' }
    }
    try {
      new URL(proxyUrl)
    } catch {
      return { success: false, message: 'Invalid proxy URL format' }
    }
  }

  // 构造 dispatcher（与下载链路同源逻辑）
  const dispatcher = resolveDispatcher(config)
  if (!dispatcher) {
    return { success: false, message: 'No proxy resolved (check configuration or env vars)' }
  }

  // 使用 AbortController 设置超时（10s：代理探测应快速失败，避免 UI 长时间等待）
  const controller = new AbortController()
  // eslint-disable-next-line no-magic-numbers -- 10000ms = 10s 代理探测超时
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    // 测试访问 GitHub 下载链路相关域名（与真实下载目标一致，更有代表性）
    // dispatcher 让请求真正走代理；这里是 undici 扩展的 RequestInit（含 dispatcher 字段），
    // 经 as RequestInit 适配全局类型（global RequestInit 在当前 lib 下未声明 dispatcher）。
    const url = 'https://github.com'
    await fetch(url, { method: 'HEAD', signal: controller.signal, dispatcher } as RequestInit)
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, message }
  } finally {
    clearTimeout(timeout)
    // ProxyAgent 持有连接池，测试完显式关闭避免句柄泄漏
    await dispatcher.close().catch(() => {})
  }
}

/**
 * 后台预下载互斥标志：防止 update:check 多次触发重复下载。
 *
 * 与 orchestrator 的 downloading 锁分离：本标志只在 handler 层防重复触发（check 可能被
 * 多次调用），orchestrator 的 downloading 锁保护真正的下载过程。预下载失败会重置此标志，
 * 下次 check 可再次尝试。
 */
let preDownloading = false

/**
 * 进行中的预下载 promise（若有）。
 *
 * 预下载持锁的是 orchestrator 的 `downloading` 锁。若用户在预下载进行中点更新，
 * update:perform 的 download 路径会因 `downloading` 锁被拒（'download already in progress'）。
 * 存下 promise 让 perform handler 先 await 它：预下载成功 → 写入 preloaded-update.json →
 * perform 重读命中快路径；预下载失败 → 锁已释放 → perform 正常走 download。
 * promise 完成后置回 null（配合 preDownloading 标志做幂等）。
 */
let preDownloadPromise: Promise<void> | null = null

/**
 * 后台预下载（静默）：检测到新版 + 预下载开关开时触发。
 *
 * 不推 update:progress 事件（静默后台行为，不干扰用户）。下载成功后写 preloaded-update.json，
 * update:perform 走快路径跳过重复下载。下载失败仅 console.warn（符合「静默放弃，下次检测重试」决策）。
 *
 * download-asset 的断点续传机制保证：预下载未完成时用户手动点更新，performUpdate 的
 * downloadUpdate 会接管同一临时文件续传，进度不浪费。
 */
async function preloadUpdateSilently(release: LatestReleaseInfo): Promise<void> {
  if (preDownloading) return
  preDownloading = true
  try {
    // 已有有效预下载产物（同版本同 asset 文件存在 + 完整性校验通过）→ 不重复下载
    const existing = await readPreloadedUpdate(release)
    if (existing) {
      console.log(`[preload] preloaded update for v${release.version} already exists, skip`)
      return
    }
    console.log(`[preload] background pre-downloading v${release.version}...`)
    const { filePath } = await downloadUpdate(release)
    writePreloadedUpdate(release, filePath)
    console.log(`[preload] pre-downloaded v${release.version} to ${filePath}`)
  } catch (err) {
    // 静默放弃：仅 warn，下次 check 检测到新版会再次尝试（断点续传保留进度）
    console.warn(`[preload] background pre-download failed for v${release.version}:`, err)
  } finally {
    preDownloading = false
    preDownloadPromise = null
  }
}

/**
 * 注册自动升级 IPC handler（update:check + update:perform + getPending + getSettings/setSettings）。
 *
 * @param deps 注入依赖（releaseChecker / updateOrchestrator / getMainWindow）
 */
export function registerUpdateHandlers(deps: IpcHandlerDeps): void {
  // ── update:check（w2：检测最新版）──────────────────────────────
  ipcMain.handle('update:check', async (_event, payload?: { force?: boolean }) => {
    if (!deps.releaseChecker) return null
    try {
      const info = await deps.releaseChecker.checkForLatestRelease(app.getVersion(), {
        force: payload?.force,
      })
      // 检测到新版 → 写持久化标志（功能 1：常驻提醒），best-effort 不阻塞响应
      if (info) {
        writePendingUpdate(info)
        // 预下载开关开 → 异步后台下载（功能 2），不 await 不阻塞 check 响应。
        // 把 promise 存起来（非 void），供 update:perform 在预下载进行中时 await，
        // 避免与后台预下载争抢 orchestrator 的 downloading 锁而硬报错。
        const settings = getUpdateSettings()
        if (settings.preDownload) {
          preDownloadPromise = preloadUpdateSilently(info)
        }
      }
      return info
    } catch (err) {
      // 兜底：理论上 checkForLatestRelease 自身已 catch，此处防止意外 reject
      console.error('[update:check] failed:', err)
      return null
    }
  })

  // ── update:perform（w3：执行升级）──────────────────────────────
  ipcMain.handle('update:perform', async (_event, payload: { release: LatestReleaseInfo }) => {
    if (!deps.updateOrchestrator) {
      throw new Error('updateOrchestrator not configured')
    }
    // [MUST-FIX #3] 记录本次是否走快路径：catch 中据此决定是否清 preloaded 标志，
    // 避免快路径 installUpdate 失败后重试反复命中同一（可能损坏的）文件而死循环。
    // 声明在 try 外，catch 才能读到。
    let usedFastPath = false
    try {
      // [SECURITY] 校验 renderer payload：防 SSRF（downloadUrl 白名单 GitHub 域名）+
      // 路径遍历（name 严格字符集）+ shell 注入（name/version/sha256 严格格式）。
      // 必须在 performUpdate 前执行——orchestrator 内部会把 name 拼进下载路径、
      // 可能 spawn bash 脚本，未校验的输入可触发任意代码执行。
      validateRelease(payload.release)

      // [功能 2 快路径] 若有有效的预下载产物（同版本 + 文件存在），跳过下载直接 installUpdate。
      // 用户体感：点击更新后无需等待下载，直接进入替换重启。产物无效则降级走完整 performUpdate。
      const onProgress: UpdateProgressCallback = (stage, percent) => {
        const win = deps.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('update:progress', { stage, percent })
        }
      }

      // [MUST-FIX #1] 若后台预下载仍在进行，先 await 它：预下载持有 orchestrator 的
      // downloading 锁，直接走 download 路径会被拒（'download already in progress'）。
      // await 到锁释放后再决定走快路径（预下载成功写入了产物）还是 download 路径（预下载失败）。
      // 用局部引用避免 await 期间 preDownloadPromise 被置 null 后读到旧值。
      const inFlight = preDownloadPromise
      if (inFlight) {
        console.log('[update:perform] background preload in progress, waiting for it to finish')
        await inFlight
      }

      const preloadedFile = await readPreloadedUpdate(payload.release)
      let result: { triggerRestart: boolean }
      if (preloadedFile) {
        // 预下载产物有效：快路径，仅推 replacing 进度 + installUpdate
        console.log(`[update:perform] using preloaded file ${preloadedFile}, skipping download`)
        usedFastPath = true
        result = await installUpdate(payload.release, preloadedFile, onProgress)
      } else {
        // 无预下载产物或产物失效：完整流程（下载 → 校验 → 替换）
        result = await deps.updateOrchestrator.performUpdate(payload.release, { onProgress })
      }
      if (result.triggerRestart) {
        // 延迟 RESTART_QUIT_DELAY_MS 给前端时间显示「重启中」，再 quit
        setTimeout(() => app.quit(), RESTART_QUIT_DELAY_MS)
      }
      return result
    } catch (err) {
      // [MUST-FIX #3] 快路径 installUpdate 失败时清 preloaded 标志：避免重试反复命中
      // 同一产物（installUpdate 非「文件完整性」失败如 spawn 失败、replacing 权限错误，
      // 或即便文件真坏），下次重试强制走完整重下 + 重新校验，杜绝死循环。
      // 采用「快路径失败一律 clear」保守策略：重下后会重新 sha256 校验，比死循环安全；
      // 文件完整性错误（UpdateIntegrityError）本就需重下，clear 同样正确。
      if (usedFastPath) {
        console.warn('[update:perform] fast-path install failed, clearing preloaded flag to force full re-download on retry')
        clearPreloadedUpdate()
      }

      // 错误转 update:error 事件（区分 stage / errorCode）
      const win = deps.getMainWindow()
      let errorPayload

      if (err instanceof UpdateError) {
        // 使用 toUserFriendly() 获取用户友好的错误信息
        const friendlyInfo = err.toUserFriendly()
        errorPayload = {
          stage: friendlyInfo.stage,
          message: friendlyInfo.message,
          errorCode: friendlyInfo.code,
          suggestion: friendlyInfo.suggestion,
        }
      } else {
        errorPayload = {
          stage: 'replacing' as const,
          message: err instanceof Error ? err.message : String(err),
          errorCode: undefined,
          suggestion: '请重试或联系技术支持',
        }
      }

      if (win && !win.isDestroyed()) {
        win.webContents.send('update:error', errorPayload)
      }
      // [HISTORICAL] throw 可序列化的普通对象，而非原始 Error。
      // Electron IPC 使用结构化克隆算法序列化 invoke reject 值，
      // Error 对象的原生属性（stack 等）不可克隆，会抛 'an object could not be cloned'。
      // 前端 useAppUpdate 的 onUpdateError 已通过事件通道接收错误详情，
      // invoke reject 只需传递可序列化的错误摘要。
      throw { message: errorPayload.message, stage: errorPayload.stage, errorCode: errorPayload.errorCode, suggestion: errorPayload.suggestion }
    }
  })

  // ── update:getProxyConfig（读取代理配置）──────────────────────
  ipcMain.handle('update:getProxyConfig', async () => {
    return readProxyConfig()
  })

  // ── update:setProxyConfig（保存代理配置）──────────────────────
  ipcMain.handle('update:setProxyConfig', async (_event, config: IProxyConfig) => {
    // 基本校验
    if (!['system', 'manual', 'disabled'].includes(config.mode)) {
      throw new Error('Invalid proxy mode')
    }
    if (config.mode === 'manual') {
      if (!config.httpProxy) {
        throw new Error('HTTP proxy is required in manual mode')
      }
      // 验证 URL 格式
      try {
        new URL(config.httpProxy)
        if (config.httpsProxy) new URL(config.httpsProxy)
      } catch {
        throw new Error('Invalid proxy URL format')
      }
    }
    writeProxyConfig(config)
    return { success: true }
  })

  // ── update:testProxy（测试代理连接）────────────────────────────
  ipcMain.handle('update:testProxy', async (_event, config: IProxyConfig) => {
    return testProxyConnection(config)
  })

  // ── update:getPending（读取升级提醒持久化标志）──────────────────
  // 功能 1：启动时 renderer 调此 handler 恢复「可升级」提醒（离线也能常驻）。
  // readPendingUpdate 内部做版本比较：currentVersion >= pending.version → 清除 + 返回 null。
  ipcMain.handle('update:getPending', async () => {
    return readPendingUpdate(app.getVersion())
  })

  // ── update:getSettings（读取升级设置）──────────────────────────
  ipcMain.handle('update:getSettings', async () => {
    return getUpdateSettings()
  })

  // ── update:setSettings（保存升级设置）──────────────────────────
  ipcMain.handle('update:setSettings', async (_event, settings: UpdateSettings) => {
    // 基本类型校验
    if (typeof settings.preDownload !== 'boolean') {
      throw new Error('Invalid settings: preDownload must be boolean')
    }
    setUpdateSettings(settings)
    return { success: true }
  })
}
