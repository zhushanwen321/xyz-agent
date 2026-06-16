import type { ClientMessage } from '@xyz-agent/shared'
import type { Transport } from './transport'
import { createPending } from './pending'
import { createEvents } from './events'
import type { EventApi } from './events'
import { sessionApi } from './domains/session'
import { chatApi } from './domains/chat'
import { configApi } from './domains/config'
import { modelApi } from './domains/model'
import { treeApi } from './domains/tree'
import { extensionApi } from './domains/extension'
import { pluginApi } from './domains/plugin'
import { systemApi } from './domains/system'
import type { SessionDomain } from './domains/session'
import type { ChatDomain } from './domains/chat'
import type { ConfigDomain } from './domains/config'
import type { ModelDomain } from './domains/model'
import type { TreeDomain } from './domains/tree'
import type { ExtensionDomain } from './domains/extension'
import type { PluginDomain } from './domains/plugin'
import type { SystemDomain } from './domains/system'

export interface ApiClient {
  transport: Transport
  /** 命令：发消息并等待 id 匹配的响应（payload 类型 T 由调用方断言）。 */
  command: <T>(msg: ClientMessage) => Promise<T>
  /** 事件订阅 + session 路由（D6b）+ 重连收尾信号（G5）。 */
  events: EventApi
  session: SessionDomain
  chat: ChatDomain
  config: ConfigDomain
  model: ModelDomain
  tree: TreeDomain
  extension: ExtensionDomain
  plugin: PluginDomain
  system: SystemDomain
}

export function createApiClient(opts: { transport: Transport }): ApiClient {
  const pending = createPending({ send: (m) => opts.transport.send(m) })
  const events = createEvents()

  // events 是 transport 的唯一消息分发入口：
  // 命令响应（id 匹配 pending）→ pending 结算并 return；
  // 否则交 events._dispatch 走事件路径（D6b 无 sessionId 丢弃 + emit 给订阅者）。
  // 只注册一个 onMessage，避免 SA1 的双重分发问题。
  opts.transport.onMessage((msg) => {
    if (pending.handleMessage(msg)) return
    events._dispatch(msg)
  })

  const cmd = <T>(m: ClientMessage) => pending.command<T>(m)

  return {
    transport: opts.transport,
    command: cmd,
    events,
    session: sessionApi(cmd),
    chat: chatApi(cmd),
    config: configApi(cmd),
    model: modelApi(cmd),
    tree: treeApi(cmd),
    extension: extensionApi(cmd),
    plugin: pluginApi(cmd),
    system: systemApi(cmd),
  }
}

// 全局单例 re-export：composable / store / 组件统一 `import { api } from '@/api'`。
// 循环依赖安全：createApiClient 是函数声明（hoisted），singleton.ts 求值时已可用。
export { api } from './singleton'
