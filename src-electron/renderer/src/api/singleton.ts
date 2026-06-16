import { createApiClient } from './index'
import { createEventBusTransport } from './transport'

/**
 * 全局 API 单例。
 *
 * 过渡装配（SA1-SA5 阶段）：基于 event-bus + ws-client 的 createEventBusTransport，
 * 与连接状态解耦——ws 未连上时 transport.send 经 ws-client 入队，连接后 flush。
 * SA6 会切断 event-bus 直连 ws，并接上断连善后（rejectAll / clearBySessionId）。
 *
 * 迁移方（composable / store / 组件）统一 `import { api } from '@/api'`（或相对路径），
 * 禁止再直 `import { send } from '../lib/ws-client'`。
 */
export const api = createApiClient({ transport: createEventBusTransport() })
