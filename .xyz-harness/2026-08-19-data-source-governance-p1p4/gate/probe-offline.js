// CDP offline 探针（gate 专用）：
// 连 page WS → 开 Network/Runtime → offline=true → 观察 renderer console 是否出现
// [ws] onclose/reconnecting 链 → offline=false 恢复 → 打印捕获的 [ws] 日志。
// 用法: node probe-offline.js <wsUrl> <offlineMs>
const [, , wsUrl, offlineMsArg] = process.argv
const offlineMs = Number(offlineMsArg || 5000)

function cdp(ws, method, params = {}, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout ' + method)), 15000)
    const handler = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === id) {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

let nextId = 0
const wsLogs = []
const ws = new WebSocket(wsUrl)
const t0 = Date.now()

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (text.includes('[ws]')) wsLogs.push(`+${Date.now() - t0}ms [${msg.params.type}] ${text.slice(0, 160)}`)
  }
  if (msg.method === 'Network.webSocketClosed') {
    wsLogs.push(`+${Date.now() - t0}ms [WS-CLOSED] ${JSON.stringify(msg.params).slice(0, 120)}`)
  }
  if (msg.method === 'Network.webSocketCreated') {
    wsLogs.push(`+${Date.now() - t0}ms [WS-CREATED] ${msg.params.url}`)
  }
  if (msg.method === 'Network.webSocketWillSendHandshakeRequest') {
    wsLogs.push(`+${Date.now() - t0}ms [WS-HANDSHAKE] ${msg.params.url}`)
  }
})

ws.addEventListener('open', async () => {
  try {
    await cdp(ws, 'Network.enable', {}, ++nextId)
    await cdp(ws, 'Runtime.enable', {}, ++nextId)
    console.log(`[probe] setting offline=true for ${offlineMs}ms`)
    await cdp(ws, 'Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, ++nextId)
    setTimeout(async () => {
      await cdp(ws, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, ++nextId)
      console.log('[probe] offline=false restored')
      // 恢复后再观察 10s 的重连日志
      setTimeout(() => {
        console.log('[probe] captured ws logs:')
        console.log(wsLogs.length ? wsLogs.join('\n') : '(none)')
        process.exit(0)
      }, 10000)
    }, offlineMs)
  } catch (e) {
    console.error('[probe] error:', e.message)
    process.exit(1)
  }
})
ws.addEventListener('error', (e) => {
  console.error('[probe] ws error', e)
  process.exit(1)
})
