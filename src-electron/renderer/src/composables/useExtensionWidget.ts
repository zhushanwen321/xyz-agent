import { ref } from 'vue'
import { api } from '../api'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import type { ServerMessage, ExtensionWidgetPayload, ExtensionStatusPayload } from '@xyz-agent/shared'

// Module-level singleton state (shared across components in split mode)
const widgets = ref<Map<string, ExtensionWidgetPayload>>(new Map())
const statuses = ref<Map<string, ExtensionStatusPayload>>(new Map())

// 永久注册 listeners：widget/status 数据在 pi 进程重启后不会重新发送，
// 必须保持 listeners 持久化以捕获所有事件
let listenersRegistered = false

function onWidget(msg: ServerMessage) {
  const p = msg.payload as unknown as ExtensionWidgetPayload
  if (!p?.sessionId || !p?.widgetKey) return
  const key = `${p.sessionId}:${p.widgetKey}`
  if (p.lines.length === 0) {
    const next = new Map(widgets.value)
    next.delete(key)
    widgets.value = next
  } else {
    widgets.value = new Map(widgets.value.set(key, p))
  }
}

function onStatus(msg: ServerMessage) {
  const p = msg.payload as unknown as ExtensionStatusPayload
  if (!p?.sessionId || !p?.statusKey) return
  const key = `${p.sessionId}:${p.statusKey}`
  if (!p.text) {
    const next = new Map(statuses.value)
    next.delete(key)
    statuses.value = next
  } else {
    statuses.value = new Map(statuses.value.set(key, p))
  }
}

function ensureListeners() {
  if (listenersRegistered) return
  listenersRegistered = true
  api.events.on(EXTENSION_EVENTS.WIDGET, onWidget)
  api.events.on(EXTENSION_EVENTS.STATUS, onStatus)
}

export function useExtensionWidget() {
  ensureListeners()
  return { widgets, statuses }
}
