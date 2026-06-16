import { ref } from 'vue'
import { useToastStore } from '../stores/toast'
import { api } from '../api'
import type { ExtensionUIRequestPayload, ServerMessage } from '@xyz-agent/shared'

// ── 模块级单例 ──────────────────────────────────────────────

const activeRequest = ref<ExtensionUIRequestPayload | null>(null)
let listenersRegistered = false

const LEVEL_TO_TOAST_TYPE: Record<string, 'info' | 'warning' | 'danger'> = {
  info: 'info',
  warn: 'warning',
  error: 'danger',
}

function onUIRequest(msg: ServerMessage) {
  const payload = msg.payload as unknown as ExtensionUIRequestPayload

  // notify 是 fire-and-forget（pi 不等回复），走 toast 展示
  if (payload.method === 'notify') {
    const toastType = LEVEL_TO_TOAST_TYPE[payload.level ?? 'info'] ?? 'info'
    const SID_PREFIX_LEN = 8
    const sid = payload.sessionId
    const titleSuffix = sid ? ` [${sid.slice(0, SID_PREFIX_LEN)}]` : ''
    useToastStore().show({
      type: toastType,
      title: `${payload.title ?? '通知'}${titleSuffix}`,
      description: payload.message,
    })
    return
  }

  activeRequest.value = payload
}

function onPluginUIRequest(msg: ServerMessage) {
  activeRequest.value = {
    ...(msg.payload as Record<string, unknown>),
    source: 'plugin',
  } as unknown as ExtensionUIRequestPayload
}

function onUITimeout(_msg: ServerMessage) {
  void _msg
  if (!activeRequest.value) return
  const extName = activeRequest.value.title ?? 'Extension'
  activeRequest.value = null
  useToastStore().show({
    type: 'warning',
    title: 'Extension 请求超时',
    description: `${extName} 的 UI 请求已超时`,
  })
}

function registerListeners() {
  if (listenersRegistered) return
  listenersRegistered = true
  api.events.on('extension.ui_request', onUIRequest)
  api.events.on('extension.ui_timeout', onUITimeout)
  api.events.on('plugin:uiRequest', onPluginUIRequest)
}

// 模块加载时注册监听
registerListeners()

// ── Composable ──────────────────────────────────────────────

export function useExtensionUI() {
  function sendResponse(requestId: string, result: boolean | string | null, sessionId: string) {
    const source = activeRequest.value?.source
    if (source === 'plugin') {
      // Plugin UI response — no sessionId needed
      api.plugin.uiResponse({ requestId, result })
    } else {
      // Extension UI response — existing behavior
      api.extension.uiResponse({ sessionId, requestId, result })
    }
    activeRequest.value = null
  }

  function dismiss() {
    activeRequest.value = null
  }

  return { activeRequest, sendResponse, dismiss }
}
