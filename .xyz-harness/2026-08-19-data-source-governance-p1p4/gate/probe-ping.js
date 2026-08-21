// 对页面现有 3310 WS 实例发 runtime ping，观察是否收到 pong（验证连接活性/auth 状态）
const [, , wsUrl] = process.argv
function cdp(ws, method, params = {}) {
  const id = ++cdpId
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
let cdpId = 0
const ws = new WebSocket(wsUrl)
ws.addEventListener('open', async () => {
  try {
    await cdp(ws, 'Runtime.enable')
    const proto = await cdp(ws, 'Runtime.evaluate', { expression: 'WebSocket.prototype' })
    const q = await cdp(ws, 'Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId })
    const r = await cdp(ws, 'Runtime.callFunctionOn', {
      objectId: q.result.objects.objectId,
      functionDeclaration: `function () {
        return new Promise((resolve) => {
          const target = Array.from(this).find(w => String(w.url||'').includes(':3310') && w.readyState === 1);
          if (!target) { resolve(JSON.stringify({error: 'no open 3310 ws'})); return; }
          let got = [];
          target.addEventListener('message', (ev) => { got.push(String(ev.data).slice(0, 120)); });
          target.send(JSON.stringify({ type: 'ping', payload: {} }));
          setTimeout(() => resolve(JSON.stringify({ sent: true, replies: got })), 2500);
        });
      }`,
      awaitPromise: true,
      returnByValue: true,
    })
    console.log('ping probe:', r.result?.result?.value)
    process.exit(0)
  } catch (e) {
    console.error('error:', e.message)
    process.exit(1)
  }
})
