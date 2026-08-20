// gate 探针 C：包装页面 3310 WS 的 send，client→server 帧推入 window.__gateSentLog
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
        const target = window.__gateWs || Array.from(this).find(w => String(w.url||'').includes(':3310') && w.readyState === 1);
        if (!target) return JSON.stringify({error: 'no open 3310 ws'});
        if (window.__gateSendWrapped) return JSON.stringify({ok: true, already: true});
        window.__gateSentLog = window.__gateSentLog || [];
        const orig = target.send.bind(target);
        target.send = (data) => {
          try {
            const m = JSON.parse(data);
            if (m.type === 'session.setThinkingLevel' || m.type === 'model.switch' || m.type === 'message.send') {
              window.__gateSentLog.push({ t: Date.now(), type: m.type, payload: m.payload });
            }
          } catch {}
          return orig(data);
        };
        window.__gateSendWrapped = true;
        return JSON.stringify({ok: true, wrapped: true});
      }`,
      returnByValue: true,
    })
    console.log('send-hook result:', r.result?.result?.value)
    process.exit(0)
  } catch (e) {
    console.error('error:', e.message)
    process.exit(1)
  }
})
