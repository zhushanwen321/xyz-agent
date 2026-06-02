import { ref } from 'vue'
import { on, off } from '../lib/event-bus'
import { EXTENSION_EVENTS } from '@xyz-agent/shared'
import type { ExtensionWidgetPayload, ExtensionStatusPayload } from '@xyz-agent/shared'

// Module-level singleton state (shared across components in split mode)
const widgets = ref<Map<string, ExtensionWidgetPayload>>(new Map())
const statuses = ref<Map<string, ExtensionStatusPayload>>(new Map())

// CLAUDE.md Rule #2: refCount protection — prevents duplicate listeners in split mode
let refCount = 0

function onWidget(msg: { payload: ExtensionWidgetPayload }) {
  const p = msg.payload
  if (!p?.sessionId || !p?.widgetKey) return
  widgets.value = new Map(widgets.value.set(p.widgetKey, p))
}

function onStatus(msg: { payload: ExtensionStatusPayload }) {
  const p = msg.payload
  if (!p?.sessionId || !p?.statusKey) return
  statuses.value = new Map(statuses.value.set(p.statusKey, p))
}

export function useExtensionWidget() {
  if (refCount++ === 0) {
    on(EXTENSION_EVENTS.WIDGET, onWidget)
    on(EXTENSION_EVENTS.STATUS, onStatus)
  }

  function cleanup() {
    if (--refCount === 0) {
      off(EXTENSION_EVENTS.WIDGET, onWidget)
      off(EXTENSION_EVENTS.STATUS, onStatus)
      widgets.value = new Map()
      statuses.value = new Map()
    }
  }

  return { widgets, statuses, cleanup }
}
