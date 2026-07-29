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
 * 依赖方向：update-handlers → electron(app/ipcMain) + interfaces + update/types
 */
import { app, ipcMain, safeStorage } from 'electron'
import { ProxyAgent } from 'undici'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LatestReleaseInfo, IProxyConfig } from '@xyz-agent/shared'
import { getDataDir } from '@xyz-agent/shared/paths'
import type { IpcHandlerDeps } from '../interfaces.js'
import { UpdateError } from '../update/types.js'
import { validateRelease } from '../update/validate-release.js'

/** 触发重启前留给前端渲染「重启中」状态的延迟（毫秒）。 */
const RESTART_QUIT_DELAY_MS = 500

/**
 * 代理配置落盘结构。
 *
 * [M4] 不再把可能含 `user:pass` 的完整代理 URL 明文写盘。
 * URL 字段（httpProxy/httpsProxy）只保留 `protocol://host:port`，
 * 凭证经 {@link encryptCredential} 加密成 base64 后存到 credentials，读取时还原。
 * credentials 可选：无凭证时缺省；兼容无凭证的旧文件（无此字段）。
 */
interface IStoredProxyConfig {
  mode: IProxyConfig['mode']
  httpProxy?: string
  httpsProxy?: string
  /** 加密凭证（base64），key 为 'http' / 'https' */
  credentials?: Record<string, string>
}

/** 代理配置文件路径（动态推导，符合架构约定 #2）。 */
function getProxyConfigPath(): string {
  return join(getDataDir(), 'proxy-config.json')
}

/**
 * 加密代理凭证（base64）。
 *
 * 用 Electron safeStorage（mac Keychain / win DPAPI / linux keyring）做平台原生加密。
 * safeStorage 不可用（如 linux 无 keyring、或 app 未 ready）时降级为明文 base64，
 * 并 console.warn 提示用户——这是可接受的降级：配置文件权限仍由 OS 文件系统保护，
 * 但不如 keychain 强，需要用户知晓。
 */
function encryptCredential(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  console.warn('[proxy] safeStorage unavailable, storing credential as plain base64')
  return Buffer.from(plain, 'utf-8').toString('base64')
}

/**
 * 解密代理凭证。与 {@link encryptCredential} 对称。
 * safeStorage 不可用时按明文 base64 解密；解密失败抛出由调用方兜底。
 */
function decryptCredential(enc: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }
  return Buffer.from(enc, 'base64').toString('utf-8')
}

/**
 * 剥离 URL 中的凭证（user:pass），返回 { safeUrl, hasCredential, credential }。
 *
 * 用于写盘前脱敏：proxy-config.json 的 URL 字段不再含明文密码。
 * 无凭证时 credential 为 undefined。
 */
function stripCredential(urlStr: string): {
  safeUrl: string
  credential: string | undefined
} {
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    // 非法 URL（理论上 handler 已校验，这里防御）：原样返回，不视为含凭证
    return { safeUrl: urlStr, credential: undefined }
  }
  const hasCred = u.username !== '' || u.password !== ''
  if (!hasCred) {
    return { safeUrl: urlStr, credential: undefined }
  }
  const credential = u.password !== '' ? `${u.username}:${u.password}` : u.username
  // 清掉 URL 里的凭证，保留 protocol/host/port
  u.username = ''
  u.password = ''
  return { safeUrl: u.toString(), credential }
}

/**
 * 把凭证拼回代理 URL（读取时还原完整 URL，供 ProxyAgent 使用）。
 *
 * 与 {@link stripCredential} 对称。解密失败时返回原 safeUrl（不阻断，降级为无认证）。
 */
function withCredential(safeUrl: string, enc: string | undefined): string {
  if (!enc) return safeUrl
  let cred: string
  try {
    cred = decryptCredential(enc)
  } catch {
    return safeUrl
  }
  try {
    const u = new URL(safeUrl)
    const [username, password] = cred.split(':')
    u.username = username
    if (password !== undefined) u.password = password
    return u.toString()
  } catch {
    return safeUrl
  }
}

/** 读取代理配置（文件不存在返回默认值；含凭证还原）。 */
function readProxyConfig(): IProxyConfig {
  const filePath = getProxyConfigPath()
  if (!existsSync(filePath)) {
    return { mode: 'system' }
  }
  let stored: IStoredProxyConfig
  try {
    stored = JSON.parse(readFileSync(filePath, 'utf-8')) as IStoredProxyConfig
  } catch {
    return { mode: 'system' }
  }
  // 兼容旧格式：直接是 IProxyConfig（无 credentials 字段）→ 原样返回
  const config: IProxyConfig = { mode: stored.mode ?? 'system' }
  config.httpProxy = stored.httpProxy && stored.credentials?.http
    ? withCredential(stored.httpProxy, stored.credentials.http)
    : stored.httpProxy
  config.httpsProxy = stored.httpsProxy && stored.credentials?.https
    ? withCredential(stored.httpsProxy, stored.credentials.https)
    : stored.httpsProxy
  return config
}

/** 写入代理配置（凭证剥离 + 加密，URL 不落明文密码）。 */
function writeProxyConfig(config: IProxyConfig): void {
  const filePath = getProxyConfigPath()
  const dir = join(filePath, '..')
  mkdirSync(dir, { recursive: true })

  const stored: IStoredProxyConfig = { mode: config.mode }
  const credentials: Record<string, string> = {}
  if (config.httpProxy) {
    const { safeUrl, credential } = stripCredential(config.httpProxy)
    stored.httpProxy = safeUrl
    if (credential) credentials.http = encryptCredential(credential)
  }
  if (config.httpsProxy) {
    const { safeUrl, credential } = stripCredential(config.httpsProxy)
    stored.httpsProxy = safeUrl
    if (credential) credentials.https = encryptCredential(credential)
  }
  if (Object.keys(credentials).length > 0) {
    stored.credentials = credentials
  }
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(filePath, JSON.stringify(stored, null, 2))
}

/**
 * 根据 proxyConfig 解析出用于 fetch 的 dispatcher（undici ProxyAgent）。
 *
 * mode 处理：
 * - manual：下载 URL 是 https（GitHub CDN），优先 httpsProxy，缺省 fallback httpProxy。
 * - system：当前实现读系统环境变量 HTTPS_PROXY/https_proxy（fallback HTTP_PROXY/http_proxy）。
 *   [NOTE] 未走 Electron session.resolveProxy（异步回调 + 仅返回 'PROXY host:port' 字符串，
 *   需额外解析），为控制复杂度先用环境变量；后续可升级为 session API。
 * - disabled：返回 undefined（直连）。
 *
 * 返回 undefined 表示不挂代理（直连）。
 */
function resolveDispatcher(config: IProxyConfig): ProxyAgent | undefined {
  if (config.mode === 'disabled') {
    return undefined
  }
  let proxyUrl: string | undefined
  if (config.mode === 'manual') {
    proxyUrl = config.httpsProxy ?? config.httpProxy
  } else {
    // system：读环境变量
    proxyUrl =
      process.env.HTTPS_PROXY ?? process.env.https_proxy ??
      process.env.HTTP_PROXY ?? process.env.http_proxy
  }
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
    return { success: true, message: 'Proxy disabled' }
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
