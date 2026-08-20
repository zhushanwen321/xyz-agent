/**
 * UI API 模块
 *
 * 提供前端交互（对话框、通知、状态栏）的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerUiRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.ui.showSelect / showConfirm / showInput / notify / updateStatusBarItem 五个 RPC 方法。
 *
 * Worker 侧：createUiApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * showSelect/confirm/input 经 ctx.handleUiRequest 发 extension_ui_request 到前端并等待响应。
 *
 * S3-W3（D7 窄校验层）：全部方法入口 fail-fast 校验——缺字段/错类型/越界键抛
 * INVALID_* 结构化错误（message 含字段名与期望格式），畸形输入不产生 UI 副作用。
 * S3-W4（D7 限流与防毒化）：
 *   - notify 与 plugin.notify 共用同一每插件令牌桶（deps.limiter，默认 20 条/s）
 *     + message ≤8KB（INVALID_MESSAGE）；
 *   - updateStatusBarItem 单条 text ≤4KB（INVALID_TEXT，D3 验收「1MB text 被拒」
 *     依此规则），坏条目在该入口被拒——其余插件条目与后续广播不受影响
 *     （D4 毒化隔离：拒绝该条而非整包）。
 */

import { PLUGIN_NOTIFY_LIMITS } from '@xyz-agent/shared'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { StatusBarItemOptions } from '../plugin-types.js'
import {
  asBoundedString,
  asOptionalString,
  asRecord,
  asSafeKey,
  asString,
  asStringArray,
} from '../validation.js'
import { errorWithCode } from '../../../utils/errors.js'
import { guardNotifyParams, NotifyRateLimiter } from './notify-api.js'

/** KB → 字节换算 */
const BYTES_PER_KB = 1024
/** 对话框 title/message 等短文本上限：8KB（UTF-8 字节），防超长文本撑爆前端弹窗 */
const UI_TEXT_MAX_KB = 8
const UI_TEXT_MAX_BYTES = UI_TEXT_MAX_KB * BYTES_PER_KB

/** UI 服务依赖（主线程侧） */
export interface UiHandlers {
  /**
   * 发送 extension_ui_request 到前端。
   * 经 handleUiRequest 发送，返回前端选择结果。
   */
  showSelect(title: string, options: string[], pluginId: string): Promise<string | undefined>
  showConfirm(title: string, message: string, pluginId: string): Promise<boolean>
  showInput(title: string, defaultValue: string | undefined, pluginId: string): Promise<string | undefined>
  notify(pluginId: string, level: string, message: string): Promise<void>
  updateStatusBarItem(pluginId: string, id: string, text: string, options?: StatusBarItemOptions): Promise<void>
  /**
   * notify 令牌桶（S3-W4）。缺省自建（默认 20 条/s）；与 plugin.notify 入口
   * 共享时应由装配方（plugin-rpc-setup）传入同一实例。
   */
  limiter?: NotifyRateLimiter
}

/**
 * statusbar options 逐字段校验：present 但类型错即抛 INVALID_<FIELD>
 * （窄校验层风格：错误码带字段名，插件作者可据此修正）。缺省字段全放行。
 */
function parseStatusBarOptions(value: unknown): StatusBarItemOptions {
  if (value === undefined) return {}
  const options = asRecord(value, 'options')
  const tooltip = asOptionalString(options.tooltip, 'tooltip')
  const commandId = asOptionalString(options.commandId, 'commandId')
  if (options.priority !== undefined && typeof options.priority !== 'number') {
    throw errorWithCode(
      `Invalid priority: expected a number but received ${typeof options.priority}.`,
      'INVALID_PRIORITY',
    )
  }
  if (options.scope !== undefined && options.scope !== 'global' && options.scope !== 'per-session') {
    throw errorWithCode(
      `Invalid scope: expected 'global' or 'per-session' but received ${JSON.stringify(options.scope)}.`,
      'INVALID_SCOPE',
    )
  }
  const sessionId = asOptionalString(options.sessionId, 'sessionId')
  return {
    ...(tooltip !== undefined ? { tooltip } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  }
}

export function registerUiRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: UiHandlers,
): void {
  // notify 令牌桶（S3-W4）：与 plugin.notify 共用同一实例时由 deps.limiter 注入
  const limiter = deps.limiter ?? new NotifyRateLimiter()

  rpcServer.registerMethod('plugin.ui.showSelect', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const options = asStringArray(params.options, 'options')
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showSelect(title, options, pluginId)
  })

  rpcServer.registerMethod('plugin.ui.showConfirm', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const message = asBoundedString(params.message, 'message', UI_TEXT_MAX_BYTES)
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showConfirm(title, message, pluginId)
  })

  rpcServer.registerMethod('plugin.ui.showInput', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const defaultValue = asOptionalString(params.defaultValue, 'defaultValue')
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showInput(title, defaultValue, pluginId)
  })

  rpcServer.registerMethod('plugin.ui.notify', async (params) => {
    // 与 plugin.notify 同一道窄校验 + 令牌桶（guardNotifyParams 共用）
    const guarded = guardNotifyParams(limiter, params)
    if (guarded === null) {
      console.warn(
        `[ui-api] ui notify dropped: rate limit ${limiter.config.ratePerSec}/s exceeded (plugin=${String(params.pluginId)})`,
      )
      return
    }
    await deps.notify(guarded.pluginId, guarded.level, guarded.message)
  })

  rpcServer.registerMethod('plugin.ui.updateStatusBarItem', async (params) => {
    // CT-D4 毒化隔离可观测：坏条目拒绝除回包给插件外必须留宿主侧日志——
    // RPC 错误响应只到达插件侧，运维排查毒化插件（如批量投递 text:{}）需要
    // 宿主侧痕迹。日志只记错误码级摘要，不回显原始 payload（防日志被毒化刷屏）。
    try {
      const pluginId = asString(params.pluginId, 'pluginId')
      // id 进复合键 `${pluginId}:${id}`（statusBarItems Map 键）——白名单排除
      // 路径分隔符与复合键注入字符 ':'，越界键 INVALID_ID
      const id = asSafeKey(params.id, 'id')
      // 单条 text ≤4KB（D3）：空串 = 移除该 item 的既有语义，0 字节天然放行
      const text = asBoundedString(params.text, 'text', PLUGIN_NOTIFY_LIMITS.STATUSBAR_TEXT_MAX_BYTES)
      const options = parseStatusBarOptions(params.options)
      await deps.updateStatusBarItem(pluginId, id, text, options)
    } catch (e: unknown) {
      // 结构化校验错误的 code 是 'INVALID_*' 字符串（message 是人类可读文案）；
      // 只记校验失败，其他异常（deps 自身错误）原样上抛不打日志
      const code = (e as { code?: unknown }).code
      if (typeof code === 'string' && code.startsWith('INVALID_')) {
        console.warn(
          `[ui-api] statusbar item rejected: ${e instanceof Error ? e.message : String(e)} (plugin=${String(params.pluginId)} id=${String(params.id)})`,
        )
      }
      throw e
    }
  })
}

export function createUiApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  showSelect(title: string, options: string[]): Promise<string | undefined>
  showConfirm(title: string, message: string): Promise<boolean>
  showInput(title: string, defaultValue?: string): Promise<string | undefined>
  notify(level: 'info' | 'warn' | 'error', message: string): Promise<void>
  updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
} {
  return {
    showSelect: (title: string, options: string[]) =>
      rpcClient.request('plugin.ui.showSelect', { pluginId, title, options }) as Promise<string | undefined>,

    showConfirm: (title: string, message: string) =>
      rpcClient.request('plugin.ui.showConfirm', { pluginId, title, message }) as Promise<boolean>,

    showInput: (title: string, defaultValue?: string) =>
      rpcClient.request('plugin.ui.showInput', { pluginId, title, defaultValue }) as Promise<string | undefined>,

    notify: (level: 'info' | 'warn' | 'error', message: string) =>
      rpcClient.request('plugin.ui.notify', { pluginId, level, message }).then(() => {}),

    updateStatusBarItem: (id: string, text: string, options?: StatusBarItemOptions) =>
      rpcClient.request('plugin.ui.updateStatusBarItem', { pluginId, id, text, options }).then(() => {}),
  }
}
