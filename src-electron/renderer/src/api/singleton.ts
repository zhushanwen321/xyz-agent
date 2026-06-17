import { createApiClient } from './factory'
import { createEventBusTransport } from './transport'
import { createMockTransport } from './mock'
import { createIpcTransport } from './ipc-transport'

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

export const api = createApiClient({
  transport,
  // 绑定 preload 注入的 electronAPI（web/mock 环境下为 undefined，domain 方法优雅降级）。
  // design.md R4：API Client 是 WS + IPC 的统一门面，IPC 经 IpcTransport 注入。
  ipc: createIpcTransport(window.electronAPI),
})

/**
 * 连接状态 ref（re-export 自 ws-client）：App/AppStatusbar 读传输层连接状态。
 * 过渡期 re-export 合理——SA6 收口 getState 直调，后续 ws 直连 api 后由 transport 内化。
 */
export { getState } from '../lib/ws-client'
