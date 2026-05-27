/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Mock Worker bootstrap for PluginHost unit tests.
 *
 * Handles load / activate / deactivate / rpc messages without loading real plugins.
 * This file is a CommonJS test fixture — Worker threads need a directly
 * executable script, and CJS is the simplest format for that purpose.
 */

const { parentPort } = require('node:worker_threads')

if (parentPort) {
  parentPort.on('message', (msg) => {
    const m = msg
    if (m.type === 'load') {
      parentPort.postMessage({ type: 'loaded', pluginId: m.pluginId })
    } else if (m.type === 'activate') {
      parentPort.postMessage({ type: 'activated', pluginId: m.pluginId })
    } else if (m.type === 'deactivate') {
      parentPort.postMessage({ type: 'deactivated', pluginId: m.pluginId })
    } else if (m.type === 'rpc' && m.id !== undefined) {
      parentPort.postMessage({ jsonrpc: '2.0', id: m.id, result: null })
    }
  })
}
