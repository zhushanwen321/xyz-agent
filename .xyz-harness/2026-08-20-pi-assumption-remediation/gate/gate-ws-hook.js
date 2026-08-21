// gate 探针 A：对页面已 auth 的 3310 WS 挂持久 message listener，
// 帧推入 window.__gateMsgLog（数组，元素 {t, data}）。
const [, , wsUrl] = process.argv
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
const ws = new WebSocket(wsUrl)
ws.addEventListener('open', async () => {
  try {
    await cdp(ws, 'Runtime.enable')
    const proto = await cdp(ws, 'Runtime.evaluate', { expression: 'WebSocket.prototype' })
    const q = await cdp(ws, 'Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId })
    const r = await cdp(ws, 'Runtime.callFunctionOn', {
      objectId: q.result.objects.objectId,
      functionDeclaration: `function () {
        const target = Array.from(this).find(w => String(w.url||'').includes(':3310') && w.readyState === 1);
        if (!target) return JSON.stringify({error: 'no open 3310 ws'});
        window.__gateMsgLog = window.__gateMsgLog || [];
        window.__gateWs = target;
        window.__gateListener = (ev) => {
          try {
            const m = JSON.parse(ev.data);
            window.__gateMsgLog.push({ t: Date.now(), type: m.type, id: m.id, payload: m.payload, error: m.error });
          } catch {}
        };
        target.addEventListener('message', window.__gateListener);
        return JSON.stringify({ok: true, url: target.url, hooked: true});
      }`,
      returnByValue: true,
    })
    console.log('hook result:', r.result?.result?.value)
    process.exit(0)
  } catch (e) {
    console.error('error:', e.message)
    process.exit(1)
  }
})
