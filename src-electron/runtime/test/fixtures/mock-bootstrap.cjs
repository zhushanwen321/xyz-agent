/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Mock Worker bootstrap for PluginHost unit tests.
 *
 * Handles load / activate / deactivate / rpc / crash messages without loading real plugins.
 * Written in ESM-compatible format (no require) because the runtime package
 * uses "type": "module" — the copied .js file must be valid ESM.
 */

import { parentPort } from 'node:worker_threads'

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
    } else if (m.type === 'crash') {
      // Simulate crash: exit with non-zero code
      process.exit(1)
    }
  })
}
