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
import type { LatestReleaseInfo, IProxyConfig } from '@xyz-agent/shared'
import type { IpcHandlerDeps } from '../interfaces.js'
import { UpdateError } from '../update/types.js'
import { readProxyConfig, writeProxyConfig, resolveProxyUrl } from '../update/proxy-config.js'
import { validateRelease } from '../update/validate-release.js'

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
 * 注册自动升级 IPC handler（update:check + update:perform）。
 *
 * @param deps 注入依赖（releaseChecker / updateOrchestrator / getMainWindow）
 */
export function registerUpdateHandlers(deps: IpcHandlerDeps): void {
  // ── update:check（w2：检测最新版）──────────────────────────────
  ipcMain.handle('update:check', async (_event, payload?: { force?: boolean }) => {
    if (!deps.releaseChecker) return null
    try {
      return await deps.releaseChecker.checkForLatestRelease(app.getVersion(), {
        force: payload?.force,
      })
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
    try {
      // [SECURITY] 校验 renderer payload：防 SSRF（downloadUrl 白名单 GitHub 域名）+
      // 路径遍历（name 严格字符集）+ shell 注入（name/version/sha256 严格格式）。
      // 必须在 performUpdate 前执行——orchestrator 内部会把 name 拼进下载路径、
      // 可能 spawn bash 脚本，未校验的输入可触发任意代码执行。
      validateRelease(payload.release)
      const result = await deps.updateOrchestrator.performUpdate(payload.release, {
        onProgress: (stage, percent) => {
          const win = deps.getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('update:progress', { stage, percent })
          }
        },
      })
      if (result.triggerRestart) {
        // 延迟 RESTART_QUIT_DELAY_MS 给前端时间显示「重启中」，再 quit
        setTimeout(() => app.quit(), RESTART_QUIT_DELAY_MS)
      }
      return result
    } catch (err) {
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
}
