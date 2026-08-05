/**
 * Mock fork bootstrap for PluginHostProcess unit tests.
 *
 * Handles load / activate / deactivate / rpc / crash messages without loading real plugins.
 * Dual-environment: Worker thread (parentPort) and fork child process (process).
 * fork 子进程无 parentPort——同一文件两种加载环境都覆盖（协议与 plugin-bootstrap.mock.cjs 对齐）。
 *
 * CJS 后缀：fork 子进程按文件加载（resolveAndValidateFile 链 .cjs → .js → .ts），
 * 且 CJS 里 require('node:worker_threads') 在非 worker 环境返回无 parentPort 的模块。
 */

let parentPort = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- .cjs 是 CJS 模块，ESM import 不可用；动态 require 在非 worker 环境拿到空 parentPort
  ;({ parentPort } = require('node:worker_threads'))
} catch {
  parentPort = null
}

const send = (msg) => {
  if (parentPort) parentPort.postMessage(msg)
  else if (typeof process.send === 'function') process.send(msg)
}

const handle = (m) => {
  if (m.type === 'load') {
    send({ type: 'loaded', pluginId: m.pluginId })
  } else if (m.type === 'activate') {
    send({ type: 'activated', pluginId: m.pluginId })
  } else if (m.type === 'deactivate') {
    send({ type: 'deactivated', pluginId: m.pluginId })
  } else if (m.type === 'rpc' && m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: null })
  } else if (m.type === 'crash') {
    process.exit(1)
  }
}

if (parentPort) {
  parentPort.on('message', handle)
} else {
  process.on('message', handle)
}
