// 验证 CDP offline 是否能阻断 loopback 新建 WS 握手：
// offline=true → 页面 new WebSocket('ws://localhost:3310/...') → 查 readyState 变化
const [, , wsUrl] = process.argv

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
const ws = new WebSocket(wsUrl)

ws.addEventListener('open', async () => {
  try {
    await cdp(ws, 'Network.enable', {}, ++nextId)
    await cdp(ws, 'Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, ++nextId)
    console.log('[probe] offline=true, creating probe WS in page...')
    const r = await cdp(ws, 'Runtime.evaluate', {
      expression: `(function(){
        return new Promise((resolve) => {
          const w = new WebSocket('ws://localhost:3310/gate-probe');
          const t0 = Date.now();
          const report = () => resolve(JSON.stringify({readyState:w.readyState, ms:Date.now()-t0}));
          w.onopen = () => { w.close(); report(); };
          w.onerror = () => { setTimeout(report, 50); };
          setTimeout(report, 4000);
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, ++nextId)
    console.log('[probe] probe WS result:', JSON.stringify(r.result?.result?.value))
    await cdp(ws, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, ++nextId)
    console.log('[probe] offline=false restored')
    process.exit(0)
  } catch (e) {
    console.error('[probe] error:', e.message)
    process.exit(1)
  }
})
ws.addEventListener('error', () => {
  console.error('[probe] ws error')
  process.exit(1)
})
