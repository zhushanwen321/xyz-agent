/**
 * PluginRpcClient clientId 注入测试（P7 长期方案 A Worker 侧）。
 *
 * 验证 Worker→主线程 RPC 请求自动注入当前执行上下文 clientId：
 * plugin-bootstrap 在 plugin.tool.execute 入口 setCurrentClientId(clientId)，
 * 工具执行期内 plugin 调 api.sessions.getActive 等经 rpcClient.request 发出的 RPC
 * 都会在 params 注入 [CLIENT_ID_PARAM_KEY]。主线程 handler 据此 per-client resolve，
 * 绕开 ALS 跨独立 I/O tick 断裂（P7 核心缺陷）。
 */
import { describe, it, expect } from 'vitest'
import { PluginRpcClient } from './plugin-rpc-client.js'
import { CLIENT_ID_PARAM_KEY } from './plugin-types.js'

/** 捕获 postMessage 的 mock port。 */
function capturePort(): { port: { postMessage(msg: unknown): void }; messages: unknown[] } {
  const messages: unknown[] = []
  return {
    port: { postMessage: (msg: unknown) => messages.push(msg) },
    messages,
  }
}

describe('PluginRpcClient clientId 注入 (P7 长期方案 A)', () => {
  // TC-c1: 未设置 currentClientId 时 request 不注入（hook/定时器/生命周期触发的 plugin 操作）
  it('TC-c1: currentClientId 未设置 → request 不注入 CLIENT_ID_PARAM_KEY', async () => {
    const { port, messages } = capturePort()
    const client = new PluginRpcClient()
    client.attach(port)

    // 不调 setCurrentClientId（默认 undefined）
    const p = client.request('plugin.sessions.getActive', { pluginId: 'p' })
    // pending 不会 resolve（无响应），手动 catch 防止 unhandledRejection
    p.catch(() => {})

    expect(messages).toHaveLength(1)
    const msg = messages[0] as { params: Record<string, unknown> }
    expect(msg.params).not.toHaveProperty(CLIENT_ID_PARAM_KEY)
    expect(msg.params).toEqual({ pluginId: 'p' })
  })

  // TC-c2: setCurrentClientId 后 request 自动注入到 params
  it('TC-c2: setCurrentClientId 后 request 自动注入 CLIENT_ID_PARAM_KEY', async () => {
    const { port, messages } = capturePort()
    const client = new PluginRpcClient()
    client.attach(port)

    client.setCurrentClientId('client-A')
    client.request('plugin.sessions.getActive', { pluginId: 'p' }).catch(() => {})

    const msg = messages[0] as { params: Record<string, unknown> }
    expect(msg.params[CLIENT_ID_PARAM_KEY]).toBe('client-A')
    // 原 params 字段保留
    expect(msg.params.pluginId).toBe('p')
  })

  // TC-c3: setCurrentClientId(undefined) 后不再注入（复位）
  it('TC-c3: setCurrentClientId(undefined) 复位后不再注入', async () => {
    const { port, messages } = capturePort()
    const client = new PluginRpcClient()
    client.attach(port)

    client.setCurrentClientId('client-A')
    client.request('plugin.sessions.getActive', { pluginId: 'p1' }).catch(() => {})
    client.setCurrentClientId(undefined)
    client.request('plugin.sessions.getActive', { pluginId: 'p2' }).catch(() => {})

    const msg1 = messages[0] as { params: Record<string, unknown> }
    const msg2 = messages[1] as { params: Record<string, unknown> }
    expect(msg1.params[CLIENT_ID_PARAM_KEY]).toBe('client-A')
    expect(msg2.params).not.toHaveProperty(CLIENT_ID_PARAM_KEY)
  })

  // TC-c4: getCurrentClientId 读取当前值（save/restore 用）
  it('TC-c4: getCurrentClientId 返回当前设置的 clientId', () => {
    const client = new PluginRpcClient()
    expect(client.getCurrentClientId()).toBeUndefined()
    client.setCurrentClientId('client-B')
    expect(client.getCurrentClientId()).toBe('client-B')
    client.setCurrentClientId(undefined)
    expect(client.getCurrentClientId()).toBeUndefined()
  })

  // TC-c5: 多次 request 都注入同一个 currentClientId（工具执行期内多次 RPC 调用）
  it('TC-c5: currentClientId 设置期内多次 request 都注入同一 clientId', async () => {
    const { port, messages } = capturePort()
    const client = new PluginRpcClient()
    client.attach(port)

    client.setCurrentClientId('client-C')
    client.request('plugin.sessions.getActive', { pluginId: 'p' }).catch(() => {})
    client.request('plugin.sessions.sendMessage', { pluginId: 'p', role: 'user', content: 'hi' }).catch(() => {})
    client.request('plugin.agent.getModel', { pluginId: 'p' }).catch(() => {})

    expect(messages).toHaveLength(3)
    for (const m of messages) {
      const msg = m as { params: Record<string, unknown> }
      expect(msg.params[CLIENT_ID_PARAM_KEY]).toBe('client-C')
    }
  })
})
