import { ref } from 'vue'
import { on, emit as emitEventBus } from '../lib/event-bus'
import { send } from '../lib/ws-client'
import type { ExtensionUIRequestPayload, ServerMessage } from '@xyz-agent/shared'

// ── 模块级单例 ──────────────────────────────────────────────

const activeRequest = ref<ExtensionUIRequestPayload | null>(null)
let listenersRegistered = false

function onUIRequest(msg: ServerMessage) {
  activeRequest.value = msg.payload as unknown as ExtensionUIRequestPayload
}

function onUITimeout(_msg: ServerMessage) {
  void _msg
  if (!activeRequest.value) return
  const extName = activeRequest.value.title ?? 'Extension'
  activeRequest.value = null
  // toast 通过 App.vue 全局 toast 显示，这里用 event-bus 通知
  emitEventBus('extension.ui_timed_out', { extensionName: extName })
}

function registerListeners() {
  if (listenersRegistered) return
  listenersRegistered = true
  on('extension.ui_request', onUIRequest)
  on('extension.ui_timeout', onUITimeout)
}

// 模块加载时注册监听
registerListeners()

// ── Composable ──────────────────────────────────────────────

export function useExtensionUI() {
  function sendResponse(requestId: string, result: boolean | string | null, sessionId: string) {
    send({
      type: 'extension.ui_response',
      payload: { sessionId, requestId, result },
    })
    activeRequest.value = null
  }

  function dismiss() {
    activeRequest.value = null
  }

  return { activeRequest, sendResponse, dismiss }
}
