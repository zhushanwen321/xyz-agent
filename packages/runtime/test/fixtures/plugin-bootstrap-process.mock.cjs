/**
 * Mock 子进程 bootstrap for PluginHostProcess unit tests.
 *
 * fork 版 mock：响应固定消息，不加载真实插件。
 * 对齐 fixtures/mock-bootstrap.cjs（Worker 版）的消息协议，传输层换 process.send。
 *
 * 特殊分支（测试专用）：
 * - crash → process.exit(1) 模拟子进程崩溃（exit 非 0）
 * - fatal → 回 fatal_error 消息模拟子进程主动报告致命错误
 * - hang  → 不响应（模拟 loadPlugin 超时）
 */
'use strict'

// 收到 hang 后进入挂起态：后续所有消息都不响应（模拟 loadPlugin 超时）
let hanging = false

process.on('message', (msg) => {
  if (hanging) return
  const m = msg
  if (m.type === 'load') {
    process.send({ type: 'loaded', pluginId: m.pluginId })
  } else if (m.type === 'activate') {
    process.send({ type: 'activated', pluginId: m.pluginId })
  } else if (m.type === 'deactivate') {
    process.send({ type: 'deactivated', pluginId: m.pluginId })
  } else if (m.type === 'rpc') {
    // 两种入格式：
    // 1. 宿主 invoke 发的 { type: 'rpc', request: { id, ... } }
    // 2. 扁平 { type: 'rpc', id }（旧协议）
    if (m.request && typeof m.request.id !== 'undefined') {
      process.send({ type: 'rpc', response: { jsonrpc: '2.0', id: m.request.id, result: null } })
    } else if (typeof m.id !== 'undefined') {
      process.send({ type: 'rpc', response: { jsonrpc: '2.0', id: m.id, result: null } })
    }
  } else if (m.type === 'crash') {
    process.exit(1)
  } else if (m.type === 'fatal') {
    process.send({ type: 'fatal_error', error: 'mock fatal error' })
  } else if (m.type === 'hang') {
    hanging = true
  }
})
