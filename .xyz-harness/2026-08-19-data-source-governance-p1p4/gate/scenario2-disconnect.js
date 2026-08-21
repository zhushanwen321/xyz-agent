// 场景 2 断连主脚本（gate 专用）：
// 1. CDP offline=true（阻断重连新握手——已验证 52ms 内 loopback WS 握手失败）
// 2. Runtime.queryObjects(WebSocket.prototype) 枚举页面 WS 实例 → 对 OPEN 的 3310 连接调 .close()
//    —— 触发 ws-client 的 onclose（真实连接死亡）→ scheduleReconnect 指数退避
// 3. 30s 断连窗口（重连尝试全被 offline 阻断）
// 4. offline=false → 下一次 backoff 到期 connect 成功 → auth → connected
// 5. 全程捕获 console [ws] 日志与 WS 生命周期事件，输出时间线
const [, , wsUrl, disconnectMsArg] = process.argv
const disconnectMs = Number(disconnectMsArg || 30000)

function cdp(ws, method, params = {}) {
  const id = ++cdpId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout ' + method)), 20000)
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
let cdpId = 0

const logs = []
const t0 = Date.now()
const log = (s) => {
  logs.push(`+${Date.now() - t0}ms ${s}`)
  console.log(`[s2] +${Date.now() - t0}ms ${s}`)
}

const ws = new WebSocket(wsUrl)
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (text.includes('[ws]')) log(`CONSOLE[${msg.params.type}] ${text.slice(0, 180)}`)
  }
  if (msg.method === 'Network.webSocketClosed') log(`WS-EVENT closed identifier=${msg.params.identifier}`)
  if (msg.method === 'Network.webSocketCreated') log(`WS-EVENT created url=${msg.params.url}`)
  if (msg.method === 'Network.webSocketHandshakeResolved') log(`WS-EVENT handshake-resolved identifier=${msg.params.identifier}`)
})
ws.addEventListener('error', () => {
  console.error('[s2] CDP ws error')
  process.exit(1)
})

ws.addEventListener('open', async () => {
  try {
    await cdp(ws, 'Network.enable')
    await cdp(ws, 'Runtime.enable')

    // 1. offline 阻断层
    await cdp(ws, 'Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    log(`offline=true (block reconnect handshakes for ${disconnectMs}ms)`)

    // 2. 真实断开层：queryObjects 拿 WS 实例并 close
    const proto = await cdp(ws, 'Runtime.evaluate', { expression: 'WebSocket.prototype' })
    const protoObjId = proto.result?.result?.objectId
    if (!protoObjId) throw new Error('no prototype objectId')
    const q = await cdp(ws, 'Runtime.queryObjects', { prototypeObjectId: protoObjId })
    const arrObjId = q.result?.objects?.objectId
    if (!arrObjId) throw new Error('no objects objectId')
    const closed = await cdp(ws, 'Runtime.callFunctionOn', {
      objectId: arrObjId,
      functionDeclaration: `function () {
        const arr = this;
        const targets = [];
        for (const w of arr) {
          try {
            if (w && w.readyState === 1 && String(w.url || '').includes(':3310')) targets.push(w.url);
          } catch (e) { /* not a live ws */ }
        }
        for (const w of arr) {
          try {
            if (w && w.readyState === 1 && String(w.url || '').includes(':3310')) w.close();
          } catch (e) { /* ignore */ }
        }
        return JSON.stringify(targets);
      }`,
      returnByValue: true,
    })
    log(`closed renderer runtime WS instances: ${closed.result?.result?.value}`)

    // 3. 断连窗口
    await new Promise((r) => setTimeout(r, disconnectMs))

    // 4. 恢复
    await cdp(ws, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    log('offline=false restored, waiting for reconnect...')

    // 5. 观察重连窗口（backoff cap 30s，等足够久）
    await new Promise((r) => setTimeout(r, 40000))
    log('observation window done')
    console.log('\n[s2] ===== full timeline =====')
    console.log(logs.join('\n'))
    process.exit(0)
  } catch (e) {
    console.error('[s2] error:', e.message)
    console.log(logs.join('\n'))
    process.exit(1)
  }
})
