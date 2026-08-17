/**
 * extension-host-dialog.ts —— CompanionBand 适配层（FR2/FR7，AC2/AC6/AC9）。
 *
 * 把 core MessageBusBridge 归一后的 bus ui-request 事件 + runtime WS 通道
 * 适配成 ui 包契约（DialogRequestSource / UiResponseTransport，companion-band-source.ts），
 * 由 initExtensionHostBridge provide 注入，CompanionBand 消费。
 *
 * 数据流：bus 'ui-request'（plugin:uiRequest + extension.ui_request 双源归一）
 * → createDialogRequestSource.onUiRequest（无 sid 跳过 / askUser 过滤 C4 分流）
 * → convertToDialogRequest → DialogRequestQueue → CompanionBand 渲染
 * → 用户操作 → queue.respond → transport 回传（pi → extension.ui_response / plugin → plugin.uiResponse）。
 *
 * 分流契约（feature clarify C2/C4）：askUser 请求由 useExtensionUI 消费（Panel inline 独占），
 * 本适配层只投递非 askUser（CompanionBand 独占 dialog）；两者在数据源层分流，零重叠。
 */
import type { InternalEvent, InternalEventBus } from '@xyz-agent/core'
import type {
  DialogRequest,
  DialogRequestOption,
  DialogRequestSource,
  UiResponseTransport,
} from '@xyz-agent/ui/extension-host'
import type { ExtensionInteractMethod } from '@xyz-agent/shared'
import { onCrossSession } from '@/api/events'
import * as transport from '@/api/transport'
import { sendExtensionUIResponse } from '@/api/domains/extension'

type UiRequestEvent = Extract<InternalEvent, { kind: 'ui-request' }>

// ── 类型守卫（索引签名字段收窄，禁止 any 断言） ──────────────────────

const DIALOG_METHODS: readonly DialogRequest['method'][] = ['confirm', 'select', 'input', 'editor', 'askUser']

function isDialogMethod(v: unknown): v is DialogRequest['method'] {
  return typeof v === 'string' && (DIALOG_METHODS as readonly string[]).includes(v)
}

/** options 对象形状守卫：{ label: string, value: string, description?: string } */
function isOptionObject(v: unknown): v is { label: string; value: string; description?: string } {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.label === 'string' && typeof o.value === 'string'
}

/**
 * options 双形状归一（AC2）：string[] → { label, value }[]；
 * { label, value, description? }[] 透传；非法项跳过；无有效项返回 undefined。
 */
function normalizeOptions(options: unknown): DialogRequestOption[] | undefined {
  if (!Array.isArray(options)) return undefined
  const out: DialogRequestOption[] = []
  for (const item of options) {
    if (typeof item === 'string') {
      out.push({ label: item, value: item })
    } else if (isOptionObject(item)) {
      out.push({
        label: item.label,
        value: item.value,
        ...(item.description !== undefined ? { description: item.description } : {}),
      })
    }
    // 非法项（非 string 且非合法对象形状）跳过
  }
  return out.length > 0 ? out : undefined
}

/**
 * 转换 bus ui-request 事件为 ui 包 DialogRequest（AC2）：
 * - source：request.pluginId !== '' → 'plugin'（plugin 源），否则 'pi'（extension 源统一 ''）
 * - method：askUser === true → 'askUser'（C2 改写，askUserQuestions/allowCancel 透传）；
 *   否则索引签名原始 method（超界如 editor 透传）?? kind 兜底（对齐 toExtensionUIRequest 语义）
 * - options：双形状归一（normalizeOptions）
 * - receivedAt：转换时刻时间戳（队列倒计时基准）
 */
export function convertToDialogRequest(e: UiRequestEvent): DialogRequest {
  const req = e.request
  const askUser = req.askUser === true
  const method: DialogRequest['method'] = askUser
    ? 'askUser'
    : isDialogMethod(req.method)
      ? req.method
      : req.kind
  return {
    source: req.pluginId !== '' ? 'plugin' : 'pi',
    sessionId: e.sessionId ?? '',
    requestId: req.requestId,
    method,
    ...(req.title !== undefined ? { title: req.title as string } : {}),
    ...(req.message !== undefined ? { message: req.message as string } : {}),
    ...(normalizeOptions(req.options) !== undefined ? { options: normalizeOptions(req.options)! } : {}),
    ...(req.default !== undefined ? { default: req.default as string } : {}),
    ...(req.prefill !== undefined ? { prefill: req.prefill as string } : {}),
    ...(req.level !== undefined ? { level: req.level as 'info' | 'warn' | 'error' } : {}),
    ...(askUser ? { askUserQuestions: req.askUserQuestions as unknown[] } : {}),
    ...(askUser ? { allowCancel: req.allowCancel as boolean } : {}),
    receivedAt: Date.now(),
  }
}

/**
 * 创建 DialogRequestSource（bus 'ui-request' + WS extension.ui_timeout 适配）：
 * - onUiRequest：无 sessionId 跳过 + console.warn（C2，防 '' 分区脏数据）；
 *   askUser === true 跳过投递（C4 分流，CompanionBand 独占 dialog）
 * - onUiTimeout：WS extension.ui_timeout（C3 保留 WS 路径，不经 bus），事件自带 sessionId
 */
export function createDialogRequestSource(bus: InternalEventBus): DialogRequestSource {
  return {
    onUiRequest(handler) {
      return bus.on('ui-request', (e) => {
        if (!e.sessionId) {
          console.warn('[dialog-adapters] ui-request 事件缺少 sessionId，跳过投递:', e.request.requestId)
          return
        }
        if (e.request.askUser === true) return // C4：askUser 由 useExtensionUI 消费（Panel inline）
        handler(convertToDialogRequest(e))
      })
    },
    onUiTimeout(handler) {
      // MF-6：extension.ui_timeout 广播 payload 带 sessionId，route-inbound 落 session 通道 +
      // CROSS_SESSION_TYPES（crossSession 通道），onGlobal 收不到带 sid 消息——必须订阅
      // crossSession 通道（onUiTimeout 自身按 payload.sessionId 校验，双保险）。
      return onCrossSession((msg) => {
        if (msg.type !== 'extension.ui_timeout') return
        const payload = msg.payload as { sessionId?: unknown; requestId?: unknown }
        if (typeof payload.sessionId !== 'string' || typeof payload.requestId !== 'string') return
        handler({ sessionId: payload.sessionId, requestId: payload.requestId })
      })
    },
  }
}

/** method 收窄到 ExtensionInteractMethod（askUser 请求已被 C4 过滤，不会到达回传通道） */
function toInteractMethod(method: string): ExtensionInteractMethod {
  return method === 'confirm' || method === 'select' || method === 'input' || method === 'editor'
    ? method
    : 'input' // 兜底对齐 core parseUiRequest 的 kind 兜底语义
}

/**
 * 创建 UiResponseTransport（回传双通道）：
 * - sendPiResponse：复用 sendExtensionUIResponse（extension.ui_response，method 透传，
 *   runtime 按 method 构建 pi 响应格式，AC9）
 * - sendPluginResponse：发 plugin.uiResponse（runtime UiRequestQueue.handleResponse 消费，AC6）
 */
export function createUiResponseTransport(): UiResponseTransport {
  return {
    sendPiResponse(sessionId, requestId, method, result) {
      sendExtensionUIResponse(sessionId, requestId, toInteractMethod(method), result)
    },
    sendPluginResponse(requestId, result) {
      transport.send({ type: 'plugin.uiResponse', payload: { requestId, result } })
    },
  }
}
