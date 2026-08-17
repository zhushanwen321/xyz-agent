/**
 * @deprecated ws-client 已迁入 @xyz-agent/core（packages/core/src/transport/ws-client.ts）。
 * 本文件是过渡期 re-export shim，保留 '@/lib/ws-client' import 路径稳定，消费方零改动。
 *
 * 迁移说明（W2 renderer-rebuild-v2::p1-transport-coordination::transport-migration）：
 * - 实现真源：@xyz-agent/core 的 transport/ws-client（W1 commit af4e21082 迁入）
 * - mock 行为：不再由 renderer 内联 isMock 分支处理，改由 platform 注入
 *   （createMockPlatform 见 ../mock/mock-ws.ts，后续 wave bootstrap 在 VITE_MOCK 时
 *   providePlatform(createMockPlatform())）
 * - 7 值导出 + ConnectionState 类型签名不变，与 core C3 契约一致
 * - 已删除的 renderer 本地逻辑：isMock/VITE_MOCK 分支、mock-ws import、import.meta.hot HMR 块
 *
 * 后续 P6 cleanup wave 将删除本 shim，消费方 import 直接指向 @xyz-agent/core。
 */
export type { ConnectionState } from '@xyz-agent/core'

export {
  connect,
  disconnect,
  send,
  onMessage,
  getState,
  setRestarting,
  setFailed,
} from '@xyz-agent/core'
