/**
 * usePendingRequestsBatchEffect —— 全局单例订阅 extension.pendingRequestsBatch 批量补发。
 *
 * P3 D3 决策：sendInitialState 第 14 段在冷启动/长断线/页面 reload 时点对点推送跨 session 聚合的
 * pending UI 请求（审批/ask-user/select/input/editor），唤醒客户端恢复审批挂起状态。短断线由 P2
 * ring buffer 回放覆盖（extension.ui_request 是广播，天然入 buffer）。
 *
 * 职责：
 * 1. 在 App setup 作用域注册 onPendingRequestsBatch 全局订阅（早于 WS initial state 推送）。
 * 2. 收到 requests 数组后逐条 mapPendingToUIRequest 解包为 ExtensionUIRequest，按 req.sessionId
 *    写入 extensionUIStore 对应分区（跨 session 分流）。
 * 3. requestId dedup 由 store.addRequest 内置（兜底 P2 回放 + initial state 补发对同一请求的重复投递）。
 * 4. onScopeDispose 随 App 卸载自动退订。
 *
 * 与 useExtensionUI（per-panel 实时订阅）的区别：
 * - useExtensionUI 订阅实时 extension.ui_request（单 session，per-panel 实例各自订阅）。
 * - 本 effect 订阅批量补发 extension.pendingRequestsBatch（跨 session 聚合，全局单例）。
 * 两者都写入同一 extensionUIStore（requestId dedup 兜底重复），渲染层从 store 派生不区分来源。
 *
 * 数据流：
 * extension.pendingRequestsBatch（global，payload { requests: PendingUiRequest[] }）
 *   → for each req: mapPendingToUIRequest(req) → store.addRequest(req.sessionId, mapped)
 *   → store 分区派生 → useExtensionUI computed → ExtensionUIDialog/Panel 渲染审批 UI
 */
import { onScopeDispose } from 'vue'
import { onPendingRequestsBatch, mapPendingToUIRequest } from '@/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'

/**
 * 绑定 extension.pendingRequestsBatch 全局订阅（App setup 单次调用）。
 *
 * 必须在 effectScope 内调用（App setup 是 effectScope）——onScopeDispose 随作用域卸载退订。
 * 异常条目（mapPendingToUIRequest 返回 undefined）跳过不入 store（ES3）。
 */
export function bindPendingRequestsBatchEffect(): void {
  const store = useExtensionUIStore()
  const unsub = onPendingRequestsBatch((requests) => {
    for (const req of requests) {
      const mapped = mapPendingToUIRequest(req)
      // 类型守卫跳过异常条目（mapPendingToUIRequest 返回 undefined）
      if (!mapped) continue
      // 按 req.sessionId 写入对应 store 分区（跨 session 分流）。
      // requestId dedup 由 store.addRequest 内置兜底（P2 回放 + initial state 补发边角重复）。
      store.addRequest(req.sessionId, mapped)
    }
  })
  onScopeDispose(unsub)
}
