// 查询页面所有 WebSocket 实例的 url/readyState/protocol（CDP queryObjects，只读）
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
    const proto = await cdp(ws, 'Runtime.evaluate', { expression: 'WebSocket.prototype' })
    const q = await cdp(ws, 'Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId })
    const r = await cdp(ws, 'Runtime.callFunctionOn', {
      objectId: q.result.objects.objectId,
      functionDeclaration: `function () {
        return JSON.stringify(Array.from(this).map(w => ({ url: String(w.url||''), readyState: w.readyState, bufferedAmount: w.bufferedAmount })));
      }`,
      returnByValue: true,
    })
    console.log('WS instances:', r.result?.result?.value)
    process.exit(0)
  } catch (e) {
    console.error('error:', e.message)
    process.exit(1)
  }
})
