/**
 * 代理配置 IPC handler。
 *
 * 与自动升级（update-handlers.ts）解耦：proxy 是 OS 网络代理配置读写
 * （readProxyConfig/writeProxyConfig 操作 getDataDir 文件 + undici ProxyAgent 构造），
 * 属 main 进程 OS 网络能力，与 runtime（pi 子进程编排）无关，留 main 走 IPC 合理。
 *
 * 注册三类 channel（命名与职责对齐，proxy 域独立于 update 域）：
 *   - 'proxy:get'：读取代理配置（委托 readProxyConfig）
 *   - 'proxy:set'：保存代理配置（校验 mode/manual URL 后 writeProxyConfig）
 *   - 'proxy:test'：测试代理连接（testProxyConnection 真正走代理 fetch 验证可用性）
 *
 * [HISTORICAL] 不变量（从 update-handlers.ts 原样搬迁，语义零变更）：
 * - resolveDispatcher：proxyUrl 解析委托 resolveProxyUrl（proxy-config SSOT），ProxyAgent 构造留 gateway
 * - testProxyConnection：必须真正走代理（构造 ProxyAgent dispatcher 传给 fetch），
 *   否则代理不可用也因直连成功而误报（C2 回归防护）
 * - testProxyConnection：disabled 模式返回 success:false（B2：disabled 无连接可测，不误报成功）
 * - testProxyConnection：AbortController 10s 超时 + finally 显式 dispatcher.close() 防句柄泄漏
 *
 * 依赖方向：proxy-handlers → electron(ipcMain) + interfaces + update/proxy-config + shared(IProxyConfig)
 */
import { ipcMain } from 'electron'
import { ProxyAgent } from 'undici'
import type { IProxyConfig } from '@xyz-agent/shared'
import type { IpcHandlerDeps } from '../interfaces.js'
import { readProxyConfig, writeProxyConfig, resolveProxyUrl } from '../update/proxy-config.js'

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
 * 注册代理配置 IPC handler（proxy:get + proxy:set + proxy:test）。
 *
 * @param deps 注入依赖（proxy handler 当前未使用 deps 字段，保留参数以与其他 register*Handlers 签名一致，便于未来扩展）
 */
export function registerProxyHandlers(deps: IpcHandlerDeps): void {
  void deps // 当前 proxy handler 不读 deps，预留扩展位

  // ── proxy:get（读取代理配置）──────────────────────────────────
  ipcMain.handle('proxy:get', async () => {
    return readProxyConfig()
  })

  // ── proxy:set（保存代理配置）──────────────────────────────────
  ipcMain.handle('proxy:set', async (_event, config: IProxyConfig) => {
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

  // ── proxy:test（测试代理连接）──────────────────────────────────
  ipcMain.handle('proxy:test', async (_event, config: IProxyConfig) => {
    return testProxyConnection(config)
  })
}
