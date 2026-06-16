import { createApiClient } from './index'
import { createEventBusTransport } from './transport'
import { createMockTransport } from './mock'

/**
 * 全局 API 单例。
 *
 * 装配（SA3 起）：
 * - VITE_MOCK=true → createMockTransport()，不走真实 ws，send 按响应表回灌预制 ServerMessage。
 *   选 A：mock transport 独立，ws-client 的 isMock 分支仅驱动 UI 连接状态，二者互不依赖。
 * - 否则 → createEventBusTransport()（过渡期 event-bus + ws-client），SA6 会切断 event-bus 直连 ws
 *   并接上断连善后（rejectAll / clearBySessionId）。
 *
 * 迁移方（composable / store / 组件）统一 `import { api } from '@/api'`（或相对路径），
 * 禁止再直 `import { send } from '../lib/ws-client'`。
 */
const transport = import.meta.env.VITE_MOCK === 'true'
  ? createMockTransport()
  : createEventBusTransport()

export const api = createApiClient({ transport })
