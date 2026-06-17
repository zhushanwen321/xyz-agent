/**
 * API Client 工厂 —— 从 index.ts 抽出，打断 index ↔ singleton 循环依赖。
 *
 * 循环根因曾是：index.ts 定义 createApiClient 且 re-export singleton 的 api 单例，
 * singleton.ts 又从 index.ts 导入 createApiClient。抽出工厂后：
 *   index.ts ──export api──► singleton.ts ──import createApiClient──► factory.ts（单向，无环）
 *   index.ts ──export type ApiClient──► factory.ts
 */
import type { ClientMessage } from '@xyz-agent/shared'
import type { Transport } from './transport'
import type { IpcTransport } from './ipc-transport'
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
import { windowApi } from './domains/window'
import { dialogApi } from './domains/dialog'
import { runtimePortApi } from './domains/runtime-port'
import type { SessionDomain } from './domains/session'
import type { ChatDomain } from './domains/chat'
import type { ConfigDomain } from './domains/config'
import type { ModelDomain } from './domains/model'
import type { TreeDomain } from './domains/tree'
import type { ExtensionDomain } from './domains/extension'
import type { PluginDomain } from './domains/plugin'
import type { SystemDomain } from './domains/system'
import type { WindowDomain } from './domains/window'
import type { DialogDomain } from './domains/dialog'
import type { RuntimePortDomain } from './domains/runtime-port'

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
  /** M2 Window Manager IPC（design.md D1/R4 统一门面）。 */
  window: WindowDomain
  /** M3 OS Gateway IPC：对话框 + 外链。 */
  dialog: DialogDomain
  /** M1 Process Supervisor IPC：runtime 端口发现 + 重连。 */
  runtimePort: RuntimePortDomain
}

export function createApiClient(opts: { transport: Transport; ipc?: IpcTransport }): ApiClient {
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
    system: systemApi(cmd, opts.ipc),
    window: windowApi(opts.ipc ?? { ipc: undefined }),
    dialog: dialogApi(opts.ipc ?? { ipc: undefined }),
    runtimePort: runtimePortApi(opts.ipc ?? { ipc: undefined }),
  }
}

