export interface ExtensionWidgetPayload {
  sessionId: string
  widgetKey: string
  lines: string[]
}

export interface ExtensionStatusPayload {
  sessionId: string
  statusKey: string
  text: string
}

export const EXTENSION_EVENTS = {
  WIDGET: 'extension:widget',
  STATUS: 'extension:status',
} as const
